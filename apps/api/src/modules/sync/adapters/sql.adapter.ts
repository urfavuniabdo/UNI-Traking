import { createRequire } from 'node:module';
import { Injectable } from '@nestjs/common';
import { AdapterConfig, DriverNotInstalled, SourceAdapter, SourceConfigError, SyncKind, SyncRow } from '../sync.types';

const nodeRequire = createRequire(__filename);

/** معرّفات آمنة فقط (عمود/جدول/مخطط.جدول) — لا يُدمج أي إدخال آخر في نص SQL. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63})?$/;
const assertIdentifier = (name: string, what: string): string => {
  const v = String(name ?? '').trim();
  if (!IDENT_RE.test(v)) throw new SourceConfigError('BAD_IDENTIFIER', `unsafe ${what} name: "${v}"`);
  return v;
};

const SELECT_START_RE = /^\s*(?:--[^\n]*(?:\n|$))*\s*(?:\(\s*)*SELECT\b/i;
const FORBIDDEN_RE =
  /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|MERGE|CALL|COPY|VACUUM|ATTACH|OUTFILE)\b|;/i;

/** query من الإعدادات مسموح فقط إذا كان SELECT واحدًا نظيفًا — وإلا يُرفض. */
export const assertSelectOnly = (query: string): string => {
  const q = String(query ?? '').trim().replace(/;\s*$/, '');
  if (!SELECT_START_RE.test(q) || FORBIDDEN_RE.test(q)) {
    throw new SourceConfigError('QUERY_NOT_SELECT_ONLY', 'config.query must be a single SELECT statement');
  }
  return q;
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

const boolCol = (v: unknown): boolean | undefined => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n'].includes(s)) return false;
  return undefined;
};

interface PgPoolLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

interface SqlClient {
  query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  close: () => Promise<void>;
}

interface DialectDef {
  connect: (connectionString: string) => Promise<SqlClient>;
}

@Injectable()
export class SqlSyncAdapter implements SourceAdapter {
  readonly kind: SyncKind = 'sql';

  /** استكشاف الـ dialect من connectionString عند غيابه في الإعدادات. */
  static inferDialect(connectionString: string): string {
    const s = String(connectionString ?? '').toLowerCase();
    if (s.startsWith('postgres://') || s.startsWith('postgresql://')) return 'pg';
    if (s.startsWith('mysql://') || s.startsWith('mariadb://')) return 'mysql';
    if (s.startsWith('mssql://') || s.startsWith('sqlserver://') || s.startsWith('jdbc:sqlserver')) return 'mssql';
    if (s.startsWith('oracle://')) return 'oracle';
    return 'pg';
  }

  async fetch(config: AdapterConfig): Promise<SyncRow[]> {
    const connectionString = str(config.connectionString);
    if (!connectionString) throw new SourceConfigError('BAD_CONFIG', 'sql source needs config.connectionString');
    const dialect = str(config.dialect) || SqlSyncAdapter.inferDialect(connectionString);

    const map = (config.map ?? {}) as Record<string, string>;
    const cols = {
      externalId: assertIdentifier(str(map.externalId) || 'externalId', 'column'),
      name: assertIdentifier(str(map.name) || 'name', 'column'),
      phone: assertIdentifier(str(map.phone) || 'phone', 'column'),
      role: str(map.role) ? assertIdentifier(str(map.role), 'column') : '',
      orgUnit: str(map.orgUnit) ? assertIdentifier(str(map.orgUnit), 'column') : '',
      site: str(map.site) ? assertIdentifier(str(map.site), 'column') : '',
      zone: str(map.zone) ? assertIdentifier(str(map.zone), 'column') : '',
      active: str(map.active) ? assertIdentifier(str(map.active), 'column') : '',
    };
    // الاسم الظاهر في نتيجة الاستعلام = آخر جزء بعد النقطة (alias ثابت آمن)
    const out = (c: string): string => c.split('.').pop() as string;

    let sql: string;
    if (str(config.query)) {
      sql = assertSelectOnly(str(config.query));
    } else {
      const table = assertIdentifier(str(config.table) || 'employees', 'table');
      const selected = Object.values(cols).filter(Boolean);
      sql = 'SELECT ' + selected.map((c) => `${c} AS ${out(c)}`).join(', ') + ' FROM ' + table;
      const limit = Number(config.limit) || 0;
      if (limit > 0 && limit <= 50_000 && (dialect === 'pg' || dialect === 'mysql')) {
        sql += ` LIMIT ${Math.floor(limit)}`;
      }
    }
    // params مكانية فقط — قيم المستخدم لا تُدمج في النص أبدًا
    const params = Array.isArray(config.params) ? (config.params as unknown[]) : [];

    const driver = this.resolveDriver(dialect);
    const client = await driver.connect(connectionString);
    try {
      const bound = dialect === 'mysql' ? sql.replace(/\$\d+/g, '?') : sql;
      const result = await client.query(bound, params);
      return (result.rows ?? []).map((r) => ({
        externalId: str(r[out(cols.externalId)]),
        name: str(r[out(cols.name)]),
        phoneE164: str(r[out(cols.phone)]),
        roleHint: cols.role ? str(r[out(cols.role)]) || undefined : undefined,
        orgUnit: cols.orgUnit ? str(r[out(cols.orgUnit)]) || undefined : undefined,
        siteCode: cols.site ? str(r[out(cols.site)]) || undefined : undefined,
        zoneCode: cols.zone ? str(r[out(cols.zone)]) || undefined : undefined,
        active: cols.active ? boolCol(r[out(cols.active)]) : undefined,
      }));
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private resolveDriver(dialect: string): DialectDef {
    switch (dialect) {
      case 'pg': {
        // pg مثبتة في المشروع — تُحمَّل كسولًا حتى لا تُفشل بقية المصادر
        let Pool: new (c: { connectionString: string; max?: number }) => PgPoolLike;
        try {
          Pool = (nodeRequire('pg') as { Pool: new (c: { connectionString: string; max?: number }) => PgPoolLike }).Pool;
        } catch {
          throw new DriverNotInstalled('pg', 'pg');
        }
        return {
          connect: async (connectionString) => {
            const pool = new Pool({ connectionString, max: 3 });
            return {
              query: async (sqlText, queryParams) => {
                const res = await pool.query(sqlText, queryParams);
                return { rows: res.rows as Record<string, unknown>[] };
              },
              close: () => pool.end(),
            };
          },
        };
      }
      case 'mysql':
        return this.lazyDialect('mysql', 'mysql2');
      case 'mssql':
        return this.lazyDialect('mssql', 'mssql');
      case 'oracle':
        return this.lazyDialect('oracle', 'oracledb');
      default:
        throw new SourceConfigError('UNKNOWN_DIALECT', `unsupported sql dialect: ${dialect}`);
    }
  }

  private lazyDialect(dialect: string, pkg: string): DialectDef {
    return {
      connect: async () => {
        try {
          nodeRequire(pkg);
        } catch {
          throw new DriverNotInstalled(dialect, pkg);
        }
        // الحزمة مثبتة لكن الوصلة لم تُوصَّل في هذا البناء بعد — فشل صريح أفضل من سلوك غامض
        throw new SourceConfigError(
          'DRIVER_WIRING_MISSING',
          `"${pkg}" is installed but its ${dialect} connector is not wired in this build yet`,
        );
      },
    };
  }
}
