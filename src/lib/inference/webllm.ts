// Real WebLLM InferenceProvider (ADR-001, FR-CHAT-001..004). Runs a quantized LLM on
// WebGPU via @mlc-ai/web-llm. Selected when the capability check reports tier 'full'
// with verified weights (chatStatus 'ready'); otherwise the app stays on the mock/
// degraded path. Verified end-to-end on a real NVIDIA GPU through the webllm-test route.

import * as webllm from '@mlc-ai/web-llm';
import type {
  InferenceProvider,
  GenerateRequest,
  GenerateResult,
  CompleteRequest,
  CompleteResult,
  Backend
} from './provider';
import {
  assemblePrompt,
  parseCitations,
  stripPromptEcho,
  NO_RESULTS_MESSAGE
} from '$lib/chat/prompt';

const MAX_CONTEXT_TOKENS = 4096;

// Persist model weights in WebLLM's default Cache Storage (ADR-025, supersedes ADR-020's
// IndexedDB choice). Live evidence: a 695 MB chat model survived many sessions in `webllm/model`
// Cache Storage on the fixed-port origin — persistence was never the cache *backend*, it was the
// origin (a changing dev-server port orphaned the cache; `strictPort: 1420` fixes that, and the
// packaged Tauri app has a stable origin). Forcing IndexedDB would orphan that Cache-Storage copy
// and trigger one needless re-download. So we keep the default and rely on the stable origin.
const APP_CONFIG: webllm.AppConfig = webllm.prebuiltAppConfig;

export class WebLLMProvider implements InferenceProvider {
  readonly id = 'webllm' as const;
  private engine: webllm.MLCEngineInterface | null = null;

  capabilities(): { chat: boolean; maxContextTokens: number; backend: Backend } {
    return { chat: true, maxContextTokens: MAX_CONTEXT_TOKENS, backend: 'webgpu' };
  }

  /** True if this model's weights are already cached locally — no download needed (FR-MDL). */
  async isCached(modelId: string): Promise<boolean> {
    try {
      return await webllm.hasModelInCache(modelId, APP_CONFIG);
    } catch {
      return false;
    }
  }

  async loadModel(modelId: string, onProgress: (p: number) => void): Promise<void> {
    this.engine = await webllm.CreateMLCEngine(modelId, {
      appConfig: APP_CONFIG,
      initProgressCallback: (r: webllm.InitProgressReport) => onProgress(r.progress ?? 0)
    });
  }

  /**
   * Grounded, streamed, cited generation. Assembles the RAG prompt from the retrieved
   * context (no-results guard short-circuits before the model — FR-CHAT-002), streams
   * tokens (FR-CHAT-004) honoring AbortSignal, and maps [#n] markers → chunkId (FR-CHAT-003).
   */
  async generate(
    req: GenerateRequest,
    onToken: (t: string) => void,
    signal: AbortSignal
  ): Promise<GenerateResult> {
    if (!this.engine) throw new Error('Model not loaded');

    const prompt = assemblePrompt(req.query, req.context, {
      maxContextTokens: this.capabilities().maxContextTokens,
      mode: req.answerMode
    });
    if (prompt.kind === 'no_results') {
      return {
        requestId: req.requestId,
        text: NO_RESULTS_MESSAGE,
        citations: [],
        ttftMs: 0,
        tokensPerSec: 0
      };
    }

    const { text, ttftMs, tokensPerSec } = await this.streamChat(
      prompt.system,
      prompt.user,
      undefined,
      onToken,
      signal
    );
    // Defensive: strip any echoed prompt scaffolding the small model emitted, then parse
    // citations against the CLEANED text so spans line up with what the user sees.
    const cleaned = stripPromptEcho(text);
    const { citations } = parseCitations(cleaned, prompt.contextOrder);
    return { requestId: req.requestId, text: cleaned, citations, ttftMs, tokensPerSec };
  }

  /**
   * Raw streamed completion (FR-CHAT-006) — used by the whole-note map-reduce reader, which
   * supplies its own system+user prompts. No RAG assembly, no citation parsing; just stream the
   * model's text (echo scaffolding stripped) and honor cancellation.
   */
  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal
  ): Promise<CompleteResult> {
    if (!this.engine) throw new Error('Model not loaded');
    const { text, ttftMs, tokensPerSec } = await this.streamChat(
      req.system,
      req.user,
      req.maxTokens,
      onToken,
      signal
    );
    return { text: stripPromptEcho(text), ttftMs, tokensPerSec };
  }

  /** Shared streaming core for generate()/complete(): stream deltas, honor AbortSignal, time it. */
  private async streamChat(
    system: string,
    user: string,
    maxTokens: number | undefined,
    onToken: (t: string) => void,
    signal: AbortSignal
  ): Promise<{ text: string; ttftMs: number; tokensPerSec: number }> {
    if (!this.engine) throw new Error('Model not loaded');
    const start = performance.now();
    let ttftMs = 0;
    let tokens = 0;
    let text = '';

    const stream = await this.engine.chat.completions.create({
      stream: true,
      // Low temperature → grounded, reproducible answers (RAG should not be creative).
      temperature: 0.2,
      top_p: 0.9,
      // Penalize repetition: small on-device models fall into "say the same sentence forever" loops
      // on repetitive context (e.g. many near-identical notes). These keep generation moving without
      // pushing the model off the notes.
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    for await (const part of stream) {
      if (signal.aborted) {
        await this.engine.interruptGenerate();
        throw new DOMException('Generation aborted', 'AbortError');
      }
      const delta = part.choices[0]?.delta?.content ?? '';
      if (delta) {
        if (ttftMs === 0) ttftMs = Math.round(performance.now() - start);
        text += delta;
        tokens += 1;
        onToken(delta);
      }
    }

    const seconds = Math.max((performance.now() - start) / 1000, 1e-3);
    return { text, ttftMs, tokensPerSec: tokens / seconds };
  }

  async unload(): Promise<void> {
    await this.engine?.unload();
    this.engine = null;
  }
}
