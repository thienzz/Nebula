<script lang="ts">
  // Nebula workspace — the "Obsidian DNA" surfaces on the REAL RAG pipeline, now with
  // multi-format ingestion: drop PDF/CSV/TXT/MD → intake → Markdown Proxy Note (source
  // backlink, original untouched) → chunk → bge embed → SurrealDB HNSW (indxdb) → retrieve
  // → WebLLM grounded answer. 40/60 resizable split (FR-UI-001); Magic Jump scroll+highlight
  // (FR-CHAT-003); the Weaver auto-wikilinks (FR-LINK-001/002); Micro-Map (FR-GRAPH-001/002);
  // Export Vault → .zip of .md proxies + original binaries under sources/ (FR-DATA-006). In-browser.
  import { onMount, tick } from 'svelte';
  import type { SearchHit } from '$lib/inference/provider';
  import type { NoteRecord } from '$lib/db/store';
  import { buildTitleIndex, weaveLinks, notePreview, type WovenSegment } from '$lib/weave/weaver';
  import { buildMicroGraph, type MicroGraph } from '$lib/graph/micrograph';
  import { selectGraphRagContext } from '$lib/retrieval/graphrag';
  import { extractEntities } from '$lib/graph/entities';
  import { resolveExtraction } from '$lib/graph/resolve';
  import { buildEntityIndex, type EntityEntry } from '$lib/graph/entity-index';
  import { buildEntityGraph, type EntityGraph, type GraphNeighbor } from '$lib/graph/entity-graph';
  import type { EntityRecord, MentionEdge, RelationEdge } from '$lib/graph/types';
  import type { TextGenerator } from '$lib/ingest/autotag';
  import { resolveCitationTarget, buildHighlightSegments } from '$lib/chat/citation';
  import { exportVaultZip } from '$lib/vault/export';
  import { intake } from '$lib/ingest/intake';
  import { csvToMarkdown } from '$lib/ingest/csv';
  import { buildProxyNote, proxyNotePath } from '$lib/ingest/proxy';
  import {
    CHAT_MODELS,
    formatSize,
    needsOomAck,
    modelById,
    recommendModel
  } from '$lib/inference/catalog';
  import { createNote, updateNote, renameNote, moveNotePath } from '$lib/vault/note-crud';
  import { serializeNote } from '$lib/vault/note';
  import { putSource, allSources, deleteSource } from '$lib/vault/sources-db';
  import {
    resolveTarget,
    buildBacklinks,
    findUnlinkedMentions,
    autocompleteWikilink,
    applyWikilinkChoice,
    rewriteWikilinkTitle,
    type AutocompleteState
  } from '$lib/weave/wikilink';
  import { renderMarkdown } from '$lib/render/markdown';
  import { quickSwitch, type SwitchResult } from '$lib/nav/switcher';
  import {
    BUILTIN_TEMPLATES,
    expandTemplate,
    dailyNoteTitle,
    dailyNotePath,
    dailyNoteBody
  } from '$lib/vault/template';
  import { buildFileTree, type TreeNode } from '$lib/nav/tree';
  import { buildTagIndex, notesForTag, coerceTags, extractInlineTags } from '$lib/nav/tags';
  import { scopeDocIds, filterByScope, scopeLabel, type Scope } from '$lib/retrieval/scope';
  import {
    dedupeByDoc,
    referencesFromHits,
    relevantHits,
    type SourceRef
  } from '$lib/retrieval/search';
  import { sourcesFromNotes, sourcesFromHits, parseRedactions } from '$lib/context/sources';
  import { compile } from '$lib/context/compiler';

  type Note = {
    docId: string;
    title: string;
    aliases: string[];
    text: string;
    kind?: string; // 'pdf' | 'csv' | 'txt' | 'md' for imports; undefined for seed
    sourcePath?: string; // backlink to the untouched original
    frontmatter?: Record<string, unknown>;
  };
  type Cite = { n: number; chunkId: string; docId: string };

  const SEED: Note[] = [
    {
      docId: 'notes/apollo.md',
      title: 'Apollo',
      aliases: ['Apollo project', 'dashboard', 'export API'],
      text: 'The Apollo project will ship to customers in the third quarter of next year. The release adds a new dashboard and an export API for power users.'
    },
    {
      docId: 'notes/refunds.md',
      title: 'refund policy',
      aliases: ['refund', 'refunds'],
      text: 'Our refund policy lets customers return any product within thirty days of purchase for a full refund, no questions asked.'
    },
    {
      docId: 'notes/security.md',
      title: 'security',
      aliases: ['vault data', 'Context Compiler'],
      text: 'All vault data stays on the local device. Nebula never uploads note content to any server; the Context Compiler is the only path that can export text, and only with consent.'
    },
    {
      docId: 'notes/cats.md',
      title: 'Cats',
      aliases: ['cat'],
      text: 'Cats are small domesticated carnivores. They are entirely unrelated to the product roadmap.'
    }
  ];

  const MODELS = CHAT_MODELS; // curated tiny→large picker with VRAM labels + OOM guard (catalog.ts)

  let vault = $state<Note[]>(SEED.map((n) => ({ ...n })));
  let originals = $state<{ path: string; bytes: Uint8Array }[]>([]);

  // The Weaver's title index (FR-LINK-001) — rebuilds as the vault grows.
  const titleIndex = $derived(
    buildTitleIndex(
      vault.map((n) => ({ docId: n.docId, title: n.title, aliases: n.aliases, summary: n.text }))
    )
  );

  // Vault note bodies for backlink/mention scans (FR-LINK-004/005).
  const vaultBodies = $derived(
    vault.map((n) => ({ docId: n.docId, title: n.title, body: n.text, aliases: n.aliases }))
  );
  const backlinks = $derived(buildBacklinks(vaultBodies, titleIndex));

  let status = $state('starting…');
  let ready = $state(false);
  // Default to the fast 1B (good speed/quality for first load); larger, more accurate models are
  // one pick away in the catalog. `?? MODELS[0]` keeps it safe if the id is ever pruned.
  const DEFAULT_MODEL_ID = (
    MODELS.find((m) => m.id === 'Llama-3.2-1B-Instruct-q4f16_1-MLC') ?? MODELS[0]
  ).id;
  let modelId = $state(DEFAULT_MODEL_ID);
  let query = $state('Does Nebula upload my notes to a server?');
  let answer = $state('');
  let woven = $state<WovenSegment[]>([]);
  let cites = $state<Cite[]>([]);
  let hits = $state<SearchHit[]>([]);
  let references = $state<SourceRef[]>([]); // distinct source docs behind the answer (FR-CHAT-002)
  let graph = $state<MicroGraph | null>(null);
  let activeDoc = $state<string | null>(null);
  let activeSpan = $state<{ charStart: number; charEnd: number } | null>(null);
  let busy = $state(false);
  let ttft = $state(0);
  let tps = $state(0);
  let coi = $state(false);
  let modelCached = $state(false); // weights already on disk → fast load, no download (#4)
  let ackedModels = $state(new Set<string>()); // large models the user already OK'd (FR-CAP-003)
  let gpuBufferLimitGB = $state(0); // WebGPU maxBufferSize cap (Chrome ≈ 2 GB) — gates large models
  let gpu = $state<{ ok: boolean; vendor: string; arch: string; maxBufferGB: number } | null>(null);
  let preloading = $state(false); // a background model preload is in flight
  let loadPhase = $state<'' | 'downloading' | 'loading' | 'compiling'>(''); // model-load stage
  let loadPct = $state(0); // 0–100 download/load progress for the gpu-bar bar

  // Ingestion UI.
  let importMsg = $state('');
  let dropActive = $state(false);
  let fileInput: HTMLInputElement;

  // Note editor (FR-NOTE-001/003, FR-UI-002). Notes are the PRIMARY action — the app lands in
  // Write mode with the subject pre-filled; Ask is the secondary tab.
  let mode = $state<'ask' | 'write'>('write');
  let draftTitle = $state(new Date().toISOString().slice(0, 10));
  let draftFolder = $state('notes'); // target folder for a NEW note (FR-NOTE-007)
  const EMBED_PROGRESS_MIN = 4; // only show per-chunk indexing progress past this many chunks
  let draftBody = $state('');
  let editingDocId = $state<string | null>(null); // null → creating a new note
  let editMsg = $state('');
  let savingNote = $state(false);

  // BACKGROUND indexing queue (ADR-024, the Obsidian model): saving a note is INSTANT — the note
  // lands in the vault and the editor frees immediately; embedding happens here, off the save path,
  // so a long note never locks the editor. The note is searchable once its job drains.
  type IndexJob = { docId: string; body: string; oldDocId?: string };
  let indexJobs: IndexJob[] = [];
  let indexRunning = false;
  let bgPending = $state(0); // notes waiting/being indexed (drives the unobtrusive header indicator)
  let bgProgress = $state(''); // e.g. "apollo 32/66" for the current job
  let bodyEl = $state<HTMLTextAreaElement>();
  let wlState = $state<AutocompleteState | null>(null); // wikilink autocomplete (FR-LINK-003)

  // Quick switcher (FR-NAV-001).
  let switcherOpen = $state(false);
  let switcherQuery = $state('');

  // File tree + tag pane (FR-NAV-002/003).
  let collapsed = $state(new Set<string>());
  let activeTag = $state<string | null>(null);

  // Live Markdown preview (FR-UI-002 · §5.10).
  let previewOn = $state(true);

  // Retrieval scope (FR-RET-004) — restrict Ask + Compile to one client (folder/tag).
  let scope = $state<Scope | null>(null);

  // Answer mode (FR-CHAT-005): 'reason' = apply knowledge + reason WITH the notes (default — what
  // makes it feel like an assistant, not a search box); 'grounded' = strict, notes-only, verifiable.
  let answerMode = $state<'grounded' | 'reason'>('reason');

  // Knowledge graph (Phases 1–4). GraphRAG fuses vector seeds with graph-connected siblings — the
  // lever for the local-LLM quality ceiling. The Entities pane + entity page navigate the persisted
  // graph; the entity graph view is the multi-hop "how is X connected to Y" map.
  let graphRagOn = $state(true); // use GraphRAG when the vault has a graph (degrades to plain RAG)
  let graphInfo = $state(''); // e.g. "+3 graph-connected" — shows GraphRAG actually expanded context
  let graphExpandedIds = $state(new Set<string>()); // chunkIds that entered via graph expansion (badge)
  let entityIndex = $state<EntityEntry[]>([]); // the Entities pane (built from persisted edges)
  let entityRelations = $state<RelationEdge[]>([]); // all relations, for the entity graph view
  let selectedEntity = $state<EntityEntry | null>(null); // open entity page
  let entityGraph = $state<EntityGraph | null>(null); // multi-hop sub-graph for the selected entity
  let entityNotes = $state<string[]>([]); // docIds mentioning the selected entity
  let graphBusy = $state(false);

  // Context Compiler UI (FR-CTX-*) — compact, token-counted share to another LLM.
  const COMPILE_MODELS = ['gpt-4o', 'gpt-4', 'claude-sonnet', 'claude-opus'];
  let compileOpen = $state(false);
  let compileModel = $state('claude-sonnet');
  let compileRedact = $state('');
  let compileSources = $state<ReturnType<typeof sourcesFromNotes>>([]);
  let compileFrom = $state<'scope' | 'answer'>('scope');

  // 40/60 resizable split (FR-UI-001).
  let leftPct = $state(40);
  let splitEl: HTMLDivElement;
  let dragging = $state(false);
  let preview = $state<{ text: string; x: number; y: number } | null>(null);

  let pipe: {
    embed: (t: string) => Promise<number[]>;
    search: (v: number[], k: number) => Promise<SearchHit[]>;
    relate: (qid: string, hs: SearchHit[]) => Promise<void>;
    ingest: (
      docId: string,
      text: string,
      onProgress?: (done: number, total: number) => void
    ) => Promise<void>;
    removeDoc: (docId: string) => Promise<void>;
    putNote: (note: NoteRecord) => Promise<void>;
    forgetNote: (docId: string) => Promise<void>;
    // Knowledge graph (entities + relations): GraphRAG retrieval, ingest-time extraction, and
    // navigation/traversal over the persisted graph (Phases 1–4).
    graphRag: (
      v: number[],
      opts: { seedK: number; expandK: number; k: number }
    ) => Promise<{
      seeds: SearchHit[];
      expanded: SearchHit[];
      fused: SearchHit[];
      entityIds: string[];
    }>;
    indexGraph: (docId: string, text: string) => Promise<number>;
    clearGraph: (docId: string) => Promise<void>;
    entityData: () => Promise<{
      entities: EntityRecord[];
      mentions: MentionEdge[];
      relations: RelationEdge[];
    }>;
    entityNeighbors: (id: string, hops: number) => Promise<GraphNeighbor[]>;
    relationsAmong: (ids: string[]) => Promise<RelationEdge[]>;
    mentionsForEntity: (id: string) => Promise<{ docId: string; chunkId: string }[]>;
    provider: {
      isCached: (m: string) => Promise<boolean>;
      loadModel: (m: string, cb: (p: number) => void) => Promise<void>;
      complete?: (p: string, o?: { maxTokens?: number }) => Promise<string>;
      generate: (
        req: {
          requestId: string;
          query: string;
          context: SearchHit[];
          modelId: string;
          maxTokens: number;
          answerMode: 'grounded' | 'reason';
        },
        onTok: (t: string) => void,
        sig: AbortSignal
      ) => Promise<{
        text: string;
        citations: { chunkId: string; spanInAnswer: [number, number] }[];
        ttftMs: number;
        tokensPerSec: number;
      }>;
    };
  } | null = null;
  let loadedModel = $state('');

  // Cheap, stable content hash (FNV-1a) for the incremental-extraction guard: if a note's text hasn't
  // changed since its last graph extraction, skip the expensive LLM pass entirely (perf).
  function graphHash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  onMount(async () => {
    coi = crossOriginIsolated;
    // Probe WebGPU once at startup (FR-CAP-001, ADR-030): is chat possible, on what GPU, and what is
    // the per-buffer cap (Chrome ≈ 2 GB — a single weight buffer above it can't load; this is a
    // platform limit, not VRAM). Drives the GPU status line + the model recommendation.
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter) {
        gpu = {
          ok: true,
          vendor: adapter.info?.vendor || '',
          arch: adapter.info?.architecture || '',
          maxBufferGB: adapter.limits.maxBufferSize / 1e9
        };
        gpuBufferLimitGB = gpu.maxBufferGB;
      }
    } catch {
      /* no WebGPU → chat unsupported; semantic search still works (FR-CAP-002) */
    }
    // Default to the GPU-recommended model (Qwen2.5-3B — multilingual, far better entity/relation
    // extraction than the tiny 1B) when WebGPU is present. Auto-preload only fires if it's already
    // cached, so this never triggers a surprise multi-GB download — the first Ask/build does.
    {
      const rec = recommendModel(!!gpu?.ok);
      if (rec) modelId = rec.id;
    }
    const [{ createEmbedClient }, { VectorStore }, { WebLLMProvider }, { EMBEDDING_DIM }] =
      await Promise.all([
        import('$lib/embed/embed-client'),
        import('$lib/db/store'),
        import('$lib/inference/webllm'),
        import('$lib/inference/provider')
      ]);

    status = 'loading embedder…';
    // ALL chunking + embedding runs in a Worker (ADR-023) so a long note never freezes the UI; the
    // main thread only upserts the returned vectors into SurrealDB (a cheap, fast DB write).
    const embedClient = createEmbedClient();
    const store = new VectorStore();
    try {
      // -m3 namespace: the 1024-dim bge-m3 index must not collide with an old 384-dim store (ADR-021).
      await store.connect('indxdb://nebula-app-m3', EMBEDDING_DIM);
    } catch (e) {
      // mem:// means NOTHING persists across refresh — surface it rather than silently losing notes.
      console.warn('Nebula: persistent store unavailable, falling back to in-memory:', e);
      await store.connect('mem://', EMBEDDING_DIM);
    }

    const indexNote = async (
      docId: string,
      text: string,
      onProgress?: (done: number, total: number) => void
    ) => {
      const embedded = await embedClient.indexText(text, { size: 60, overlap: 12 }, onProgress);
      await store.upsertChunks(
        embedded.map((e) => ({
          chunkId: `${docId}#${e.chunk.seq}`,
          docId,
          text: e.chunk.text,
          page: e.chunk.page,
          charStart: e.chunk.charStart,
          charEnd: e.chunk.charEnd,
          embedding: e.embedding
        }))
      );
    };

    // Rehydrate the vault from the persisted `note` table (FR-DATA-001). In the browser build there
    // are no `.md` files on disk, so this table IS the source of truth — without it every saved note
    // is lost on refresh. First run (empty table) → seed the demo notes, persist + index them once;
    // later runs → load the saved notes and DO NOT re-embed (their chunks already persist in indxdb).
    const saved = await store.allNotes();
    if (saved.length > 0) {
      status = 'loading notes…';
      vault = saved.map((n) => ({
        docId: n.docId,
        title: n.title,
        aliases: n.aliases ?? [],
        text: n.body,
        kind: n.kind,
        sourcePath: n.sourcePath,
        frontmatter: n.frontmatter
      }));
    } else {
      status = 'indexing vault…';
      for (const note of vault) {
        await store.upsertNote({
          docId: note.docId,
          title: note.title,
          body: note.text,
          aliases: note.aliases,
          kind: note.kind,
          sourcePath: note.sourcePath,
          frontmatter: note.frontmatter
        });
        await indexNote(note.docId, note.text);
      }
    }

    // Rehydrate proxy-note source binaries so Export Vault still ships the originals after a refresh.
    try {
      originals = await allSources();
    } catch (e) {
      console.warn('Nebula: could not load source binaries:', e);
    }

    const provider = new WebLLMProvider();

    // Ingest-time knowledge-graph extraction (Phase 1). Best-effort, exactly like auto-tagging: with
    // no chat model loaded there's nothing to extract WITH, so skip — chunks/embeddings (and thus
    // plain RAG) are unaffected. With a model loaded, skim → extract → resolve → persist with
    // chunk-level provenance so GraphRAG can later expand on shared entities.
    const indexGraph = async (docId: string, text: string): Promise<number> => {
      const gen: TextGenerator | null =
        loadedModel && provider.complete ? (p, o) => provider.complete(p, o) : null;
      if (!gen) return 0;
      // Incremental guard (perf): skip the LLM extraction when this exact text was already extracted.
      // Turns a repeat "build graph" from a minutes-long full pass into re-reading only CHANGED notes.
      const hash = graphHash(text);
      if ((await store.getGraphHash(docId)) === hash) return -1; // -1 = skipped (unchanged)
      const res = await extractEntities(text, gen);
      if (!res.ok) return 0;
      const g = resolveExtraction(res.extraction);
      if (g.entities.length === 0) return 0;
      await store.clearDocGraph(docId);
      for (const e of g.entities) await store.upsertEntity(e);
      // Attach each entity to the chunks whose text actually names it → chunk-level provenance, which
      // is what lets GraphRAG pull the RIGHT sibling chunks (not the whole doc) on a shared entity.
      const chunks = await store.chunkTextsForDoc(docId);
      const lc = chunks.map((c) => ({ chunkId: c.chunkId, text: c.text.toLowerCase() }));
      for (const e of g.entities) {
        const surfaces = [e.name, ...e.aliases].map((s) => s.toLowerCase()).filter(Boolean);
        for (const c of lc) {
          if (surfaces.some((s) => c.text.includes(s)))
            await store.relateMention(c.chunkId, docId, e.id);
        }
      }
      // Quality gate: drop weak/guessed relations so the graph isn't polluted with low-signal edges
      // (e.g. a tiny model labelling everything the same generic type). 0.5 is a forgiving floor.
      for (const r of g.relations) {
        if ((r.confidence ?? 1) < 0.5) continue;
        await store.relateEntities(r.sourceId, r.targetId, r.type, docId);
      }
      await store.setGraphHash(docId, hash); // mark this text as extracted → next rebuild skips it
      return g.entities.length;
    };

    pipe = {
      embed: (t) => embedClient.embedQuery(t),
      search: (v, k) => store.search(v, k),
      relate: (qid, hs) =>
        store.relateRetrieval(
          qid,
          hs.map((h) => ({ chunkId: h.chunkId, score: h.score }))
        ),
      ingest: indexNote,
      removeDoc: (docId) => store.deleteDoc(docId),
      putNote: (note) => store.upsertNote(note),
      forgetNote: (docId) => store.deleteNote(docId),
      graphRag: (v, opts) => store.graphRagSearch(v, opts),
      indexGraph,
      clearGraph: (docId) => store.clearDocGraph(docId),
      entityData: async () => ({
        entities: await store.allEntities(),
        mentions: await store.allMentions(),
        relations: await store.allRelations()
      }),
      entityNeighbors: (id, hops) => store.entityNeighbors(id, hops),
      relationsAmong: (ids) => store.relationsAmong(ids),
      mentionsForEntity: (id) => store.mentionsForEntity(id),
      provider
    };
    status = 'ready';
    ready = true;
    void refreshEntities(); // populate the Entities pane from any graph persisted in a prior session

    // Auto-preload the selected model IF it's already cached (no download) so the first Ask is
    // instant (ADR-030). We never auto-DOWNLOAD a multi-GB model unasked — uncached models wait for
    // an explicit Ask / "Preload" click.
    if (await pipe.provider.isCached(modelId).catch(() => false)) void preloadModel();
  });

  const today = (): string => new Date().toISOString().slice(0, 10);

  // Multi-format ingestion (FR-ING-001/012): drop/pick PDF/CSV/TXT/MD → Markdown Proxy Note.
  async function ingestFiles(list: FileList | null) {
    if (!pipe || !ready || !list || list.length === 0) return;
    for (const file of Array.from(list)) {
      importMsg = `ingesting ${file.name}…`;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const res = intake({ name: file.name, bytes });
        if (!res.ok) {
          importMsg = `skipped ${file.name}: ${res.reason}`;
          continue;
        }
        let body = '';
        let sourcePath: string | undefined;
        if (res.type === 'pdf') {
          try {
            importMsg = `reading PDF ${file.name}…`;
            const { extractPdf } = await import('$lib/ingest/pdf');
            body = (await extractPdf(bytes)).text;
            if (!body.trim()) {
              importMsg = `${file.name} has no extractable text (scanned image PDF?) — skipped`;
              continue;
            }
          } catch (e) {
            importMsg = `couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`;
            continue;
          }
          sourcePath = `sources/${file.name}`;
        } else if (res.type === 'csv') {
          body = csvToMarkdown(res.text ?? '');
          sourcePath = `sources/${file.name}`;
        } else {
          body = res.text ?? '';
        }
        if (!body.trim()) {
          importMsg = `nothing to index in ${file.name}`;
          continue;
        }
        const stem = file.name.replace(/\.[^.]+$/, '');
        const docId = sourcePath ? proxyNotePath(sourcePath) : `notes/${stem}.md`;
        const note = buildProxyNote({
          sourcePath,
          body,
          now: today(),
          taggableLater: !!sourcePath
        });
        await pipe.ingest(docId, body);
        // Extract + persist this document's entity graph (best-effort; needs a loaded model).
        const entCount = await pipe.indexGraph(docId, body).catch(() => 0);
        await pipe.putNote({
          docId,
          title: stem,
          body,
          aliases: [],
          kind: res.type,
          sourcePath,
          frontmatter: note.frontmatter
        });
        vault = [
          ...vault.filter((n) => n.docId !== docId),
          {
            docId,
            title: stem,
            aliases: [],
            text: body,
            kind: res.type,
            sourcePath,
            frontmatter: note.frontmatter
          }
        ];
        if (sourcePath) {
          originals = [
            ...originals.filter((o) => o.path !== sourcePath),
            { path: sourcePath, bytes }
          ];
          await putSource(sourcePath, bytes); // persist the original so Export survives a refresh
        }
        importMsg = `✓ ingested ${docId} (${res.type})${entCount > 0 ? ` · ${entCount} entities` : ''}`;
        showSource(docId);
      } catch (e) {
        importMsg = `error on ${file.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // Refresh the Entities pane ONCE after the whole batch — never per-file. A fire-and-forget
    // refresh inside the loop runs a READ that overlaps the next file's WRITES, which wedges the
    // IndexedDB engine ("Can not open transaction") on large bulk ingests (FOUND via stress test).
    await refreshEntities();
    if (fileInput) fileInput.value = '';
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dropActive = false;
    void ingestFiles(e.dataTransfer?.files ?? null);
  }

  // --- Note editor (FR-NOTE-001/003, FR-UI-002) ------------------------------
  // Author a note → write a portable `.md` (frontmatter + body) → index it immediately so it is
  // searchable, citable, weave-linkable, and exportable to any LLM (Export Vault / Context Compiler).
  function startNewNote() {
    editingDocId = null;
    draftTitle = today(); // subject pre-filled with today's date (overwrite if you want)
    draftBody = '';
    editMsg = '';
    activeTag = null; // so returning to the vault lands on the folder tree, not a stale filter
    mode = 'write';
  }

  function editNote(note: Note) {
    editingDocId = note.docId;
    draftTitle = String(note.frontmatter?.title ?? note.title ?? '');
    draftBody = note.text;
    editMsg = '';
    mode = 'write';
  }

  const shortName = (docId: string) => docId.slice(docId.lastIndexOf('/') + 1).replace(/\.md$/, '');

  /** Queue a note for background indexing (drop old chunks first on an edit/rename, then embed). */
  function enqueueIndex(docId: string, body: string, oldDocId?: string) {
    indexJobs.push({ docId, body, oldDocId });
    bgPending = indexJobs.length;
    void drainIndexQueue();
  }

  /** Serially drain the index queue off the save path; the worker does the heavy work (ADR-023/024). */
  async function drainIndexQueue() {
    if (indexRunning || !pipe) return;
    indexRunning = true;
    while (indexJobs.length) {
      const job = indexJobs[0];
      try {
        if (job.oldDocId) {
          await pipe.removeDoc(job.oldDocId);
          await pipe.clearGraph(job.oldDocId);
        }
        await pipe.ingest(job.docId, job.body, (done, total) => {
          bgProgress = total > EMBED_PROGRESS_MIN ? `${shortName(job.docId)} ${done}/${total}` : '';
        });
        // Extract + persist the note's entity graph too (best-effort; needs a loaded model).
        await pipe.indexGraph(job.docId, job.body);
      } catch {
        /* a failed index shouldn't wedge the queue; the note stays in the vault, just unindexed */
      }
      indexJobs.shift();
      bgPending = indexJobs.length;
      bgProgress = '';
    }
    indexRunning = false;
    await refreshEntities(); // once, after the queue drains — never per-job (avoids the read/write race)
  }

  /** Rebuild the Entities pane from the persisted graph (after ingest / index / delete). Phase 2. */
  async function refreshEntities() {
    if (!pipe) return;
    try {
      const data = await pipe.entityData();
      entityIndex = buildEntityIndex(data.entities, data.mentions);
      entityRelations = data.relations;
    } catch {
      /* graph is best-effort; an empty pane is fine */
    }
  }

  /** Open an entity page: its notes (mentions) + a multi-hop sub-graph over the persisted graph. */
  async function openEntity(e: EntityEntry) {
    if (!pipe) return;
    selectedEntity = e;
    graphBusy = true;
    entityGraph = null;
    entityNotes = [];
    activeDoc = null;
    try {
      entityNotes = [...new Set((await pipe.mentionsForEntity(e.id)).map((m) => m.docId))].sort();
      const neighbors = await pipe.entityNeighbors(e.id, 2); // 1–2 hops (Phase 4 traversal)
      const ids = [e.id, ...neighbors.map((n) => n.id)];
      const rels = await pipe.relationsAmong(ids);
      entityGraph = buildEntityGraph(
        { id: e.id, name: e.name, type: e.type },
        neighbors,
        rels.map((r) => ({ sourceId: r.sourceId, targetId: r.targetId, type: r.type }))
      );
    } finally {
      graphBusy = false;
    }
  }
  function closeEntity() {
    selectedEntity = null;
    entityGraph = null;
    entityNotes = [];
  }

  /** Jump from a node in the entity graph to that entity's page (multi-hop browsing). */
  function openEntityById(id: string) {
    const e = entityIndex.find((x) => x.id === id);
    if (e) {
      void openEntity(e);
      return;
    }
    const node = entityGraph?.nodes.find((n) => n.id === id);
    if (node) void openEntity({ id, name: node.label, type: node.type ?? '', noteCount: 0, docIds: [] });
  }

  /** One-click: extract the entity graph across the whole vault (loads the model if needed). */
  async function buildVaultGraph() {
    if (!pipe || graphBusy) return;
    if (!loadedModel) {
      const ok = await ensureModelLoaded(modelId);
      if (!ok) return;
    }
    graphBusy = true;
    try {
      let extracted = 0;
      let skipped = 0;
      for (const n of vault) {
        status = `extracting entities: ${shortName(n.docId)}…`;
        const r = await pipe.indexGraph(n.docId, n.text).catch(() => 0);
        if (r === -1) skipped++;
        else if (r > 0) extracted++;
      }
      await refreshEntities();
      status =
        `graph ready · ${entityIndex.length} entities · ${extracted} extracted` +
        (skipped ? `, ${skipped} unchanged (skipped)` : '');
    } finally {
      graphBusy = false;
    }
  }

  async function saveNote() {
    if (!pipe || !ready || savingNote) return;
    // Never block a save on a missing subject — default it to today's date. Duplicates are
    // fine: createNote auto-suffixes the path (-2, -3…) so nothing is ever overwritten.
    draftTitle = draftTitle.trim() || today();
    savingNote = true;
    editMsg = 'saving…';
    try {
      const nowIso = new Date().toISOString();
      const body = draftBody;
      const oldDocId = editingDocId ?? undefined;
      let file;
      if (editingDocId) {
        const existing = vault.find((n) => n.docId === editingDocId);
        const currentMd = serializeNote({
          frontmatter: existing?.frontmatter ?? { title: existing?.title ?? draftTitle },
          body: existing?.text ?? ''
        });
        file = await updateNote({
          docId: editingDocId,
          markdown: currentMd,
          title: draftTitle,
          body,
          now: nowIso
        });
      } else {
        file = await createNote({
          title: draftTitle,
          body,
          now: nowIso,
          folder: draftFolder,
          existingPaths: vault.map((n) => n.docId)
        });
      }
      // INSTANT save (the Obsidian model, ADR-024): the note is in the vault NOW — visible,
      // linkable, editable — and the editor frees immediately. Embedding runs in the BACKGROUND
      // queue, so a long note never locks the editor; it becomes searchable when its job drains.
      const title = String(file.note.frontmatter.title ?? draftTitle);
      const noteRec: NoteRecord = {
        docId: file.docId,
        title,
        body,
        aliases: [],
        kind: 'note',
        frontmatter: file.note.frontmatter
      };
      vault = [
        ...vault.filter((n) => n.docId !== file.docId && n.docId !== editingDocId),
        {
          docId: file.docId,
          title,
          aliases: [],
          text: body,
          kind: 'note',
          frontmatter: file.note.frontmatter
        }
      ];
      // Persist the note doc durably FIRST (fast DB write) so it survives a refresh even before its
      // embeddings finish (FR-DATA-001). An edit that changed the path also forgets the old record.
      if (oldDocId && oldDocId !== file.docId) await pipe.forgetNote(oldDocId);
      await pipe.putNote(noteRec);
      enqueueIndex(file.docId, body, oldDocId);
      editMsg = `✓ saved ${file.docId}`;
      // Notes are primary: flow straight into a fresh note (date pre-filled), with the folder
      // tree visible on the right (clear any tag filter / open doc) so navigation isn't lost.
      editingDocId = null;
      draftTitle = today();
      draftBody = '';
      mode = 'write';
      activeTag = null;
      activeDoc = null;
      activeSpan = null;
    } catch (e) {
      editMsg = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      savingNote = false;
    }
  }

  /** Re-key a note's chunks from `oldDocId` → `newDocId` via the background queue (non-blocking). */
  function reindexAs(oldDocId: string, newDocId: string, body: string) {
    enqueueIndex(newDocId, body, oldDocId);
  }

  // Delete a note (FR-NOTE-009): remove it from the vault + drop its chunks from the index. Works
  // for hand-written notes AND proxy notes (the untouched original under sources/ is unaffected).
  async function deleteNote(docId: string) {
    if (!pipe || !ready) return;
    if (!confirm(`Delete ${docId}?\nThis removes it from the vault and the search index.`)) return;
    await pipe.removeDoc(docId);
    await pipe.forgetNote(docId); // drop the persisted note doc too, so it stays deleted after refresh
    await pipe.clearGraph(docId); // and its entity-graph edges (entity nodes stay if other docs use them)
    void refreshEntities();
    const gone = vault.find((n) => n.docId === docId);
    if (gone?.sourcePath) {
      originals = originals.filter((o) => o.path !== gone.sourcePath);
      await deleteSource(gone.sourcePath); // forget the persisted original binary too
    }
    vault = vault.filter((n) => n.docId !== docId);
    if (activeDoc === docId) {
      activeDoc = null;
      activeSpan = null;
    }
    if (editingDocId === docId) {
      editingDocId = null;
      draftTitle = today();
      draftBody = '';
    }
    editMsg = `🗑 deleted ${docId}`;
  }

  // Rename a note (FR-NOTE-008): change its title + path, re-index under the new docId, AND rewrite
  // every inbound `[[OldTitle]]` wikilink in the rest of the vault so no link breaks (links resolve
  // by title). Each note whose body changes is re-embedded so retrieval stays consistent.
  async function renameNoteAction(note: Note) {
    if (!pipe || !ready) return;
    const oldTitle = note.title;
    const next = prompt('Rename note — new title:', oldTitle);
    if (next === null) return;
    const newTitle = next.trim();
    if (!newTitle || newTitle === oldTitle) return;
    const nowIso = new Date().toISOString();
    const md = serializeNote({
      frontmatter: note.frontmatter ?? { title: note.title },
      body: note.text
    });
    const file = await renameNote({
      docId: note.docId,
      markdown: md,
      newTitle,
      now: nowIso,
      existingPaths: vault.map((n) => n.docId)
    });
    const newTitleStr = String(file.note.frontmatter.title);
    reindexAs(note.docId, file.docId, note.text);

    // Rewrite inbound [[oldTitle]] links across every other note; re-index the ones that changed.
    const rewrites = new Map<string, string>();
    for (const other of vault) {
      if (other.docId === note.docId) continue;
      const r = rewriteWikilinkTitle(other.text, oldTitle, newTitleStr);
      if (r.changed) rewrites.set(other.docId, r.text);
    }
    for (const [docId, body] of rewrites) reindexAs(docId, docId, body);

    vault = vault
      .filter((n) => n.docId !== note.docId)
      .map((n) => (rewrites.has(n.docId) ? { ...n, text: rewrites.get(n.docId)! } : n))
      .concat([
        {
          docId: file.docId,
          title: newTitleStr,
          aliases: note.aliases ?? [],
          text: note.text,
          kind: note.kind,
          sourcePath: note.sourcePath,
          frontmatter: file.note.frontmatter
        }
      ]);
    // Persist: forget the old path, store the renamed note, and re-store every link-rewritten note.
    await pipe.forgetNote(note.docId);
    await pipe.putNote({
      docId: file.docId,
      title: newTitleStr,
      body: note.text,
      aliases: note.aliases ?? [],
      kind: note.kind,
      sourcePath: note.sourcePath,
      frontmatter: file.note.frontmatter
    });
    for (const n of vault) {
      if (rewrites.has(n.docId)) {
        await pipe.putNote({
          docId: n.docId,
          title: n.title,
          body: n.text,
          aliases: n.aliases,
          kind: n.kind,
          sourcePath: n.sourcePath,
          frontmatter: n.frontmatter
        });
      }
    }
    if (activeDoc === note.docId) activeDoc = file.docId;
    if (editingDocId === note.docId) editingDocId = file.docId;
    editMsg = `✓ renamed → ${file.docId}${rewrites.size ? ` (rewrote ${rewrites.size} link${rewrites.size > 1 ? 's' : ''})` : ''}`;
  }

  // Move a note to another folder (FR-NOTE-008): the filename (slug) and title are unchanged, so
  // title-based wikilinks keep resolving — only the docId/path changes, re-keyed in the index.
  async function moveNoteAction(note: Note) {
    if (!pipe || !ready) return;
    const currentFolder = note.docId.slice(0, note.docId.lastIndexOf('/')) || 'notes';
    const next = prompt('Move note — destination folder:', currentFolder);
    if (next === null) return;
    const newDocId = moveNotePath(
      note.docId,
      next,
      vault.map((n) => n.docId)
    );
    if (newDocId === note.docId) return;
    reindexAs(note.docId, newDocId, note.text);
    // Persist the path change so the move survives a refresh.
    await pipe.forgetNote(note.docId);
    await pipe.putNote({
      docId: newDocId,
      title: note.title,
      body: note.text,
      aliases: note.aliases,
      kind: note.kind,
      sourcePath: note.sourcePath,
      frontmatter: note.frontmatter
    });
    vault = vault.filter((n) => n.docId !== note.docId).concat([{ ...note, docId: newDocId }]);
    if (activeDoc === note.docId) activeDoc = newDocId;
    if (editingDocId === note.docId) editingDocId = newDocId;
    editMsg = `✓ moved → ${newDocId}`;
  }

  // Insert a template into the editor body (FR-NOTE-006), expanding {{date}}/{{title}}/… for now.
  function applyTemplate(id: string) {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    draftBody = expandTemplate(t.body, { now: new Date().toISOString(), title: draftTitle });
    wlState = null;
  }

  // Open today's daily note, creating it from the daily template if it doesn't exist (FR-NOTE-005).
  async function openDailyNote() {
    if (!pipe || !ready) return;
    const nowIso = new Date().toISOString();
    const path = dailyNotePath(nowIso);
    if (vault.some((n) => n.docId === path)) {
      showSource(path);
      return;
    }
    const body = dailyNoteBody(nowIso);
    const file = await createNote({
      title: dailyNoteTitle(nowIso),
      body,
      now: nowIso,
      existingPaths: vault.map((n) => n.docId)
    });
    await pipe.ingest(file.docId, body);
    const dailyTitle = String(file.note.frontmatter.title ?? dailyNoteTitle(nowIso));
    await pipe.putNote({
      docId: file.docId,
      title: dailyTitle,
      body,
      aliases: [],
      kind: 'note',
      frontmatter: file.note.frontmatter
    });
    vault = [
      ...vault,
      {
        docId: file.docId,
        title: dailyTitle,
        aliases: [],
        text: body,
        kind: 'note',
        frontmatter: file.note.frontmatter
      }
    ];
    showSource(file.docId);
  }

  /**
   * Ensure `id` is the loaded chat model (FR-CAP-003/004): ack for experimental (7–8 B) models that
   * may exceed the WebGPU per-buffer cap, cache-aware status, graceful failure. Returns true if it's
   * loaded (or already current), false if declined/failed. Shared by Ask + preload.
   */
  async function ensureModelLoaded(id: string): Promise<boolean> {
    if (!pipe) return false;
    if (loadedModel === id) return true;
    if (needsOomAck(id) && !ackedModels.has(id)) {
      const m = modelById(id);
      const limitNote =
        gpuBufferLimitGB > 0
          ? `\n\nYour browser's WebGPU limit is ~${gpuBufferLimitGB.toFixed(1)} GB per buffer (a ` +
            `Chrome cap, not your VRAM). 7–8 B models may need a bigger single buffer and fail to ` +
            `load; 1–3 B models load reliably.`
          : '';
      const ok = confirm(
        `${m?.label} needs ~${formatSize(m?.sizeMB ?? 0)}.${limitNote}\n\nDownload and try to load it anyway?`
      );
      if (!ok) {
        modelId = loadedModel || DEFAULT_MODEL_ID;
        status = 'ready';
        return false;
      }
      ackedModels = new Set(ackedModels).add(id);
    }
    modelCached = await pipe.provider.isCached(id).catch(() => false);
    loadPhase = modelCached ? 'loading' : 'downloading';
    loadPct = 0;
    status = `${modelCached ? 'loading cached model' : 'first run — downloading model once'}…`;
    try {
      await pipe.provider.loadModel(id, (p) => {
        loadPct = Math.round(p * 100);
        // WebLLM reports 100% download well before the GPU finishes compiling shaders — name that
        // last stage so a few frozen seconds read as "compiling", not "stuck".
        loadPhase = loadPct >= 100 ? 'compiling' : modelCached ? 'loading' : 'downloading';
        status = `${loadPhase} model ${loadPct}%`;
      });
    } catch (err) {
      loadPhase = '';
      const m = modelById(id);
      const msg = err instanceof Error ? err.message : String(err);
      modelId = loadedModel || DEFAULT_MODEL_ID;
      // Distinguish a DOWNLOAD failure (network / HuggingFace 503 / Cache.add) from a real GPU OOM.
      // The old code blamed every failure on the buffer cap — misleading during a host outage, where
      // the right action is "retry" (cached shards resume), not "pick a smaller model".
      const isDownload = /cache|network|fetch|failed to execute 'add'|http|50\d|429|timeout|load/i.test(
        msg
      );
      if (isDownload) {
        status =
          `⚠ ${m?.label ?? 'model'} download didn't finish — the model host (HuggingFace) may be ` +
          `busy/rate-limiting. Wait a moment and retry; already-downloaded parts resume. [${msg}]`;
      } else {
        const cap =
          gpuBufferLimitGB > 0 ? `~${gpuBufferLimitGB.toFixed(1)} GB WebGPU buffer cap` : 'this GPU';
        status = `⚠ ${m?.label ?? 'model'} couldn't load — it may exceed ${cap}. Pick a smaller model. [${msg}]`;
      }
      return false;
    }
    loadPhase = '';
    loadedModel = id;
    modelCached = true;
    return true;
  }

  /** Preload the selected model now (so the first Ask is instant). Non-blocking; safe to ignore. */
  async function preloadModel() {
    if (!pipe || !ready || busy || preloading || loadedModel === modelId) return;
    preloading = true;
    try {
      const ok = await ensureModelLoaded(modelId);
      if (ok) status = 'ready';
    } finally {
      preloading = false;
    }
  }

  /** Switch to the recommended model for this GPU and preload it. */
  async function useRecommended() {
    const rec = recommendModel(!!gpu?.ok);
    if (!rec) return;
    modelId = rec.id;
    await preloadModel();
  }

  async function ask() {
    if (!pipe || busy || !query.trim()) return;
    busy = true;
    answer = '';
    woven = [];
    cites = [];
    references = [];
    graph = null;
    activeDoc = null;
    activeSpan = null;
    try {
      status = 'embedding query…';
      const qv = await pipe.embed(query);
      status = scope ? `retrieving (scoped: ${scopeLabel(scope)})…` : 'retrieving…';
      graphInfo = '';
      // Scoped retrieval (FR-RET-004): over-fetch then keep only in-scope hits so a question
      // about one client never pulls another client's notes (no cross-client bleed).
      let relevant: SearchHit[] = [];
      const expandedIds = new Set<string>();
      if (graphRagOn) {
        // GraphRAG (Phase 3): vector seeds + graph-connected siblings. The relevance floor still
        // gates the SEEDS (irrelevant notes must never anchor the answer — same precision as plain
        // RAG, and the no-results guard fires when nothing clears it). Graph-expanded siblings are
        // then KEPT even below the floor — they earn inclusion structurally (shared entities), which
        // is exactly the context plain cosine misses (the quality lever). Seeds keep their cosine
        // score for display; we don't surface the internal RRF fusion score to the user.
        const rag = await pipe.graphRag(qv, {
          seedK: scope ? 24 : 12,
          expandK: 10,
          k: scope ? 24 : 12
        });
        const seedRelevant = relevantHits(filterByScope(rag.seeds, scopeIds));
        if (seedRelevant.length > 0) {
          const expandedScoped = filterByScope(rag.expanded, scopeIds);
          relevant = selectGraphRagContext(seedRelevant, expandedScoped);
          const seedIds = new Set(seedRelevant.map((h) => h.chunkId));
          for (const h of relevant) if (!seedIds.has(h.chunkId)) expandedIds.add(h.chunkId);
        }
      } else {
        // Plain RAG: over-fetch → precision floor (ADR-018) drops the low-score tail so References,
        // Micro-Map, and the grounded context carry only genuinely relevant notes (FR-CHAT-002).
        relevant = relevantHits(filterByScope(await pipe.search(qv, scope ? 24 : 12), scopeIds));
      }
      // Favor BREADTH across distinct documents (FR-CHAT-002): one best chunk per doc. GraphRAG gets
      // more room (8 docs) so the graph-connected siblings actually surface alongside the seeds.
      hits = dedupeByDoc(relevant, graphRagOn ? 8 : 5);
      graphExpandedIds = expandedIds;
      const graphAdded = hits.filter((h) => expandedIds.has(h.chunkId)).length;
      graphInfo = graphAdded > 0 ? `+${graphAdded} graph-connected` : '';
      references = referencesFromHits(hits);
      // Micro-Map (FR-GRAPH-001) + persist the retrieval sub-graph edges (FR-GRAPH-002).
      graph = buildMicroGraph(query, hits);
      try {
        await pipe.relate('current', hits);
      } catch {
        /* edge persistence is best-effort; the visual graph is built from hits */
      }

      if (loadedModel !== modelId) {
        const ok = await ensureModelLoaded(modelId);
        if (!ok) {
          busy = false;
          return;
        }
      }

      status = 'generating…';
      const res = await pipe.provider.generate(
        // Reason mode elaborates, so give it more room than the terse grounded answer.
        {
          requestId: 'q',
          query,
          context: hits,
          modelId,
          maxTokens: answerMode === 'reason' ? 512 : 256,
          answerMode
        },
        (t) => {
          answer += t;
        },
        new AbortController().signal
      );
      ttft = res.ttftMs;
      tps = Math.round(res.tokensPerSec);
      // Replace the streamed text with the provider's cleaned final answer (echo stripped).
      answer = res.text;
      const order = hits.map((h) => h.chunkId);
      cites = res.citations.map((c) => {
        const docId = order.find((id) => id === c.chunkId) ? c.chunkId.split('#')[0] : c.chunkId;
        const n = order.indexOf(c.chunkId) + 1;
        return { n, chunkId: c.chunkId, docId };
      });
      // The Weaver (FR-LINK-001): wrap note-title mentions in the finished answer as links.
      woven = weaveLinks(answer, titleIndex, { once: true });
      status = 'done';
      await tick();
    } catch (e) {
      status = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  // Magic Jump (FR-CHAT-003): open the cited chunk's document and highlight its exact span.
  function jumpTo(chunkId: string) {
    const target = resolveCitationTarget(chunkId, hits);
    if (!target) return;
    activeDoc = target.docId;
    activeSpan = { charStart: target.charStart, charEnd: target.charEnd };
  }

  function showSource(docId: string) {
    activeDoc = docId;
    activeSpan = null;
  }

  function exportVault() {
    const zip = exportVaultZip({
      notes: vault.map((n) => ({
        path: n.docId,
        frontmatter: n.frontmatter ?? { title: n.title },
        body: n.text
      })),
      originals
    });
    const url = URL.createObjectURL(new Blob([new Uint8Array(zip)], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nebula-vault.zip';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Weaver popover (FR-LINK-002).
  function showPreview(e: MouseEvent, docId: string) {
    const ref = vault.find((r) => r.docId === docId);
    preview = {
      text: notePreview({ summary: ref?.text }),
      x: e.clientX + 12,
      y: e.clientY + 12
    };
  }
  const hidePreview = () => (preview = null);

  // Resizable divider.
  function startDrag(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDrag(e: PointerEvent) {
    if (!dragging || !splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    leftPct = Math.min(70, Math.max(25, ((e.clientX - rect.left) / rect.width) * 100));
  }
  function endDrag() {
    dragging = false;
  }
  function dividerKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') leftPct = Math.max(25, leftPct - 2);
    if (e.key === 'ArrowRight') leftPct = Math.min(70, leftPct + 2);
  }

  const activeNote = $derived(activeDoc ? vault.find((n) => n.docId === activeDoc) : undefined);
  const activeBacklinks = $derived(activeDoc ? (backlinks.get(activeDoc) ?? []) : []);
  const activeUnlinked = $derived(
    activeNote
      ? findUnlinkedMentions(
          { docId: activeNote.docId, title: activeNote.title, aliases: activeNote.aliases },
          vaultBodies
        )
      : []
  );

  // Markdown preview wiring (FR-UI-002 · §5.10): resolve [[ ]] + delegate wikilink clicks.
  function resolveNoteLink(target: string) {
    return resolveTarget(target, titleIndex);
  }
  function onRenderedClick(e: MouseEvent) {
    const a = (e.target as HTMLElement | null)?.closest?.('a.wikilink') as HTMLElement | null;
    if (a?.dataset.doc) {
      e.preventDefault();
      showSource(a.dataset.doc);
    }
  }

  // --- Wikilink autocomplete (FR-LINK-003) ---------------------------------
  function onBodyInput() {
    if (!bodyEl) return;
    wlState = autocompleteWikilink(
      draftBody,
      bodyEl.selectionStart ?? draftBody.length,
      titleIndex
    );
  }
  async function pickWikilink(title: string) {
    if (!wlState) return;
    const res = applyWikilinkChoice(draftBody, wlState, title);
    draftBody = res.text;
    wlState = null;
    await tick();
    if (bodyEl) {
      bodyEl.focus();
      bodyEl.setSelectionRange(res.caret, res.caret);
    }
  }

  // --- Quick switcher (FR-NAV-001) -----------------------------------------
  const switcherResults = $derived<SwitchResult[]>(
    switcherOpen
      ? quickSwitch(
          vault.map((n) => ({ docId: n.docId, title: n.title })),
          switcherQuery,
          10
        )
      : []
  );
  async function openSwitcher() {
    switcherQuery = '';
    switcherOpen = true;
    await tick();
    document.getElementById('switcher-input')?.focus();
  }
  function chooseSwitch(docId: string) {
    switcherOpen = false;
    showSource(docId);
  }

  // --- File tree + tag pane (FR-NAV-002/003) -------------------------------
  const fileTree = $derived<TreeNode[]>(buildFileTree(vault.map((n) => n.docId)));
  const taggedVault = $derived(
    vault.map((n) => ({
      docId: n.docId,
      tags: [...coerceTags(n.frontmatter?.tags), ...extractInlineTags(n.text)]
    }))
  );
  const tagIndex = $derived(buildTagIndex(taggedVault));
  const taggedDocIds = $derived(activeTag ? new Set(notesForTag(taggedVault, activeTag)) : null);
  const filteredNotes = $derived(
    taggedDocIds ? vault.filter((n) => taggedDocIds.has(n.docId)) : []
  );
  function toggleFolder(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }
  function toggleTag(tag: string) {
    activeTag = activeTag === tag ? null : tag;
  }

  // --- Retrieval scope (FR-RET-004) ----------------------------------------
  const scopeNotes = $derived(taggedVault.map((n) => ({ docId: n.docId, tags: n.tags })));
  const scopeIds = $derived(scopeDocIds(scopeNotes, scope));
  // Distinct folder prefixes + tags, as selectable scopes.
  const folderScopes = $derived.by(() => {
    const set = new Set<string>();
    for (const n of vault) {
      const parts = n.docId.split('/');
      parts.pop();
      let p = '';
      for (const seg of parts) {
        p = p ? `${p}/${seg}` : seg;
        set.add(`${p}/`);
      }
    }
    return [...set].sort();
  });
  function setScope(value: string) {
    if (!value) scope = null;
    else if (value.startsWith('folder:')) scope = { kind: 'folder', value: value.slice(7) };
    else scope = { kind: 'tag', value: value.slice(4) };
  }

  // --- Context Compiler (FR-CTX-*) -----------------------------------------
  const hashOfDoc = (docId: string): string =>
    String(vault.find((n) => n.docId === docId)?.frontmatter?.nebula_hash ?? '');
  const compileResult = $derived(
    compileOpen && compileSources.length
      ? compile({
          sources: compileSources,
          targetModel: compileModel,
          redactions: parseRedactions(compileRedact)
        })
      : null
  );
  function openCompileFromScope() {
    const inScope = scopeIds ? vault.filter((n) => scopeIds.has(n.docId)) : vault;
    compileSources = sourcesFromNotes(
      inScope.map((n) => ({ docId: n.docId, text: n.text, hash: hashOfDoc(n.docId) }))
    );
    compileFrom = 'scope';
    compileOpen = true;
  }
  function openCompileFromHits() {
    if (!hits.length) return;
    compileSources = sourcesFromHits(
      hits.map((h) => ({ chunkId: h.chunkId, docId: h.docId, text: h.text, page: h.page })),
      hashOfDoc
    );
    compileFrom = 'answer';
    compileOpen = true;
  }
  async function copyCompiled() {
    if (compileResult) await navigator.clipboard.writeText(compileResult.xml);
  }
  function downloadCompiled() {
    if (!compileResult) return;
    const url = URL.createObjectURL(new Blob([compileResult.xml], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nebula-context.xml';
    a.click();
    URL.revokeObjectURL(url);
  }
  function onGlobalKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'o')) {
      e.preventDefault();
      void openSwitcher();
    } else if (e.key === 'Escape') {
      switcherOpen = false;
      wlState = null;
    }
  }
</script>

<svelte:window onkeydown={onGlobalKey} />

<main class="shell">
  <header class="topbar">
    <span class="brand">✦ Nebula</span>
    <span class="tag">local-first RAG · Obsidian DNA</span>
    <button class="eject" onclick={openSwitcher} title="Quick switch to a note (Ctrl/⌘+K)">
      ⌘K Switch
    </button>
    <button
      class="eject"
      onclick={exportVault}
      title="Export the vault as a portable .zip — .md proxies + original binaries (FR-DATA-006)"
    >
      ⤓ Export Vault
    </button>
    {#if bgPending > 0}
      <span class="bg-index" title="Notes are saved instantly; embedding runs in the background.">
        <span class="spinner" aria-hidden="true"></span>
        indexing{bgProgress ? ` ${bgProgress}` : ''}{bgPending > 1 ? ` · ${bgPending} queued` : ''}
      </span>
    {/if}
    <span class="status">
      {#if busy || !ready}<span class="spinner" aria-hidden="true"></span>{/if}
      {status}{ready && ttft ? ` · TTFT ${ttft}ms · ${tps} tok/s` : ''}
    </span>
    <span class="coi" class:ok={coi}>{coi ? 'isolated ✓' : 'not isolated'}</span>
  </header>

  <div class="split" bind:this={splitEl}>
    <!-- LEFT (40%) — the Active/Command zone: chat + Micro-Map -->
    <section class="pane chat" style="width: {leftPct}%" aria-label="Chat">
      <div class="modes" role="tablist" aria-label="Left pane mode">
        <button
          class="modetab primary"
          class:active={mode === 'write'}
          role="tab"
          aria-selected={mode === 'write'}
          onclick={startNewNote}>✎ New note</button
        >
        <button
          class="modetab"
          class:active={mode === 'ask'}
          role="tab"
          aria-selected={mode === 'ask'}
          onclick={() => (mode = 'ask')}>Ask</button
        >
      </div>

      {#if mode === 'ask'}
        <div class="controls">
          <select
            bind:value={modelId}
            disabled={busy || !!loadPhase}
            title={loadPhase ? 'Locked while a model is loading…' : 'Choose the chat model'}
          >
            {#each MODELS as m (m.id)}<option value={m.id}
                >{m.label} · {formatSize(m.sizeMB)}</option
              >{/each}
          </select>
          <select
            class="scope-select"
            value={scope
              ? scope.kind === 'folder'
                ? `folder:${scope.value}`
                : `tag:${scope.value}`
              : ''}
            disabled={busy}
            title="Restrict Ask + Compile to one client (folder or tag) — no cross-client bleed"
            onchange={(e) => setScope(e.currentTarget.value)}
          >
            <option value="">🎯 Whole vault</option>
            {#if folderScopes.length}
              <optgroup label="Folders">
                {#each folderScopes as f (f)}<option value={`folder:${f}`}>📁 {f}</option>{/each}
              </optgroup>
            {/if}
            {#if tagIndex.length}
              <optgroup label="Tags">
                {#each tagIndex as t (t.tag)}<option value={`tag:${t.tag}`}>#{t.tag}</option>{/each}
              </optgroup>
            {/if}
          </select>
          <div class="mode-toggle" role="group" aria-label="Answer mode">
            <button
              class="mode-btn"
              class:on={answerMode === 'reason'}
              disabled={busy}
              title="Reason WITH your notes — synthesize, infer, and apply knowledge to actually answer"
              onclick={() => (answerMode = 'reason')}>💡 Reason</button
            >
            <button
              class="mode-btn"
              class:on={answerMode === 'grounded'}
              disabled={busy}
              title="Strict: answer only from the notes, cite everything — verifiable, no outside knowledge"
              onclick={() => (answerMode = 'grounded')}>📌 Grounded</button
            >
          </div>
          <div class="mode-toggle" role="group" aria-label="Retrieval mode">
            <button
              class="mode-btn"
              class:on={graphRagOn}
              disabled={busy}
              title="GraphRAG: also pull in chunks connected through SHARED ENTITIES, not just semantically similar ones — the context plain vector search misses. Falls back to plain RAG when the vault has no graph."
              onclick={() => (graphRagOn = !graphRagOn)}
              >🕸 GraphRAG {graphRagOn ? 'on' : 'off'}</button
            >
          </div>
        </div>

        {#if ready}
          {@const rec = recommendModel(!!gpu?.ok)}
          <div class="gpu-bar" class:warn={!gpu?.ok}>
            {#if gpu?.ok}
              <span title="WebGPU per-buffer cap is a Chrome limit, not your VRAM"
                >🖥 GPU: {gpu.vendor || 'WebGPU'}{gpu.arch ? ` (${gpu.arch})` : ''} · ~{gpu.maxBufferGB.toFixed(
                  1
                )} GB/buffer</span
              >
              {#if loadPhase}
                <span class="loading-model">
                  <span class="spinner" aria-hidden="true"></span>
                  {loadPhase}
                  {modelById(modelId)?.label ?? 'model'} · {loadPct}%
                  {#if loadPhase === 'downloading'}<small
                      >one-time {formatSize(modelById(modelId)?.sizeMB ?? 0)}</small
                    >{:else if loadPhase === 'compiling'}<small>GPU compiling, a few seconds…</small
                    >{/if}
                </span>
                <span class="progress" aria-hidden="true"
                  ><span class="progress-fill" style="width:{loadPct}%"></span></span
                >
              {:else if loadedModel === modelId}
                <span class="ok">✓ {modelById(modelId)?.label ?? 'model'} loaded</span>
                {#if rec && rec.id !== modelId}
                  <button class="mini accent" onclick={useRecommended} disabled={busy}
                    >★ Use {rec.label}</button
                  >
                {/if}
              {:else}
                <button class="mini accent" onclick={preloadModel} disabled={busy}
                  >⬇ Load {modelById(modelId)?.label ?? 'model'} ({formatSize(
                    modelById(modelId)?.sizeMB ?? 0
                  )})</button
                >
                {#if rec && rec.id !== modelId}
                  <button
                    class="mini"
                    onclick={useRecommended}
                    disabled={busy}
                    title="Best quality that loads reliably on this GPU (multilingual)"
                    >★ {rec.label} instead</button
                  >
                {/if}
              {/if}
            {:else}
              ⚠ No WebGPU — chat unavailable (semantic search still works). Use Chrome/Edge on a
              GPU-capable device.
            {/if}
          </div>
        {/if}

        <textarea bind:value={query} rows="2" placeholder="Ask a question…" disabled={busy}
        ></textarea>
        <div class="ask-row">
          <button class="ask" onclick={ask} disabled={!ready || busy}
            >{busy ? 'Working…' : 'Ask'}</button
          >
          <button
            class="ghost"
            onclick={openCompileFromScope}
            disabled={!ready}
            title="Compile {scope
              ? scopeLabel(scope)
              : 'the whole vault'} into a compact, token-counted payload for another LLM (GPT/Claude)"
            >📦 Compile {scope ? 'scope' : 'vault'}</button
          >
        </div>

        {#if busy || !ready}
          <div class="loading-banner">
            <span class="spinner"></span>
            <span>
              {status}
              {#if /model/i.test(status)}<br /><small
                  >{modelCached
                    ? 'Loading the cached model from disk — no download.'
                    : "First run downloads the model once (~hundreds of MB), then it's cached — later runs are fast."}</small
                >{/if}
            </span>
          </div>
        {/if}

        {#if hits.length}
          <div class="sources">
            <div class="block-h">
              Retrieved sources{#if graphInfo}
                <span class="graph-badge" title="GraphRAG added chunks reached through shared entities"
                  >🕸 {graphInfo}</span
                >{/if}
            </div>
            {#each hits as h, i (h.chunkId)}
              <button class="src" onclick={() => jumpTo(h.chunkId)}>
                <span class="src-n">[#{i + 1}]</span>
                {h.docId} <span class="score">{h.score.toFixed(2)}</span>
                {#if graphExpandedIds.has(h.chunkId)}<span
                    class="graph-badge"
                    title="Pulled in via the entity graph, not vector similarity">🕸</span
                  >{/if}
              </button>
            {/each}
          </div>
        {/if}

        {#if graph}
          <div class="micromap">
            <div class="block-h">Micro-Map · how the AI answered</div>
            <svg
              width="100%"
              height={40 + graph.nodes.filter((n) => n.kind === 'chunk').length * 30}
              class="graph"
            >
              {#each graph.edges as e, i (e.to)}
                {@const cy = 30 + i * 30}
                <line
                  x1="78"
                  y1="24"
                  x2="76%"
                  y2={cy}
                  stroke="#6750a4"
                  stroke-width={e.width}
                  stroke-opacity="0.55"
                />
              {/each}
              <circle cx="40" cy="24" r="9" fill="#6750a4" />
              <text x="40" y="44" text-anchor="middle" class="g-label">query</text>
              {#each graph.nodes.filter((n) => n.kind === 'chunk') as n, i (n.id)}
                {@const cy = 30 + i * 30}
                <circle cx="76%" {cy} r="6" fill="#efeaf8" stroke="#6750a4" />
                <text x="80%" y={cy + 4} class="g-label">{n.label} · {n.score}</text>
              {/each}
            </svg>
          </div>
        {/if}

        {#if answer}
          <div class="answer">
            <div class="block-h">Answer</div>
            {#if woven.length}
              <p>
                {#each woven as seg, i (i)}
                  {@const link = seg.link}
                  {#if link}
                    <button
                      class="wikilink"
                      onclick={() => showSource(link.docId)}
                      onmouseenter={(e) => showPreview(e, link.docId)}
                      onmouseleave={hidePreview}>{seg.text}</button
                    >
                  {:else}{seg.text}{/if}
                {/each}
              </p>
            {:else}
              <p>{answer}</p>
            {/if}
            {#if references.length}
              <div class="references">
                <div class="block-h">
                  References — {references.length} note{references.length > 1 ? 's' : ''}
                </div>
                {#each references as r (r.docId)}
                  {@const cited = cites.some((c) => c.docId === r.docId)}
                  <button
                    class="reference"
                    class:cited
                    onclick={() => jumpTo(r.chunkId)}
                    title="Open this note"
                  >
                    <span class="ref-n">[{r.n}]</span>
                    <span class="ref-title"
                      >{vault.find((n) => n.docId === r.docId)?.title ?? r.docId}</span
                    >
                    <span class="ref-doc">{r.docId}</span>
                  </button>
                {/each}
              </div>
            {/if}
            {#if hits.length}
              <button
                class="ghost compile-ctx"
                onclick={openCompileFromHits}
                title="Compile just the retrieved context (the relevant ~5%) for another LLM"
                >📦 Compile this context →</button
              >
            {/if}
          </div>
        {/if}
      {:else}
        <div class="editor">
          <div class="editor-top">
            <input
              class="title-input"
              bind:value={draftTitle}
              placeholder="Note title"
              disabled={savingNote}
            />
            {#if !editingDocId}
              <input
                class="folder-input"
                bind:value={draftFolder}
                placeholder="folder"
                title="Folder (e.g. clients/acme) — created on save"
                disabled={savingNote}
              />
            {/if}
            <select
              class="tpl-select"
              disabled={savingNote}
              title="Insert a template"
              onchange={(e) => {
                const el = e.currentTarget;
                applyTemplate(el.value);
                el.selectedIndex = 0;
              }}
            >
              <option value="">Template ▾</option>
              {#each BUILTIN_TEMPLATES as t (t.id)}
                <option value={t.id}>{t.label}</option>
              {/each}
            </select>
          </div>
          <div class="body-wrap">
            <textarea
              class="body-input"
              bind:this={bodyEl}
              bind:value={draftBody}
              rows="14"
              placeholder="Write your note in Markdown… type [[ to link a note"
              disabled={savingNote}
              oninput={onBodyInput}
              onkeyup={onBodyInput}
              onclick={onBodyInput}
            ></textarea>
            {#if wlState && wlState.suggestions.length}
              <ul class="wl-menu">
                {#each wlState.suggestions as s (s.docId)}
                  <li>
                    <button
                      class="wl-item"
                      onmousedown={(e) => e.preventDefault()}
                      onclick={() => pickWikilink(s.title)}
                    >
                      <span class="wl-title">{s.title}</span>
                      <span class="wl-doc">{s.docId}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
          {#if previewOn && draftBody.trim()}
            <div class="block-h">Preview</div>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <article
              class="doc rendered editor-preview"
              onclick={onRenderedClick}
              onkeydown={(e) => e.key === 'Enter' && onRenderedClick(e as unknown as MouseEvent)}
              role="document"
            >
              {@html renderMarkdown(draftBody, { resolveLink: resolveNoteLink })}
            </article>
          {/if}
          <div class="editor-actions">
            <button class="ask" onclick={saveNote} disabled={!ready || savingNote}>
              {savingNote ? 'Saving…' : editingDocId ? 'Save changes' : 'Save note'}
            </button>
            <button class="ghost" onclick={startNewNote} disabled={savingNote}>＋ New</button>
            <button
              class="ghost"
              onclick={() => (previewOn = !previewOn)}
              title="Toggle live Markdown preview">👁 {previewOn ? 'Hide' : 'Preview'}</button
            >
            {#if editMsg}<span class="editmsg">{editMsg}</span>{/if}
          </div>
          <p class="editor-hint">
            Saved as a portable <code>.md</code> in <code>notes/</code> — instantly searchable, citable,
            and exportable to any LLM via Export Vault / the Context Compiler.
          </p>
        </div>
      {/if}
    </section>

    <!-- Window-splitter: an intentionally interactive separator (pointer drag + arrow keys). -->
    <button
      class="divider"
      class:dragging
      onpointerdown={startDrag}
      onpointermove={onDrag}
      onpointerup={endDrag}
      onkeydown={dividerKey}
      aria-label="Resize panes (arrow keys)"
    ></button>

    <!-- RIGHT (60%) — the Reference zone: document viewer / vault / drop target -->
    <section
      class="pane viewer"
      class:drop={dropActive}
      aria-label="Document viewer and ingestion drop zone"
      ondragover={(e) => {
        e.preventDefault();
        dropActive = true;
      }}
      ondragleave={() => (dropActive = false)}
      ondrop={onDrop}
    >
      <div class="toolbar">
        <button class="addfiles newnote" onclick={startNewNote} disabled={!ready}>
          ✎ New note
        </button>
        <button class="addfiles newnote" onclick={openDailyNote} disabled={!ready}>
          📅 Today
        </button>
        <button class="addfiles" onclick={() => fileInput?.click()} disabled={!ready}>
          ＋ Add files
        </button>
        <span class="hint">Write a note · or drop PDF · CSV · TXT · MD anywhere here</span>
        {#if importMsg}<span class="importmsg">{importMsg}</span>{/if}
      </div>
      <input
        class="hidden-input"
        type="file"
        multiple
        accept=".pdf,.csv,.txt,.md,.markdown,.text"
        bind:this={fileInput}
        onchange={(e) => ingestFiles((e.currentTarget as HTMLInputElement).files)}
      />

      {#if activeNote}
        <div class="block-h">
          {activeNote.docId}{activeSpan ? ' · cited span highlighted' : ''}
          {#if activeNote.kind}<span class="badge">{activeNote.kind}</span>{/if}
          <span class="note-actions">
            {#if !activeNote.sourcePath}
              <button class="back edit" onclick={() => editNote(activeNote)}>✎ Edit</button>
              <button class="back" onclick={() => renameNoteAction(activeNote)}>✏️ Rename</button>
            {/if}
            <button class="back" onclick={() => moveNoteAction(activeNote)}>📂 Move</button>
            <button class="back danger" onclick={() => deleteNote(activeNote.docId)}
              >🗑 Delete</button
            >
            <button class="back" onclick={() => (activeDoc = null)}>✕ vault</button>
          </span>
        </div>
        {#if activeNote.sourcePath}
          <div class="source-link">
            📎 source: {activeNote.sourcePath} — original preserved, never edited
          </div>
        {/if}
        {#if activeSpan}
          {@const seg = buildHighlightSegments(
            activeNote.text,
            activeSpan.charStart,
            activeSpan.charEnd
          )}
          <article class="doc">{seg.pre}<mark>{seg.hit}</mark>{seg.post}</article>
        {:else}
          <!-- Rendered Markdown preview (FR-UI-002). Output is escape-first/safe (ADR-016);
               wikilink clicks/keys are delegated to vault navigation. -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <article
            class="doc rendered"
            onclick={onRenderedClick}
            onkeydown={(e) => e.key === 'Enter' && onRenderedClick(e as unknown as MouseEvent)}
            role="document"
          >
            {@html renderMarkdown(activeNote.text, { resolveLink: resolveNoteLink })}
          </article>
        {/if}

        {#if activeBacklinks.length || activeUnlinked.length}
          <div class="links-panel">
            {#if activeBacklinks.length}
              <div class="block-h">🔗 Backlinks — {activeBacklinks.length}</div>
              {#each activeBacklinks as bl (bl.docId)}
                <button class="src" onclick={() => showSource(bl.docId)}>
                  {bl.title}
                  <span class="score">{bl.count > 1 ? `×${bl.count}` : ''} {bl.docId}</span>
                </button>
              {/each}
            {/if}
            {#if activeUnlinked.length}
              <div class="block-h">💭 Unlinked mentions — {activeUnlinked.length}</div>
              {#each activeUnlinked as um (um.docId)}
                <button class="src" onclick={() => showSource(um.docId)}>
                  <span class="src-n">{um.title}</span>
                  <span class="um-snippet">{um.snippet}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      {:else if selectedEntity}
        <!-- Entity page (Phase 2 + 4): the entity's notes + a multi-hop graph over the PERSISTED graph -->
        <div class="doc-head">
          <div class="doc-title">
            🕸 {selectedEntity.name}
            <span class="badge">{selectedEntity.type}</span>
            <span class="score">{selectedEntity.noteCount} notes</span>
          </div>
          <button class="back" onclick={closeEntity}>✕ close</button>
        </div>
        {#if graphBusy}
          <div class="loading-banner"><span class="spinner"></span><span>traversing graph…</span></div>
        {/if}
        {#if entityGraph && entityGraph.edges.length}
          <div class="micromap">
            <div class="block-h">
              Connections · {entityGraph.nodes.length - 1} entities within 2 hops
            </div>
            {#each entityGraph.edges as e (e.from + e.to + e.label)}
              {@const fromN = entityGraph.nodes.find((n) => n.id === e.from)}
              {@const toN = entityGraph.nodes.find((n) => n.id === e.to)}
              <div class="rel-row">
                <button class="tagchip" onclick={() => openEntityById(e.from)}
                  >{fromN?.label ?? e.from}</button
                >
                <span class="rel-type">{e.label.replace(/_/g, ' ')}</span>
                <button class="tagchip" onclick={() => openEntityById(e.to)}
                  >{toN?.label ?? e.to}</button
                >
              </div>
            {/each}
          </div>
        {:else if !graphBusy}
          <div class="hint">No relations extracted for this entity yet.</div>
        {/if}
        {#if entityNotes.length}
          <div class="block-h">📄 Notes mentioning {selectedEntity.name} — {entityNotes.length}</div>
          {#each entityNotes as docId (docId)}
            <button class="src" onclick={() => showSource(docId)}>
              <span class="src-n">{docId}</span>
            </button>
          {/each}
        {/if}
      {:else}
        <!-- Entities pane (Phase 2): browse the knowledge graph like the Tag pane, but for the
             people/orgs/concepts the LLM extracted at ingest. Click one to open its entity page. -->
        <div class="block-h">
          🕸 Entities{#if entityIndex.length} — {entityIndex.length}{/if}
          <button class="back" onclick={buildVaultGraph} disabled={graphBusy}
            >{graphBusy ? 'extracting…' : entityIndex.length ? '↻ rebuild' : '✨ build graph'}</button
          >
        </div>
        {#if entityIndex.length}
          <div class="tagbar">
            {#each entityIndex.slice(0, 40) as e (e.id)}
              <button class="tagchip" onclick={() => openEntity(e)} title={e.type}
                >{e.name} <span class="tagcount">{e.noteCount}</span></button
              >
            {/each}
          </div>
        {:else}
          <div class="hint">
            No entity graph yet. Click “build graph” — it loads a chat model, reads your notes, and
            extracts the people/orgs/concepts + how they connect, so GraphRAG can use them.
          </div>
        {/if}

        {#if tagIndex.length}
          <div class="block-h">🏷 Tags</div>
          <div class="tagbar">
            {#each tagIndex as t (t.tag)}
              <button
                class="tagchip"
                class:active={activeTag === t.tag}
                onclick={() => toggleTag(t.tag)}
                >#{t.tag} <span class="tagcount">{t.count}</span></button
              >
            {/each}
          </div>
        {/if}

        {#if activeTag}
          <div class="block-h">
            Tagged #{activeTag} — {filteredNotes.length}
            <button class="back" onclick={() => (activeTag = null)}>✕ clear</button>
          </div>
          {#each filteredNotes as note (note.docId)}
            <button class="note" onclick={() => showSource(note.docId)}>
              <div class="note-title">
                {note.docId}
                {#if note.kind}<span class="badge">{note.kind}</span>{/if}
              </div>
              <div class="note-body">{note.text}</div>
            </button>
          {/each}
        {:else}
          <div class="block-h">📁 Vault — {vault.length} notes</div>
          {@render treeView(fileTree)}
        {/if}
      {/if}
    </section>
  </div>

  {#snippet treeView(nodes: TreeNode[])}
    {#each nodes as node (node.path)}
      {#if node.kind === 'folder'}
        <button class="tree-folder" onclick={() => toggleFolder(node.path)}>
          <span class="tree-caret">{collapsed.has(node.path) ? '▸' : '▾'}</span>📁 {node.name}
        </button>
        {#if !collapsed.has(node.path)}
          <div class="tree-children">{@render treeView(node.children)}</div>
        {/if}
      {:else}
        {@const kind = vault.find((n) => n.docId === node.docId)?.kind}
        <button class="tree-file" onclick={() => node.docId && showSource(node.docId)}>
          📄 {node.name}{#if kind}<span class="badge">{kind}</span>{/if}
        </button>
      {/if}
    {/each}
  {/snippet}

  {#if preview}
    <div class="popover" style="left: {preview.x}px; top: {preview.y}px">{preview.text}</div>
  {/if}

  {#if switcherOpen}
    <!-- Quick switcher (FR-NAV-001) -->
    <div
      class="switcher-overlay"
      role="button"
      tabindex="-1"
      aria-label="Close switcher"
      onclick={() => (switcherOpen = false)}
      onkeydown={(e) => e.key === 'Enter' && (switcherOpen = false)}
    >
      <div
        class="switcher"
        role="dialog"
        tabindex="-1"
        aria-label="Quick switcher"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          if (e.key === 'Enter' && switcherResults[0]) chooseSwitch(switcherResults[0].docId);
        }}
      >
        <input
          id="switcher-input"
          class="switcher-input"
          bind:value={switcherQuery}
          placeholder="Jump to a note…"
          autocomplete="off"
        />
        <ul class="switcher-list">
          {#each switcherResults as r (r.docId)}
            <li>
              <button class="switcher-item" onclick={() => chooseSwitch(r.docId)}>
                <span class="wl-title">{r.title}</span>
                <span class="wl-doc">{r.docId}</span>
              </button>
            </li>
          {:else}
            <li class="switcher-empty">No matching notes</li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}

  {#if compileOpen}
    <!-- Context Compiler (FR-CTX-*): compact, token-counted share to another LLM. -->
    <div
      class="switcher-overlay"
      role="button"
      tabindex="-1"
      aria-label="Close compiler"
      onclick={() => (compileOpen = false)}
      onkeydown={(e) => e.key === 'Escape' && (compileOpen = false)}
    >
      <div
        class="compiler"
        role="dialog"
        tabindex="-1"
        aria-label="Context Compiler"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (compileOpen = false)}
      >
        <div class="compiler-head">
          <strong>📦 Share to another LLM</strong>
          <span class="compiler-sub"
            >{compileFrom === 'answer' ? 'retrieved context' : 'scope'}: {compileSources.length} source(s){scope
              ? ` · ${scopeLabel(scope)}`
              : ''}</span
          >
          <button class="back" onclick={() => (compileOpen = false)}>✕</button>
        </div>
        <div class="compiler-controls">
          <label>
            Target model
            <select bind:value={compileModel}>
              {#each COMPILE_MODELS as m (m)}<option value={m}>{m}</option>{/each}
            </select>
          </label>
          <label class="redact">
            Redact (comma-separated)
            <input bind:value={compileRedact} placeholder="Acme, John Doe, 555-…" />
          </label>
        </div>
        {#if compileResult}
          <div class="compiler-meta">
            ~<strong>{compileResult.manifest.tokenCount}</strong> tokens · tokenizer
            {compileResult.manifest.tokenizer} ·
            <span class="consent"
              >⚠ {compileSources.length} source(s) will leave the device when you copy/paste</span
            >
          </div>
          <textarea class="compiler-xml" readonly rows="14" value={compileResult.xml}></textarea>
          <div class="compiler-actions">
            <button class="ask" onclick={copyCompiled}>⧉ Copy</button>
            <button class="ghost" onclick={downloadCompiled}>⤓ Download .xml</button>
          </div>
        {:else}
          <div class="compiler-meta">Nothing to compile.</div>
        {/if}
      </div>
    </div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, sans-serif;
    color: #1c1c22;
    background: #fafafb;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.55rem 1rem;
    border-bottom: 1px solid #e4e4ea;
    background: #fff;
  }
  .brand {
    font-weight: 700;
    color: #6750a4;
  }
  .tag {
    font-size: 0.75rem;
    color: #8a8a90;
  }
  .eject {
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
    background: #efeaf8;
    color: #6750a4;
    border: 1px solid #d9cef2;
    border-radius: 7px;
    padding: 0.2rem 0.55rem;
  }
  .bg-index {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.74rem;
    color: #6750a4;
    background: #efeaf8;
    border-radius: 6px;
    padding: 1px 8px;
  }
  .bg-index + .status {
    margin-left: 0.5rem;
  }
  .status {
    margin-left: auto;
    font-size: 0.8rem;
    color: #6a6a72;
  }
  .coi {
    font-size: 0.72rem;
    color: #b00020;
    border: 1px solid currentColor;
    border-radius: 6px;
    padding: 1px 6px;
  }
  .coi.ok {
    color: #1a7f37;
  }
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pane {
    overflow: auto;
    padding: 1rem 1.1rem;
  }
  .viewer {
    flex: 1;
    background: #fff;
  }
  .viewer.drop {
    outline: 2px dashed #6750a4;
    outline-offset: -8px;
    background: #faf8ff;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.7rem;
    flex-wrap: wrap;
  }
  .addfiles {
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    background: #6750a4;
    color: #fff;
    border: 0;
    border-radius: 7px;
    padding: 0.25rem 0.7rem;
  }
  .addfiles:disabled {
    opacity: 0.5;
  }
  .hint {
    font-size: 0.74rem;
    color: #9a9aa2;
  }
  .importmsg {
    font-size: 0.74rem;
    color: #1a7f37;
    margin-left: auto;
  }
  .hidden-input {
    display: none;
  }
  .source-link {
    font-size: 0.76rem;
    color: #6750a4;
    background: #f5f2fd;
    border: 1px solid #e7e0f8;
    border-radius: 7px;
    padding: 0.3rem 0.5rem;
    margin-bottom: 0.6rem;
  }
  .badge {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    background: #efeaf8;
    color: #6750a4;
    border-radius: 5px;
    padding: 0 5px;
    margin-left: 4px;
  }
  .divider {
    width: 6px;
    padding: 0;
    border: 0;
    cursor: col-resize;
    background: #e4e4ea;
    flex: 0 0 auto;
  }
  .divider.dragging,
  .divider:hover {
    background: #c9c2e6;
  }
  .divider:focus-visible {
    outline: 2px solid #6750a4;
  }
  .block-h {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9a9aa2;
    margin-bottom: 0.3rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .back {
    margin-left: auto;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
    border: 0;
    background: #f0f0f4;
    border-radius: 6px;
    padding: 0.1rem 0.4rem;
    color: #6a6a72;
  }
  .note {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 1px solid #e8e8ee;
    border-radius: 10px;
    padding: 0.6rem 0.7rem;
    margin-bottom: 0.6rem;
    background: #fff;
  }
  .note:hover {
    border-color: #6750a4;
  }
  .note-title {
    font-weight: 600;
    font-size: 0.82rem;
    color: #444;
  }
  .note-body {
    font-size: 0.82rem;
    color: #555;
    margin-top: 0.25rem;
    overflow: hidden;
    max-height: 3rem;
  }
  .doc {
    font-size: 0.9rem;
    line-height: 1.6;
    white-space: pre-wrap;
    color: #2a2a30;
  }
  mark {
    background: #fff3a3;
    border-radius: 3px;
    padding: 0 2px;
  }
  .doc.rendered {
    white-space: normal;
  }
  .doc.rendered :global(h1),
  .doc.rendered :global(h2),
  .doc.rendered :global(h3) {
    line-height: 1.25;
    margin: 0.8rem 0 0.4rem;
  }
  .doc.rendered :global(h1) {
    font-size: 1.4rem;
  }
  .doc.rendered :global(h2) {
    font-size: 1.2rem;
  }
  .doc.rendered :global(h3) {
    font-size: 1.05rem;
  }
  .doc.rendered :global(p) {
    margin: 0.5rem 0;
  }
  .doc.rendered :global(ul),
  .doc.rendered :global(ol) {
    margin: 0.4rem 0;
    padding-left: 1.4rem;
  }
  .doc.rendered :global(li) {
    margin: 0.15rem 0;
  }
  .doc.rendered :global(code) {
    background: #f2f2f6;
    border-radius: 4px;
    padding: 0 4px;
    font-size: 0.86em;
  }
  .doc.rendered :global(pre) {
    background: #1c1c22;
    color: #f3f3f6;
    border-radius: 8px;
    padding: 0.7rem 0.85rem;
    overflow: auto;
  }
  .doc.rendered :global(pre code) {
    background: none;
    color: inherit;
    padding: 0;
  }
  .doc.rendered :global(blockquote) {
    margin: 0.5rem 0;
    padding: 0.1rem 0.8rem;
    border-left: 3px solid #d9cef2;
    color: #5a5a62;
  }
  .doc.rendered :global(hr) {
    border: 0;
    border-top: 1px solid #e4e4ea;
    margin: 0.9rem 0;
  }
  .doc.rendered :global(table) {
    border-collapse: collapse;
    margin: 0.5rem 0;
    font-size: 0.85rem;
  }
  .doc.rendered :global(th),
  .doc.rendered :global(td) {
    border: 1px solid #e4e4ea;
    padding: 0.3rem 0.55rem;
    text-align: left;
  }
  .doc.rendered :global(th) {
    background: #f6f4fc;
  }
  .doc.rendered :global(a.wikilink) {
    color: #6750a4;
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .doc.rendered :global(a) {
    color: #6750a4;
  }
  .doc.rendered :global(.broken-link) {
    color: #b00020;
    text-decoration: underline dotted;
  }
  .doc.rendered :global(input[type='checkbox']) {
    margin-right: 0.3rem;
  }
  .editor-preview {
    border: 1px solid #ececf2;
    border-radius: 8px;
    padding: 0.4rem 0.7rem;
    background: #fcfcfe;
    max-height: 40vh;
    overflow: auto;
  }
  .controls {
    margin-bottom: 0.5rem;
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .scope-select {
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.3rem 0.4rem;
    font-size: 0.8rem;
    color: #6750a4;
    background: #fff;
    cursor: pointer;
    max-width: 100%;
  }
  .mode-toggle {
    display: inline-flex;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    overflow: hidden;
  }
  .mode-btn {
    font: inherit;
    font-size: 0.78rem;
    border: 0;
    background: #fff;
    color: #6a6a72;
    padding: 0.3rem 0.55rem;
    cursor: pointer;
  }
  .mode-btn.on {
    background: #efeaf8;
    color: #6750a4;
    font-weight: 600;
  }
  .mode-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .gpu-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.5rem;
    font-size: 0.74rem;
    color: #5a5a64;
  }
  .gpu-bar.warn {
    color: #8a5a00;
    background: #fff4e0;
    border-radius: 8px;
    padding: 0.35rem 0.55rem;
  }
  .gpu-bar .ok {
    color: #1a7f37;
  }
  .loading-model {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: #6750a4;
    font-weight: 600;
  }
  .loading-model small {
    color: #8a8a92;
    font-weight: 400;
  }
  .progress {
    flex: 1 1 8rem;
    min-width: 6rem;
    height: 6px;
    background: #e8e4f4;
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-fill {
    display: block;
    height: 100%;
    background: #6750a4;
    border-radius: 999px;
    transition: width 0.2s ease;
  }
  .mini {
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    border: 1px solid #d8d8e0;
    background: #fff;
    border-radius: 6px;
    padding: 0.12rem 0.5rem;
    color: #444;
  }
  .mini.accent {
    color: #6750a4;
    background: #efeaf8;
    border-color: #d9cffa;
    font-weight: 600;
  }
  .mini:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .ask-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .compile-ctx {
    margin-top: 0.7rem;
  }
  .compiler {
    width: min(720px, 94vw);
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 12px 48px #0004;
    padding: 0.9rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .compiler-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .compiler-sub {
    font-size: 0.76rem;
    color: #8a8a90;
  }
  .compiler-head .back {
    margin-left: auto;
  }
  .compiler-controls {
    display: flex;
    gap: 0.8rem;
    flex-wrap: wrap;
    font-size: 0.76rem;
    color: #6a6a72;
  }
  .compiler-controls label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .compiler-controls .redact {
    flex: 1;
    min-width: 180px;
  }
  .compiler-controls select,
  .compiler-controls input {
    border: 1px solid #d8d8e0;
    border-radius: 7px;
    padding: 0.3rem 0.45rem;
    font: inherit;
    font-size: 0.82rem;
  }
  .compiler-meta {
    font-size: 0.78rem;
    color: #5a5a62;
  }
  .consent {
    color: #9a5a00;
  }
  .compiler-xml {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #e4e4ea;
    border-radius: 8px;
    padding: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.76rem;
    line-height: 1.45;
    background: #fbfbfd;
    resize: vertical;
  }
  .compiler-actions {
    display: flex;
    gap: 0.5rem;
  }
  select,
  textarea,
  button {
    font: inherit;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.5rem;
    resize: vertical;
  }
  .ask {
    margin-top: 0.5rem;
    cursor: pointer;
    background: #6750a4;
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 0.5rem 1rem;
  }
  .ask:disabled {
    opacity: 0.5;
  }
  .spinner {
    display: inline-block;
    width: 0.8rem;
    height: 0.8rem;
    border: 2px solid #d9cef2;
    border-top-color: #6750a4;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: -1px;
    margin-right: 0.35rem;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .loading-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.8rem;
    padding: 0.6rem 0.7rem;
    background: #f5f2fd;
    border: 1px solid #e7e0f8;
    border-radius: 10px;
    font-size: 0.82rem;
    color: #5a4a86;
  }
  .loading-banner small {
    color: #8a7fb0;
  }
  .sources,
  .micromap,
  .answer {
    margin-top: 1rem;
  }
  .src {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 8px;
    padding: 0.35rem 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
  }
  .src:hover {
    border-color: #6750a4;
  }
  .src-n {
    color: #6750a4;
    font-weight: 600;
  }
  .score {
    float: right;
    color: #9a9aa2;
  }
  .graph {
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 10px;
  }
  .g-label {
    font-size: 9px;
    fill: #6a6a72;
  }
  .answer {
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 12px;
    padding: 0.8rem 0.9rem;
  }
  .answer p {
    margin: 0;
    line-height: 1.5;
  }
  .wikilink {
    cursor: pointer;
    border: 0;
    background: none;
    padding: 0;
    color: #6750a4;
    font: inherit;
    text-decoration: underline dotted;
  }
  .references {
    margin-top: 0.8rem;
    border-top: 1px solid #ececf2;
    padding-top: 0.55rem;
  }
  .reference {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: none;
    border: 0;
    border-radius: 6px;
    padding: 0.25rem 0.4rem;
  }
  .reference:hover {
    background: #efeaf8;
  }
  .ref-n {
    color: #6750a4;
    font-weight: 600;
    font-size: 0.8rem;
  }
  .reference.cited .ref-n::after {
    content: ' •';
    color: #1a7f37;
  }
  .ref-title {
    font-size: 0.82rem;
    color: #2a2a30;
    font-weight: 600;
  }
  .ref-doc {
    font-size: 0.72rem;
    color: #9a9aa2;
    margin-left: auto;
    white-space: nowrap;
  }
  .modes {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 0.7rem;
  }
  .modetab {
    cursor: pointer;
    font-size: 0.78rem;
    border: 1px solid #e0e0e8;
    background: #fff;
    color: #6a6a72;
    border-radius: 7px;
    padding: 0.25rem 0.7rem;
  }
  .modetab.active {
    background: #efeaf8;
    color: #6750a4;
    border-color: #d9cef2;
    font-weight: 600;
  }
  .modetab.primary {
    border-color: #d9cef2;
    color: #6750a4;
    font-weight: 600;
  }
  .modetab.primary.active {
    background: #6750a4;
    color: #fff;
    border-color: #6750a4;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .editor-top {
    display: flex;
    gap: 0.4rem;
  }
  .title-input {
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    font-size: 1rem;
    font-weight: 600;
  }
  .folder-input {
    width: 9rem;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    font-size: 0.82rem;
    color: #555;
  }
  .tpl-select {
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0 0.4rem;
    font-size: 0.78rem;
    color: #6750a4;
    background: #fff;
    cursor: pointer;
  }
  .body-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.6rem;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.86rem;
    line-height: 1.5;
  }
  .editor-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ghost {
    cursor: pointer;
    font-size: 0.8rem;
    background: #f0f0f4;
    color: #6a6a72;
    border: 0;
    border-radius: 8px;
    padding: 0.5rem 0.8rem;
  }
  .editmsg {
    font-size: 0.76rem;
    color: #1a7f37;
  }
  .editor-hint {
    margin: 0.2rem 0 0;
    font-size: 0.74rem;
    color: #9a9aa2;
    line-height: 1.4;
  }
  .editor-hint code {
    background: #f2f2f6;
    border-radius: 4px;
    padding: 0 4px;
  }
  .newnote {
    background: #efeaf8;
    color: #6750a4;
    border: 1px solid #d9cef2;
  }
  .note-actions {
    margin-left: auto;
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .note-actions .back {
    margin-left: 0;
  }
  .back.edit {
    color: #6750a4;
    background: #efeaf8;
  }
  .back.danger {
    color: #b3261e;
    background: #fce8e6;
  }
  .body-wrap {
    position: relative;
  }
  .wl-menu {
    position: absolute;
    left: 0.6rem;
    right: 0.6rem;
    top: 100%;
    margin: -0.3rem 0 0;
    padding: 0.2rem;
    list-style: none;
    background: #fff;
    border: 1px solid #d9cef2;
    border-radius: 8px;
    box-shadow: 0 6px 20px #0002;
    z-index: 8;
    max-height: 220px;
    overflow: auto;
  }
  .wl-item,
  .switcher-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 0;
    background: none;
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
  .wl-item:hover,
  .switcher-item:hover {
    background: #efeaf8;
  }
  .wl-title {
    font-size: 0.84rem;
    font-weight: 600;
    color: #2a2a30;
  }
  .wl-doc {
    font-size: 0.7rem;
    color: #9a9aa2;
  }
  .tagbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.9rem;
  }
  .tagchip {
    cursor: pointer;
    font-size: 0.74rem;
    background: #f3f1fa;
    color: #6750a4;
    border: 1px solid #e7e0f8;
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
  }
  .tagchip.active {
    background: #6750a4;
    color: #fff;
    border-color: #6750a4;
  }
  .tagcount {
    opacity: 0.6;
    font-size: 0.68rem;
  }
  .graph-badge {
    font-size: 0.68rem;
    color: #6750a4;
    margin-left: 0.3rem;
  }
  .rel-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.18rem 0;
  }
  .rel-type {
    font-size: 0.68rem;
    color: #79747e;
    font-style: italic;
  }
  .tree-folder,
  .tree-file {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 0;
    background: none;
    border-radius: 6px;
    padding: 0.22rem 0.4rem;
    font-size: 0.82rem;
    color: #2a2a30;
  }
  .tree-folder {
    font-weight: 600;
  }
  .tree-folder:hover,
  .tree-file:hover {
    background: #efeaf8;
  }
  .tree-caret {
    display: inline-block;
    width: 0.9rem;
    color: #9a9aa2;
  }
  .tree-children {
    margin-left: 0.8rem;
    border-left: 1px solid #ececf2;
    padding-left: 0.3rem;
  }
  .links-panel {
    margin-top: 1rem;
    border-top: 1px solid #ececf2;
    padding-top: 0.7rem;
  }
  .um-snippet {
    display: block;
    font-size: 0.74rem;
    color: #8a8a90;
    margin-top: 0.1rem;
  }
  .switcher-overlay {
    position: fixed;
    inset: 0;
    background: #0006;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 20;
  }
  .switcher {
    width: min(560px, 92vw);
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 12px 48px #0004;
    overflow: hidden;
  }
  .switcher-input {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    border-bottom: 1px solid #ececf2;
    padding: 0.8rem 1rem;
    font-size: 1rem;
    outline: none;
  }
  .switcher-list {
    list-style: none;
    margin: 0;
    padding: 0.3rem;
    max-height: 50vh;
    overflow: auto;
  }
  .switcher-empty {
    padding: 0.7rem 1rem;
    color: #9a9aa2;
    font-size: 0.84rem;
  }
  .popover {
    position: fixed;
    max-width: 280px;
    background: #1c1c22;
    color: #f3f3f6;
    font-size: 0.76rem;
    line-height: 1.4;
    padding: 0.4rem 0.55rem;
    border-radius: 8px;
    pointer-events: none;
    z-index: 10;
    box-shadow: 0 4px 16px #0003;
  }
</style>
