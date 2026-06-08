import { describe, it, expect } from 'vitest';
import {
  IDENTITY_VIEW,
  clampScale,
  zoomAt,
  panBy,
  applyOverrides,
  toGraphPoint,
  MIN_SCALE,
  MAX_SCALE
} from '../../src/lib/graph/graph-view';
import type { GraphLayout } from '../../src/lib/graph/graph-layout';

// Pure interactive-view math for the entity node-link graph (drag + pan/zoom). ALGORITHMS §19.

const layout: GraphLayout = {
  width: 200,
  height: 200,
  nodes: [
    { id: 'a', label: 'A', hop: 0, x: 100, y: 100, r: 26 },
    { id: 'b', label: 'B', hop: 1, x: 100, y: 40, r: 17 }
  ],
  edges: [{ from: 'a', to: 'b', label: 'rel', x1: 100, y1: 100, x2: 100, y2: 40, mx: 100, my: 70 }]
};

describe('clampScale', () => {
  it('clamps to [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('zoomAt', () => {
  it('keeps the anchor point fixed under the cursor', () => {
    const v = zoomAt(IDENTITY_VIEW, 2, 50, 50);
    // The graph point under (50,50) before and after must map to the same screen position.
    const before = { x: 50, y: 50 }; // identity view: screen == graph
    const screenAfter = { x: v.tx + v.scale * before.x, y: v.ty + v.scale * before.y };
    expect(screenAfter.x).toBeCloseTo(50, 6);
    expect(screenAfter.y).toBeCloseTo(50, 6);
    expect(v.scale).toBe(2);
  });

  it('does not exceed the scale bounds', () => {
    let v = IDENTITY_VIEW;
    for (let i = 0; i < 20; i++) v = zoomAt(v, 2, 0, 0);
    expect(v.scale).toBe(MAX_SCALE);
  });
});

describe('panBy', () => {
  it('shifts the translation, leaving scale alone', () => {
    expect(panBy({ tx: 5, ty: 5, scale: 2 }, 10, -3)).toEqual({ tx: 15, ty: 2, scale: 2 });
  });
});

describe('applyOverrides', () => {
  it('returns the same layout (identity) when there are no overrides', () => {
    expect(applyOverrides(layout, new Map())).toBe(layout);
  });

  it('moves a dragged node and drags its edges along', () => {
    const out = applyOverrides(layout, new Map([['b', { x: 10, y: 20 }]]));
    expect(out.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 10, y: 20 });
    expect(out.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 100, y: 100 }); // untouched
    const e = out.edges[0];
    expect([e.x2, e.y2]).toEqual([10, 20]); // edge endpoint follows node b
    expect([e.mx, e.my]).toEqual([55, 60]); // midpoint recomputed
  });

  it('is deterministic for a fixed override set', () => {
    const ov = new Map([['a', { x: 7, y: 8 }]]);
    expect(applyOverrides(layout, ov)).toEqual(applyOverrides(layout, ov));
  });
});

describe('toGraphPoint', () => {
  const rect = { left: 0, top: 0, width: 400, height: 400 }; // viewBox 200×200 shown at 400px → 2× zoom-to-fit
  it('inverts the viewBox fit under the identity view', () => {
    // A click at screen (200,200) — the centre of a 400px box — is graph (100,100).
    expect(toGraphPoint(200, 200, rect, 200, 200, IDENTITY_VIEW)).toEqual({ x: 100, y: 100 });
  });

  it('inverts pan + zoom too', () => {
    const view = { tx: 20, ty: 0, scale: 2 };
    // screen 200 → viewBox 100 → graph (100-20)/2 = 40.
    expect(toGraphPoint(200, 200, rect, 200, 200, view)).toMatchObject({ x: 40, y: 50 });
  });
});
