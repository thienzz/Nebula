// Note authoring — create / edit / save HAND-WRITTEN notes (FR-NOTE-001..004) · OBSIDIAN-DNA §5.6.
//
// "Notes are the core." A note typed in Nebula is a first-class `.md` in the vault — written to
// disk as plain Markdown + YAML frontmatter (DATA-MODEL §2), instantly chunk/embed indexed so it
// is searchable + citable, and portable to ANY LLM via Export Vault (FR-DATA-006) or the Context
// Compiler (FR-CTX-*). This module owns the deterministic core of authoring: turning a title+body
// draft into a valid `.md`, deriving a collision-free `notes/<slug>.md` path, and re-stamping
// `modified` + `nebula_hash` on edit so change-detection (FR-DATA-003) stays honest.
//
// Pure & deterministic (ADR-014): `now` and the note `id` are INJECTED — no clock, no randomness
// here — so the unit tests are exact and the same draft always serializes byte-identically. The
// disk write itself goes through fs_scope (NFR-SEC-003); this layer only produces the bytes.

import { type ParsedNote, serializeNote, parseNote, computeNoteHash } from '$lib/vault/note';

export interface NoteDraft {
  title: string;
  body: string;
}

export type DraftValidation = { ok: true } | { ok: false; reason: string };

export interface CreateNoteInput extends NoteDraft {
  /** ISO timestamp for `created`/`modified` (injected → deterministic, no clock here). */
  now: string;
  /** Stable note id (e.g. a ULID), injected. Omitted from frontmatter when absent. */
  id?: string;
  /** Existing vault paths, so the derived slug never collides (FR-NOTE-002). */
  existingPaths?: Iterable<string>;
  /** Pre-existing / user frontmatter keys to preserve (never clobbered, except title/modified). */
  frontmatter?: Record<string, unknown>;
}

export interface NoteFile {
  /** Vault-relative path, e.g. `notes/project-x.md` — the docId used everywhere downstream. */
  docId: string;
  /** Parsed form (frontmatter + body). */
  note: ParsedNote;
  /** Serialized `.md` — the bytes written to disk (the source of truth, FR-DATA-001). */
  markdown: string;
}

const MAX_SLUG_LEN = 80;
// Combining diacritical marks (U+0300–U+036F) left behind by NFKD decomposition.
const COMBINING = /[̀-ͯ]/g;

/**
 * Path-safe, Obsidian-friendly slug for a note title (FR-NOTE-002).
 * Lowercases, strips diacritics, keeps `[a-z0-9]`, collapses every other run to a single `-`,
 * and trims leading/trailing `-`. An empty/punctuation-only title degrades to `untitled` rather
 * than producing an invalid or hidden filename.
 */
export function slugify(title: string): string {
  const ascii = title.normalize('NFKD').replace(COMBINING, '').replace(/[đĐ]/g, 'd'); // Vietnamese đ has no NFKD decomposition
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

/**
 * Derive a collision-free `notes/<slug>.md` path (FR-NOTE-002). If the base path is already in
 * `existingPaths`, append `-2`, `-3`, … until free, so saving two "Untitled" notes never
 * overwrites the first.
 */
export function notePathFromTitle(title: string, existingPaths: Iterable<string> = []): string {
  const taken = new Set(existingPaths);
  const slug = slugify(title);
  let candidate = `notes/${slug}.md`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `notes/${slug}-${n}.md`;
    n++;
  }
  return candidate;
}

/** A draft is saveable iff it has a non-blank title (FR-NOTE-001). Empty body is allowed. */
export function validateDraft(draft: NoteDraft): DraftValidation {
  if (!draft.title || !draft.title.trim()) {
    return { ok: false, reason: 'A note needs a title.' };
  }
  return { ok: true };
}

/**
 * Create a brand-new hand-written note (FR-NOTE-001). Builds the `.md` frontmatter
 * (`id?`, `title`, `type: note`, `created`, `modified`, `nebula_hash`), preserving any caller
 * frontmatter, and derives a collision-free path. `nebula_hash` is computed over the BODY only,
 * matching `computeNoteHash` (FR-DATA-003), so metadata edits don't force a needless re-embed.
 */
export async function createNote(input: CreateNoteInput): Promise<NoteFile> {
  const title = input.title.trim();
  const frontmatter: Record<string, unknown> = { ...input.frontmatter };
  if (input.id !== undefined && frontmatter.id === undefined) frontmatter.id = input.id;
  frontmatter.title = title;
  if (frontmatter.type === undefined) frontmatter.type = 'note';
  if (frontmatter.created === undefined) frontmatter.created = input.now;
  frontmatter.modified = input.now;

  const note: ParsedNote = { frontmatter, body: input.body };
  // Hash the BODY AS IT WILL PARSE BACK OFF DISK, so re-reading the file reproduces this exact
  // `nebula_hash` (FR-DATA-003) instead of flagging every saved note as "externally changed".
  frontmatter.nebula_hash = await computeNoteHash(serializeNote(note));

  const docId = notePathFromTitle(title, input.existingPaths);
  return { docId, note, markdown: serializeNote(note) };
}

export interface UpdateNoteInput {
  /** The note's current path (unchanged by an edit — rename is a separate op). */
  docId: string;
  /** The current on-disk/in-memory `.md` text being edited. */
  markdown: string;
  /** New title (optional — omit to keep the existing one). */
  title?: string;
  /** New body (optional — omit to keep the existing one). */
  body?: string;
  /** ISO timestamp for the new `modified` stamp. */
  now: string;
}

/**
 * Apply an edit to an existing note (FR-NOTE-003). Parses the current `.md`, overlays the new
 * title/body, re-stamps `modified` and `nebula_hash`, and preserves every other key (`id`,
 * `created`, tags, source, unknown Obsidian keys). The path does NOT change — keeping links and
 * the note `id` stable; renaming is handled separately.
 */
export async function updateNote(input: UpdateNoteInput): Promise<NoteFile> {
  const parsed = parseNote(input.markdown);
  const frontmatter = { ...parsed.frontmatter };
  // parseNote leaves a single leading `\n` from the frontmatter separator; strip it so the
  // editor and re-save see the clean authored body.
  const body = input.body ?? parsed.body.replace(/^\n/, '');
  if (input.title !== undefined) frontmatter.title = input.title.trim();
  if (frontmatter.created === undefined) frontmatter.created = input.now;
  frontmatter.modified = input.now;

  const note: ParsedNote = { frontmatter, body };
  frontmatter.nebula_hash = await computeNoteHash(serializeNote(note));

  return { docId: input.docId, note, markdown: serializeNote(note) };
}
