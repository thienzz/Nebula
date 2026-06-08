import { describe, it, expect } from 'vitest';
import { scoreStrategy, averageScores, efficiency } from '../../src/lib/context/bench-score';
import { runBench, REFERENCE_VAULT, GOLD_QUESTIONS } from '../../src/lib/context/bench';

// CE0 — the bench. The scoring math and the headline claim ("compiled beats naive top-k at a
// fraction of raw's tokens") are pinned here so they stay true. The human-facing `npm run bench`
// runner (tests/bench) prints the table + writes results.json; this is the gate-enforced core.
const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;

describe('scoreStrategy', () => {
  it('computes recall, precision, and f1 against the gold set', () => {
    const s = scoreStrategy(['a', 'b', 'x'], ['a', 'b', 'c', 'd'], 100);
    expect(s.recall).toBe(0.5); // got a,b of 4 gold
    expect(s.precision).toBeCloseTo(2 / 3, 5); // 2 of 3 sent were relevant
    expect(s.hitCount).toBe(2);
    expect(s.tokens).toBe(100);
  });

  it('handles empty selection and empty gold sanely', () => {
    expect(scoreStrategy([], ['a'], 0).recall).toBe(0);
    expect(scoreStrategy([], ['a'], 0).precision).toBe(0);
    expect(scoreStrategy(['a'], [], 0).recall).toBe(1); // nothing to miss
  });
});

describe('averageScores', () => {
  it('macro-averages and rounds to 3dp for byte-stable output', () => {
    const a = scoreStrategy(['a'], ['a', 'b'], 10); // recall .5
    const b = scoreStrategy(['a', 'b'], ['a', 'b'], 20); // recall 1
    expect(averageScores([a, b]).recall).toBe(0.75);
    expect(averageScores([a, b]).tokens).toBe(15);
  });
});

describe('runBench — the proof', () => {
  const result = runBench({ countTokens: words });

  it('covers the whole reference vault and gold question set', () => {
    expect(result.vaultSize).toBe(REFERENCE_VAULT.length);
    expect(result.questionCount).toBe(GOLD_QUESTIONS.length);
  });

  it('compiled beats naive top-k on recall (the CE1 win)', () => {
    expect(result.strategies.compiled.recall).toBeGreaterThan(result.strategies.naive.recall);
  });

  it('compiled matches raw recall at a fraction of the tokens', () => {
    expect(result.strategies.compiled.recall).toBe(result.strategies.raw.recall); // both find all gold
    expect(result.strategies.compiled.tokens).toBeLessThan(result.strategies.raw.tokens);
  });

  it('compiled is the most token-efficient (quality per 1k tokens)', () => {
    const e = (k: 'raw' | 'naive' | 'compiled') => efficiency(result.strategies[k]);
    expect(e('compiled')).toBeGreaterThan(e('naive'));
    expect(e('compiled')).toBeGreaterThan(e('raw'));
  });

  it('compiled never pads beyond the gold-sized budget', () => {
    for (const q of result.perQuestion) {
      expect(q.compiled.tokens).toBeLessThanOrEqual(result.budgetPerQuestion);
    }
  });
});
