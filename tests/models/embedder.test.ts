import { describe, it, expect } from 'vitest';
import { embed, embedBatch, makeBgeTokenCounter } from '../../src/lib/embed/embedder';
import { EMBEDDING_DIM, EMBEDDING_MAX_TOKENS } from '../../src/lib/inference/provider';

// FR-ING-004 — REAL bge-small embeddings on CPU (no GPU). Proves the degraded-tier
// semantic path (FR-CAP-002) actually runs headless.

describe('embed — real 384-dim normalized vectors', () => {
  it('produces a 384-dim L2-normalized vector', async () => {
    const v = await embed('The launch is scheduled for Q3.');
    expect(v).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3); // normalized at write time (ALGORITHMS §2)
  });

  it('embeds a batch into N rows of 384', async () => {
    const rows = await embedBatch(['alpha', 'beta', 'gamma']);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toHaveLength(EMBEDDING_DIM);
  });

  it('semantically similar text scores higher than unrelated text', async () => {
    const [q, near, far] = await embedBatch([
      'When does the product launch?',
      'The release date is set for the third quarter.',
      'Cats are small domesticated carnivores.'
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    expect(dot(q, near)).toBeGreaterThan(dot(q, far));
  });
});

describe('makeBgeTokenCounter — the real tokenizer that closes R-1', () => {
  it('counts tokens and flags >512-token text (silent-truncation guard)', async () => {
    const count = await makeBgeTokenCounter();
    expect(count('The launch is scheduled for Q3.')).toBeGreaterThan(0);
    const long = 'word '.repeat(600);
    expect(count(long)).toBeGreaterThan(EMBEDDING_MAX_TOKENS); // would truncate if chunked naively
  });
});
