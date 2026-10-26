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

// Isolated temp DB for the recorded field trace (§5 — net travel decides, wander never does).
const DB = 'file:../tmp-field-trace.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(120_000);

let prisma: PrismaService;
let positions: PositionsService;

/**
 * D0203, 2026-10-26 08:22→08:32 UTC, exactly as uploaded: he stood for two minutes and then paced
 * the courtyard — 13/15/21/40/15/27 m steps, the phone judging 3.4→18→8.3→4.7→9.1→8.2 km/h.
 * 119 m of path, 7.5 m of net travel: what he walked out he walked back. Measured end to end, no
 * coordinate rule can call that ماشي and still call standing still واقف — §5 says so out loud.
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

describe('the recorded field trace of a driver who stood and then paced (§5)', () => {
  it('reads واقف for 119 m of pacing that came back to where it started', async () => {
    const { deviceId, employeeId } = await mkDriver();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: toItems() });

    // His feet did move — but the coordinates say he went 7.5 m in eleven minutes, and a board that
    // calls that ماشي is the board that called standing still ماشي last week. §5 prices the two
    // apart on net travel only; proving steps needs the accelerometer (CONTRACT §5).
    expect(await stateOf(employeeId)).toBe('STOPPED');
  });

  it('does not invent movement out of the two standing minutes before it', async () => {
    const { deviceId, employeeId } = await mkDriver();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: toItems().slice(0, 6) });
    expect(await stateOf(employeeId)).toBe('STOPPED');
  });

  // The walk this trace never contained: the same uploads with the metres actually going somewhere
  // (10 m of one-way travel per fix, on top of his own scatter), which is what §5 needs to see.
  const M_PER_DEG_LNG = 96_315;
  const walked = (): PositionItemDto[] =>
    toItems().slice(6).map((p, i) => ({ ...p, lng: p.lng - (10 * (i + 1)) / M_PER_DEG_LNG }));

  it('leaves STOPPED when the same cadence does go somewhere', async () => {
    const { deviceId, employeeId } = await mkDriver();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: toItems().slice(0, 6) });
    expect(await stateOf(employeeId)).toBe('STOPPED');

    await positions.ingestBatch({ deviceId, batchSeq: 2, positions: walked() });
    // out of STOPPED, and how far is the phone's say: those rows report up to 18 km/h, so §5 gives
    // him RIDING — the coordinates prove the travel, the device only picks the band.
    expect(['WALKING', 'RIDING']).toContain(await stateOf(employeeId));
  });
});

/**
 * Wael Gamal (D0203), 2026-10-26 10:11→10:17 UTC — pulled out of the live database with
 * GET /positions/route, byte for byte, the rows his own phone uploaded while he stood in place.
 * The deployed engine stored WALKING for the last three of them: 104 m of wandering path, 1.4 m of
 * travel, a 15.3 km/h Doppler reading at 16 m of accuracy. This is the bug he reported.
 */
const STOOD_STILL: PositionItemDto[] = [
  { clientTs: '2026-10-26T10:11:07.080Z', lat: 30.0970296, lng: 31.3815935, speed: 0.2, accuracy: 5.034999847412109 },
  { clientTs: '2026-10-26T10:16:52.492Z', lat: 30.097156, lng: 31.3817221, speed: 0.9, accuracy: 13.86699962615967 },
  { clientTs: '2026-10-26T10:16:55.497Z', lat: 30.0972175, lng: 31.3818346, speed: 15.3, accuracy: 16.78499984741211 },
  { clientTs: '2026-10-26T10:17:09.496Z', lat: 30.0972779, lng: 31.3819183, speed: 4.9, accuracy: 4.586999893188477 },
  { clientTs: '2026-10-26T10:17:21.493Z', lat: 30.0973315, lng: 31.3820028, speed: 3.6, accuracy: 5.827000141143799 },
  { clientTs: '2026-10-26T10:17:34.950Z', lat: 30.0971705, lng: 31.3817991, speed: 4.3, accuracy: 30.29500007629395 },
  { clientTs: '2026-10-26T10:17:49.593Z', lat: 30.0970196, lng: 31.3816018, speed: 6.2, accuracy: 11.09200000762939 },
];

describe('the standing burst he reported, replayed from the live rows (§5)', () => {
  it('reads واقف at every fix, not ماشي at the last three', async () => {
    const { deviceId, employeeId } = await mkDriver();
    for (const item of STOOD_STILL) {
      await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [item] });
      expect(await stateOf(employeeId)).toBe('STOPPED');
    }
  });

  it('opens no journey for a driver who never left the courtyard', async () => {
    const { deviceId, employeeId } = await mkDriver();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: STOOD_STILL });
    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    const rows = await prisma.position.findMany({ where: { employeeId }, orderBy: { clientTs: 'asc' } });
    expect(rows.map((r) => r.motionState)).toEqual(rows.map(() => 'STOPPED'));
  });
});
