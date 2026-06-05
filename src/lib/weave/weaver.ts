// The Weaver — AI-driven bi-directional linking (FR-LINK-001/002) · OBSIDIAN-DNA §5.2.
//
// Obsidian makes you type `[[WikiLinks]]` by hand; Nebula weaves them automatically. As the
// local LLM streams an answer, this pure pass scans the text for surface forms that match
// existing note titles/aliases in the vault and wraps them as interactive links — the
// "silent archivist." notePreview() backs the hover popover (first 200 chars / YAML summary).
//
// Pure & deterministic (ALGORITHMS §9): no GPU/DB/network. Longest-match, case-insensitive,
// word-boundary aware, and it never links inside code spans, fenced blocks, or existing
// `[[wikilinks]]` / `[md](links)` — so it can't corrupt code samples or double-wrap links.

export interface NoteRef {
  docId: string; // e.g. notes/apollo.md
  title: string; // display title (frontmatter.title or filename stem)
  aliases?: string[]; // alternative surface forms that should also link here
  summary?: string; // frontmatter summary / auto_summary — preferred popover text
  body?: string; // fallback popover text when there is no summary
}

export interface TitleIndex {
  surfaces: { surface: string; docId: string; title: string }[]; // normalized, longest-first
}

export interface WovenSegment {
  text: string;
  link?: { docId: string; title: string }; // present → render as an auto-wikilink
}

export interface WeaveOptions {
  minLength?: number; // ignore surfaces shorter than this (default 2) to avoid noise
  once?: boolean; // link only the first occurrence per target doc (default false: link all)
}

const WORD = /[A-Za-z0-9]/;
const isWord = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Build a lookup of linkable surface forms from note titles + aliases (FR-LINK-001).
 * Normalized (lowercased, whitespace-collapsed), deduped (first note wins a given surface),
 * and sorted longest-first so "machine learning" wins over "machine".
 */
export function buildTitleIndex(notes: NoteRef[], opts: WeaveOptions = {}): TitleIndex {
  const min = opts.minLength ?? 2;
  const seen = new Set<string>();
  const surfaces: TitleIndex['surfaces'] = [];
  for (const note of notes) {
    for (const form of [note.title, ...(note.aliases ?? [])]) {
      const surface = norm(form);
      if (surface.length < min || seen.has(surface)) continue;
      seen.add(surface);
      surfaces.push({ surface, docId: note.docId, title: form });
    }
  }
  surfaces.sort(
    (a, b) =>
      b.surface.length - a.surface.length ||
      (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0)
  );
  return { surfaces };
}

interface Range {
  start: number;
  end: number;
}

/** Character ranges that must never be linked: fenced/inline code + existing links. */
function protectedRanges(text: string): Range[] {
  const patterns = [
    /```[\s\S]*?```/g, // fenced code block
    /`[^`\n]*`/g, // inline code
    /\[\[[^\]]*\]\]/g, // existing wikilink
    /\[[^\]]*\]\([^)]*\)/g // existing markdown link
  ];
  const ranges: Range[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null)
      ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * Weave auto-wikilinks into `text` (FR-LINK-001). Returns ordered segments; segments with
 * a `link` should render as interactive links, the rest as plain text. Concatenating all
 * `segment.text` reproduces the input exactly (lossless) — only the markup is added.
 */
export function weaveLinks(
  text: string,
  index: TitleIndex,
  opts: WeaveOptions = {}
): WovenSegment[] {
  const lower = text.toLowerCase();
  const guarded = protectedRanges(text);
  const surfaces = index.surfaces;
  const linkedOnce = new Set<string>();
  const out: WovenSegment[] = [];

  let i = 0;
  let plainStart = 0;
  let g = 0; // pointer into guarded ranges (sorted, i only increases)
  const flush = (to: number) => {
    if (to > plainStart) out.push({ text: text.slice(plainStart, to) });
  };

  while (i < text.length) {
    while (g < guarded.length && guarded[g].end <= i) g++;
    if (g < guarded.length && i >= guarded[g].start) {
      // inside a protected region — emit it verbatim, never linked
      flush(i);
      const end = guarded[g].end;
      out.push({ text: text.slice(i, end) });
      i = end;
      plainStart = i;
      continue;
    }

    if (isWord(text[i - 1]) && isWord(text[i])) {
      i++; // mid-word: not a token start
      continue;
    }

    const nextGuard = g < guarded.length ? guarded[g].start : text.length;
    let matched: { surface: string; docId: string; title: string; len: number } | null = null;
    for (const s of surfaces) {
      const len = s.surface.length;
      if (i + len > nextGuard) continue; // would cross into a protected region or past EOS
      if (!lower.startsWith(s.surface, i)) continue;
      if (isWord(text[i + len - 1]) && isWord(text[i + len])) continue; // would cut a word
      if (opts.once && linkedOnce.has(s.docId)) continue;
      matched = { ...s, len };
      break;
    }

    if (matched) {
      flush(i);
      out.push({
        text: text.slice(i, i + matched.len),
        link: { docId: matched.docId, title: matched.title }
      });
      if (opts.once) linkedOnce.add(matched.docId);
      i += matched.len;
      plainStart = i;
    } else {
      i++;
    }
  }
  flush(text.length);
  return out;
}

/**
 * Inline-popover text for a linked note (FR-LINK-002): the YAML summary if present, else
 * the first `max` characters of the body — so the user previews context without leaving
 * the chat flow.
 */
export function notePreview(note: Pick<NoteRef, 'summary' | 'body'>, max = 200): string {
  const raw = (note.summary ?? note.body ?? '').replace(/\s+/g, ' ').trim();
  return raw.length <= max ? raw : raw.slice(0, max).trimEnd() + '…';
}
