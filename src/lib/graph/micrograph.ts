// Micro-Map — the session-scoped retrieval sub-graph (FR-GRAPH-001) · OBSIDIAN-DNA §5.3.
//
// Obsidian's global Graph View can choke on 10k nodes; Nebula instead visualizes *how the
// AI reached this answer*. For each question it builds a tiny graph: the central node is the
// user query, connected to the top 3–5 chunks the vector search retrieved, with edge width
// scaled by cosine similarity (thicker = more relevant). The persisted form is a SurrealDB
// `RELATE query->retrieved_from->chunk` edge set (FR-GRAPH-002, see db/store.ts); this module
// is the pure builder the UI renders.
//
// Pure & deterministic (ALGORITHMS §10): input SearchHit[] → graph, no GPU/DB.

import type { SearchHit } from '$lib/inference/provider';

export interface GraphNode {
  id: string; // 'query' for the centre, else the chunkId
  kind: 'query' | 'chunk';
  label: string; // query text (truncated) for the centre; docId (+page) for chunks
  docId?: string;
  page?: number;
  score?: number; // cosine similarity for chunk nodes
  viaGraph?: boolean; // reached through the entity graph (shared entities), not vector similarity
  sharedEntities?: string[]; // the seed entities this chunk shares (set only when viaGraph)
}

export interface GraphEdge {
  from: 'query';
  to: string; // chunkId
  weight: number; // proximity (0..1): cosine for seeds, normalised shared-entity count for graph nodes
  width: number; // stroke width for the UI, scaled from weight
  viaGraph?: boolean; // weight reflects graph proximity (shared entities), not cosine
}

export interface MicroGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MicroGraphOptions {
  topN?: number; // chunk nodes to show, clamped to 3..5 (default 5)
  minWidth?: number; // stroke for similarity 0 (default 1)
  maxWidth?: number; // stroke for similarity 1 (default 6)
  labelMax?: number; // truncate the query label (default 48)
  /** Per-chunk graph-proximity info (chunkId → shared entities). When a hit appears here it's a
   *  graph-expanded node: it's labelled with its shared entities and its edge is weighted by
   *  shared-entity count (graph proximity), not cosine — exactly the signal cosine misses. */
  graphInfo?: Map<string, { sharedCount: number; sharedEntities: string[] }>;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;

function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd() + '…';
}

/**
 * Build the retrieval sub-graph for one question (FR-GRAPH-001): a central query node plus
 * the top-N retrieved chunks, each joined by an edge whose `width` grows with cosine
 * similarity. `hits` are assumed in descending score (as retrieval returns them).
 */
export function buildMicroGraph(
  query: string,
  hits: SearchHit[],
  opts: MicroGraphOptions = {}
): MicroGraph {
  const topN = clamp(Math.floor(opts.topN ?? 5), 3, 5);
  const minWidth = opts.minWidth ?? 1;
  const maxWidth = opts.maxWidth ?? 6;
  const labelMax = opts.labelMax ?? 48;

  const top = hits.slice(0, topN);
  const graphInfo = opts.graphInfo;
  // Graph-expanded nodes earn their place STRUCTURALLY (shared entities), so weight their edge by
  // graph proximity (shared-entity count, normalised) — NOT cosine, which is low for exactly these.
  // Seed nodes keep cosine. With no graphInfo this is a no-op: everything weights by cosine as before.
  const maxShared = Math.max(1, ...top.map((h) => graphInfo?.get(h.chunkId)?.sharedCount ?? 0));

  const nodes: GraphNode[] = [{ id: 'query', kind: 'query', label: truncate(query, labelMax) }];
  const edges: GraphEdge[] = [];

  for (const hit of top) {
    const gi = graphInfo?.get(hit.chunkId);
    const weight = gi ? clamp(gi.sharedCount / maxShared, 0, 1) : clamp(hit.score, 0, 1);
    nodes.push({
      id: hit.chunkId,
      kind: 'chunk',
      label: hit.page === undefined ? hit.docId : `${hit.docId} · p.${hit.page}`,
      docId: hit.docId,
      page: hit.page,
      score: round2(hit.score),
      ...(gi ? { viaGraph: true, sharedEntities: gi.sharedEntities } : {})
    });
    edges.push({
      from: 'query',
      to: hit.chunkId,
      weight: round2(weight),
      width: round2(minWidth + weight * (maxWidth - minWidth)),
      ...(gi ? { viaGraph: true } : {})
    });
  }

  return { nodes, edges };
}
