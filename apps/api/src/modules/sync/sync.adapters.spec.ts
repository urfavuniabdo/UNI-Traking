import { RestSyncAdapter } from './adapters/rest.adapter';
import { CsvSyncAdapter } from './adapters/csv.adapter';
import { SqlSyncAdapter, assertSelectOnly } from './adapters/sql.adapter';
import { SyncSourcesService } from './sync-sources.service';
import { cronDueWithin, matchesCron } from './cron.util';
import { DriverNotInstalled, HttpFetcher, SourceConfigError } from './sync.types';
import { sanitizeUploadName } from './upload.util';

const pageOf = (items: unknown[]) => ({ data: { items } });

const stubFetcher = (pagesByPage: Record<string, unknown[]>): HttpFetcher & { urls: string[] } => ({
  urls: [],
  async getJson(url: string, headers?: Record<string, string>) {
    this.urls.push(url);
    void headers;
    const u = new URL(url);
    const p = u.searchParams.get('page') || '1';
    return pageOf(pagesByPage[p] ?? []);
  },
});

describe('RestSyncAdapter', () => {
  it('maps nested path + field map + paginates until a short page', async () => {
    const fetcher = stubFetcher({
      '1': [
        { emp_id: 'E1', full_name: 'Ahmed', mobile: '01000000001', role: 'driver', unit: 'ORG1', site: 'S1' },
        { emp_id: 'E2', full_name: 'Mona', mobile: '01100000002', role: 'EMPLOYEE', unit: 'ORG1', zone: 'Z1' },
      ],
      '2': [{ emp_id: 'E3', full_name: 'Sameh', mobile: '01100000003' }],
    });
    const adapter = new RestSyncAdapter(fetcher);
    const rows = await adapter.fetch({
      sourceUrl: 'https://hr.example/employees',
      token: 't0ken',
      nested: 'data.items',
      pageParam: 'page',
      sizeParam: 'size',
      pageSize: 2,
      map: { externalId: 'emp_id', name: 'full_name', phone: 'mobile', role: 'role', orgUnit: 'unit', site: 'site', zone: 'zone' },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ externalId: 'E1', name: 'Ahmed', phoneE164: '01000000001', roleHint: 'driver', siteCode: 'S1' });
    expect(rows[2]).toMatchObject({ externalId: 'E3', roleHint: undefined });
    const first = new URL(fetcher.urls[0]);
    expect(first.searchParams.get('size')).toBe('2');
    expect(fetcher.urls).toHaveLength(2);
  });

  it('hard-caps records and fails loudly (truncated fetch must NOT trigger deactivation)', async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ externalId: `E${i}`, name: 'n', phone: '0100000000' + i }));
    const fetcher: HttpFetcher = {
      async getJson(url: string) {
        const p = new URL(url).searchParams.get('page');
        return p === '99' ? [] : many;
      },
    };
    const adapter = new RestSyncAdapter(fetcher);
    await expect(adapter.fetch({ sourceUrl: 'http://x/y', pageSize: 3, maxRecords: 5, map: {} })).rejects.toThrow(/REST_CAP_EXCEEDED/);
  });

  it('rejects a non-array shape at config.nested', async () => {
    const adapter = new RestSyncAdapter({ async getJson() { return { oops: 1 }; } });
    await expect(adapter.fetch({ sourceUrl: 'http://x/y', nested: 'data.items' })).rejects.toThrow(SourceConfigError);
  });
});

describe('CsvSyncAdapter', () => {
  const csv = new CsvSyncAdapter();
  it('parses the sample header shape exactly', () => {
    const text = [
      'externalId,name,phone,roleHint,siteCode,zoneCode,orgUnit',
      'E1,Ahmed,01000000001,EMPLOYEE,HR1,,CAIRO',
      'E2,Mona,+201100000002,DRIVER,,Z1,GIZA',
    ].join('\n');
    const rows = csv.parseText(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      externalId: 'E1', name: 'Ahmed', phoneE164: '01000000001', roleHint: 'EMPLOYEE',
      siteCode: 'HR1', zoneCode: undefined, orgUnit: 'CAIRO', active: undefined,
    });
    expect(rows[1].zoneCode).toBe('Z1');
  });
  it('rejects a header without externalId', () => {
    expect(() => csv.parseText('id,nom\n1,2')).toThrow(/CSV_HEADER_MISMATCH/);
  });
});

