import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import { SyncModule } from './sync.module';
import { SyncService } from './sync.service';
import { SyncSourcesService } from './sync-sources.service';
import { SyncScheduler } from './sync.scheduler';
import { SyncController } from './sync.controller';
import { PrismaService } from '../../common/prisma.service';

// —— البيئة قبل أي اتصال (sqlite مؤقت خاص بالاختبار) ——
process.env.DATABASE_URL = 'file:./tmp-sync-e2e.db';
process.env.ADMIN_INIT_PASSWORD = 'Init#1234';
process.env.SYNC_WEBHOOK_SECRET = 'wh-global-secret';
process.env.SYNC_SCHEDULER_DISABLED = 'true';
const API_DIR = path.resolve(__dirname, '../../..'); // apps/api
const DATA_DIR = path.resolve(__dirname, 'tmp-e2e-data');
process.env.SYNC_DATA_DIR = DATA_DIR;
const UPLOADS = path.join(DATA_DIR, 'uploads');

const CSV_HEADER = 'externalId,name,phone,roleHint,siteCode,zoneCode,orgUnit';
const ROW_E1 = 'E1,Ahmed Farouk,01000000001,EMPLOYEE,HR1,,CAIRO';
const ROW_E2 = 'E2,Mona Samir,+201100000002,DRIVER,,Z1,GIZA';
const ROW_E2_NEW = 'E2,Mona Samir,01199999999,DRIVER,,Z1,GIZA';
const ROW_E3 = 'E3,Sameh Bad,not-a-phone,EMPLOYEE,NOSITE,,CAIRO';

const csv = (...rows: string[]) => [CSV_HEADER, ...rows].join('\n');

let prisma: PrismaService;
let sync: SyncService;
let sources: SyncSourcesService;
let scheduler: SyncScheduler;
let controller: SyncController;
let moduleRef: INestApplicationContext;

