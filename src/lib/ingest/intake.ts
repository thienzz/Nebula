// Ingestion intake guards — FR-ING-001 (accepted types) + FR-ING-010 (size cap,
// non-UTF-8/undecodable handling). Pure: decides accept/skip/fail before any parsing,
// so an oversized or undecodable file is marked `failed` with a specific reason and the
// app stays responsive (others continue). PDF extraction itself runs later in the
// parser Worker (pdfjs); here we only classify and decode text formats.

export type IntakeType = 'pdf' | 'md' | 'txt' | 'csv';

export type IntakeResult =
  | { ok: true; type: IntakeType; text?: string } // `text` for md/txt/csv; pdf parsed later
  | { ok: false; status: 'skipped' | 'failed'; code: string; reason: string };

const EXT_TO_TYPE: Record<string, IntakeType> = {
  pdf: 'pdf',
  md: 'md',
  markdown: 'md',
  txt: 'txt',
  text: 'txt',
  csv: 'csv'
};

export const DEFAULT_MAX_FILE_MB = 100; // FR-ING-010

/** Classify by extension. Returns null for unsupported types (FR-ING-001). */
export function detectFileType(name: string): IntakeType | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return EXT_TO_TYPE[ext] ?? null;
}

/** Strict UTF-8 decode; throws-free. Returns null when the bytes are undecodable. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface IntakeOptions {
  maxFileSizeMB?: number;
}

/**
 * Gate a file before ingestion (FR-ING-001/010):
 * - unsupported type → `skipped` (UNSUPPORTED)
 * - over the size cap → `failed` (OVERSIZED) without attempting to parse
 * - non-UTF-8 md/txt/csv → `failed` (UNDECODABLE)
 * - md/txt/csv → ok, with decoded `text` (CSV is rendered to a Markdown table downstream);
 *   pdf → ok (parsed later in the Worker)
 */
export function intake(
  file: { name: string; bytes: Uint8Array },
  opts: IntakeOptions = {}
): IntakeResult {
  const type = detectFileType(file.name);
  if (type === null) {
    return {
      ok: false,
      status: 'skipped',
      code: 'UNSUPPORTED',
      reason: `Unsupported file type: ${file.name}`
    };
  }

  const maxBytes = (opts.maxFileSizeMB ?? DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  if (file.bytes.byteLength > maxBytes) {
    const mb = (file.bytes.byteLength / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      status: 'failed',
      code: 'OVERSIZED',
      reason: `File is ${mb} MB, over the ${opts.maxFileSizeMB ?? DEFAULT_MAX_FILE_MB} MB limit`
    };
  }

  if (type === 'pdf') {
    return { ok: true, type }; // binary; decoded/extracted by the pdfjs Worker
  }

  const text = decodeUtf8(file.bytes);
  if (text === null) {
    return {
      ok: false,
      status: 'failed',
      code: 'UNDECODABLE',
      reason: 'File is not valid UTF-8 text'
    };
  }
  return { ok: true, type, text };
}