describe('SqlSyncAdapter', () => {
  const sql = new SqlSyncAdapter();
  it('accepts clean SELECTs and rejects anything else', () => {
    expect(assertSelectOnly('SELECT id FROM emp')).toBe('SELECT id FROM emp');
    expect(assertSelectOnly('SELECT id FROM emp;')).toBe('SELECT id FROM emp');
    expect(() => assertSelectOnly('SELECT 1; DROP TABLE emp')).toThrow(/QUERY_NOT_SELECT_ONLY/);
    expect(() => assertSelectOnly('UPDATE emp SET x=1')).toThrow(/QUERY_NOT_SELECT_ONLY/);
    expect(() => assertSelectOnly('DELETE FROM emp')).toThrow(/QUERY_NOT_SELECT_ONLY/);
  });
  it('whitelists identifiers from table/map', async () => {
    await expect(sql.fetch({ connectionString: 'postgresql://u:p@h/db', table: 'emp; DROP x' })).rejects.toThrow(/BAD_IDENTIFIER/);
    await expect(sql.fetch({ connectionString: 'postgresql://u:p@h/db', map: { phone: 'ph; --' } })).rejects.toThrow(/BAD_IDENTIFIER/);
  });
  it('infers dialect from connection string', () => {
    expect(SqlSyncAdapter.inferDialect('postgresql://x')).toBe('pg');
    expect(SqlSyncAdapter.inferDialect('mysql://x')).toBe('mysql');
    expect(SqlSyncAdapter.inferDialect('mssql://x')).toBe('mssql');
    expect(SqlSyncAdapter.inferDialect('oracle://x')).toBe('oracle');
  });
  it('fails with DriverNotInstalled telling the operator the exact npm package', async () => {
    for (const [dialect, pkg] of [['mssql', 'mssql'], ['mysql', 'mysql2'], ['oracle', 'oracledb']] as const) {
      await expect(sql.fetch({ connectionString: `${dialect}://x`, dialect })).rejects.toBeInstanceOf(DriverNotInstalled);
      await expect(sql.fetch({ connectionString: `${dialect}://x`, dialect })).rejects.toThrow(new RegExp(`npm i ${pkg}`));
    }
  });
});

describe('SyncSourcesService.maskConfig', () => {
  const svc = new SyncSourcesService({} as never);
  it('never returns tokens/secrets or connection-string passwords in clear text', () => {
    const masked = JSON.parse(
      svc.maskConfig(JSON.stringify({ sourceUrl: 'https://x/api', token: 'sup3r', secret: 'wh-s3cr3t', connectionString: 'postgresql://hr:MyPassword@db:5432/hr' })),
    );
    expect(masked.token).toBe('****');
    expect(masked.secret).toBe('****');
    expect(masked.connectionString).toBe('postgresql://hr:****@db:5432/hr');
    expect(masked.sourceUrl).toBe('https://x/api');
  });
});

describe('cron.util', () => {
  it('matches 6-field cron at second precision', () => {
    expect(matchesCron('0 */15 * * * *', new Date('2026-10-22T12:15:00Z'))).toBe(true);
    expect(matchesCron('0 */15 * * * *', new Date('2026-10-22T12:15:30Z'))).toBe(false);
    expect(matchesCron('0 */15 * * * *', new Date('2026-10-22T12:07:00Z'))).toBe(false);
    expect(matchesCron('* * * * * *', new Date('2026-10-22T12:07:31Z'))).toBe(true);
    expect(matchesCron('bad expr', new Date())).toBe(false);
  });
  it('cronDueWithin covers a firing inside the last minute only', () => {
    expect(cronDueWithin('0 */15 * * * *', new Date('2026-10-22T12:15:20Z'), 60_000)).toBe(true);
    expect(cronDueWithin('0 */15 * * * *', new Date('2026-10-22T12:14:20Z'), 60_000)).toBe(false);
  });
});

describe('upload sanitization', () => {
  it('kills path traversal and weird chars', () => {
    expect(sanitizeUploadName('../../evil/name.csv')).toMatch(/\.csv$/);
    expect(sanitizeUploadName('../../../etc/passwd')).not.toMatch(/[\/]|\.\./);
    expect(sanitizeUploadName('مرحبا employees.csv')).toMatch(/\.csv$/);
    expect(sanitizeUploadName('')).toMatch(/upload\.csv$/);
  });
});
