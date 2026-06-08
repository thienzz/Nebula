// Context-Engine bench scoring (CE0 proof) — the pure, unit-tested half of `npm run bench`.
//
// The bench answers one question: for a fixed token budget, which context-selection STRATEGY gives a
// cloud model the best material? It scores each strategy's chosen chunk set against a gold relevance
// label on three axes — retrieval recall, citation precision, and token cost — so "compiled" (CE1)
// can be shown to beat "naive vector top-k" at a fraction of "raw folder dump"'s tokens. This module
// is pure (no GPU, no DB, no I/O) so the scoring itself is trustworthy and reproducible. ALGORITHMS §5.

export interface StrategyScore {
  recall: number; // |selected ∩ gold| / |gold| — did we bring the relevant material?
  precision: number; // |selected ∩ gold| / |selected| — how much of what we sent was relevant?
  f1: number; // harmonic mean of recall & precision
  tokens: number; // token cost of the payload (the price paid for that quality)
  selectedCount: number;
  hitCount: number; // |selected ∩ gold|
}

/** Score one strategy's selected docIds/chunkIds against the gold-relevant set. Pure + deterministic. */
export function scoreStrategy(
  selected: readonly string[],
  gold: readonly string[],
  tokens: number
): StrategyScore {
  const sel = new Set(selected);
  const goldSet = new Set(gold);
  let hitCount = 0;
  for (const id of sel) if (goldSet.has(id)) hitCount++;
  const recall = goldSet.size === 0 ? 1 : hitCount / goldSet.size;
  const precision = sel.size === 0 ? 0 : hitCount / sel.size;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);
  return { recall, precision, f1, tokens, selectedCount: sel.size, hitCount };
}

/** Average a set of per-question scores into one strategy summary (macro-average). Pure. */
export function averageScores(scores: readonly StrategyScore[]): StrategyScore {
  if (scores.length === 0)
    return { recall: 0, precision: 0, f1: 0, tokens: 0, selectedCount: 0, hitCount: 0 };
  const sum = scores.reduce(
    (a, s) => ({
      recall: a.recall + s.recall,
      precision: a.precision + s.precision,
      f1: a.f1 + s.f1,
      tokens: a.tokens + s.tokens,
      selectedCount: a.selectedCount + s.selectedCount,
      hitCount: a.hitCount + s.hitCount
    }),
    { recall: 0, precision: 0, f1: 0, tokens: 0, selectedCount: 0, hitCount: 0 }
  );
  const n = scores.length;
  const round = (x: number) => Math.round(x * 1000) / 1000; // stable to 3 dp → byte-stable results.json
  return {
    recall: round(sum.recall / n),
    precision: round(sum.precision / n),
    f1: round(sum.f1 / n),
    tokens: Math.round(sum.tokens / n),
    selectedCount: round(sum.selectedCount / n),
    hitCount: round(sum.hitCount / n)
  };
}

/** Quality-per-1k-tokens — the headline "is this budget well spent?" number. Pure. */
export function efficiency(score: StrategyScore): number {
  return score.tokens === 0 ? 0 : Math.round((score.f1 / score.tokens) * 1000 * 1000) / 1000;
}
