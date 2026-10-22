import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../../common/prisma.module';
import { PrismaService } from '../../common/prisma.service';
import { GeoModule } from '../../common/geo/geo.module';
import { ReportsService } from './reports.service';
import { toCsv } from './csv';

const DB = 'file:../tmp-track-reports.db';
process.env.DATABASE_URL = DB;
jest.setTimeout(120_000);

let prisma: PrismaService;
let reports: ReportsService;

beforeAll(() => {
  try {
    rmSync('tmp-track-reports.db', { force: true });
    rmSync('tmp-track-reports.db-journal', { force: true });
  } catch {
    /* ignore */
  }
  execSync('npx prisma db push --skip-generate', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: DB }, stdio: 'pipe' });
});

beforeAll(async () => {
  const m = await Test.createTestingModule({
    imports: [PrismaModule, GeoModule],
    providers: [ReportsService],
  }).compile();
  await m.init();
  prisma = m.get(PrismaService);
  reports = m.get(ReportsService);
});

afterAll(async () => {
  try {
    await prisma?.$disconnect();
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  await prisma.notificationLog.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.stopEvent.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.position.deleteMany();
  await prisma.routeLine.deleteMany();
  await prisma.attendanceRecord.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.zone.deleteMany();
  await prisma.orgUnit.deleteMany();
});

async function seedDriver(name = 'محمد سعيد') {
  const org = await prisma.orgUnit.create({ data: { code: `o-${Math.random()}`, name: 'Org' } });
  const emp = await prisma.employee.create({ data: { externalId: `e-${Math.random()}`, name, phone: '+201000000001', kind: 'DRIVER', orgUnitId: org.id } });
  const user = await prisma.user.create({ data: { identifier: `u-${Math.random()}`, passwordHash: 'x', role: 'DRIVER', name, employeeId: emp.id } });
  const device = await prisma.device.create({ data: { deviceId: `d-${Math.random()}`, employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, lastSeenAt: new Date(Date.now() - 40 * 60_000) } });
  const now = Date.now();
  await prisma.position.create({ data: { employeeId: emp.id, deviceId: device.id, clientTs: new Date(now), serverTs: new Date(now), lat: 30.0, lng: 31.0, speedKmh: 65, motionState: 'RIDING', ingestHash: `h1-${emp.id}`, insideZone: true } });
  await prisma.position.create({ data: { employeeId: emp.id, deviceId: device.id, clientTs: new Date(now + 10_000), serverTs: new Date(now), lat: 30.01, lng: 31.0, speedKmh: 0, motionState: 'STOPPED', ingestHash: `h2-${emp.id}` } });
  await prisma.trip.create({ data: { employeeId: emp.id, startedAt: new Date(now), endedAt: new Date(now + 60_000), distanceKm: 12.5, maxSpeedKmh: 88, state: 'CLOSED' } });
  await prisma.stopEvent.create({ data: { employeeId: emp.id, lat: 30.01, lng: 31.0, startedAt: new Date(now + 10_000), endedAt: new Date(now + 600_000), durationS: 590, kind: 'UNPLANNED' } });
  await prisma.alert.create({ data: { type: 'SPEEDING', severity: 'CRITICAL', employeeId: emp.id, title: 't', body: 'b', meta: '{}', status: 'OPEN', cooldownKey: `${emp.id}:SPEEDING` } });
  return { employeeId: emp.id, userId: user.id };
}

describe('Reports (CONTRACT §9)', () => {
  it('/reports/live-kpis returns the exact 5-card shape', async () => {
    await seedDriver();
    const k = await reports.liveKpis();
    expect(k).toEqual({
      activeDrivers: expect.any(Number),
      openAlerts: expect.any(Number),
      criticalAlerts: expect.any(Number),
      offlineDrivers: expect.any(Number),
      avgSpeedToday: expect.any(Number),
      generatedAt: expect.any(String),
    });
    expect(k.openAlerts).toBeGreaterThanOrEqual(1);
    expect(k.criticalAlerts).toBeGreaterThanOrEqual(1);
    expect(k.activeDrivers).toBeGreaterThanOrEqual(1);
  });

  it('/reports/daily returns the dashboard envelope { date, kpis, alertsByType, hourlyPositions } (CSV surface kept)', async () => {
    const { employeeId } = await seedDriver();
    const date = new Date().toISOString().slice(0, 10);
    const r = await reports.daily(date);
    expect(r.headers).toContain('distanceKm'); // stable Arabic-safe CSV columns
    expect(r.rows.length).toBe(1);
    const body = r.body as any;
    expect(body.date).toBe(date);
    expect(Object.keys(body.kpis).sort()).toEqual([
      'absent', 'activeDrivers', 'criticalAlerts', 'exceptions', 'kmDriven', 'offlineMinutes', 'openAlerts', 'present',
    ]);
    expect(body.kpis.openAlerts).toBeGreaterThanOrEqual(1);
    expect(body.kpis.criticalAlerts).toBeGreaterThanOrEqual(1);
    expect(body.kpis.activeDrivers).toBeGreaterThanOrEqual(1); // DRIVER kind with positions today
    expect(body.kpis.kmDriven).toBeGreaterThanOrEqual(12.5);
    expect(body.alertsByType).toEqual([
      { type: expect.any(String), count: expect.any(Number), open: expect.any(Number) },
    ]);
    expect(body.hourlyPositions.length).toBeGreaterThan(0);
    expect(body.hourlyPositions[0]).toEqual({ hour: expect.any(Number), count: expect.any(Number) });
    void employeeId;
  });

  it('/reports/mileage returns object rows { label, km, ridingMin, replayedKm } + totalKm', async () => {
    await seedDriver();
    const date = new Date().toISOString().slice(0, 10);
    const r = await reports.mileage(date, date, 'driver');
    const body = r.body as any;
    expect(body.rows).toHaveLength(1);
    expect(Object.keys(body.rows[0]).sort()).toEqual(['key', 'km', 'label', 'replayedKm', 'ridingMin']);
    expect(body.rows[0].label).toContain('محمد');
    expect(body.rows[0].km).toBe(12.5);
    expect(body.rows[0].replayedKm).toBe(0);
    expect(typeof body.rows[0].ridingMin).toBe('number');
    expect(body.totalKm).toBe(12.5);
    expect(body.groupBy).toBe('driver');
  });

  it('/reports/exceptions returns grouped rows { type, count, unresolved } + total/unresolved', async () => {
    const { employeeId } = await seedDriver();
    await prisma.alert.create({
      data: { type: 'SPEEDING', severity: 'WARNING', employeeId, title: 't', body: 'b', meta: '{}', status: 'RESOLVED', cooldownKey: `${employeeId}:S2` },
    });
    // page-style call: from=to=date → the service expands to the full day
    const date = new Date().toISOString().slice(0, 10);
    const r = await reports.exceptions(date, date);
    const body = r.body as any;
    expect(body.rows).toHaveLength(1); // one type: SPEEDING x2
    expect(body.rows[0]).toMatchObject({ type: 'SPEEDING', count: 2, unresolved: 1 });
    expect(body.total).toBe(2);
    expect(body.unresolved).toBe(1);
  });

  it('/reports/timesheet returns object rows { userId, userName, date, checkIn, checkOut, hoursWorked, status, replayed }', async () => {
    const { employeeId } = await seedDriver();
    const date = new Date().toISOString().slice(0, 10);
    await prisma.attendanceRecord.create({
      data: {
        employeeId, workDate: date, status: 'VALID',
        checkInAt: new Date(`${date}T06:00:00Z`), checkOutAt: new Date(`${date}T14:00:00Z`),
      },
    });
    const r = await reports.timesheet(date, date);
    const body = r.body as any;
    expect(body.rows).toHaveLength(1);
    expect(Object.keys(body.rows[0]).sort()).toEqual([
      'checkIn', 'checkOut', 'date', 'hoursWorked', 'replayed', 'status', 'userId', 'userName',
    ]);
    expect(body.rows[0].userId).toBe(employeeId);
    expect(body.rows[0].date).toBe(date);
    expect(body.rows[0].hoursWorked).toBe(8);
    expect(body.rows[0].status).toBe('VALID');
    expect(body.rows[0].replayed).toBe(false);
  });

  it('CSV export is BOM-prefixed and escapes Arabic + commas', async () => {
    const { employeeId } = await seedDriver('علي, الإبن');
    const date = new Date().toISOString().slice(0, 10);
    const r = await reports.daily(date);
    const csv = toCsv(r.headers, r.rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(csv).toContain('"علي, الإبن"'); // ASCII comma forces quoting; Arabic preserved
    void employeeId;
  });
});
