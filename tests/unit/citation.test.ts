import { describe, it, expect } from 'vitest';
import {
  resolveCitationTarget,
  resolveCitations,
  buildHighlightSegments,
  answerUsage
} from '../../src/lib/chat/citation';
import type { SearchHit } from '../../src/lib/inference/provider';

// FR-CHAT-003 · OBSIDIAN-DNA §5.5. Citation → source location + highlight (Magic Jump).

const hits: SearchHit[] = [
  {
    chunkId: 'a#0',
    docId: 'sources/contract.pdf',
    text: '...',
    page: 4,
    charStart: 100,
    charEnd: 160,
    score: 0.9
  },
  { chunkId: 'b#1', docId: 'notes/security.md', text: '...', charStart: 0, charEnd: 42, score: 0.7 }
];

describe('resolveCitationTarget', () => {
  it('maps a chunkId to its document, page, and span', () => {
    expect(resolveCitationTarget('a#0', hits)).toEqual({
      chunkId: 'a#0',
      docId: 'sources/contract.pdf',
      page: 4,
      charStart: 100,
      charEnd: 160
    });
  });

  it('markdown chunk has no page', () => {
    expect(resolveCitationTarget('b#1', hits)!.page).toBeUndefined();
  });

  it('returns null for an unknown chunkId (no dangling jump)', () => {
    expect(resolveCitationTarget('zzz', hits)).toBeNull();
  });
});

describe('resolveCitations', () => {
  it('dedupes by chunkId, preserves order, drops unknowns', () => {
    const targets = resolveCitations(['b#1', 'a#0', 'b#1', 'ghost'], hits);
    expect(targets.map((t) => t.chunkId)).toEqual(['b#1', 'a#0']);
  });
});

describe('buildHighlightSegments', () => {
  it('splits the document into pre / hit / post around the span', () => {
    const doc = 'Nebula keeps all vault data on the local device, always.';
    const seg = buildHighlightSegments(doc, 18, 27); // "vault dat"
    expect(seg.pre + seg.hit + seg.post).toBe(doc); // lossless
    expect(seg.hit).toBe(doc.slice(18, 27));
  });

  it('clamps out-of-range offsets instead of throwing', () => {
    const doc = 'short';
    expect(buildHighlightSegments(doc, -5, 999)).toEqual({ pre: '', hit: 'short', post: '' });
    expect(buildHighlightSegments(doc, 3, 2)).toEqual({ pre: 'sho', hit: '', post: 'rt' }); // empty hit
  });
});

describe('answerUsage', () => {
  it('reports which retrieved hits the answer actually cited (LLM provenance), ignoring unknowns', () => {
    const u = answerUsage(['a#0', 'b#1', 'c#2'], ['b#1', 'b#1', 'ghost']);
    expect(u.count).toBe(1); // only b#1 is both retrieved AND cited (deduped; ghost wasn't retrieved)
    expect(u.used.has('b#1')).toBe(true);
    expect(u.used.has('a#0')).toBe(false);
  });

  it('count is 0 when the answer cited nothing retrieved (e.g. no citations)', () => {
    expect(answerUsage(['a#0', 'b#1'], []).count).toBe(0);
  });
});
