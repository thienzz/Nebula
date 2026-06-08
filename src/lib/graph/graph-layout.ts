// Deterministic 2-D layout for the entity sub-graph (Phase 4 visual) — the node-link "graph view"
// the Micro-Map's text rows never were. buildEntityGraph (entity-graph.ts) gives nodes carrying a
// `hop` distance from the centre and the relation edges among them; this places them as concentric
// rings (centre at hop 0, neighbours fanned out by hop) and resolves each edge to pixel endpoints
// so the page can draw plain SVG. Pure + deterministic (no physics sim, no Math.random) so the same
// graph always renders identically and the placement is unit-testable.

import type { EntityGraph, EntityGraphNode } from './entity-graph';

export interface LaidOutNode {
  id: string;
  label: string;
  type?: string;
  hop: number;
  x: number;
  y: number;
  r: number; // node radius
}

export interface LaidOutEdge {
  from: string;
  to: string;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number; // edge-label anchor (midpoint)
  my: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
}

const CENTER_R = 26;
const NODE_R = 17;

/**
 * Lay a centre-anchored entity graph onto a fixed coordinate space (the page scales it via the SVG
 * viewBox). Nodes are grouped by hop and spread evenly around concentric rings — hop 0 at the
 * centre, hop 1 on an inner ring, hop 2+ on an outer ring — starting each ring at the top (−90°)
 * and proceeding in the node order buildEntityGraph already sorted (hop then id), so layout is
 * stable. Edges resolve to the pixel centres of their endpoints (dangling edges are dropped).
 */
export function layoutEntityGraph(graph: EntityGraph, opts: LayoutOptions = {}): GraphLayout {
  const width = opts.width ?? 720;
  const height = opts.height ?? 460;
  const cx = width / 2;
  const cy = height / 2;
  const span = Math.min(width, height);

  const byHop = new Map<number, EntityGraphNode[]>();
  for (const n of graph.nodes) {
    const hop = n.hop ?? (n.kind === 'center' ? 0 : 1);
    if (!byHop.has(hop)) byHop.set(hop, []);
    byHop.get(hop)!.push(n);
  }

  // Ring radius per hop. Hop 0 sits at the centre; deeper hops fan outward but stay on-canvas.
  const ringFor = (hop: number): number => {
    if (hop <= 0) return 0;
    if (hop === 1) return span * 0.27;
    return span * 0.43; // hop 2 and anything beyond share the outer ring
  };

  const pos = new Map<string, LaidOutNode>();
  for (const [hop, nodes] of byHop) {
    const ring = ringFor(hop);
    const count = nodes.length;
    nodes.forEach((n, i) => {
      // Single node on a ring → place it straight up for a tidy, stable look.
      const angle = -Math.PI / 2 + (count > 0 ? (i / count) * Math.PI * 2 : 0);
      const x = hop <= 0 ? cx : cx + ring * Math.cos(angle);
      const y = hop <= 0 ? cy : cy + ring * Math.sin(angle);
      pos.set(n.id, {
        id: n.id,
        label: n.label,
        type: n.type,
        hop,
        x,
        y,
        r: n.kind === 'center' ? CENTER_R : NODE_R
      });
    });
  }

  const edges: LaidOutEdge[] = [];
  for (const e of graph.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    edges.push({
      from: e.from,
      to: e.to,
      label: e.label,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2
    });
  }

  return { nodes: [...pos.values()], edges, width, height };
}

// A small, fixed palette keyed by entity type so the same kind is always the same colour. Unknown
// types hash into the palette deterministically (stable across sessions, no per-render churn).
const PALETTE = [
  '#6750a4', // person — the brand violet (also the centre default)
  '#1a7f37', // org
  '#b8860b', // concept
  '#0b6bcb', // place
  '#b00020', // event
  '#8a3ffc', // product
  '#00748a' // other
];

const TYPE_INDEX: Record<string, number> = {
  person: 0,
  people: 0,
  org: 1,
  organization: 1,
  company: 1,
  concept: 2,
  topic: 2,
  place: 3,
  location: 3,
  event: 4,
  product: 5,
  project: 5
};

/** Stable colour for an entity type (case-insensitive; unknown types hash into the palette). */
export function entityColor(type?: string): string {
  const key = (type ?? '').toLowerCase().trim();
  if (key in TYPE_INDEX) return PALETTE[TYPE_INDEX[key]];
  if (!key) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
