// Interactive view math for the entity node-link graph (Phase 4 visual) — the pure half of
// "drag nodes + pan/zoom". layoutEntityGraph (graph-layout.ts) gives a deterministic STARTING
// placement; this module applies (a) per-node position overrides from dragging and (b) a pan/zoom
// transform, both as pure functions so the interactive view stays unit-testable (no DOM, no GPU) and
// — for a fixed set of drags — deterministic. The component owns the pointer events; the geometry
// lives here. ALGORITHMS §19.

import type { GraphLayout } from './graph-layout';

/** Pan offset (tx,ty) + zoom (scale) applied to the graph's coordinate space via an SVG transform. */
export interface ViewTransform {
  tx: number;
  ty: number;
  scale: number;
}

export const IDENTITY_VIEW: ViewTransform = { tx: 0, ty: 0, scale: 1 };

export const MIN_SCALE = 0.35;
export const MAX_SCALE = 4;

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Zoom by `factor` about the point (px,py) — in the graph's own coordinate space — so that point
 * stays fixed under the cursor (the natural "zoom toward the mouse" feel). Pure. The scale is clamped
 * to [MIN_SCALE, MAX_SCALE]; if it clamps, the translation is recomputed for the realised scale so
 * the anchor still holds.
 */
export function zoomAt(view: ViewTransform, factor: number, px: number, py: number): ViewTransform {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale; // realised zoom ratio (0 if clamped to the same value → identity)
  // Keep (px,py) fixed: screen = t + scale*p must be unchanged ⇒ newT = p - k*(p - oldT).
  return {
    scale,
    tx: px - k * (px - view.tx),
    ty: py - k * (py - view.ty)
  };
}

/** Translate the view by a delta already expressed in graph-space units. Pure. */
export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, tx: view.tx + dx, ty: view.ty + dy };
}

export interface NodePos {
  x: number;
  y: number;
}

/**
 * Apply per-node position overrides (from dragging) to a base layout and recompute every edge's
 * endpoints + label midpoint so lines follow their nodes. Pure and allocation-stable: with no
 * overrides it returns the input layout unchanged (identity), so an undragged graph is byte-identical
 * to layoutEntityGraph's output.
 */
export function applyOverrides(
  layout: GraphLayout,
  overrides: ReadonlyMap<string, NodePos>
): GraphLayout {
  if (overrides.size === 0) return layout;
  const nodes = layout.nodes.map((n) => {
    const o = overrides.get(n.id);
    return o ? { ...n, x: o.x, y: o.y } : n;
  });
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const edges = layout.edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return e;
    return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  });
  return { ...layout, nodes, edges };
}

/**
 * Map a pointer position from on-screen pixels into the graph's coordinate space, inverting both the
 * SVG's viewBox fit (rect → viewBox) and the current pan/zoom. `rect` is the SVG element's bounding
 * box; `vbW`/`vbH` its viewBox size. Pure — the component supplies the measured rect.
 */
export function toGraphPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  vbW: number,
  vbH: number,
  view: ViewTransform
): NodePos {
  // 1. screen px → viewBox units (the SVG scales its viewBox to fill the rect, preserving via fit).
  const vbX = rect.width === 0 ? 0 : ((clientX - rect.left) / rect.width) * vbW;
  const vbY = rect.height === 0 ? 0 : ((clientY - rect.top) / rect.height) * vbH;
  // 2. viewBox units → graph space (undo the pan/zoom <g> transform): p = (vb - t) / scale.
  return { x: (vbX - view.tx) / view.scale, y: (vbY - view.ty) / view.scale };
}

/** Pixel→viewBox scale factor on the X axis — used to convert a drag delta into viewBox units. */
export function pxToViewBoxScale(rectWidth: number, vbW: number): number {
  return rectWidth === 0 ? 1 : vbW / rectWidth;
}
