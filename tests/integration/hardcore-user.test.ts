import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ============================================================================
// HARDCORE-USER END-TO-END SCENARIO (offline, real SurrealDB, no GPU)
// ----------------------------------------------------------------------------
// "Linh" is an independent consultant running THREE clients out of ONE vault:
// Acme, Globex, Initech. Over one working session she imports client material,
// organizes it, captures decisions, links notes, asks scoped questions, and
// shares a COMPACT, token-counted slice of ONE client's context to another LLM.
//
// The non-negotiable invariant under test: **no cross-client bleed** — a query
// or a compiled payload scoped to one client must NEVER contain another client's
// data. This wires the REAL modules end to end (intake → proxy note → authoring
// → wikilink graph → tag/tree → real HNSW retrieval → scope → Context Compiler
// → export) and asserts the whole chain, not isolated units.
// ============================================================================

import { intake } from '../../src/lib/ingest/intake';
import { csvToMarkdown } from '../../src/lib/ingest/csv';
import { buildProxyNote, proxyNotePath } from '../../src/lib/ingest/proxy';
import { createNote, type NoteFile } from '../../src/lib/vault/note-crud';
import { computeNoteHash, parseNote, serializeNote } from '../../src/lib/vault/note';
import { expandTemplate, BUILTIN_TEMPLATES } from '../../src/lib/vault/template';
import { buildTitleIndex, weaveLinks } from '../../src/lib/weave/weaver';
import {
  parseWikilinks,
  resolveTarget,
  buildBacklinks,
  findUnlinkedMentions
} from '../../src/lib/weave/wikilink';
import { renderMarkdown } from '../../src/lib/render/markdown';
import { buildTagIndex, extractInlineTags, coerceTags, notesForTag } from '../../src/lib/nav/tags';
import { buildFileTree, flattenFiles } from '../../src/lib/nav/tree';
import { scopeDocIds, filterByScope, type Scope } from '../../src/lib/retrieval/scope';
import { sourcesFromNotes, sourcesFromHits, parseRedactions } from '../../src/lib/context/sources';
import { compile } from '../../src/lib/context/compiler';
import { quickSwitch } from '../../src/lib/nav/switcher';
import { exportVaultZip } from '../../src/lib/vault/export';
import { chunk } from '../../src/lib/ingest/chunker';
import { VectorStore } from '../../src/lib/db/store';
import { EMBEDDING_DIM, type SearchHit } from '../../src/lib/inference/provider';

const NOW = '2026-06-06T09:30:00Z';
const wc = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

// Deterministic, offline keyword embedding (no model). Texts/queries that share
// vocabulary land near each other under cosine — enough to prove that a global
// search MIXES clients (the risk) and that scope removes the leak.
const VOCAB = [
  'price',
  'pricing',
  'payment',
  'invoice',
  'monthly',
  'dashboard',
  'sow',
  'contract',
  'decision',
  'postgres',
  'redis',
  'kickoff',
  'launch',
  'q3',
  'support',
  'renewal',
  'acme',
  'globex',
  'initech',
  'budget'
];
function embed(text: string): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  const lower = text.toLowerCase();
  VOCAB.forEach((w, i) => {
    if (lower.includes(w)) v[i] = 1;
  });
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

interface VNote {
  docId: string;
  title: string;
  aliases: string[];
  body: string;
  tags: string[]; // merged frontmatter + inline
  kind?: string;
  sourcePath?: string;
  frontmatter: Record<string, unknown>;
}

let vault: VNote[] = [];
let store: VectorStore;
let originals: { path: string; bytes: Uint8Array }[] = [];

// Helpers built once the vault exists.
const titleIndex = () =>
  buildTitleIndex(
    vault.map((n) => ({ docId: n.docId, title: n.title, aliases: n.aliases, summary: n.body }))
  );
const bodies = () =>
  vault.map((n) => ({ docId: n.docId, title: n.title, body: n.body, aliases: n.aliases }));
const tagged = () => vault.map((n) => ({ docId: n.docId, tags: n.tags }));
const scopeNotes = () => vault.map((n) => ({ docId: n.docId, tags: n.tags }));
const hashOf = (docId: string) =>
  String(vault.find((n) => n.docId === docId)?.frontmatter.nebula_hash ?? '');

