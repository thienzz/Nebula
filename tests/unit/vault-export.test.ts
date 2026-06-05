import { describe, it, expect } from 'vitest';
import {
  buildVaultExport,
  toZip,
  exportVaultZip,
  crc32,
  type VaultExportInput
} from '../../src/lib/vault/export';

// FR-DATA-006 (Eject Button / Export Vault) + FR-ING-011 (non-destructive) · OBSIDIAN-DNA §5.1.
// The deterministic core: DB content → portable Markdown → valid store-only PKZIP.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Minimal store-only ZIP reader (test-only) — proves the writer round-trips. */
function readStoreZip(
  zip: Uint8Array
): { path: string; content: string; bytes: Uint8Array; crcOk: boolean }[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // locate End Of Central Directory (no archive comment, so it's the last 22 bytes).
  const eocd = zip.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central dir offset
  const out: { path: string; content: string; bytes: Uint8Array; crcOk: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50); // central header signature
    const crc = dv.getUint32(p + 16, true);
    const nameLen = dv.getUint16(p + 28, true);
    const localOff = dv.getUint32(p + 42, true);
    const path = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    // jump to the local header to read the stored bytes
    expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtra = dv.getUint16(localOff + 28, true);
    const size = dv.getUint32(localOff + 22, true);
    const dataStart = localOff + 30 + lNameLen + lExtra;
    const data = zip.subarray(dataStart, dataStart + size);
    out.push({ path, content: dec.decode(data), bytes: data, crcOk: crc32(data) === crc });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

const sample: VaultExportInput = {
  notes: [
    { path: 'notes/apollo.md', frontmatter: { title: 'Apollo', tags: ['x'] }, body: 'Ships in Q3.' }
  ],
  sources: [
    { path: 'sources/contract.md', frontmatter: { type: 'contract' }, text: 'Liability capped.' }
  ],
  chats: [
    {
      id: 'sess-1',
      title: 'Security',
      created: '2026-06-05T00:00:00Z',
      messages: [
        { role: 'user', content: 'Is it private?' },
        { role: 'assistant', content: 'Yes, fully local. [#1]' }
      ]
    }
  ]
};

describe('crc32', () => {
  it('matches the canonical CRC-32 check value and empty-string identity', () => {
    expect(crc32(enc.encode('123456789')) >>> 0).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('buildVaultExport', () => {
  it('resolves notes/sources/chats into a sorted .md hierarchy with frontmatter', () => {
    const entries = buildVaultExport(sample);
    expect(entries.map((e) => e.path)).toEqual([
      'chats/sess-1.md',
      'notes/apollo.md',
      'sources/contract.md'
    ]);
    const note = entries.find((e) => e.path === 'notes/apollo.md')!;
    expect(note.content).toContain('title: Apollo');
    expect(note.content).toContain('Ships in Q3.');
    const chat = entries.find((e) => e.path === 'chats/sess-1.md')!;
    expect(chat.content).toContain('type: chat');
    expect(chat.content).toContain('**assistant:**');
  });

  it('is non-destructive: never mutates its inputs (FR-ING-011)', () => {
    const input: VaultExportInput = {
      notes: [{ path: 'notes/a.md', frontmatter: { tags: ['keep'] }, body: 'orig' }]
    };
    const snapshot = JSON.stringify(input);
    buildVaultExport(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('toZip / exportVaultZip', () => {
  it('emits a valid store-only ZIP that round-trips with correct CRCs', () => {
    const zip = exportVaultZip(sample);
    // PKZIP local-file signature at the start.
    expect([zip[0], zip[1], zip[2], zip[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const back = readStoreZip(zip);
    expect(back.map((e) => e.path)).toEqual([
      'chats/sess-1.md',
      'notes/apollo.md',
      'sources/contract.md'
    ]);
    expect(back.every((e) => e.crcOk)).toBe(true);
    // content survives the round-trip byte-for-byte
    const built = buildVaultExport(sample);
    expect(back.map((e) => e.content)).toEqual(built.map((e) => e.content));
  });

  it('is deterministic — identical input yields identical bytes', () => {
    expect(Array.from(exportVaultZip(sample))).toEqual(Array.from(exportVaultZip(sample)));
  });

  it('handles an empty vault (valid empty archive)', () => {
    const zip = toZip([]);
    const dv = new DataView(zip.buffer);
    expect(zip.length).toBe(22); // just the EOCD record
    expect(dv.getUint32(0, true)).toBe(0x06054b50);
  });
});

describe('Markdown-Proxy export: proxy notes + original binaries (FR-ING-012)', () => {
  it('packs proxy .md notes alongside the untouched original binaries', () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe, 0x0a]); // %PDF + non-UTF8 bytes
    const zip = exportVaultZip({
      notes: [
        {
          path: 'notes/report.md',
          frontmatter: { source: 'sources/report.pdf', title: 'Q3' },
          body: 'extracted text'
        }
      ],
      originals: [{ path: 'sources/report.pdf', bytes: pdfBytes }]
    });
    const back = readStoreZip(zip);
    expect(back.map((e) => e.path)).toEqual(['notes/report.md', 'sources/report.pdf']);
    // the proxy note carries the source backlink
    expect(back.find((e) => e.path === 'notes/report.md')!.content).toContain(
      'source: sources/report.pdf'
    );
    // the original binary round-trips byte-for-byte with a correct CRC
    const orig = back.find((e) => e.path === 'sources/report.pdf')!;
    expect(orig.crcOk).toBe(true);
    expect(Array.from(orig.bytes)).toEqual(Array.from(pdfBytes));
  });
});
