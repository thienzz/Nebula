import { describe, it, expect } from 'vitest';
import { classifyCapabilities, requiresOomAck } from '../../src/lib/capability/capability';
import { DEFAULT_CHAT_MODEL, OPTIONAL_CHAT_MODEL } from '../../src/lib/inference/provider';

// FR-CAP-001/002/003/004 · TC-CAP-001/002/004.

const base = { ramGB: 16, freeDiskGB: 50 };

describe('TC-CAP-001 — provider selection', () => {
  it('selects webllm on a full (WebGPU) tier', () => {
    const c = classifyCapabilities({ ...base, webgpu: true, hasVerifiedWeights: true });
    expect(c.tier).toBe('full');
    expect(c.selectedProvider).toBe('webllm');
  });
});

describe('TC-CAP-002 — graceful degrade keeps semantic search', () => {
  it('no WebGPU → degraded tier, chat unsupported, semantic search still on', () => {
    const c = classifyCapabilities({ ...base, webgpu: false, hasVerifiedWeights: false });
    expect(c.tier).toBe('degraded');
    expect(c.selectedProvider).toBe('none');
    expect(c.chatStatus).toBe('unsupported');
    expect(c.semanticSearch).toBe(true); // the macOS/Linux value story
  });
});

describe('TC-CAP-004 — chat-readiness distinct from tier', () => {
  it('WebGPU + verified weights → ready', () => {
    expect(
      classifyCapabilities({ ...base, webgpu: true, hasVerifiedWeights: true }).chatStatus
    ).toBe('ready');
  });
  it('WebGPU + no weights → needs_model (download affordance, not an error)', () => {
    expect(
      classifyCapabilities({ ...base, webgpu: true, hasVerifiedWeights: false }).chatStatus
    ).toBe('needs_model');
  });
  it('no WebGPU + no native provider → unsupported', () => {
    expect(
      classifyCapabilities({ ...base, webgpu: false, hasVerifiedWeights: false }).chatStatus
    ).toBe('unsupported');
  });
});

describe('FR-CAP-003 — OOM warning', () => {
  it('warns for an 8B model on an 8GB machine; not for the default', () => {
    expect(requiresOomAck(OPTIONAL_CHAT_MODEL, 8)).toBe(true);
    expect(requiresOomAck(OPTIONAL_CHAT_MODEL, 16)).toBe(false);
    expect(requiresOomAck(DEFAULT_CHAT_MODEL, 8)).toBe(false);
  });
});
