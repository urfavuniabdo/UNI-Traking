import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../common/prisma.module';
import { PrismaService } from '../../common/prisma.service';
import { GeoModule } from '../../common/geo/geo.module';
import { RulesService } from '../rules/rules.service';
import { AlertDispatchService } from '../notify/alert-dispatch.service';
import { PushService } from '../notify/push.service';
import { MotionClassifierService } from './motion-classifier.service';
import { PositionsService } from './positions.service';
import type { PositionItemDto } from './dto';
import { ALERT_DISPATCHER, REALTIME_PUBLISHER, type RealtimePublisher } from '../../common/contracts';

// Isolated temp DB for the recorded field trace (§5 — a driver who walked must read ماشي).
const DB = 'file:../tmp-field-trace.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(120_000);

let prisma: PrismaService;
let positions: PositionsService;

/**
 * D0203, 2026-10-26 08:22→08:32 UTC, exactly as uploaded: he stood for two minutes and then
 * walked — 13/15/21/40/15/27 m steps, the phone judging 3.4→18→8.3→4.7→9.1→8.2 km/h.
 * Every one of those rows came back motionState=STOPPED on the phone and on the board.
 */
const TRACE: Array<[string, number, number, number, number]> = [
  ['2026-10-26T08:22:38.966Z', 30.0969929, 31.3816802, 0, 11.7],
  ['2026-10-26T08:23:04.421Z', 30.0970702, 31.3816164, 0, 8.3],
  ['2026-10-26T08:23:38.182Z', 30.0970292, 31.3817134, 0, 8.1],
  ['2026-10-26T08:23:57.283Z', 30.0969442, 31.3816749, 2.3, 8.6],
  ['2026-10-26T08:24:16.819Z', 30.0969868, 31.3815794, 1.9, 6.1],
  ['2026-10-26T08:30:48.523Z', 30.0970333, 31.3816817, 0.1, 3],
  ['2026-10-26T08:31:02.518Z', 30.09699, 31.381555, 3.4, 5.5],
  ['2026-10-26T08:31:05.515Z', 30.0969233, 31.38142, 18, 5.3],
  ['2026-10-26T08:31:14.848Z', 30.0970432, 31.3815958, 8.3, 13.3],
  ['2026-10-26T08:31:45.508Z', 30.0969083, 31.38121, 4.7, 9.3],
  ['2026-10-26T08:31:51.512Z', 30.0969033, 31.3813683, 9.1, 7.8],
  ['2026-10-26T08:32:03.510Z', 30.0970452, 31.3815992, 8.2, 11.7],
];

const toItems = (): PositionItemDto[] =>
  TRACE.map(([clientTs, lat, lng, speed, accuracy]) => ({ clientTs, lat, lng, speed, accuracy }));

async function mkDriver(): Promise<{ deviceId: string; employeeId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: 'trace-org', name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: 'trace-zone', name: 'Zone', orgUnitId: org.id, lat: 30.097, lng: 31.3816, radiusM: 100000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: 'trace-ext', name: 'سائق المشي', phone: '+2010999999903', kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: 'trace-user', passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: 'trace-dev', employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 77, lastSeenAt: new Date() },
  });
  return { deviceId: device.deviceId, employeeId: emp.id };
}

const stateOf = async (employeeId: string): Promise<string | null> => {
  const snap = await positions.liveSnapshot();
  return snap.positions.find((p) => p.employeeId === employeeId)?.motionState ?? null;
};

beforeAll(() => {
  try {
    rmSync('tmp-field-trace.db', { force: true });
    rmSync('tmp-field-trace.db-journal', { force: true });
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
    imports: [PrismaModule, GeoModule, ScheduleModule.forRoot()],
    providers: [
      RulesService,
      MotionClassifierService,
      PushService,
      AlertDispatchService,
      PositionsService,
      { provide: ALERT_DISPATCHER, useExisting: AlertDispatchService },
      { provide: REALTIME_PUBLISHER, useValue: { position: jest.fn(), alert: jest.fn(), attendance: jest.fn(), presence: jest.fn() } as unknown as RealtimePublisher },
    ],
  }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  positions = moduleRef.get(PositionsService);
});

beforeEach(async () => {
  positions['tracks']?.clear?.();
  positions['live']?.clear?.();
  await prisma.position.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.stopEvent.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.routeLine.deleteMany();
  await prisma.geoEvent.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.zone.deleteMany();
  await prisma.site.deleteMany();
  await prisma.orgUnit.deleteMany();
});

afterAll(async () => {
  try {
    await prisma?.$disconnect();
  } catch {
    /* ignore */
  }
});

describe('the recorded field trace of a driver who walked (§5)', () => {
  it('leaves STOPPED while he is on foot', async () => {
    const { deviceId, employeeId } = await mkDriver();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: toItems() });

    const state = await stateOf(employeeId);
    expect(state).not.toBe('STOPPED');
    expect(['WALKING', 'RIDING']).toContain(state);
  });

  it('does not invent movement out of the two standing minutes before it', async () => {
    const { deviceId, employeeId } = await mkDriver();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: toItems().slice(0, 6) });
    expect(await stateOf(employeeId)).toBe('STOPPED');
  });
});
