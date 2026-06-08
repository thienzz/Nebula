import { describe, it, expect } from 'vitest';
import { layoutEntityGraph, entityColor } from '../../src/lib/graph/graph-layout';
import { buildEntityGraph, type GraphNeighbor } from '../../src/lib/graph/entity-graph';

const center = { id: 'acme', name: 'Acme', type: 'org' };
const neighbors: GraphNeighbor[] = [
  { id: 'john', name: 'John', type: 'person', hop: 1 },
  { id: 'mary', name: 'Mary', type: 'person', hop: 1 },
  { id: 'projx', name: 'Project X', type: 'project', hop: 2 }
];
const relations = [
  { sourceId: 'acme', targetId: 'john', type: 'hired' },
  { sourceId: 'john', targetId: 'projx', type: 'leads' }
];

describe('layoutEntityGraph', () => {
  const graph = buildEntityGraph(center, neighbors, relations);

  it('puts the centre node at the canvas centre with the larger radius', () => {
    const lay = layoutEntityGraph(graph, { width: 720, height: 460 });
    const c = lay.nodes.find((n) => n.id === 'acme')!;
    expect(c.x).toBe(360);
    expect(c.y).toBe(230);
    expect(c.r).toBeGreaterThan(lay.nodes.find((n) => n.id === 'john')!.r);
  });

  it('places deeper hops on a wider ring than nearer hops', () => {
    const lay = layoutEntityGraph(graph);
    const cx = lay.width / 2;
    const cy = lay.height / 2;
    const dist = (id: string) => {
      const n = lay.nodes.find((x) => x.id === id)!;
      return Math.hypot(n.x - cx, n.y - cy);
    };
    expect(dist('projx')).toBeGreaterThan(dist('john')); // hop 2 outside hop 1
    expect(dist('acme')).toBeCloseTo(0);
  });

  it('resolves edges to endpoint coordinates and drops danglers', () => {
    const lay = layoutEntityGraph(graph);
    expect(lay.edges).toHaveLength(2);
    const e = lay.edges.find((x) => x.from === 'acme' && x.to === 'john')!;
    const a = lay.nodes.find((n) => n.id === 'acme')!;
    const b = lay.nodes.find((n) => n.id === 'john')!;
    expect([e.x1, e.y1, e.x2, e.y2]).toEqual([a.x, a.y, b.x, b.y]);
    expect(e.mx).toBeCloseTo((a.x + b.x) / 2);
  });

  it('is deterministic — same graph lays out identically', () => {
    expect(layoutEntityGraph(graph)).toEqual(layoutEntityGraph(graph));
  });
});

describe('entityColor', () => {
  it('is stable per type and case-insensitive', () => {
    expect(entityColor('person')).toBe(entityColor('Person'));
    expect(entityColor('org')).not.toBe(entityColor('person'));
  });
  it('hashes unknown types deterministically into the palette', () => {
    expect(entityColor('xyzzy')).toBe(entityColor('xyzzy'));
    expect(typeof entityColor(undefined)).toBe('string');
  });
});
