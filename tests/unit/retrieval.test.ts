import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  rrfFuse,
  vectorSearch,
  type IndexedChunk
} from '../../src/lib/retrieval/search';

// FR-RET-001 · ALGORITHMS §3 — pure ranking/fusion primitives.

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0, 0], [2, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
  });
  it('returns 0 against a zero vector (no NaN)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('rrfFuse — Σ 1/(k+rank)', () => {
  it('rewards items ranked high across lists', () => {
    const fused = rrfFuse(
      [
        ['a', 'b', 'c'],
        ['c', 'a']
      ],
      60
    );
    // a: 1/61 + 1/62 ; c: 1/63 + 1/61 ; c appears rank1 in list2 -> should beat b.
    expect(fused.get('c')!).toBeGreaterThan(fused.get('b')!);
  });
});

describe('vectorSearch — no-results relevance floor (FR-CHAT-002)', () => {
  const index: IndexedChunk[] = [
    { chunkId: 'x', docId: 'd', text: 't', charStart: 0, charEnd: 1, embedding: [0, 1] }
  ];
  it('returns [] when the best score is below the floor', () => {
    expect(vectorSearch([1, 0], index, { floor: 0.5 })).toEqual([]); // orthogonal -> 0 < 0.5
  });
  it('returns the hit when above the floor', () => {
    expect(vectorSearch([0, 1], index, { floor: 0.5 }).length).toBe(1);
  });
});
