import { describe, it, expect } from 'vitest';
import {
  CHAT_MODELS,
  BIG_MODEL_MB,
  RECOMMENDED_MODEL_ID,
  modelById,
  formatSize,
  needsOomAck,
  recommendModel
} from '../../src/lib/inference/catalog';

// FR-CAP-003/004. The curated chat-model picker + the OOM-risk gate for large models.

describe('CHAT_MODELS catalog', () => {
  it('is non-empty, uniquely keyed, and every model has a positive size', () => {
    expect(CHAT_MODELS.length).toBeGreaterThanOrEqual(5);
    const ids = CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup ids
    expect(CHAT_MODELS.every((m) => m.sizeMB > 0 && m.label && m.params)).toBe(true);
  });

  it('offers at least one multilingual option (Vietnamese-capable)', () => {
    expect(CHAT_MODELS.some((m) => m.multilingual)).toBe(true);
  });
});

describe('modelById', () => {
  it('finds a known model and returns undefined otherwise', () => {
    expect(modelById('Llama-3.2-1B-Instruct-q4f16_1-MLC')?.params).toBe('1B');
    expect(modelById('nope')).toBeUndefined();
  });
});

describe('formatSize', () => {
  it('shows GB ≥ 1000 MB, else MB', () => {
    expect(formatSize(945)).toBe('945 MB');
    expect(formatSize(5107)).toBe('5.1 GB');
  });
});

describe('recommendModel', () => {
  it('recommends the multilingual 3B with WebGPU, nothing without', () => {
    const r = recommendModel(true);
    expect(r?.id).toBe(RECOMMENDED_MODEL_ID);
    expect(r?.multilingual).toBe(true);
    expect(recommendModel(false)).toBeNull();
  });
  it('recommends a model that loads reliably (below the experimental ack threshold)', () => {
    expect(needsOomAck(RECOMMENDED_MODEL_ID)).toBe(false); // a 3B must not be gated as "too big"
  });
});

describe('needsOomAck', () => {
  it('flags models at/above the big-model threshold, not the small ones', () => {
    expect(needsOomAck('Llama-3.2-1B-Instruct-q4f16_1-MLC')).toBe(false); // 879 MB
    expect(needsOomAck('Llama-3.1-8B-Instruct-q4f16_1-MLC')).toBe(true); // 5001 MB
    expect(needsOomAck('unknown-model')).toBe(false);
  });

  it('agrees with the published threshold for every catalog entry', () => {
    for (const m of CHAT_MODELS) {
      expect(needsOomAck(m.id)).toBe(m.sizeMB >= BIG_MODEL_MB);
    }
  });
});
