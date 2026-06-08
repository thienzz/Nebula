import { describe, it, expect } from 'vitest';
import { buildMicroGraph } from '../../src/lib/graph/micrograph';
import type { SearchHit } from '../../src/lib/inference/provider';

// FR-GRAPH-001 · OBSIDIAN-DNA §5.3. Pure retrieval sub-graph builder.

const hit = (chunkId: string, docId: string, score: number, page?: number): SearchHit => ({
  chunkId,
  docId,
  text: 't',
  page,
  charStart: 0,
  charEnd: 1,
  score
});

const hits: SearchHit[] = [
  hit('a#0', 'notes/a.md', 0.9, 2),
  hit('b#0', 'notes/b.md', 0.5),
  hit('c#0', 'notes/c.md', 0.1)
];

describe('buildMicroGraph', () => {
  it('centres on the query and connects the retrieved chunks', () => {
    const g = buildMicroGraph('Why is it private?', hits);
    expect(g.nodes[0]).toEqual({ id: 'query', kind: 'query', label: 'Why is it private?' });
    expect(g.nodes.filter((n) => n.kind === 'chunk').map((n) => n.id)).toEqual([
      'a#0',
      'b#0',
      'c#0'
    ]);
    expect(g.edges.map((e) => e.to)).toEqual(['a#0', 'b#0', 'c#0']);
    expect(g.edges.every((e) => e.from === 'query')).toBe(true);
  });

  it('scales edge width with cosine similarity (thicker = more relevant)', () => {
    const g = buildMicroGraph('q', hits);
    const [e1, e2, e3] = g.edges;
    expect(e1.weight).toBe(0.9);
    expect(e1.width).toBeGreaterThan(e2.width);
    expect(e2.width).toBeGreaterThan(e3.width);
    // default scale: width = 1 + score*(6-1)
    expect(e1.width).toBe(5.5);
  });

  it('labels a PDF chunk node with its page', () => {
    const g = buildMicroGraph('q', hits);
    const a = g.nodes.find((n) => n.id === 'a#0')!;
    expect(a.label).toBe('notes/a.md · p.2');
    expect(g.nodes.find((n) => n.id === 'b#0')!.label).toBe('notes/b.md');
  });

  it('clamps topN to 3..5 and truncates a long query label', () => {
    const many = Array.from({ length: 8 }, (_, i) => hit(`k${i}`, `d${i}`, 1 - i * 0.1));
    expect(buildMicroGraph('q', many, { topN: 10 }).edges).toHaveLength(5);
    expect(buildMicroGraph('q', many, { topN: 1 }).edges).toHaveLength(3);
    const label = buildMicroGraph('w'.repeat(100), hits, { labelMax: 10 }).nodes[0].label;
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(11);
  });

  it('weights graph-expanded edges by shared-entity count (not cosine) and labels them', () => {
    // c#0 has the LOWEST cosine (0.1) but is the most graph-connected (2 shared entities) — it must
    // get the THICKEST edge, the opposite of what cosine alone would draw. a#0 stays a cosine seed.
    const graphInfo = new Map([
      ['c#0', { sharedCount: 2, sharedEntities: ['Atlas Migration', 'Priya Nair'] }],
      ['b#0', { sharedCount: 1, sharedEntities: ['Priya Nair'] }]
    ]);
    const g = buildMicroGraph('q', hits, { graphInfo });
    const ea = g.edges.find((e) => e.to === 'a#0')!; // seed: no graphInfo → cosine
    const eb = g.edges.find((e) => e.to === 'b#0')!;
    const ec = g.edges.find((e) => e.to === 'c#0')!;
    expect(ea.viaGraph).toBeUndefined(); // seed weighted by cosine, not marked
    expect(ec.viaGraph).toBe(true);
    expect(ec.weight).toBe(1); // 2/2 shared = max → full-strength edge despite cosine 0.1
    expect(eb.weight).toBe(0.5); // 1/2 shared
    expect(ec.width).toBeGreaterThan(eb.width); // more shared entities → thicker
    const nc = g.nodes.find((n) => n.id === 'c#0')!;
    expect(nc.viaGraph).toBe(true);
    expect(nc.sharedEntities).toEqual(['Atlas Migration', 'Priya Nair']);
    expect(nc.score).toBe(0.1); // cosine still recorded for reference
  });
});