/** Author a hand-written note exactly as the app's Write mode does. */
async function authorNote(
  folder: string,
  title: string,
  body: string,
  tags: string[]
): Promise<VNote> {
  const file: NoteFile = await createNote({ title, body, now: NOW });
  // The app keeps notes under notes/<slug>.md; for the multi-client scenario we
  // place client notes under notes/<client>/, deduping within that folder.
  const slug = file.docId.replace(/^notes\//, '').replace(/\.md$/, '');
  const taken = new Set(vault.map((v) => v.docId));
  let docId = `${folder}/${slug}.md`;
  let k = 2;
  while (taken.has(docId)) docId = `${folder}/${slug}-${k++}.md`;
  return {
    docId,
    title: String(file.note.frontmatter.title ?? title),
    aliases: [],
    body,
    tags: [...new Set([...tags, ...extractInlineTags(body)])],
    kind: 'note',
    frontmatter: { ...file.note.frontmatter }
  };
}

beforeAll(async () => {
  // --- 1. Import Acme's pricing CSV (multi-format intake → Markdown proxy note) ---
  const csv = 'Tier,Monthly\nDashboard,9000\nSupport,1500\n';
  const csvBytes = new TextEncoder().encode(csv);
  const csvIntake = intake({ name: 'acme-pricing.csv', bytes: csvBytes });
  if (!csvIntake.ok) throw new Error('csv intake failed');
  const csvMd = csvToMarkdown(csvIntake.text ?? '');
  const sourcePath = 'sources/acme/acme-pricing.csv';
  const proxy = buildProxyNote({ sourcePath, body: csvMd, now: NOW, taggableLater: true });
  vault.push({
    docId: proxyNotePath(sourcePath).replace(/^notes\//, 'notes/acme/'),
    title: 'acme-pricing',
    aliases: [],
    body: csvMd,
    tags: ['client/acme'],
    kind: 'csv',
    sourcePath,
    frontmatter: { ...proxy.frontmatter, tags: ['client/acme'] }
  });
  originals.push({ path: sourcePath, bytes: csvBytes });

  // --- 2. Import Globex SOW (TXT intake) ---
  const sowBytes = new TextEncoder().encode(
    'Globex SOW: monthly payment of $5,000. Includes pricing for support and renewal.'
  );
  const sowIntake = intake({ name: 'globex-sow.txt', bytes: sowBytes });
  if (!sowIntake.ok) throw new Error('txt intake failed');
  vault.push({
    docId: 'notes/globex/sow.md',
    title: 'Globex SOW',
    aliases: [],
    body: '#client/globex\n\n' + (sowIntake.text ?? ''),
    tags: ['client/globex'],
    kind: 'txt',
    frontmatter: { title: 'Globex SOW', tags: ['client/globex'], nebula_hash: '' }
  });

  // --- 3. Author decision notes (template-driven) for two clients ---
  const acmeDecisionBody = expandTemplate(
    BUILTIN_TEMPLATES.find((t) => t.id === 'decision')!.body,
    { now: NOW, title: 'Acme Q3 Decision' }
  ).replace(
    '## Decision\n',
    '## Decision\nAcme agreed pricing of $9,000 for the dashboard launch. #client/acme #priority\n'
  );
  vault.push(
    await authorNote('notes/acme', 'Acme Q3 Decision', acmeDecisionBody, [
      'client/acme',
      'priority'
    ])
  );

  const globexDecisionBody = expandTemplate(
    BUILTIN_TEMPLATES.find((t) => t.id === 'decision')!.body,
    { now: NOW, title: 'Globex Renewal' }
  ).replace(
    '## Decision\n',
    '## Decision\nGlobex renewal at $5,000 monthly payment. #client/globex\n'
  );
  vault.push(
    await authorNote('notes/globex', 'Globex Renewal', globexDecisionBody, ['client/globex'])
  );

  // --- 4. Linking notes: one [[wikilink]], one prose (unlinked) mention ---
  vault.push(
    await authorNote(
      'notes/acme',
      'Acme Kickoff',
      'Kickoff with Acme. Pricing discussed. Action: finalize via [[Acme Q3 Decision]]. #client/acme',
      ['client/acme']
    )
  );
  vault.push(
    await authorNote(
      'notes/acme',
      'Acme Recap',
      'Recap: the Acme Q3 Decision was approved and pricing is locked. #client/acme',
      ['client/acme']
    )
  );

  // --- 5. Unicode title + filename collision (Initech) ---
  vault.push(
    await authorNote(
      'notes/initech',
      'Đánh giá Initech Q3',
      'Initech budget review. Pricing TBD. #client/initech',
      ['client/initech']
    )
  );
  vault.push(
    await authorNote('notes/initech', 'Meeting Notes', 'First Initech meeting. #client/initech', [
      'client/initech'
    ])
  );
  vault.push(
    await authorNote('notes/initech', 'Meeting Notes', 'Second Initech meeting. #client/initech', [
      'client/initech'
    ])
  );

  // --- 6. PII note for the redaction test ---
  vault.push(
    await authorNote(
      'notes/acme',
      'Acme Contacts',
      'Acme billing contact: jane@acme.com, phone 555-867-5309. Pricing owner. #client/acme',
      ['client/acme']
    )
  );

  // --- 7. Index EVERY note into a REAL SurrealDB HNSW store (chunk → embed → upsert) ---
  store = new VectorStore();
  await store.connect('mem://', EMBEDDING_DIM);
  for (const n of vault) {
    const cs = chunk(n.body, { size: 30, overlap: 5, countTokens: wc });
    await store.upsertChunks(
      cs.map((c) => ({
        chunkId: `${n.docId}#${c.seq}`,
        docId: n.docId,
        text: c.text,
        page: c.page,
        charStart: c.charStart,
        charEnd: c.charEnd,
        embedding: embed(c.text)
      }))
    );
  }
});

afterAll(async () => {
  await store?.close();
});

// Scoped retrieval exactly as the app does it: over-fetch, then filter by scope.
async function scopedSearch(query: string, scope: Scope | null, k = 5): Promise<SearchHit[]> {
  const raw = await store.search(embed(query), scope ? 24 : k);
  return filterByScope(raw, scopeDocIds(scopeNotes(), scope)).slice(0, k);
}

describe('Hardcore user — ingestion & organization', () => {
  it('CSV import became a Markdown proxy note under the client folder, original preserved', () => {
    const proxy = vault.find((n) => n.kind === 'csv')!;
    expect(proxy.docId).toBe('notes/acme/acme-pricing.md');
    expect(proxy.body).toContain('| Tier | Monthly |'); // rendered as a Markdown table
    expect(proxy.frontmatter.source).toBe('sources/acme/acme-pricing.csv');
    // the original bytes are untouched (FR-ING-011)
    expect(new TextDecoder().decode(originals[0].bytes)).toContain('Dashboard,9000');
  });

  it('the file tree nests all three clients with the right files', () => {
    const tree = buildFileTree(vault.map((n) => n.docId));
    const notes = tree.find((t) => t.name === 'notes')!;
    const folders = notes.children.filter((c) => c.kind === 'folder').map((c) => c.name);
    expect(folders).toEqual(['acme', 'globex', 'initech']); // alphabetical
    expect(flattenFiles(tree).length).toBe(vault.length);
  });

  it('the tag pane aggregates client + priority tags with correct counts', () => {
    const idx = buildTagIndex(tagged());
    const acme = idx.find((t) => t.tag === 'client/acme')!;
    expect(acme.count).toBe(vault.filter((n) => n.tags.includes('client/acme')).length);
    expect(acme.count).toBeGreaterThanOrEqual(5);
    expect(idx.find((t) => t.tag === 'client/initech')!.count).toBe(3);
    expect(notesForTag(tagged(), '#client/globex').sort()).toEqual(
      vault
        .filter((n) => n.tags.includes('client/globex'))
        .map((n) => n.docId)
        .sort()
    );
  });

  it('a Vietnamese title slugs safely and duplicate titles never collide', () => {
    const initech = vault.find((n) => n.title === 'Đánh giá Initech Q3')!;
    expect(initech.docId).toBe('notes/initech/danh-gia-initech-q3.md');
    const meetings = vault.filter((n) => n.title === 'Meeting Notes').map((n) => n.docId);
    expect(new Set(meetings).size).toBe(2); // -2 suffix kept them distinct
  });
});

describe('Hardcore user — authoring integrity', () => {
  it('decision notes carry note frontmatter and a body-hash that survives reload (FR-DATA-003)', async () => {
    const dec = vault.find((n) => n.title === 'Acme Q3 Decision')!;
    expect(dec.frontmatter.type).toBe('note');
    expect(dec.frontmatter.created).toBe(NOW);
    expect(dec.body).toContain('# Decision: Acme Q3 Decision');
    // re-serialize from frontmatter+body and confirm the stored hash matches the parsed body
    const md = serializeNote({ frontmatter: dec.frontmatter, body: dec.body });
    expect(dec.frontmatter.nebula_hash).toBe(await computeNoteHash(md));
  });

  it('a saved note round-trips through serialize → parse', () => {
    const dec = vault.find((n) => n.title === 'Globex Renewal')!;
    const round = parseNote(serializeNote({ frontmatter: dec.frontmatter, body: dec.body }));
    expect(round.frontmatter.title).toBe('Globex Renewal');
    expect(round.body).toContain('Globex renewal');
  });
});

describe('Hardcore user — the knowledge graph', () => {
  it('wikilinks resolve and render as clickable; a missing target renders broken', () => {
    const idx = titleIndex();
    const kickoff = vault.find((n) => n.title === 'Acme Kickoff')!;
    expect(parseWikilinks(kickoff.body)[0].target).toBe('Acme Q3 Decision');
    expect(resolveTarget('Acme Q3 Decision', idx)?.docId).toBe(
      vault.find((n) => n.title === 'Acme Q3 Decision')!.docId
    );
    const html = renderMarkdown(kickoff.body, { resolveLink: (t) => resolveTarget(t, idx) });
    expect(html).toContain('class="wikilink"');
    expect(
      renderMarkdown('See [[No Such Note]].', { resolveLink: (t) => resolveTarget(t, idx) })
    ).toContain('broken-link');
  });

  it('backlinks list the linking note; unlinked mentions list the prose note (not the linked one)', () => {
    const idx = titleIndex();
    const decisionDoc = vault.find((n) => n.title === 'Acme Q3 Decision')!.docId;
    const back = buildBacklinks(bodies(), idx).get(decisionDoc) ?? [];
    expect(back.map((b) => b.title)).toContain('Acme Kickoff');

    const mentions = findUnlinkedMentions(
      { docId: decisionDoc, title: 'Acme Q3 Decision', aliases: [] },
      bodies()
    );
    const docs = mentions.map((m) => m.docId);
    expect(docs).toContain(vault.find((n) => n.title === 'Acme Recap')!.docId); // prose mention
    expect(docs).not.toContain(vault.find((n) => n.title === 'Acme Kickoff')!.docId); // already [[linked]]
  });
});

describe('Hardcore user — CONFIDENTIALITY: scoped retrieval (no cross-client bleed)', () => {
  it('an UNSCOPED price query MIXES clients (the real risk)', async () => {
    const hits = await scopedSearch('agreed pricing and monthly payment', null, 6);
    const clients = new Set(hits.map((h) => h.docId.split('/')[1]));
    expect(clients.size).toBeGreaterThan(1); // global search pulls Acme AND Globex (and maybe Initech)
  });

  it('scoping to one client returns ONLY that client, across multiple queries', async () => {
    const clientScopes: { client: string; scope: Scope }[] = [
      { client: 'acme', scope: { kind: 'tag', value: 'client/acme' } },
      { client: 'globex', scope: { kind: 'folder', value: 'notes/globex/' } },
      { client: 'initech', scope: { kind: 'tag', value: 'client/initech' } }
    ];
    const queries = ['pricing', 'monthly payment', 'q3 decision', 'budget renewal support'];
    for (const { client, scope } of clientScopes) {
      for (const q of queries) {
        const hits = await scopedSearch(q, scope, 24);
        for (const h of hits) {
          // EVERY surviving hit must belong to the scoped client — zero leak.
          if (scope.kind === 'folder') expect(h.docId.startsWith(scope.value)).toBe(true);
          else expect(h.docId).toContain(`/${client}/`);
        }
      }
    }
  });
});

describe('Hardcore user — share a COMPACT slice to another LLM', () => {
  it('compiling a scoped answer yields that client only, and is deterministic', async () => {
    const scope: Scope = { kind: 'tag', value: 'client/acme' };
    const hits = await scopedSearch('pricing decision', scope, 8);
    const sources = sourcesFromHits(
      hits.map((h) => ({ chunkId: h.chunkId, docId: h.docId, text: h.text, page: h.page })),
      hashOf
    );
    const a = compile({ sources, targetModel: 'claude-sonnet' });
    const b = compile({ sources, targetModel: 'claude-sonnet' });
    expect(a.xml).toBe(b.xml); // deterministic (FR-CTX-002)
    expect(a.xml).not.toMatch(/globex|initech/i); // no other client
    expect(a.manifest.tokenCount).toBeGreaterThan(0);
  });

  it('token count tracks the target model tokenizer', () => {
    const sources = sourcesFromNotes(
      vault
        .filter((n) => n.tags.includes('client/acme'))
        .map((n) => ({ docId: n.docId, text: n.body, hash: hashOf(n.docId) }))
    );
    const claude = compile({ sources, targetModel: 'claude-sonnet' });
    const gpt4o = compile({ sources, targetModel: 'gpt-4o' });
    expect(claude.manifest.tokenizer).toBe('cl100k_base');
    expect(gpt4o.manifest.tokenizer).toBe('o200k_base');
  });

  it('redaction strips PII before the payload leaves the device (FR-CTX-005)', () => {
    const contacts = vault.find((n) => n.title === 'Acme Contacts')!;
    const sources = sourcesFromNotes([
      { docId: contacts.docId, text: contacts.body, hash: hashOf(contacts.docId) }
    ]);
    const r = compile({
      sources,
      targetModel: 'gpt-4o',
      redactions: parseRedactions('jane@acme\\.com, 555-867-5309, Acme')
    });
    expect(r.xml).not.toContain('jane@acme.com');
    expect(r.xml).not.toContain('555-867-5309');
    expect(r.xml).not.toMatch(/\bAcme\b/);
    expect(r.xml).toContain('[REDACTED]');
  });
});

describe('Hardcore user — navigation & portability', () => {
  it('the quick switcher fuzzy-finds a note by its initials', () => {
    const items = vault.map((n) => ({ docId: n.docId, title: n.title }));
    const r = quickSwitch(items, 'aqd');
    expect(r[0].title).toBe('Acme Q3 Decision');
  });

  it('the Weaver auto-links a note title mentioned in free text, losslessly', () => {
    const idx = titleIndex();
    const segs = weaveLinks('We should revisit the Acme Q3 Decision soon.', idx, { once: true });
    expect(segs.some((s) => s.link && s.link.title === 'Acme Q3 Decision')).toBe(true);
    expect(segs.map((s) => s.text).join('')).toBe('We should revisit the Acme Q3 Decision soon.');
  });

  it('Export Vault produces a valid ZIP carrying notes/ and the original under sources/', () => {
    const zip = new Uint8Array(
      exportVaultZip({
        notes: vault.map((n) => ({ path: n.docId, frontmatter: n.frontmatter, body: n.body })),
        originals
      })
    );
    expect(zip.length).toBeGreaterThan(0);
    // PK local-file-header magic → a real archive any tool can open
    expect([zip[0], zip[1], zip[2], zip[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // store-only zip embeds filenames as ASCII; the client note + original are both there
    const raw = new TextDecoder('latin1').decode(zip);
    expect(raw).toContain('notes/acme/acme-pricing.md');
    expect(raw).toContain('sources/acme/acme-pricing.csv');
  });
});
