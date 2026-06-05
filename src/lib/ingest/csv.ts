// CSV ingestion — multi-format intake (FR-ING-001) · OBSIDIAN-DNA §5.1.
//
// "Markdown-First": a dropped `.csv` is parsed and rendered to a Markdown table so it becomes
// a portable, Obsidian-readable proxy note (proxy.ts) and chunks cleanly for RAG. Pure &
// deterministic (ALGORITHMS §12): a small RFC-4180-style parser (quoted fields, embedded
// commas/newlines, "" escapes, CR/LF, BOM) — no dependency added.

/** Parse CSV text into rows of string cells (RFC-4180-ish). Pure. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  if (text.length === 0) return [];
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1; // CRLF: the \n closes the row
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  // flush the final field/row unless the file ended on a clean newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Escape a cell for a Markdown table (pipes + newlines would break the row). */
function escapeCell(s: string): string {
  return s
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Render CSV as a GitHub-flavored Markdown table (first row = header), padded to a uniform
 * column count so ragged rows still produce a valid table. Empty input → ''. Pure.
 */
export function csvToMarkdown(text: string, opts: { delimiter?: string } = {}): string {
  const rows = parseCsv(text, opts.delimiter);
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const fit = (r: string[]): string[] =>
    Array.from({ length: cols }, (_, i) => escapeCell(r[i] ?? ''));
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  const header = fit(rows[0]);
  const sep = Array.from({ length: cols }, () => '---');
  const body = rows.slice(1).map((r) => line(fit(r)));
  return [line(header), line(sep), ...body].join('\n');
}
