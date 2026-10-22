/**
 * Sync module contract types — docs/CONTRACT.md §8.
 * كل adapter يخرّج نفس الصف؛ المزامنة لا تعرف شيئًا عن مصدر البيانات.
 */

export const SYNC_KINDS = ['sql', 'rest', 'csv'] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export type SyncTrigger = 'MANUAL' | 'CRON' | 'WEBHOOK';

/** صف موحّد من أي مصدر (CONTRACT §8) */
export interface SyncRow {
  externalId: string;
  name: string;
  /** كما وصل من المصدر — يُطبَّع بـ normalizePhone داخل Service */
  phoneE164: string;
  /** hint خام: EMPLOYEE | DRIVER | أي قيمة أخرى ⇒ SyncIssue BAD_ROLE */
  roleHint?: string;
  orgUnit?: string;
  siteCode?: string;
  zoneCode?: string;
  active?: boolean;
}

export interface AdapterConfig {
  [key: string]: unknown;
}

export interface SourceAdapter {
  readonly kind: SyncKind;
  fetch(config: AdapterConfig): Promise<SyncRow[]>;
}

/** خطأ واضح للمشغّل: حزمة npm ناقصة — لا نثبّت شيئًا من الكود. */
export class DriverNotInstalled extends Error {
  constructor(public readonly dialect: string, public readonly pkg: string) {
    super(
      `DriverNotInstalled: sync dialect "${dialect}" requires package "${pkg}" — run: npm i ${pkg} (in apps/api)`,
    );
    this.name = 'DriverNotInstalled';
  }
}

/** أخطاء مُرمّزة للمصدر تُعرض في SyncRun.error */
export class SourceConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SourceConfigError';
  }
}

export const HTTP_FETCHER = 'HTTP_FETCHER';

export interface HttpFetcher {
  getJson(url: string, headers?: Record<string, string>): Promise<unknown>;
}

/** ملخّصcounts الظاهر في GET /sync/runs/:id */
export interface RunCounts {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  noPhone: number;
  issues: number;
}
