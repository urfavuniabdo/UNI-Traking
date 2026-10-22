/** CSV helpers — RFC-4180 escaping + UTF-8 BOM so Arabic renders correctly in Excel. */

export type CsvValue = string | number | boolean | null | undefined;

function escapeCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  // Quote when the cell contains a comma, double-quote, CR or LF; double up inner quotes.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines: string[] = [];
  lines.push(headers.map(escapeCell).join(','));
  for (const r of rows) lines.push(r.map(escapeCell).join(','));
  // BOM + CRLF line endings for Excel compatibility.
  return '﻿' + lines.join('\r\n');
}

export interface Column<T> {
  label: string;
  get: (row: T) => CsvValue;
}

/** Build a tabular payload (JSON rows + CSV cells) from typed rows and column specs. */
export function tabular<T>(columns: Column<T>[], data: T[]): {
  headers: string[];
  rows: CsvValue[][];
  data: Record<string, CsvValue>[];
} {
  const headers = columns.map((c) => c.label);
  const rows = data.map((d) => columns.map((c) => c.get(d)));
  const asObjects = data.map((d) => {
    const o: Record<string, CsvValue> = {};
    for (const c of columns) o[c.label] = c.get(d);
    return o;
  });
  return { headers, rows, data: asObjects };
}
