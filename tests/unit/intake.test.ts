import { describe, it, expect } from 'vitest';
import { intake, detectFileType, decodeUtf8 } from '../../src/lib/ingest/intake';

// FR-ING-001 / FR-ING-010 · TC-ING-010 (size cap + non-UTF-8 safety).

const enc = (s: string) => new TextEncoder().encode(s);

describe('detectFileType', () => {
  it('maps known extensions and rejects unknown', () => {
    expect(detectFileType('a.pdf')).toBe('pdf');
    expect(detectFileType('a.md')).toBe('md');
    expect(detectFileType('a.markdown')).toBe('md');
    expect(detectFileType('a.txt')).toBe('txt');
    expect(detectFileType('a.exe')).toBeNull();
    expect(detectFileType('noext')).toBeNull();
  });
});

describe('intake — accepts supported text formats', () => {
  it('decodes md/txt to text', () => {
    const r = intake({ name: 'note.md', bytes: enc('# Hello') });
    expect(r).toEqual({ ok: true, type: 'md', text: '# Hello' });
  });
  it('accepts pdf as binary for later Worker parsing', () => {
    const r = intake({ name: 'doc.pdf', bytes: enc('%PDF-1.7 ...') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type).toBe('pdf');
  });
});

describe('TC-ING-010 — guards', () => {
  it('skips unsupported types with UNSUPPORTED', () => {
    const r = intake({ name: 'virus.exe', bytes: enc('x') });
    expect(r).toMatchObject({ ok: false, status: 'skipped', code: 'UNSUPPORTED' });
  });

  it('fails oversized files without attempting to parse', () => {
    // tiny cap so a small buffer trips it (no 500 MB allocation needed)
    const r = intake({ name: 'big.txt', bytes: enc('x'.repeat(2048)) }, { maxFileSizeMB: 0.001 });
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'OVERSIZED' });
    if (!r.ok) expect(r.reason).toMatch(/over the .* MB limit/);
  });

  it('fails non-UTF-8 text with a specific reason', () => {
    const bad = new Uint8Array([0xff, 0x28, 0x80, 0x00]); // invalid UTF-8
    const r = intake({ name: 'mojibake.txt', bytes: bad });
    expect(r).toMatchObject({ ok: false, status: 'failed', code: 'UNDECODABLE' });
  });
});

describe('decodeUtf8', () => {
  it('returns null for undecodable bytes, text otherwise', () => {
    expect(decodeUtf8(new Uint8Array([0xff, 0xff]))).toBeNull();
    expect(decodeUtf8(enc('ok'))).toBe('ok');
  });
});
