import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { PrismaService } from '../../common/prisma.service';
import { PositionsService } from '../tracking/positions.service';
import { OpsResetService, RESET_CONFIRM } from './ops-reset.service';

// Isolated temp sqlite DB — apps/api/tmp-*.db is gitignored.
const DB = 'file:../tmp-ops-reset.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(120_000);

let prisma: PrismaService;
let reset: OpsResetService;
const cleared = jest.fn();

beforeAll(() => {
  try {
    rmSync('tmp-ops-reset.db', { force: true });
    rmSync('tmp-ops-reset.db-journal', { force: true });
  } catch {
    /* ignore */
  }
  execSync('npx prisma db push --skip-generate', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });
});

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [OpsResetService, { provide: PositionsService, useValue: { clearTrack: cleared } }],
  }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  reset = moduleRef.get(OpsResetService);
});

/** One row in every cleared table plus everything that must survive, so ordering has to be right. */
async function seed(): Promise<{ employeeId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: 'ops-org', name: 'Org' } });
  const site = await prisma.site.create({
    data: { code: 'ops-site', name: 'Site', orgUnitId: org.id, lat: 30.04, lng: 31.23, radiusM: 250 },
  });
  const zone = await prisma.zone.create({
    data: { code: 'ops-zone', name: 'Zone', orgUnitId: org.id, lat: 30.06, lng: 31.33, radiusM: 6000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: 'ops-d1', name: 'سائق', phone: '+201000000001', kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id, siteId: site.id },
  });
  const user = await prisma.user.create({
    data: { identifier: 'ops-d1', passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: 'ops-dev', employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, lastSeenAt: new Date() },
  });
  const schedule = await prisma.shiftSchedule.create({
    data: { code: 'ops-sched', name: 'Shift', startMinDay: 480, endMinDay: 1080 },
  });
  await prisma.shiftAssignment.create({ data: { employeeId: emp.id, scheduleId: schedule.id, weekday: null } });
  await prisma.ruleOverride.create({ data: { employeeId: emp.id, stopAlertMin: 5 } });
  await prisma.setting.create({ data: { key: 'rules.global', value: '{"stopAlertMin":5}' } });
  await prisma.userPreference.create({ data: { userId: user.id, key: 'theme', value: 'light' } });
  await prisma.syncSource.create({ data: { code: 'ops-src', name: 'Src', kind: 'csv', config: '{}' } });

  const trip = await prisma.trip.create({ data: { employeeId: emp.id, startedAt: new Date(), zoneId: zone.id, state: 'CLOSED' } });
  await prisma.position.create({
    data: { employeeId: emp.id, deviceId: device.id, tripId: trip.id, clientTs: new Date(), lat: 30.06, lng: 31.33, motionState: 'STOPPED', ingestHash: 'ops-hash' },
  });
  await prisma.stopEvent.create({ data: { employeeId: emp.id, tripId: trip.id, zoneId: zone.id, lat: 30.06, lng: 31.33, startedAt: new Date() } });
  await prisma.routeLine.create({ data: { employeeId: emp.id, workDate: '2026-10-25', geojson: '{"type":"LineString","coordinates":[]}' } });
  await prisma.geoEvent.create({ data: { deviceId: device.id, employeeId: emp.id, kind: 'GPS_ON', at: new Date() } });

  const alert = await prisma.alert.create({
    data: { type: 'STOP_EXCEEDED', severity: 'WARNING', employeeId: emp.id, userId: user.id, title: 't', body: 'b', meta: '{}', cooldownKey: '' },
  });
  await prisma.callLog.create({ data: { alertId: alert.id, userId: user.id, called: true } });
  await prisma.notificationLog.create({ data: { alertId: alert.id, userId: user.id, channel: 'SOCKET', target: 'u', status: 'SENT' } });

  await prisma.attendanceRecord.create({ data: { employeeId: emp.id, workDate: '2026-10-25', status: 'VALID', siteId: site.id } });
  await prisma.leaveRequest.create({ data: { employeeId: emp.id, dateFrom: '2026-10-26', dateTo: '2026-10-26', decidedById: user.id } });

  const run = await prisma.syncRun.create({ data: { sourceId: (await prisma.syncSource.findFirstOrThrow()).id, trigger: 'MANUAL', status: 'SUCCESS' } });
  await prisma.syncIssue.create({ data: { runId: run.id, externalId: 'ops-d1', reason: 'DUPLICATE' } });

  return { employeeId: emp.id };
}

