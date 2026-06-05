// Markdown Proxy Note — the "Markdown-First" core (FR-ING-012) · OBSIDIAN-DNA §5.1, DATA-MODEL §1.
//
// When you drop a PDF/CSV into Nebula it is NEVER edited (FR-ING-011). Instead Nebula creates a
// portable `.md` that REPRESENTS it: the searchable/taggable note. The proxy carries the AI
// frontmatter (FR-ING-006) plus a `source:` backlink to the untouched original under sources/.
// So Export Vault (FR-DATA-006) yields `notes/*.md` proxies + a `sources/` folder of the original
// binaries — a vault that opens 1:1 in Obsidian. Pure & deterministic (ALGORITHMS §12).

import type { ParsedNote } from '$lib/vault/note';
import { applyAutoFrontmatter, markTaggableLater, type AutoTagMeta } from '$lib/ingest/autotag';

export interface ProxyNoteInput {
  /** Vault-relative path to the untouched original, e.g. `sources/report.pdf`. Omit for native .md/.txt notes. */
  sourcePath?: string;
  /** Body of the proxy: extracted text (PDF), Markdown table (CSV), or raw (txt). */
  body: string;
  /** AI-generated frontmatter (FR-ING-006); absent when no chat model is loaded. */
  meta?: AutoTagMeta;
  /** date_ingested stamp (injected → deterministic, no clock here). */
  now: string;
  /** Flag the note for later tagging when `meta` is absent (FR-ING-006 degradation). */
  taggableLater?: boolean;
  /** Pre-existing / user frontmatter keys to preserve (never clobbered). */
  frontmatter?: Record<string, unknown>;
}

/** Derive the proxy note path from a source path: `sources/Q3 report.pdf` → `notes/Q3 report.md`. */
export function proxyNotePath(sourcePath: string): string {
  const base = sourcePath.split('/').pop() ?? sourcePath;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `notes/${stem}.md`;
}

/**
 * Build the Markdown Proxy Note for an imported document (FR-ING-012). Sets the `source:`
 * backlink (when importing a binary), merges AI frontmatter without clobbering user keys
 * (FR-ING-006 override), and stamps `date_ingested`. The original file is never touched.
 */
export function buildProxyNote(input: ProxyNoteInput): ParsedNote {
  let note: ParsedNote = { frontmatter: { ...input.frontmatter }, body: input.body };
  if (input.sourcePath) note.frontmatter.source = input.sourcePath;
  if (input.meta) {
    note = applyAutoFrontmatter(note, input.meta, { now: input.now });
  } else {
    if (note.frontmatter.date_ingested === undefined) note.frontmatter.date_ingested = input.now;
    if (input.taggableLater) note = markTaggableLater(note, true);
  }
  return note;
}
