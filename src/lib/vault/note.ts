// Vault note IO — `.md` + YAML frontmatter (FR-DATA-001) and content-hash change
// detection (FR-DATA-003). Pure/async over strings; the actual disk read/write goes
// through fs_scope (NFR-SEC-003).
//
// Frontmatter is parsed/serialized by a small, dependency-free, BROWSER-SAFE codec
// (ADR-013). gray-matter — the previous choice — relies on Node's global `Buffer`
// (via `Buffer.from`), which is undefined in the webview and crashed Export Vault. This
// codec handles exactly what Nebula writes (scalars, inline `[a, b]` arrays, block `- `
// lists, booleans) and preserves unknown keys, so the Obsidian round-trip (NFR-PORT-001)
// is not clobbered. Unsupported YAML (folded `>`/`|`, nested maps) degrades to a string
// rather than throwing — values are never lost from the file body.

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

function parseScalar(raw: string): string | boolean {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

function parseInlineArray(raw: string): (string | boolean)[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(parseScalar);
}

/** Parse a raw `.md` file into frontmatter + body. */
export function parseNote(raw: string): ParsedNote {
  const m = FENCE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (value === '') {
      // maybe a block list (`  - item`) follows
      const items: (string | boolean)[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(parseScalar(lines[j].replace(/^\s*-\s+/, '')));
        j++;
      }
      frontmatter[key] = items.length ? items : '';
      i = j - 1;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[key] = parseInlineArray(value);
    } else {
      frontmatter[key] = parseScalar(value);
    }
  }
  return { frontmatter, body: m[2] };
}

/** A string that is safe to emit as a bare (unquoted) YAML scalar. */
function isSafePlain(s: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9 _/.-]*$/.test(s) &&
    !/\s$/.test(s) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(s)
  );
}

function dumpScalar(v: unknown): string {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return isSafePlain(s) ? s : JSON.stringify(s); // JSON double-quotes are valid YAML
}

function dumpValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(dumpScalar).join(', ')}]`;
  return dumpScalar(v);
}

/** Serialize frontmatter + body back to a `.md` string, preserving all keys. */
export function serializeNote(note: ParsedNote): string {
  const keys = Object.keys(note.frontmatter);
  if (keys.length === 0) return note.body;
  const lines = keys.map((k) => `${k}: ${dumpValue(note.frontmatter[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${note.body.replace(/^\n+/, '')}`;
}

/** SHA-256 of arbitrary text as `sha256:<hex>` (Web Crypto — works in browser, Worker, Node). */
export async function hashContent(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/**
 * Content hash used for change detection (`nebula_hash`, FR-DATA-003). Hashed over the
 * BODY only, so metadata-only frontmatter edits (e.g. adding tags) don't force a
 * needless re-embed, while any change to the searchable text triggers re-indexing.
 */
export async function computeNoteHash(raw: string): Promise<string> {
  return hashContent(parseNote(raw).body);
}

/** True if the note's body differs from the stored hash (→ re-index, FR-DATA-003). */
export async function hasChanged(
  raw: string,
  storedHash: string | null | undefined
): Promise<boolean> {
  if (!storedHash) return true;
  return (await computeNoteHash(raw)) !== storedHash;
}

/** Stamp the current `nebula_hash` into frontmatter and return the serialized note. */
export async function withNebulaHash(raw: string): Promise<string> {
  const note = parseNote(raw);
  note.frontmatter.nebula_hash = await hashContent(note.body);
  return serializeNote(note);
}
