import { readFileSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { AdapterConfig, SourceAdapter, SourceConfigError, SyncKind, SyncRow } from '../sync.types';
import { resolveSyncFilePath } from '../upload.util';

/**
 * Header الرسمي (CONTRACT / _data/employees.sample.csv):
 *   externalId,name,phone,roleHint,siteCode,zoneCode,orgUnit
 * الاعمدة الاضافية آمنة (email/jobTitle...) والـ header حساس لحالة الاحرف تمامًا مثل الملف العينة.
 */
export const CSV_HEADER = ['externalId', 'name', 'phone', 'roleHint', 'siteCode', 'zoneCode', 'orgUnit'] as const;

const EXPECTED = CSV_HEADER.join(',');

const boolish = (v: string): boolean | undefined => {
  const s = v.trim().toLowerCase();
  if (!s) return undefined;
  if (['1', 'true', 'yes', 'y', 'active'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'inactive', 'disabled'].includes(s)) return false;
  return undefined;
};

@Injectable()
export class CsvSyncAdapter implements SourceAdapter {
  readonly kind: SyncKind = 'csv';

  async fetch(config: AdapterConfig): Promise<SyncRow[]> {
    const filePath = resolveSyncFilePath(String(config.filePath ?? ''));
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      throw new SourceConfigError('CSV_FILE_MISSING', `cannot read csv file at ${filePath}`);
    }
    return this.parseText(text, filePath);
  }

  parseText(text: string, label = 'upload'): SyncRow[] {
    let records: Record<string, string>[];
    try {
      records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (e) {
      throw new SourceConfigError('CSV_PARSE_FAILED', `${label}: ${(e as Error).message.split('\n')[0]}`);
    }
    const first = records[0] ?? {};
    const cols = Object.keys(first);
    if (cols.length && !cols.includes('externalId')) {
      throw new SourceConfigError(
        'CSV_HEADER_MISMATCH',
        `${label}: expected header "${EXPECTED}", got "${cols.join(',')}"`,
      );
    }
    return records.map((r) => ({
      externalId: (r.externalId ?? '').trim(),
      name: (r.name ?? '').trim(),
      phoneE164: (r.phone ?? '').trim(),
      roleHint: (r.roleHint ?? '').trim() || undefined,
      siteCode: (r.siteCode ?? '').trim() || undefined,
      zoneCode: (r.zoneCode ?? '').trim() || undefined,
      orgUnit: (r.orgUnit ?? '').trim() || undefined,
      active: boolish(r.active ?? ''),
    }));
  }
}
