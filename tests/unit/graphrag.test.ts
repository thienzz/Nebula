import { describe, it, expect } from 'vitest';
import {
  entitiesOfChunks,
  expandByEntities,
  fuseGraphRag,
  selectGraphRagContext
} from '../../src/lib/retrieval/graphrag';
import type { MentionEdge } from '../../src/lib/graph/types';
import type { SearchHit } from '../../src/lib/inference/provider';

const hit = (chunkId: string, score: number): SearchHit => ({
  chunkId,
  docId: chunkId.split('#')[0],
  text: chunkId,
  charStart: 0,
  charEnd: 1,
  score
});

const mentions: MentionEdge[] = [
  { docId: 'd1', chunkId: 'd1#0', entityId: 'acme' },
  { docId: 'd1', chunkId: 'd1#0', entityId: 'john' },
  { docId: 'd2', chunkId: 'd2#0', entityId: 'john' },
  { docId: 'd2', chunkId: 'd2#0', entityId: 'projx' },
  { docId: 'd3', chunkId: 'd3#0', entityId: 'projx' }
];

describe('entitiesOfChunks', () => {
  it('returns the distinct entities mentioned by the given chunks', () => {
    expect(entitiesOfChunks(mentions, ['d1#0']).sort()).toEqual(['acme', 'john']);
    expect(entitiesOfChunks(mentions, ['d1#0', 'd2#0']).sort()).toEqual(['acme', 'john', 'projx']);
  });
});

describe('expandByEntities', () => {
  it('finds sibling chunks mentioning the entities, excludes seeds, ranks by shared count', () => {
    // Seeds = d1#0 (entities acme, john). Expand on those entities, excluding d1#0.
    const out = expandByEntities(mentions, ['acme', 'john'], ['d1#0']);
    expect(out).toEqual(['d2#0']); // d2#0 shares 'john'; d3#0 shares none of {acme,john}
  });

  it('orders by number of shared entities (most-connected first)', () => {
    const m: MentionEdge[] = [
      { docId: 'a', chunkId: 'a#0', entityId: 'x' },
      { docId: 'a', chunkId: 'a#0', entityId: 'y' }, // a#0 shares 2
      { docId: 'b', chunkId: 'b#0', entityId: 'x' } // b#0 shares 1
    ];
    expect(expandByEntities(m, ['x', 'y'], [])).toEqual(['a#0', 'b#0']);
  });
});

describe('fuseGraphRag', () => {
  it('degrades to plain vector order when there is no expansion', () => {
    const fused = fuseGraphRag([hit('a', 0.9), hit('b', 0.8)], [], { k: 2 });
    expect(fused.map((h) => h.chunkId)).toEqual(['a', 'b']);
  });

  it('lets a structurally-connected chunk outrank a seed on the graph signal', () => {
    // Seed 'a' (vector-strong) vs expanded 'e' (vector-weak but graph-reached). 'e' gains BOTH a
    // vector-rank and a graph-rank contribution, so it can beat the seed that only has vector rank.
    const fused = fuseGraphRag([hit('a', 0.9)], [hit('e', 0.2)], { k: 1 });
    expect(fused.map((h) => h.chunkId)).toEqual(['e']);
  });

  it('dedupes a chunk present in both seeds and expansion', () => {
    const fused = fuseGraphRag([hit('a', 0.9)], [hit('a', 0.5), hit('b', 0.2)], { k: 5 });
    const ids = fused.map((h) => h.chunkId);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids.filter((id) => id === 'a')).toHaveLength(1);
  });

  it('caps the fused result at k', () => {
    const seeds = [hit('a', 0.9), hit('b', 0.8)];
    const expanded = [hit('c', 0.3), hit('d', 0.2)];
    expect(fuseGraphRag(seeds, expanded, { k: 3 })).toHaveLength(3);
  });
});

describe('selectGraphRagContext (regression: relevance floor must gate seeds)', () => {
  it('keeps floored seeds + appends graph-expanded siblings, preserving cosine scores', () => {
    const seeds = [hit('s1', 0.68)]; // already passed the relevance floor upstream
    const expanded = [hit('e1', 0.21)]; // graph-reached, intentionally below the floor
    const ctx = selectGraphRagContext(seeds, expanded);
    expect(ctx.map((h) => h.chunkId)).toEqual(['s1', 'e1']);
    expect(ctx[0].score).toBe(0.68); // cosine preserved, NOT replaced by an RRF score (~0.02)
  });

  it('returns [] when no seed cleared the floor (no-results — never expand into noise)', () => {
    // This is the exact bug found in the browser: with no relevant seed, the answer must be empty,
    // not "all seeds fused" (which leaked an unrelated note like cats.md into the context).
    expect(selectGraphRagContext([], [hit('e1', 0.2)])).toEqual([]);
  });

  it('dedupes an expanded chunk that is already a seed', () => {
    const ctx = selectGraphRagContext([hit('s1', 0.7)], [hit('s1', 0.4), hit('e1', 0.3)]);
    expect(ctx.map((h) => h.chunkId)).toEqual(['s1', 'e1']);
  });
});
