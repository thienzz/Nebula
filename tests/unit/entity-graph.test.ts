import { describe, it, expect } from 'vitest';
import { buildEntityGraph, type GraphNeighbor } from '../../src/lib/graph/entity-graph';

const center = { id: 'acme', name: 'Acme', type: 'org' };
const neighbors: GraphNeighbor[] = [
  { id: 'john', name: 'John', type: 'person', hop: 1 },
  { id: 'projx', name: 'Project X', type: 'project', hop: 2 }
];
const relations = [
  { sourceId: 'acme', targetId: 'john', type: 'hired' },
  { sourceId: 'john', targetId: 'projx', type: 'leads' },
  { sourceId: 'projx', targetId: 'ghost', type: 'uses' } // ghost is NOT a node → dangling
];

describe('buildEntityGraph', () => {
  it('places the centre + neighbours as nodes with hop distances', () => {
    const g = buildEntityGraph(center, neighbors, relations);
    expect(g.nodes[0]).toEqual({ id: 'acme', kind: 'center', label: 'Acme', type: 'org', hop: 0 });
    expect(g.nodes.map((n) => n.id)).toEqual(['acme', 'john', 'projx']);
    expect(g.nodes.find((n) => n.id === 'projx')?.hop).toBe(2);
  });

  it('keeps only edges whose both endpoints are in the node set (no dangling lines)', () => {
    const g = buildEntityGraph(center, neighbors, relations);
    expect(g.edges).toEqual([
      { from: 'acme', to: 'john', label: 'hired' },
      { from: 'john', to: 'projx', label: 'leads' }
    ]);
  });

  it('drops the centre if it reappears in the neighbour list', () => {
    const g = buildEntityGraph(center, [{ id: 'acme', name: 'Acme', type: 'org', hop: 1 }], []);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].kind).toBe('center');
  });

  it('caps surrounding nodes at maxNodes, nearest hops first', () => {
    const many: GraphNeighbor[] = Array.from({ length: 30 }, (_, i) => ({
      id: `e${i}`,
      name: `E${i}`,
      type: 'concept',
      hop: i < 10 ? 1 : 2
    }));
    const g = buildEntityGraph(center, many, [], { maxNodes: 5 });
    expect(g.nodes).toHaveLength(6); // centre + 5
    expect(g.nodes.slice(1).every((n) => n.hop === 1)).toBe(true); // nearest first
  });
});
