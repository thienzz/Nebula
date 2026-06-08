// Entity sub-graph builder (Phase 4) — the persistent cousin of the Micro-Map (micrograph.ts).
//
// The Micro-Map shows how the AI reached ONE answer (query → retrieved chunks, ephemeral). This
// builds the view over the PERSISTENT entity graph: a centre entity surrounded by the entities it
// connects to, labelled by relation type, expandable across multiple hops. It's the "how is X
// connected to Y" view and the entity-page neighbourhood. Pure builder — the multi-hop traversal
// that feeds it (real graph traversal over persisted edges) lives in db/store.ts.

export interface EntityGraphNode {
  id: string;
  kind: 'center' | 'entity';
  label: string;
  type?: string; // entity kind (person/org/…)
  hop?: number; // distance from centre (0 = centre)
}

export interface EntityGraphEdge {
  from: string;
  to: string;
  label: string; // relation type
}

export interface EntityGraph {
  nodes: EntityGraphNode[];
  edges: EntityGraphEdge[];
}

/** A neighbour returned by traversal: an entity plus how it connects and how far away it is. */
export interface GraphNeighbor {
  id: string;
  name: string;
  type: string;
  hop: number;
}

export interface EntityGraphRelation {
  sourceId: string;
  targetId: string;
  type: string;
}

export interface EntityGraphOptions {
  maxNodes?: number; // cap surrounding nodes (default 24) so dense hubs stay readable
}

/**
 * Assemble a renderable sub-graph from a centre entity, its traversed neighbours (each with a hop
 * distance), and the relation edges among all of them. Only edges whose BOTH endpoints are in the
 * node set are kept (no dangling lines). Neighbours are taken nearest-first up to `maxNodes`.
 * Deterministic: nodes sorted by hop then id, edges by (from,to,label).
 */
export function buildEntityGraph(
  center: { id: string; name: string; type: string },
  neighbors: GraphNeighbor[],
  relations: EntityGraphRelation[],
  opts: EntityGraphOptions = {}
): EntityGraph {
  const maxNodes = opts.maxNodes ?? 24;

  const kept = [...neighbors]
    .filter((n) => n.id !== center.id)
    .sort((a, b) => a.hop - b.hop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, maxNodes);

  const nodes: EntityGraphNode[] = [
    { id: center.id, kind: 'center', label: center.name, type: center.type, hop: 0 },
    ...kept.map((n) => ({
      id: n.id,
      kind: 'entity' as const,
      label: n.name,
      type: n.type,
      hop: n.hop
    }))
  ];

  const inGraph = new Set(nodes.map((n) => n.id));
  const edgeSeen = new Set<string>();
  const edges: EntityGraphEdge[] = [];
  for (const r of relations) {
    if (!inGraph.has(r.sourceId) || !inGraph.has(r.targetId)) continue;
    const key = `${r.sourceId}|${r.targetId}|${r.type}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ from: r.sourceId, to: r.targetId, label: r.type });
  }
  edges.sort(
    (a, b) =>
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)
  );

  return { nodes, edges };
}
