// The "~5%" selection (FR-CTX-007) — Context-Engine CE1 · ALGORITHMS §5.
//
// This is the heart of the Context Engine: given retrieval CANDIDATES (the vector seeds + the
// graph-connected siblings GraphRAG already surfaced) and a token budget for the target cloud model,
// pick the most useful subset that (a) never exceeds the budget, (b) always keeps user-picked items,
// (c) is not padded with near-duplicates, and (d) is deterministic for a fixed input. It deliberately
// admits chunks reached only through SHARED ENTITIES — the structural context a plain vector top-k
// (cosine-only) drops below its budget cutoff — which is exactly how "compiled" beats "naive top-k"
// in the CE0 bench.
//
// PURE: no GPU, no DB, no clock, no Math.random. Retrieval (embed + graphRagSearch) happens upstream
// behind the existing seams; token counting is injected (the compiler's target-model tokenizer). So
// identical candidates + budget → identical selection (the determinism invariant, FR-CTX-002).

export interface SelectionCandidate {
  chunkId: string; // `${docId}#${seq}`
  docId: string;
  seq: number;
  text: string;
  score: number; // semantic similarity (cosine) to the query; graph-only siblings may sit near 0
  page?: number;
  graphConnected?: boolean; // reached via shared-entity expansion (eligible even below the cosine floor)
  sharedCount?: number; // # of seed entities it shares (graph proximity) — ranks the graph tier
  pinned?: boolean; // user-picked — ALWAYS kept (the "~5%" filter applies to expansion, not picks)
}

export interface SelectOptions {
  tokenBudget: number; // hard ceiling for the EXPANSION (pinned items are always kept on top)
  countTokens: (text: string) => number; // injected: the target model's tokenizer (compiler.ts)
  /** Min cosine for a chunk to qualify on SEMANTIC merit alone (default 0.25). Graph-connected and
   *  pinned chunks bypass it — that's the structural-recall lever. */
  floor?: number;
  /** Shingle-Jaccard at/above which two chunks count as near-duplicates and the later one is dropped
   *  (default 0.8). Prevents padding the payload with repeats. */
  dedupThreshold?: number;
}

export interface SelectedChunk extends SelectionCandidate {
  tokens: number;
}

export interface SelectionResult {
  selected: SelectedChunk[]; // ordered by (docId, seq) — the compiler's deterministic output order
  tokenTotal: number; // tokens across `selected` (may exceed budget ONLY via pinned items)
  budget: number;
  droppedForBudget: number; // eligible chunks left out because they wouldn't fit
  droppedAsDuplicate: number; // eligible chunks left out as near-duplicates of a kept one
}

export const DEFAULT_FLOOR = 0.25;
export const DEFAULT_DEDUP = 0.8;

const byDocSeq = (a: SelectionCandidate, b: SelectionCandidate): number =>
  a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : a.seq - b.seq;

/** Lowercased word-trigram shingles of a text (for near-duplicate detection). Pure. */
function shingles(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  if (words.length < 3) {
    if (words.length) out.add(words.join(' ')); // short text → compare on its normalized whole
    return out;
  }
  for (let i = 0; i + 3 <= words.length; i++)
    out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Jaccard overlap of two shingle sets (0..1). Pure. */
export function textSimilarity(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0)
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Rank candidates by usefulness (most useful first), in three deterministic tiers:
 *   1. pinned (user-picked) — by (docId, seq);
 *   2. semantic — score ≥ floor — by score desc, then (docId, seq);
 *   3. graph-connected — the structural siblings — by sharedCount desc, then score desc, then (docId, seq).
 * Candidates that are none of the above (below the floor AND not graph-connected) are ineligible —
 * that filter is the "~5%". Exported for the bench so it can explain the ordering.
 */
export function rankCandidates(
  candidates: SelectionCandidate[],
  floor: number = DEFAULT_FLOOR
): SelectionCandidate[] {
  const pinned: SelectionCandidate[] = [];
  const semantic: SelectionCandidate[] = [];
  const graph: SelectionCandidate[] = [];
  for (const c of candidates) {
    if (c.pinned) pinned.push(c);
    else if (c.score >= floor) semantic.push(c);
    else if (c.graphConnected) graph.push(c);
    // else: below floor, no graph link → not part of the relevant slice.
  }
  pinned.sort(byDocSeq);
  semantic.sort((a, b) => b.score - a.score || byDocSeq(a, b));
  graph.sort(
    (a, b) => (b.sharedCount ?? 0) - (a.sharedCount ?? 0) || b.score - a.score || byDocSeq(a, b)
  );
  return [...pinned, ...semantic, ...graph];
}

/**
 * Select the most useful in-budget subset of retrieval candidates (CE1). Greedy over the usefulness
 * ranking: pinned items are always taken (even past budget — the user chose them); every other item
 * is taken if it both FITS the remaining budget and is not a near-duplicate of an already-kept chunk.
 * Items that don't fit are skipped (budget packing, never exceeded); duplicates are dropped. The kept
 * set is then ordered by (docId, seq) so the compiled payload is byte-identical for identical input.
 */
export function selectContext(
  candidates: SelectionCandidate[],
  opts: SelectOptions
): SelectionResult {
  const floor = opts.floor ?? DEFAULT_FLOOR;
  const dedup = opts.dedupThreshold ?? DEFAULT_DEDUP;

  // Dedup exact chunkIds up front (keep the first occurrence in input order).
  const seenIds = new Set<string>();
  const unique = candidates.filter((c) => (seenIds.has(c.chunkId) ? false : (seenIds.add(c.chunkId), true))); // prettier-ignore

  const ranked = rankCandidates(unique, floor);

  const kept: SelectedChunk[] = [];
  let tokenTotal = 0;
  let droppedForBudget = 0;
  let droppedAsDuplicate = 0;

  for (const c of ranked) {
    const tokens = opts.countTokens(c.text);
    const isDup = kept.some(
      (k) => k.docId === c.docId && k.seq === c.seq && k.chunkId !== c.chunkId
    ) || kept.some((k) => textSimilarity(k.text, c.text) >= dedup); // prettier-ignore
    if (c.pinned) {
      if (isDup) continue; // a pinned item duplicating another kept item adds nothing
      kept.push({ ...c, tokens });
      tokenTotal += tokens;
      continue;
    }
    if (isDup) {
      droppedAsDuplicate++;
      continue;
    }
    if (tokenTotal + tokens > opts.tokenBudget) {
      droppedForBudget++;
      continue; // skip-and-continue: pack smaller items that still fit, never exceed the ceiling
    }
    kept.push({ ...c, tokens });
    tokenTotal += tokens;
  }

  kept.sort(byDocSeq);
  return {
    selected: kept,
    tokenTotal,
    budget: opts.tokenBudget,
    droppedForBudget,
    droppedAsDuplicate
  };
}
