import { describe, it, expect } from 'vitest';
import { dedupeByDoc, referencesFromHits } from '../../src/lib/retrieval/search';

// FR-RET-001 / FR-CHAT-002. Multi-doc breadth + the References list at the foot of an answer.

describe('dedupeByDoc', () => {
  it('keeps the best (first) hit per document, preserving rank order', () => {
    const hits = [
      { docId: 'notes/a.md', chunkId: 'notes/a.md#0', score: 0.9 },
      { docId: 'notes/a.md', chunkId: 'notes/a.md#1', score: 0.85 }, // same doc → dropped
      { docId: 'notes/b.md', chunkId: 'notes/b.md#0', score: 0.8 },
      { docId: 'notes/c.md', chunkId: 'notes/c.md#0', score: 0.7 }
    ];
    expect(dedupeByDoc(hits).map((h) => h.docId)).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/c.md'
    ]);
  });

  it('caps the number of distinct docs', () => {
    const hits = [
      { docId: 'notes/a.md', chunkId: 'a#0' },
      { docId: 'notes/b.md', chunkId: 'b#0' },
      { docId: 'notes/c.md', chunkId: 'c#0' }
    ];
    expect(dedupeByDoc(hits, 2).map((h) => h.docId)).toEqual(['notes/a.md', 'notes/b.md']);
  });
});

describe('referencesFromHits', () => {
  it('numbers the distinct source docs 1..n, aligned with inline [#n]', () => {
    const refs = referencesFromHits([
      { docId: 'notes/a.md', chunkId: 'notes/a.md#0' },
      { docId: 'notes/a.md', chunkId: 'notes/a.md#1' },
      { docId: 'notes/b.md', chunkId: 'notes/b.md#0' }
    ]);
    expect(refs).toEqual([
      { n: 1, docId: 'notes/a.md', chunkId: 'notes/a.md#0' },
      { n: 2, docId: 'notes/b.md', chunkId: 'notes/b.md#0' }
    ]);
  });
});
