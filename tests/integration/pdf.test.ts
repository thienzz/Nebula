import { describe, it, expect } from 'vitest';
import { extractPdf } from '../../src/lib/ingest/pdf';
import { chunk } from '../../src/lib/ingest/chunker';

// FR-ING-001/002 — REAL PDF parsing via pdfjs in Node (no GPU, no network).

/** Build a minimal valid multi-page PDF with correct xref offsets. */
function buildPdf(pageTexts: string[]): Uint8Array {
  const enc = (s: string) => Buffer.from(s, 'latin1');
  const P = pageTexts.length;
  const fontObj = 3 + 2 * P;
  const objs: string[] = [];
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = Array.from({ length: P }, (_, i) => `${3 + 2 * i} 0 R`).join(' ');
  objs[1] = `<< /Type /Pages /Kids [${kids}] /Count ${P} >>`;
  for (let i = 0; i < P; i++) {
    const pageNum = 3 + 2 * i;
    const contentNum = 4 + 2 * i;
    const stream = `BT /F1 24 Tf 72 700 Td (${pageTexts[i]}) Tj ET`;
    objs[pageNum - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`;
    objs[contentNum - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objs[fontObj - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let body = enc('%PDF-1.4\n');
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets[i] = body.length;
    body = Buffer.concat([body, enc(`${i + 1} 0 obj\n${o}\nendobj\n`)]);
  });
  const xrefStart = body.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    xref += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.concat([body, enc(xref), enc(trailer)]));
}

describe('extractPdf — real pdfjs text extraction', () => {
  it('extracts text from a single page', async () => {
    const pdf = buildPdf(['Hello Nebula PDF extraction works']);
    const out = await extractPdf(pdf);
    expect(out.pages).toHaveLength(1);
    expect(out.text).toContain('Hello Nebula PDF extraction works');
  });

  it('extracts multiple pages and maps offsets back to page numbers', async () => {
    const pdf = buildPdf(['First page about contracts', 'Second page about budgets']);
    const out = await extractPdf(pdf);

    expect(out.pages).toHaveLength(2);
    expect(out.pages[0].text).toContain('First page about contracts');
    expect(out.pages[1].text).toContain('Second page about budgets');

    // pageForOffset resolves a char position to the right page
    expect(out.pageForOffset(out.pages[0].charStart)).toBe(1);
    expect(out.pageForOffset(out.pages[1].charStart)).toBe(2);
  });

  it('feeds extracted text + page map into the chunker (page-annotated chunks)', async () => {
    const pdf = buildPdf(['Alpha beta gamma delta', 'Epsilon zeta eta theta']);
    const out = await extractPdf(pdf);
    const chunks = chunk(out.text, { size: 3, overlap: 0, pageForOffset: out.pageForOffset });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].page).toBe(1);
    expect(chunks[chunks.length - 1].page).toBe(2);
  });
});