const opsTotal = async (): Promise<number> => {
  const plan = await reset.plan();
  return plan.total;
};

beforeEach(async () => {
  cleared.mockClear();
  for (const t of ['syncIssue', 'syncRun', 'syncSource', 'leaveRequest', 'attendanceRecord', 'callLog', 'notificationLog', 'alert', 'position', 'stopEvent', 'routeLine', 'geoEvent', 'trip', 'userPreference', 'setting', 'ruleOverride', 'shiftAssignment', 'shiftSchedule', 'device', 'user', 'employee', 'zone', 'site', 'orgUnit'] as const) {
    await (prisma as unknown as Record<string, { deleteMany(): Promise<unknown> }>)[t].deleteMany();
  }
});

afterAll(async () => {
  try {
    await prisma?.$disconnect();
  } catch {
    /* ignore */
  }
});

describe('POST /ops/reset-data', () => {
  it('previews the whole operational history without deleting it', async () => {
    await seed();
    const plan = await reset.plan();
    expect(plan.apply).toBe(false);
    expect(plan.wouldDelete).toMatchObject({ Trip: 1, Position: 1, Alert: 1, AttendanceRecord: 1, LeaveRequest: 1, SyncRun: 1 });
    expect(plan.total).toBe(12);
    expect(await opsTotal()).toBe(12);
  });

  it('refuses apply without the confirm phrase', async () => {
    await seed();
    await expect(reset.reset({ apply: true })).rejects.toThrow(BadRequestException);
    await expect(reset.reset({ apply: true, confirm: 'yes' })).rejects.toThrow(`CONFIRM_REQUIRED: send { "confirm": "${RESET_CONFIRM}" }`);
    expect(await opsTotal()).toBe(12);
  });

  it('clears every ops table in FK order and keeps the org intact', async () => {
    const { employeeId } = await seed();
    const res = await reset.reset({ apply: true, confirm: RESET_CONFIRM });
    if (res.apply !== true) throw new Error('expected an apply result');
    expect(res.total).toBe(12);
    expect(res.remaining).toBe(0);
    expect(Object.values(res.deleted).reduce((a, b) => a + b, 0)).toBe(12);
    expect(res.kept).toMatchObject({ Employee: 1, Zone: 1, Site: 1, User: 1, Device: 1, RuleOverride: 1, Setting: 1, ShiftAssignment: 1, UserPreference: 1 });
    expect(cleared).toHaveBeenCalledWith(employeeId);
  });

  it('an empty board reports zero and deletes nothing', async () => {
    const res = await reset.reset({ apply: true, confirm: RESET_CONFIRM });
    if (res.apply !== true) throw new Error('expected an apply result');
    expect(res.total).toBe(0);
    expect(res.remaining).toBe(0);
  });

  it('includeFences previews the drawn fences and leaves them standing', async () => {
    await seed();
    const plan = await reset.reset({ includeFences: true });
    if (plan.apply !== false) throw new Error('expected a preview');
    expect(plan.fences).toEqual({ Zone: 1, Site: 1 });
    expect(await prisma.zone.count()).toBe(1);
    expect(await prisma.site.count()).toBe(1);
  });

  it('includeFences wipes every zone and site and unassigns their people', async () => {
    const { employeeId } = await seed();
    const res = await reset.reset({ apply: true, confirm: RESET_CONFIRM, includeFences: true });
    if (res.apply !== true) throw new Error('expected an apply result');
    expect(res.fencesDeleted).toEqual({ Zone: 1, Site: 1 });
    expect(res.kept).toMatchObject({ Zone: 0, Site: 0, OrgUnit: 1, Employee: 1, Device: 1, User: 1 });
    const emp = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    expect(emp.zoneId).toBeNull();
    expect(emp.siteId).toBeNull();
  });
});
