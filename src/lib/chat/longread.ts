// Whole-note reading with map-reduce (FR-CHAT-006) — answer over the FULL body of every relevant
// note, not just retrieved chunks. When the relevant notes fit the model's context window we make a
// single pass; when they don't, we split them into window-sized passes, EXTRACT the relevant detail
// from each (the "map"), then SYNTHESIZE one answer from those findings (the "reduce"). This lets a
// small on-device model read a note in full no matter how long it is — at the cost of extra passes.
//
// Pure/deterministic except for the injected `complete` (the model call) and `signal`: `planPasses`
// and the prompt builders are unit-testable without a GPU, and the orchestrator is testable with a
// fake `complete`.

import { chunk, type TokenCounter } from '$lib/ingest/chunker';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { NO_RESULTS_MESSAGE, type AnswerMode } from '$lib/chat/prompt';

/** Default token counter — cl100k is a model-agnostic proxy (±, but we pack conservatively). */
export const countCl100k: TokenCounter = (t) => encodeCl100k(t).length;

/** One whole note to read in full. */
export interface ReadSource {
  docId: string;
  text: string;
}

/** A slice of a source that fits in one pass; `part` is set only when a long note was split. */
export interface PassPart {
  docId: string;
  text: string;
  part?: { index: number; total: number }; // 1-based
}

/** The content of a single model pass (≤ the per-pass budget). */
export interface Pass {
  parts: PassPart[];
}

const MAP_NONE = 'NONE';

// --- Prompts -----------------------------------------------------------------
// Deliberately MINIMAL (the "just give the model the notes + the question" principle): heavy rule
// lists ("don't invent", "cite", "no headers", …) confuse small on-device models and make them
// answer worse, not better. One short instruction + the notes + the question is what lets even a
// 1B model explain the content correctly and completely.

const ANSWER_SYSTEM = `You are a helpful assistant. Answer the user's question using the notes provided. Reply in the same language as the question.`;

const ANSWER_SYSTEM_REASON = `You are a helpful assistant. Answer the user's question thoroughly using the notes provided, explaining as needed. Reply in the same language as the question.`;

const MAP_SYSTEM = `Read the notes below and write down everything in them relevant to the user's question, keeping the details. If nothing is relevant, reply ${MAP_NONE}.`;

const REDUCE_SYSTEM = `You are a helpful assistant. Answer the user's question using the information below. Reply in the same language as the question.`;

const REDUCE_SYSTEM_REASON = `You are a helpful assistant. Answer the user's question thoroughly using the information below, explaining as needed. Reply in the same language as the question.`;

