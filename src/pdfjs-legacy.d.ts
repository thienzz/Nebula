// The legacy build has no bundled type entry; reuse the main pdfjs-dist types.
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
