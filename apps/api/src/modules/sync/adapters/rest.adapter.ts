import { Inject, Injectable } from '@nestjs/common';
import {
  AdapterConfig,
  HTTP_FETCHER,
  HttpFetcher,
  SourceAdapter,
  SourceConfigError,
  SyncKind,
  SyncRow,
} from '../sync.types';

/** حد أقصى صلب للتصفّح — لا نثق في إعدادات المصدر بالكامل. */
const HARD_RECORD_CAP = 50_000;
const HARD_PAGE_CAP = 1_000;

/** "data.items" → ['data','items'] */
export const pathParts = (p: string): string[] =>
  String(p ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean);

export const getByPath = (obj: unknown, parts: string[]): unknown => {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

@Injectable()
export class RestSyncAdapter implements SourceAdapter {
  readonly kind: SyncKind = 'rest';

  constructor(@Inject(HTTP_FETCHER) private readonly http: HttpFetcher) {}

  async fetch(config: AdapterConfig): Promise<SyncRow[]> {
    const base = str(config.sourceUrl);
    if (!base) throw new SourceConfigError('BAD_CONFIG', 'rest source needs config.sourceUrl');
    const token = str(config.token);
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

    const map = (config.map ?? {}) as Record<string, string>;
    const fExternalId = str(map.externalId) || 'externalId';
    const fName = str(map.name) || 'name';
    const fPhone = str(map.phone) || 'phone';
    const fRole = str(map.role) || 'role';
    const fOrg = str(map.orgUnit) || 'orgUnit';
    const fSite = str(map.site) || 'site';
    const fZone = str(map.zone) || 'zone';
    const fActive = str(map.active);

    const nested = str(config.nested);
    const pageParam = str(config.pageParam) || 'page';
    const sizeParam = str(config.sizeParam) || 'size';
    const pageSize = Math.min(HARD_PAGE_CAP, Math.max(1, Number(config.pageSize) || 200));
    const cap = Math.min(HARD_RECORD_CAP, Math.max(1, Number(config.maxRecords) || 10_000));

    const rows: SyncRow[] = [];
    for (let page = 1; ; page += 1) {
      const u = new URL(base);
      u.searchParams.set(sizeParam, String(pageSize));
      u.searchParams.set(pageParam, String(page));
      const body = await this.http.getJson(u.toString(), headers);
      const holder = nested ? getByPath(body, pathParts(nested)) : body;
      const items = Array.isArray(holder) ? holder : [];
      if (!Array.isArray(holder) && page === 1) {
        throw new SourceConfigError(
          'REST_SHAPE_MISMATCH',
          `expected an array at "${nested || 'root'}" of the response, got ${typeof holder}`,
        );
      }
      for (const item of items) {
        if (rows.length >= cap) {
          // مصدر مبتور ⇒ فشل صريح أفضل من تعطيل جماعي لغياب الصفوف
          throw new SourceConfigError(
            'REST_CAP_EXCEEDED',
            `rest source produced more than ${cap} records — raise config.maxRecords (hard cap ${HARD_RECORD_CAP}) or fix the endpoint`,
          );
        }
        const o = (item ?? {}) as Record<string, unknown>;
        const activeRaw = fActive ? getByPath(o, pathParts(fActive)) : undefined;
        rows.push({
          externalId: str(getByPath(o, pathParts(fExternalId))),
          name: str(getByPath(o, pathParts(fName))),
          phoneE164: str(getByPath(o, pathParts(fPhone))),
          roleHint: str(getByPath(o, pathParts(fRole))) || undefined,
          orgUnit: str(getByPath(o, pathParts(fOrg))) || undefined,
          siteCode: str(getByPath(o, pathParts(fSite))) || undefined,
          zoneCode: str(getByPath(o, pathParts(fZone))) || undefined,
          active:
            activeRaw === undefined || activeRaw === null
              ? undefined
              : activeRaw === true || ['true', '1', 'y', 'yes', 'active'].includes(String(activeRaw).toLowerCase()),
        });
      }
      if (items.length < pageSize) break;
      if (page * pageSize > cap + pageSize) break;
    }
    return rows;
  }
}
