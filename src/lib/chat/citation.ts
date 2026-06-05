// Magic Jump — citation → source-location resolution + highlight spans (FR-CHAT-003)
// · OBSIDIAN-DNA §5.5. Pure/deterministic complement to prompt.ts's parseCitations.
//
// The chunk record stores `page` + `charStart`/`charEnd` (DATA-MODEL §3, written by the
// chunker/pdf extractor), so a clicked `[#n]` resolves to an exact location: which document,
// which PDF page, and which character span to wrap in the yellow overlay. This module turns
// a parsed citation's chunkId into that target and slices the source text into pre/hit/post —
// the right pane (PDF.js / Markdown viewer) just scrolls to `page` and styles `hit`.

import type { SearchHit } from '$lib/inference/provider';

export interface CitationTarget {
  chunkId: string;
  docId: string;
  page?: number; // PDF page to scroll to (undefined for markdown)
  charStart: number;
  charEnd: number;
}

export interface HighlightSegments {
  pre: string; // text before the cited span
  hit: string; // the cited span — wrap this in the highlight
  post: string; // text after the cited span
}

/** Resolve a chunkId (from a parsed citation) to its source location (FR-CHAT-003). */
export function resolveCitationTarget(chunkId: string, hits: SearchHit[]): CitationTarget | null {
  const hit = hits.find((h) => h.chunkId === chunkId);
  if (!hit) return null;
  return {
    chunkId: hit.chunkId,
    docId: hit.docId,
    page: hit.page,
    charStart: hit.charStart,
    charEnd: hit.charEnd
  };
}

/**
 * Resolve an ordered list of cited chunkIds to targets, de-duplicated by chunkId and
 * preserving first-seen order. Unknown chunkIds are dropped (never a dangling jump).
 */
export function resolveCitations(chunkIds: string[], hits: SearchHit[]): CitationTarget[] {
  const seen = new Set<string>();
  const out: CitationTarget[] = [];
  for (const id of chunkIds) {
    if (seen.has(id)) continue;
    const target = resolveCitationTarget(id, hits);
    if (target) {
      seen.add(id);
      out.push(target);
    }
  }
  return out;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Slice the source document into the three runs the viewer needs to render the yellow
 * highlight (FR-CHAT-003). Offsets are clamped to the document; an out-of-range or empty
 * span yields an empty `hit` (no highlight) rather than throwing.
 */
export function buildHighlightSegments(
  docText: string,
  charStart: number,
  charEnd: number
): HighlightSegments {
  const start = clamp(charStart, 0, docText.length);
  const end = clamp(charEnd, start, docText.length);
  return {
    pre: docText.slice(0, start),
    hit: docText.slice(start, end),
    post: docText.slice(end)
  };
}
