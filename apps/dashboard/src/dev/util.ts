import type { Query } from '@/api/client';

export interface RawResponse {
  status: number;
  json: unknown;
}

export const ok = (json: unknown): RawResponse => ({ status: 200, json });
export const err = (status: number, code: string, message: string): RawResponse => ({
  status,
  json: { code, message },
});

export const qstr = (q: Query, key: string): string | undefined => {
  const v = (q as Record<string, string | undefined>)[key];
  return v === undefined || v === '' ? undefined : v;
};

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

/** wrap a payload if `format=csv` was requested */
export function maybeCsv(q: Query, rows: Record<string, unknown>[], json: unknown): RawResponse {
  if (qstr(q, 'format') === 'csv') return ok({ csv: toCsv(rows) });
  return ok(json);
}
