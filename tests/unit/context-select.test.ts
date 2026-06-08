import { describe, it, expect } from 'vitest';
import {
  selectContext,
  rankCandidates,
  textSimilarity,
  type SelectionCandidate
} from '../../src/lib/context/select';

// CE1 — the "~5%" selection (FR-CTX-007 · ALGORITHMS §5). Pure budgeted selection over GraphRAG
// candidates. A word counter stands in for the target-model tokenizer (the real one is injected).
const words = (t: string): number => t.split(/\s+/).filter(Boolean).length;

const C = (over: Partial<SelectionCandidate> & { chunkId: string }): SelectionCandidate => ({
  docId: over.chunkId.split('#')[0],
  seq: Number(over.chunkId.split('#')[1] ?? 0),
  text: 'some text',
  score: 0.5,
  ...over
});

describe('textSimilarity', () => {
  it('is 1 for identical text and low for unrelated', () => {
    expect(textSimilarity('the quick brown fox jumps', 'the quick brown fox jumps')).toBe(1);
    expect(
      textSimilarity('the quick brown fox', 'completely different sentence here')
    ).toBeLessThan(0.2);
  });
});

describe('rankCandidates', () => {
  it('orders pinned, then semantic-by-score, then graph-by-sharedCount; drops the ineligible', () => {
    const ranked = rankCandidates(
      [
        C({ chunkId: 'd2#0', score: 0.9 }),
        C({ chunkId: 'd1#0', score: 0.1, graphConnected: true, sharedCount: 2 }),
        C({ chunkId: 'd0#0', score: 0.05 }), // below floor, no graph link → ineligible
        C({ chunkId: 'd3#0', score: 0.4, pinned: true }),
        C({ chunkId: 'd4#0', score: 0.1, graphConnected: true, sharedCount: 1 })
      ],
      0.25
    );
    expect(ranked.map((c) => c.chunkId)).toEqual(['d3#0', 'd2#0', 'd1#0', 'd4#0']);
    expect(ranked.map((c) => c.chunkId)).not.toContain('d0#0'); // the irrelevant one is filtered out
  });
});

describe('selectContext', () => {
  it('never exceeds the token budget (expansion is bounded)', () => {
    // 10 DISTINCT 10-token chunks (so dedup never fires), budget 25 → at most 2 fit.
    const cands = Array.from({ length: 10 }, (_, i) =>
      C({
        chunkId: `d${i}#0`,
        text: `chunk${i} alpha beta gamma delta epsilon zeta eta theta iota`,
        score: 0.9 - i * 0.01
      })
    );
    const r = selectContext(cands, { tokenBudget: 25, countTokens: words });
    expect(r.tokenTotal).toBeLessThanOrEqual(25);
    expect(r.selected.length).toBe(2);
    expect(r.droppedForBudget).toBeGreaterThan(0);
  });

  it('always keeps pinned items even when they blow the budget', () => {
    const r = selectContext(
      [
        C({ chunkId: 'p#0', text: 'a b c d e f g h i j', pinned: true }), // 10 tokens, budget 3
        C({ chunkId: 'q#0', text: 'one two', score: 0.9 })
      ],
      { tokenBudget: 3, countTokens: words }
    );
    expect(r.selected.map((c) => c.chunkId)).toContain('p#0'); // user pick kept past budget
    expect(r.tokenTotal).toBeGreaterThan(3); // exceeded ONLY because of the pin
  });

  it('admits a graph-connected chunk that a cosine-only top-k would drop', () => {
    // Budget fits exactly two 3-word chunks. A high-cosine distractor and a low-cosine graph sibling
    // compete for the second slot; the graph sibling is admitted (semantic tier first, then graph).
    const r = selectContext(
      [
        C({ chunkId: 'seed#0', text: 'aaa bbb ccc', score: 0.95 }),
        C({
          chunkId: 'graph#0',
          text: 'ddd eee fff',
          score: 0.05,
          graphConnected: true,
          sharedCount: 2
        })
      ],
      { tokenBudget: 6, countTokens: words, floor: 0.25 }
    );
    expect(r.selected.map((c) => c.chunkId).sort()).toEqual(['graph#0', 'seed#0']);
  });

  it('does not pad with near-duplicates', () => {
    const r = selectContext(
      [
        C({ chunkId: 'a#0', text: 'the budget has not been approved yet by finance', score: 0.9 }),
        C({ chunkId: 'b#0', text: 'the budget has not been approved yet by finance', score: 0.8 }),
        C({ chunkId: 'c#0', text: 'a totally unrelated note about cats and dogs', score: 0.7 })
      ],
      { tokenBudget: 100, countTokens: words }
    );
    expect(r.selected.map((c) => c.chunkId)).toEqual(['a#0', 'c#0']); // the duplicate b#0 is dropped
    expect(r.droppedAsDuplicate).toBe(1);
  });

  it('orders the selected set by (docId, seq) regardless of usefulness order', () => {
    const r = selectContext(
      [
        C({ chunkId: 'zeta#2', text: 'one two', score: 0.99 }),
        C({ chunkId: 'alpha#0', text: 'three four', score: 0.3 }),
        C({ chunkId: 'alpha#1', text: 'five six', score: 0.4 })
      ],
      { tokenBudget: 100, countTokens: words }
    );
    expect(r.selected.map((c) => c.chunkId)).toEqual(['alpha#0', 'alpha#1', 'zeta#2']);
  });

  it('is deterministic for a fixed input', () => {
    const cands = [
      C({ chunkId: 'd1#0', score: 0.8 }),
      C({ chunkId: 'd2#0', score: 0.1, graphConnected: true, sharedCount: 1 }),
      C({ chunkId: 'd3#0', score: 0.6 })
    ];
    const a = selectContext(cands, { tokenBudget: 100, countTokens: words });
    const b = selectContext(cands, { tokenBudget: 100, countTokens: words });
    expect(a).toEqual(b);
  });
});