async function waitRun(runId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await prisma.syncRun.findUnique({ where: { id: runId }, include: { issues: true } });
    if (run && run.finishedAt) return run;
    if (Date.now() > deadline) throw new Error(`sync run ${runId} still RUNNING after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function writeCsvFile(name: string, content: string): string {
  mkdirSync(UPLOADS, { recursive: true });
  const p = path.join(UPLOADS, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

beforeAll(async () => {
  rmSync(path.join(API_DIR, 'prisma', 'tmp-sync-e2e.db'), { force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
  execSync('npx prisma db push --skip-generate', {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: 'file:./tmp-sync-e2e.db' },
    stdio: 'ignore',
  });
  const testing = await Test.createTestingModule({ imports: [SyncModule] }).compile();
  await testing.init();
  moduleRef = testing;
  prisma = testing.get(PrismaService);
  sync = testing.get(SyncService);
  sources = testing.get(SyncSourcesService);
  scheduler = testing.get(SyncScheduler);
  controller = testing.get(SyncController);
});

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(path.join(API_DIR, 'prisma', 'tmp-sync-e2e.db'), { force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

let csvPath = '';
let sourceId = '';

beforeEach(async () => {
  // نظيف لكل اختبار — بالترتيب لعلاقات FK
  await prisma.syncIssue.deleteMany({});
  await prisma.syncRun.deleteMany({});
  await prisma.syncSource.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.attendanceRecord.deleteMany({});
  await prisma.employee.deleteMany({});
  await prisma.setting.deleteMany({});
  await prisma.zone.deleteMany({});
  await prisma.site.deleteMany({});
  await prisma.orgUnit.deleteMany({});
  const root = await prisma.orgUnit.create({ data: { code: 'ROOT', name: 'Uni Group' } });
  await prisma.site.create({ data: { code: 'HR1', name: 'HQ Cairo', orgUnitId: root.id, lat: 30.0444, lng: 31.2357 } });
  await prisma.zone.create({ data: { code: 'Z1', name: 'Giza Zone', orgUnitId: root.id, lat: 30.01, lng: 31.21 } });
  csvPath = writeCsvFile('staff.csv', csv(ROW_E1, ROW_E2, ROW_E3));
  const src = await sources.create({ code: 'hr_csv', name: 'HR CSV', kind: 'csv', config: { filePath: csvPath } });
  sourceId = (src as { id: string }).id;
});

describe('SyncService — csv → sqlite (CONTRACT §8)', () => {
  it('full sync creates employees + users, flags phone/site issues, never blocks the row', async () => {
    const { runId } = await sync.startRun({ sourceId }, 'MANUAL');
    const run = await waitRun(runId);
    expect(run.status).toBe('PARTIAL'); // به مشاكل E3
    expect(run.scanned).toBe(3);
    expect(run.created).toBe(3);
    expect(run.updated).toBe(0);
    expect(run.error).toBe('noPhone=1');

    const e1 = await prisma.employee.findUnique({ where: { externalId: 'E1' }, include: { user: true, site: true } });
    expect(e1?.phone).toBe('+201000000001'); // 010… → +20
    expect(e1?.site?.code).toBe('HR1');
    expect(e1?.source).toBe('MASTER');
    expect(e1?.syncedAt).toBeTruthy();
    expect(e1?.user?.identifier).toBe('E1');
    expect(e1?.user?.role).toBe('EMPLOYEE');
    expect(e1?.user?.mustChangePassword).toBe(true);
    expect(await bcrypt.compare('Init#1234', e1?.user?.passwordHash ?? '')).toBe(true);

    const e2 = await prisma.employee.findUnique({ where: { externalId: 'E2' }, include: { user: true, zone: true } });
    expect(e2?.kind).toBe('DRIVER');
    expect(e2?.user?.role).toBe('DRIVER'); // سواق ⇒ حساب DRIVER
    expect(e2?.zone?.code).toBe('Z1');

    const e3 = await prisma.employee.findUnique({ where: { externalId: 'E3' } });
    expect(e3?.phone).toBe(''); // يُزامن بلا هاتف ويُوسم — لا فشل صامت
    expect(e3?.active).toBe(true);
    expect(await prisma.user.findFirst({ where: { identifier: 'E3' } })).toBeNull(); // لا حساب بدون هاتف

    const reasons = run.issues.map((i) => i.reason).sort();
    expect(reasons).toEqual(['MISSING_PHONE', 'UNKNOWN_SITE']);
    const orgs = await prisma.orgUnit.findMany({ select: { code: true } });
    expect(orgs.map((o) => o.code).sort()).toEqual(['CAIRO', 'GIZA', 'ROOT']); // orgUnit resolve/create
  });

  it('idempotency proof — same source twice: created=N then created=0 updated=0', async () => {
    const first = await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    expect(first.created).toBe(3);
    const second = await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(3);
    expect(await prisma.employee.count()).toBe(3); // صفر تكرار أبدًا
    expect(await prisma.user.count()).toBe(2);
  });

  it('phone change → exactly 1 updated', async () => {
    await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    writeCsvFile('staff.csv', csv(ROW_E1, ROW_E2_NEW, ROW_E3));
    const run = await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    expect(run.updated).toBe(1);
    expect(run.created).toBe(0);
    expect(run.unchanged).toBe(2);
    expect((await prisma.employee.findUnique({ where: { externalId: 'E2' } }))?.phone).toBe('+201199999999');
  });

  it('disappeared record → active:false, never deleted, attendance history intact', async () => {
    await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    const e1 = await prisma.employee.findUnique({ where: { externalId: 'E1' } });
    await prisma.attendanceRecord.create({
      data: { employeeId: e1!.id, workDate: '2026-10-21', status: 'VALID', checkInAt: new Date() },
    });
    writeCsvFile('staff.csv', csv(ROW_E2, ROW_E3)); // E1 اختفى من الداتا الرئيسية
    const run = await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    expect(run.deactivated).toBe(1);
    const gone = await prisma.employee.findUnique({ where: { externalId: 'E1' } });
    expect(gone).not.toBeNull();
    expect(gone!.active).toBe(false);
    expect(await prisma.attendanceRecord.count({ where: { employeeId: gone!.id } })).toBe(1);
    expect(await prisma.user.count({ where: { identifier: 'E1' } })).toBe(1); // الحساب لم يُحذف
    expect(run.issues.some((i) => i.reason === 'DEACTIVATED' && i.externalId === 'E1')).toBe(true);
  });
});

describe('SyncService — issues that must not corrupt accounts', () => {
  it('identifier collision → SyncIssue, existing user untouched (no login hijack)', async () => {
    const other = await prisma.employee.create({
      data: { externalId: 'E0-LEGACY', name: 'Legacy', phone: '+201000000000', source: 'MANUAL' },
    });
    await prisma.user.create({
      data: { identifier: 'E2', passwordHash: 'OLD-HASH-DO-NOT-TOUCH', role: 'ADMIN', name: 'Impostor', employeeId: other.id },
    });
    writeCsvFile('staff.csv', csv(ROW_E2));
    const run = await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    expect(run.created).toBe(1);
    expect(run.issues.some((i) => i.reason === 'IDENTIFIER_COLLISION' && i.externalId === 'E2')).toBe(true);
    const u = await prisma.user.findUnique({ where: { identifier: 'E2' } });
    expect(u!.passwordHash).toBe('OLD-HASH-DO-NOT-TOUCH');
    expect(u!.employeeId).toBe(other.id); // لم تُسرق الحسابية
  });

  it('overlap guard — RUNNING run for same source ⇒ skip + SKIPPED_OVERLAP record', async () => {
    const blocking = await prisma.syncRun.create({ data: { sourceId, trigger: 'MANUAL', status: 'RUNNING' } });
    const res = await sync.startRun({ sourceId }, 'CRON');
    expect(res.skippedOverlap).toBe(true);
    expect(res.runId).toBe(blocking.id);
    const issues = await prisma.syncIssue.findMany({ where: { runId: blocking.id } });
    expect(issues.some((i) => i.reason === 'SKIPPED_OVERLAP')).toBe(true);
    // لا يوجد تشغيل RUNNING ثانٍ
    expect(await prisma.syncRun.count({ where: { sourceId, status: 'RUNNING' } })).toBe(1);
  });

  it('failed adapter ⇒ run FAILED with coded error, no partial mutations', async () => {
    const src = await sources.create({ code: 'rest_bad', name: 'Bad REST', kind: 'rest', config: { nested: 'nope' } });
    const run = await waitRun((await sync.startRun({ sourceId: (src as { id: string }).id }, 'MANUAL')).runId);
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/BAD_CONFIG/);
    expect(await prisma.employee.count()).toBe(0);
  });
});

describe('webhook — public route guarded ONLY by x-sync-secret', () => {
  it('wrong secret ⇒ 401', async () => {
    await expect(controller.webhook(sourceId, 'totally-wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.webhook(sourceId, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.webhook(undefined, 'wh-global-secret')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('env secret accepted, config.secret overrides it, async run starts', async () => {
    const ok = await controller.webhook(sourceId, 'wh-global-secret');
    expect(ok.status).toBe('RUNNING');
    await waitRun(ok.runId);

    await sources.update(sourceId, { config: { filePath: csvPath, secret: 'per-source-s3cr3t' } });
    await expect(controller.webhook(sourceId, 'wh-global-secret')).rejects.toBeInstanceOf(UnauthorizedException);
    const second = await controller.webhook(sourceId, 'per-source-s3cr3t');
    await waitRun(second.runId);
    const runs = await prisma.syncRun.findMany({ where: { sourceId } });
    expect(runs.filter((r) => r.trigger === 'WEBHOOK').length).toBeGreaterThanOrEqual(2);
  });
});

describe('sources API — secrets never leave in clear text', () => {
  it('masked token/secret/connectionString password in GET responses', async () => {
    await controller.createSource({
      code: 'hr_rest', name: 'HR REST', kind: 'rest',
      config: { sourceUrl: 'https://hr.example/api', token: 'SUP3R-T0KEN', secret: 'WH-SEC' },
    });
    await controller.createSource({
      code: 'hr_sql', name: 'HR SQL', kind: 'sql',
      config: { connectionString: 'postgresql://hr:Str0ngPass@db.internal:5432/hr', table: 'employees' },
    });
    const list = (await controller.listSources()) as { code: string; config: string }[];
    const rest = list.find((s) => s.code === 'hr_rest')!;
    const sqls = list.find((s) => s.code === 'hr_sql')!;
    expect(rest.config).not.toContain('SUP3R-T0KEN');
    expect(rest.config).not.toContain('WH-SEC');
    expect(JSON.parse(rest.config).token).toBe('****');
    expect(sqls.config).not.toContain('Str0ngPass');
    expect(JSON.parse(sqls.config).connectionString).toBe('postgresql://hr:****@db.internal:5432/hr');
    const detail = (await controller.getRun('nope').catch(() => null));
    expect(detail).toBeNull(); // run غير موجود ⇒ 404 عبر NotFoundException
  });

  it('update with masked config preserves live secrets; enable/disable via toggle', async () => {
    const created = (await controller.createSource({ code: 'hr_rest2', name: 'R2', kind: 'rest', config: { sourceUrl: 'https://a', token: 'LIVE-TOKEN' } })) as { id: string; config: string };
    await controller.updateSource(created.id, { config: { sourceUrl: 'https://b', token: '****' } });
    const live = await prisma.syncSource.findUnique({ where: { id: created.id } });
    expect(JSON.parse(live!.config).token).toBe('LIVE-TOKEN'); // السر الحقيقي محفوظ
    expect(JSON.parse(live!.config).sourceUrl).toBe('https://b');
    await controller.toggleSource(created.id, { enabled: false });
    expect((await prisma.syncSource.findUnique({ where: { id: created.id } }))!.enabled).toBe(false);
  });
});

describe('matrix / preview / ad-hoc / scheduler / issue resolution', () => {
  it('GET /sync/matrix — freshness + reachability per synced employee', async () => {
    await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    const matrix = (await controller.matrix()) as Record<string, unknown>[];
    expect(matrix).toHaveLength(3);
    const e1 = matrix.find((m) => m.externalId === 'E1')!;
    expect(Object.keys(e1).sort()).toEqual([
      'active', 'employeeId', 'externalId', 'hasAccount', 'hasPhone', 'kind', 'lastSyncedAt',
      'mustChangePassword', 'name', 'orgUnitCode', 'phone', 'siteCode', 'source', 'zoneCode',
    ]);
    expect(e1.hasPhone).toBe(true);
    expect(e1.hasAccount).toBe(true);
    expect(e1.siteCode).toBe('HR1');
    const e3 = matrix.find((m) => m.externalId === 'E3')!;
    expect(e3.hasPhone).toBe(false);
    expect(e3.siteCode).toBeNull(); // مجهول ⇒ بلا تعيين لكن موجود
    expect(matrix.every((m) => m.lastSyncedAt)).toBe(true);
  });

  it('POST /sync/preview-upload — sanitized filename inside _data/uploads, rows previewed, nothing written', async () => {
    const res = controller.previewUpload({
      originalname: '../../../evil/اسماء staff.csv',
      buffer: Buffer.from(csv(ROW_E1, ROW_E3), 'utf8'),
    }) as { totalRows: number; rowIssues: unknown[]; filePath: string };
    expect(res.totalRows).toBe(2);
    expect(res.rowIssues).toEqual([{ row: 3, externalId: 'E3', reason: 'MISSING_PHONE' }]);
    expect(res.filePath.startsWith(path.join(DATA_DIR, 'uploads'))).toBe(true);
    expect(res.filePath).not.toMatch(/\.\./);
    expect(await prisma.employee.count()).toBe(0); // preview لا يلمس الداتا
  });

  it('ad-hoc run by kind+filePath (no sourceId) works and stores an ADHOC disabled source', async () => {
    const { runId } = await sync.startRun({ kind: 'csv', filePath: csvPath }, 'MANUAL');
    const run = await waitRun(runId);
    expect(run.created).toBe(3);
    const adhoc = await prisma.syncSource.findFirst({ where: { kind: 'csv', enabled: false, code: { startsWith: 'ADHOC' } } });
    expect(adhoc).not.toBeNull();
  });

  it('scheduler tick starts CRON runs only for due sources', async () => {
    process.env.SYNC_SCHEDULER_DISABLED = 'false';
    try {
      await prisma.syncSource.update({ where: { id: sourceId }, data: { scheduleCron: '* * * * * *' } });
      const disabled = await sources.create({ code: 'off_src', name: 'Off', kind: 'csv', config: { filePath: csvPath }, enabled: false });
      void disabled;
      const now = new Date();
      await scheduler.tick(now);
      const cronRuns = await prisma.syncRun.findMany({ where: { trigger: 'CRON' } });
      expect(cronRuns.length).toBe(1);
      const run = await waitRun(cronRuns[0].id);
      expect(run.scanned).toBe(3);
      // مصدر بموعد بعيد جدًا لا يُشغَّل
      await prisma.syncIssue.deleteMany({});
      await prisma.syncRun.deleteMany({});
      await prisma.syncSource.update({ where: { id: sourceId }, data: { scheduleCron: '0 0 3 1 1 *', lastRunAt: null } });
      await scheduler.tick(now);
      expect(await prisma.syncRun.count({ where: { trigger: 'CRON' } })).toBe(0);
    } finally {
      process.env.SYNC_SCHEDULER_DISABLED = 'true';
    }
  });

  it('GET /sync/issues?resolved=false + POST resolve flips the flag', async () => {
    await waitRun((await sync.startRun({ sourceId }, 'MANUAL')).runId);
    const open = (await controller.listIssues({})) as { id: string; reason: string; resolved: boolean }[];
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((i) => i.resolved === false)).toBe(true);
    const target = open.find((i) => i.reason === 'UNKNOWN_SITE')!;
    await controller.resolveIssue(target.id);
    const after = (await controller.listIssues({ resolved: false })) as { id: string }[];
    expect(after.find((i) => i.id === target.id)).toBeUndefined();
  });
});