function sourceBlocks(parts: PassPart[]): string {
  // Only label sources when there's more than one (or a split note) — a single note should reach the
  // model as plain content, with nothing extra around it.
  if (parts.length === 1 && !parts[0].part) return parts[0].text;
  return parts
    .map((p) => {
      const label = p.part ? `${p.docId} (part ${p.part.index}/${p.part.total})` : p.docId;
      return `--- ${label} ---\n${p.text}`;
    })
    .join('\n\n');
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** Single-pass: hand the model the whole notes + the question, nothing more. */
export function buildAnswerPrompt(query: string, pass: Pass, mode: AnswerMode): BuiltPrompt {
  return {
    system: mode === 'reason' ? ANSWER_SYSTEM_REASON : ANSWER_SYSTEM,
    user: `${sourceBlocks(pass.parts)}\n\nQuestion: ${query}`
  };
}

/** Map step: extract everything relevant to the question from this pass. */
export function buildMapPrompt(query: string, pass: Pass): BuiltPrompt {
  return {
    system: MAP_SYSTEM,
    user: `${sourceBlocks(pass.parts)}\n\nQuestion: ${query}`
  };
}

/** Reduce step: synthesize one answer from the per-pass findings. */
export function buildReducePrompt(
  query: string,
  partials: string[],
  mode: AnswerMode
): BuiltPrompt {
  return {
    system: mode === 'reason' ? REDUCE_SYSTEM_REASON : REDUCE_SYSTEM,
    user: `${partials.join('\n\n')}\n\nQuestion: ${query}`
  };
}

// --- Planning ----------------------------------------------------------------

/** Split one over-long note into non-overlapping segments that each fit `budget` (reuses the chunker). */
function splitToBudget(text: string, budget: number, count: TokenCounter): string[] {
  // overlap 0 → no duplicated content (we want to read 100% once); maxTokens high so size<window holds.
  return chunk(text, { size: budget, overlap: 0, countTokens: count, maxTokens: budget + 1 }).map(
    (c) => c.text
  );
}

/**
 * Pack whole notes into the fewest passes that each fit `budgetTokens`. A note larger than the
 * budget is split across consecutive passes (labeled part i/N); smaller notes share a pass greedily.
 * Order is preserved (callers pass notes most-relevant first).
 */
export function planPasses(
  sources: ReadSource[],
  opts: { budgetTokens: number; countTokens?: TokenCounter }
): Pass[] {
  const count = opts.countTokens ?? countCl100k;
  const budget = Math.max(1, Math.floor(opts.budgetTokens));

  // 1. Turn each source into one or more budget-sized parts.
  const parts: PassPart[] = [];
  for (const src of sources) {
    if (!src.text.trim()) continue;
    if (count(src.text) <= budget) {
      parts.push({ docId: src.docId, text: src.text });
    } else {
      const segs = splitToBudget(src.text, budget, count);
      segs.forEach((text, i) =>
        parts.push({ docId: src.docId, text, part: { index: i + 1, total: segs.length } })
      );
    }
  }

  // 2. Greedily pack parts into passes without exceeding the budget. A single part at/over budget
  //    (an unsplittable run) gets its own pass.
  const passes: Pass[] = [];
  let cur: PassPart[] = [];
  let curTokens = 0;
  for (const p of parts) {
    const t = count(p.text);
    if (cur.length > 0 && curTokens + t > budget) {
      passes.push({ parts: cur });
      cur = [];
      curTokens = 0;
    }
    cur.push(p);
    curTokens += t;
  }
  if (cur.length > 0) passes.push({ parts: cur });
  return passes;
}

// --- Orchestration -----------------------------------------------------------

export type CompleteFn = (
  req: { system: string; user: string; maxTokens: number },
  onToken: (t: string) => void,
  signal: AbortSignal
) => Promise<{ text: string; ttftMs: number; tokensPerSec: number }>;

export interface LongReadOptions {
  budgetTokens: number; // the model's usable context window
  mode: AnswerMode;
  maxAnswerTokens: number; // generation cap for the final answer / reduce
  mapTokens?: number; // generation cap per map pass (default 512 — room to preserve detail)
  reserveSystem?: number; // tokens reserved for the system prompt (default 256)
  countTokens?: TokenCounter;
  onStatus?: (s: string) => void; // progress updates while mapping/reducing
}

export interface LongReadResult {
  text: string;
  passes: number; // how many map passes ran (1 = single-pass, no reduce)
  ttftMs: number;
  tokensPerSec: number;
}

/**
 * Answer `query` over the FULL body of every note in `sources`. Single pass when they fit the
 * window; otherwise map (extract per pass) → reduce (synthesize). Streams only the user-visible
 * answer (single-pass output, or the reduce) via `onToken`; map passes report progress via onStatus.
 */
export async function answerOverNotes(
  query: string,
  sources: ReadSource[],
  complete: CompleteFn,
  onToken: (t: string) => void,
  signal: AbortSignal,
  opts: LongReadOptions
): Promise<LongReadResult> {
  const usable = sources.filter((s) => s.text.trim().length > 0);
  if (usable.length === 0) {
    return { text: NO_RESULTS_MESSAGE, passes: 0, ttftMs: 0, tokensPerSec: 0 };
  }

  const count = opts.countTokens ?? countCl100k;
  const mapTokens = opts.mapTokens ?? 512;
  const reserve =
    count(query) + Math.max(opts.maxAnswerTokens, mapTokens) + (opts.reserveSystem ?? 256) + 128;
  const contentBudget = Math.max(512, opts.budgetTokens - reserve);

  const passes = planPasses(usable, { budgetTokens: contentBudget, countTokens: count });

  // Fits in one window → answer directly over the whole notes (stream to the user).
  if (passes.length <= 1) {
    const { system, user } = buildAnswerPrompt(query, passes[0], opts.mode);
    const r = await complete({ system, user, maxTokens: opts.maxAnswerTokens }, onToken, signal);
    return { text: r.text, passes: 1, ttftMs: r.ttftMs, tokensPerSec: r.tokensPerSec };
  }

  // MAP — extract relevant detail from each pass (not streamed; show progress instead).
  const partials: string[] = [];
  for (let i = 0; i < passes.length; i++) {
    opts.onStatus?.(`reading ${i + 1}/${passes.length}…`);
    const { system, user } = buildMapPrompt(query, passes[i]);
    const r = await complete({ system, user, maxTokens: mapTokens }, () => {}, signal);
    const t = r.text.trim();
    if (t && t.toUpperCase() !== MAP_NONE) partials.push(t);
  }

  if (partials.length === 0) {
    return { text: NO_RESULTS_MESSAGE, passes: passes.length, ttftMs: 0, tokensPerSec: 0 };
  }

  // REDUCE — synthesize one answer from the findings (streamed to the user).
  opts.onStatus?.('combining…');
  const { system, user } = buildReducePrompt(query, partials, opts.mode);
  const r = await complete({ system, user, maxTokens: opts.maxAnswerTokens }, onToken, signal);
  return { text: r.text, passes: passes.length, ttftMs: r.ttftMs, tokensPerSec: r.tokensPerSec };
}
