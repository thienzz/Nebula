// PDF text extraction — FR-ING-001/002 (parse off the main thread). Uses pdfjs-dist's
// legacy build, which runs headless in Node/Workers (no DOM needed for text content).
// Produces per-page text + char offsets so the chunker can map a chunk back to its page
// (pageForOffset → FR-CHAT-003 citation scroll/highlight).

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfPage {
  page: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface PdfExtract {
  text: string;
  pages: PdfPage[];
  pageForOffset(charStart: number): number | undefined;
}

const PAGE_SEPARATOR = '\n\n';

/** Extract text + page boundaries from a PDF byte buffer. */
export async function extractPdf(data: Uint8Array): Promise<PdfExtract> {
  const doc = await getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  }).promise;

  const pages: PdfPage[] = [];
  let full = '';

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (p > 1) full += PAGE_SEPARATOR;
    const charStart = full.length;
    full += pageText;
    pages.push({ page: p, text: pageText, charStart, charEnd: full.length });
  }

  return {
    text: full,
    pages,
    pageForOffset: (offset: number) =>
      pages.find((pg) => offset >= pg.charStart && offset < pg.charEnd)?.page
  };
}
