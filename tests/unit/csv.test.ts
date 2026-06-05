import { describe, it, expect } from 'vitest';
import { parseCsv, csvToMarkdown } from '../../src/lib/ingest/csv';
import { intake, detectFileType } from '../../src/lib/ingest/intake';

// FR-ING-001 (multi-format) · OBSIDIAN-DNA §5.1. Deterministic CSV parse + Markdown render.

const enc = new TextEncoder();

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ]);
  });

  it('handles quoted fields with embedded commas, newlines, and "" escapes', () => {
    const csv = 'name,note\n"Doe, John","line1\nline2"\n"a ""quote""",x';
    expect(parseCsv(csv)).toEqual([
      ['name', 'note'],
      ['Doe, John', 'line1\nline2'],
      ['a "quote"', 'x']
    ]);
  });

  it('handles CRLF line endings and a BOM, with no trailing empty row', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });

  it('empty input → no rows', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('csvToMarkdown', () => {
  it('renders a header + separator + padded rows', () => {
    const md = csvToMarkdown('h1,h2\n1,2\n3');
    expect(md).toBe('| h1 | h2 |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |');
  });

  it('escapes pipes so cells cannot break the table', () => {
    expect(csvToMarkdown('a|b,c')).toBe('| a\\|b | c |\n| --- | --- |');
  });

  it('empty input → empty string', () => {
    expect(csvToMarkdown('')).toBe('');
  });
});

describe('intake accepts CSV', () => {
  it('detects and decodes a .csv file as text', () => {
    expect(detectFileType('data.csv')).toBe('csv');
    const r = intake({ name: 'data.csv', bytes: enc.encode('a,b\n1,2') });
    expect(r).toEqual({ ok: true, type: 'csv', text: 'a,b\n1,2' });
  });
});
