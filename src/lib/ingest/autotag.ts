// Lazy YAML frontmatter — AI auto-tagging on ingestion (FR-ING-006) · OBSIDIAN-DNA §5.4.
//
// Obsidian's power-querying (Dataview) needs structured YAML, but typing it by hand for every
// file is the friction. Nebula does the data entry for you: on ingestion, when a chat model is
// loaded, it "skim-reads" the first ~1000 tokens and emits title/type/tags/summary, prepended
// to the note's frontmatter. Fully user-overridable — manual edits are never clobbered, and a
// missing model degrades gracefully to `taggable_later` (TC-ING-006b), never a hard failure.
//
// The LLM is reached through an injected `TextGenerator` (the same seam idea as the bge
// `countTokens` injection in chunker.ts), so this module is pure & unit-testable with a stub —
// no GPU in the gate. PROMPTS §2 holds the canonical instruction.

import type { ParsedNote } from '$lib/vault/note';

/** Generic completion seam — production wires WebLLM; tests pass a deterministic stub. */
export type TextGenerator = (
  prompt: string,
  opts?: { maxTokens?: number; signal?: AbortSignal }
) => Promise<string>;

export interface AutoTagMeta {
  title?: string;
  type?: string;
  tags: string[];
  summary?: string;
}

export type AutoTagResult =
  | { ok: true; meta: AutoTagMeta }
  | { ok: false; reason: 'no_model' | 'unparseable' | 'error'; detail?: string };

export interface AutoTagOptions {
  skimTokens?: number; // how much of the doc to skim (default 1000)
  maxTags?: number; // clamp tag count (default 6)
  maxTokens?: number; // generation budget (default 256)
  signal?: AbortSignal;
}

export const DEFAULT_SKIM_TOKENS = 1000;

// PROMPTS §2 — versioned; changing it must re-run the autotag parse tests.
export const AUTOTAG_INSTRUCTION = `You are Nebula's local archivist. Read the document excerpt and output ONLY a JSON object describing it. No prose, no code fence, no extra keys. Schema:
{"title": string, "type": string, "tags": string[], "summary": string}
Rules:
- title: a concise human-readable title for the document.
- type: ONE lowercase word for the kind (e.g. "report", "contract", "note", "paper", "email").
- tags: 3-6 lowercase topical keywords, no "#".
- summary: at most 3 sentences describing what the document is about.
Output the JSON object and nothing else.`;

/** First ~n whitespace tokens of the text — the "skim read" window (FR-ING-006). */
export function firstTokens(text: string, n: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= n ? words.join(' ') : words.slice(0, n).join(' ');
}

/** Assemble the strict-JSON skim prompt (FR-ING-006 · PROMPTS §2). Pure. */
export function buildAutoTagPrompt(text: string, opts: AutoTagOptions = {}): string {
  const excerpt = firstTokens(text, opts.skimTokens ?? DEFAULT_SKIM_TOKENS);
  return `${AUTOTAG_INSTRUCTION}\n\n# Document excerpt\n${excerpt}`;
}

/** Pull the outermost {...} object out of a possibly-noisy LLM response. */
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanTags(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.toLowerCase().replace(/^#+/, '').replace(/\s+/g, ' ').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

function firstSentences(text: string, n: number): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  const parts = norm.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  return parts
    .slice(0, n)
    .map((p) => p.trim())
    .join(' ')
    .trim();
}

/**
 * Parse + normalize an LLM auto-tag response (FR-ING-006). Tolerant of code fences and
 * surrounding prose; clamps tags, lowercases the type, trims the summary to ≤3 sentences.
 * Returns null when no JSON object can be recovered (caller → `taggable_later`).
 */
export function parseAutoTagResponse(raw: string, opts: AutoTagOptions = {}): AutoTagMeta | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const meta: AutoTagMeta = { tags: cleanTags(obj.tags, opts.maxTags ?? 6) };
  if (typeof obj.title === 'string' && obj.title.trim()) meta.title = obj.title.trim();
  if (typeof obj.type === 'string' && obj.type.trim()) {
    meta.type = obj.type.toLowerCase().trim().split(/\s+/)[0];
  }
  if (typeof obj.summary === 'string' && obj.summary.trim()) {
    meta.summary = firstSentences(obj.summary, 3);
  }
  return meta;
}

/**
 * Merge generated metadata into a note's frontmatter (FR-ING-006). USER OVERRIDE: existing
 * keys are never clobbered unless `overwrite` is set, so manual tag edits survive re-ingestion.
 * `date_ingested` is stamped from the injected `now` (no clock here → deterministic).
 */
export function applyAutoFrontmatter(
  note: ParsedNote,
  meta: AutoTagMeta,
  opts: { now: string; overwrite?: boolean }
): ParsedNote {
  const fm: Record<string, unknown> = { ...note.frontmatter };
  const set = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (opts.overwrite || fm[key] === undefined || fm[key] === '') fm[key] = value;
  };
  set('title', meta.title);
  set('type', meta.type);
  if (meta.tags.length) set('tags', meta.tags);
  set('summary', meta.summary);
  set('date_ingested', opts.now);
  return { frontmatter: fm, body: note.body };
}

/** Flag (or clear) a note for later tagging when no model was available (TC-ING-006b). */
export function markTaggableLater(note: ParsedNote, on: boolean): ParsedNote {
  const fm = { ...note.frontmatter };
  if (on) fm.taggable_later = true;
  else delete fm.taggable_later;
  return { frontmatter: fm, body: note.body };
}

/**
 * Skim-read a document and produce frontmatter metadata (FR-ING-006). Reaches the LLM via the
 * injected generator; `null` generator (no model loaded) degrades to `no_model` so the caller
 * flags `taggable_later` instead of failing the ingest.
 */
export async function autoTag(
  text: string,
  generate: TextGenerator | null,
  opts: AutoTagOptions = {}
): Promise<AutoTagResult> {
  if (!generate) return { ok: false, reason: 'no_model' };
  try {
    const raw = await generate(buildAutoTagPrompt(text, opts), {
      maxTokens: opts.maxTokens ?? 256,
      signal: opts.signal
    });
    const meta = parseAutoTagResponse(raw, opts);
    if (!meta) return { ok: false, reason: 'unparseable', detail: raw.slice(0, 120) };
    return { ok: true, meta };
  } catch (e) {
    return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
}
