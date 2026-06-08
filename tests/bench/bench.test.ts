import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import {
  runBench,
  REFERENCE_VAULT,
  GOLD_QUESTIONS,
  SYNTHETIC_VECS,
  type VaultVecs
} from '../../src/lib/context/bench';
import { efficiency } from '../../src/lib/context/bench-score';

// CE0 — `npm run bench`. Compares three context-selection strategies (raw folder dump · naive vector
// top-k · compiled CE1) on the reference vault + gold questions, prints a quality-vs-tokens table, and
// writes a reproducible tests/bench/results.json. Default vectors are SYNTHETIC (headless, byte-stable);
// `BENCH_REAL=1 npm run bench` swaps in real bge-m3 embeddings (human-gated, like test:models).

const REAL = !!process.env.BENCH_REAL;
const countTokens = (t: string) => encodeCl100k(t).length; // the target cloud model's tokenizer (cl100k)

async function realVecs(): Promise<VaultVecs> {
  const { embedBatch } = await import('../../src/lib/embed/embedder');
  const noteVecs = await embedBatch(REFERENCE_VAULT.map((n) => n.text));
  const qVecs = await embedBatch(GOLD_QUESTIONS.map((q) => q.query));
  const idx = new Map(REFERENCE_VAULT.map((n, i) => [n.docId, i]));
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  return { cosFor: (note, axis) => dot(noteVecs[idx.get(note.docId)!], qVecs[axis]) };
}

describe('Context-Engine bench (npm run bench)', () => {
  it(`compares strategies on ${REAL ? 'REAL bge-m3' : 'synthetic'} vectors`, async () => {
    const vecs = REAL ? await realVecs() : SYNTHETIC_VECS;
    const result = runBench({ countTokens, vecs });

    const table = (['raw', 'naive', 'compiled'] as const).map((k) => {
      const s = result.strategies[k];
      return {
        strategy: k,
        recall: s.recall,
        precision: s.precision,
        f1: s.f1,
        tokens: s.tokens,
        'quality/1k': efficiency(s)
      };
    });
    // eslint-disable-next-line no-console
    console.log(`\nContext-Engine bench — ${REAL ? 'real bge-m3' : 'synthetic'} vectors`);
    // eslint-disable-next-line no-console
    console.table(table);

    const out = { mode: REAL ? 'real-bge-m3' : 'synthetic', ...result };
    const path = fileURLToPath(new URL('./results.json', import.meta.url));
    writeFileSync(path, JSON.stringify(out, null, 2) + '\n');

    // The bench IS the regression guard: compiled must beat naive and cost far less than raw.
    expect(result.strategies.compiled.recall).toBeGreaterThanOrEqual(
      result.strategies.naive.recall
    );
    expect(result.strategies.compiled.tokens).toBeLessThan(result.strategies.raw.tokens);
    expect(efficiency(result.strategies.compiled)).toBeGreaterThan(
      efficiency(result.strategies.naive)
    );
  });
});
