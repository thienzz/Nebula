import { describe, it, expect } from 'vitest';
import {
  buildAutoTagPrompt,
  parseAutoTagResponse,
  applyAutoFrontmatter,
  markTaggableLater,
  autoTag,
  firstTokens,
  AUTOTAG_INSTRUCTION
} from '../../src/lib/ingest/autotag';
import type { ParsedNote } from '../../src/lib/vault/note';

// FR-ING-006 · OBSIDIAN-DNA §5.4. Lazy YAML auto-tagging via the injected generator seam.

describe('firstTokens / buildAutoTagPrompt', () => {
  it('skims only the first ~N tokens', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ');
    expect(firstTokens(text, 1000).split(' ')).toHaveLength(1000);
    const prompt = buildAutoTagPrompt(text, { skimTokens: 5 });
    expect(prompt).toContain(AUTOTAG_INSTRUCTION);
    expect(prompt).toContain('# Document excerpt\nw0 w1 w2 w3 w4');
    expect(prompt).not.toContain('w5');
  });
});

describe('parseAutoTagResponse', () => {
  it('parses a clean JSON object', () => {
    const meta = parseAutoTagResponse(
      '{"title":"Q3 Report","type":"Report","tags":["Finance","Q3"],"summary":"Revenue up. New market."}'
    );
    expect(meta).toEqual({
      title: 'Q3 Report',
      type: 'report', // lowercased single word
      tags: ['finance', 'q3'], // lowercased
      summary: 'Revenue up. New market.'
    });
  });

  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Sure! Here you go:\n```json\n{"title":"X","tags":["a"]}\n```\nHope that helps.';
    expect(parseAutoTagResponse(raw)).toEqual({ title: 'X', tags: ['a'] });
  });

  it('clamps tags, dedupes, strips #, and limits summary to 3 sentences', () => {
    const meta = parseAutoTagResponse(
      JSON.stringify({
        tags: ['#A', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
        summary: 'One. Two. Three. Four. Five.'
      })
    );
    expect(meta!.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f']); // ≤6, deduped, no #
    expect(meta!.summary).toBe('One. Two. Three.');
  });

  it('returns null when there is no JSON object', () => {
    expect(parseAutoTagResponse('I could not tag this document.')).toBeNull();
  });
});

describe('applyAutoFrontmatter — user override (FR-ING-006)', () => {
  it('prepends generated keys but never clobbers user edits', () => {
    const note: ParsedNote = { frontmatter: { tags: ['mine'], title: 'My Title' }, body: 'B' };
    const merged = applyAutoFrontmatter(
      note,
      { title: 'Auto Title', type: 'note', tags: ['auto'], summary: 'S' },
      { now: '2026-06-05' }
    );
    expect(merged.frontmatter.title).toBe('My Title'); // user wins
    expect(merged.frontmatter.tags).toEqual(['mine']); // user wins
    expect(merged.frontmatter.type).toBe('note'); // filled (was absent)
    expect(merged.frontmatter.summary).toBe('S');
    expect(merged.frontmatter.date_ingested).toBe('2026-06-05');
    expect(note.frontmatter.type).toBeUndefined(); // input not mutated
  });

  it('overwrite:true replaces existing keys', () => {
    const note = { frontmatter: { type: 'old' }, body: 'B' };
    const merged = applyAutoFrontmatter(
      note,
      { type: 'new', tags: [] },
      {
        now: '2026-06-05',
        overwrite: true
      }
    );
    expect(merged.frontmatter.type).toBe('new');
  });
});

describe('autoTag — graceful degradation', () => {
  it('ok path: generator → parsed meta', async () => {
    const gen = async () => '{"title":"T","type":"note","tags":["x"],"summary":"S."}';
    const res = await autoTag('doc text', gen);
    expect(res).toEqual({
      ok: true,
      meta: { title: 'T', type: 'note', tags: ['x'], summary: 'S.' }
    });
  });

  it('no model → no_model (caller flags taggable_later)', async () => {
    const res = await autoTag('doc', null);
    expect(res).toEqual({ ok: false, reason: 'no_model' });
    const flagged = markTaggableLater({ frontmatter: {}, body: 'B' }, true);
    expect(flagged.frontmatter.taggable_later).toBe(true);
  });

  it('unparseable model output → unparseable, never throws', async () => {
    const res = await autoTag('doc', async () => 'no json here');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unparseable');
  });

  it('generator error is captured, not thrown', async () => {
    const res = await autoTag('doc', async () => {
      throw new Error('GPU OOM');
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
      expect(res.detail).toContain('GPU OOM');
    }
  });
});
