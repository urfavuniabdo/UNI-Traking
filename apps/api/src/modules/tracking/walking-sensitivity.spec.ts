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

// Isolated temp DB for the walking-sensitivity tests (§5 motion bands).
const DB = 'file:../tmp-walking.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(120_000);

let prisma: PrismaService;
let positions: PositionsService;

const iso = (ms: number): string => new Date(ms).toISOString();
/** ~6.7 m of real ground per 5 s ≈ 4.8 km/h — a person walking, not a car. */
const STEP_LAT = 0.00006;

async function mkDriver(): Promise<{ deviceId: string; employeeId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: 'walk-org', name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: 'walk-zone', name: 'Zone', orgUnitId: org.id, lat: 30.0, lng: 31.2, radiusM: 100000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: 'walk-ext', name: 'سائق راجل', phone: '+2010999999901', kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: 'walk-user', passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: 'walk-dev', employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 77, lastSeenAt: new Date() },
  });
  return { deviceId: device.deviceId, employeeId: emp.id };
}

const stateOf = async (employeeId: string): Promise<string | null> => {
  const snap = await positions.liveSnapshot();
  const item = snap.positions.find((p) => p.employeeId === employeeId);
  return item?.motionState ?? null;
};

beforeAll(() => {
  try {
    rmSync('tmp-walking.db', { force: true });
    rmSync('tmp-walking.db-journal', { force: true });
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

describe('a driver on foot must not read as STOPPED (§5)', () => {
  it('walks out of STOPPED once the window has proved the walk', async () => {
    const { deviceId, employeeId } = await mkDriver();
    const t0 = Date.now();
    const stand = (s: number): PositionItemDto => ({
      clientTs: iso(t0 + s * 1000),
      lat: 30.0,
      lng: 31.2,
      speed: 0.3,
      accuracy: 5,
    });
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [stand(0), stand(5), stand(10)] });
    expect(await stateOf(employeeId)).toBe('STOPPED');

    const walk = (s: number, i: number): PositionItemDto => ({
      clientTs: iso(t0 + s * 1000),
      lat: 30.0 + STEP_LAT * i,
      lng: 31.2,
      speed: 4.8, // what the new build uploads: max(doppler, metres covered / dt)
      accuracy: 5,
    });
    const step = (n: number): PositionItemDto => walk(10 + n * 5, n);

    // 20 s of walking is 27 m of net travel against a 12 m-per-fix wander: the coordinates cannot
    // separate it from standing yet, and the board must say واقف rather than guess.
    await positions.ingestBatch({ deviceId, batchSeq: 2, positions: [step(1), step(2), step(3), step(4)] });
    expect(await stateOf(employeeId)).toBe('STOPPED');

    // By ~50 s the window has MIN_NET_SAMPLES fixes of one-direction travel, and he leaves STOPPED.
    await positions.ingestBatch({ deviceId, batchSeq: 3, positions: [step(5), step(6), step(7), step(8), step(9), step(10)] });
    expect(await stateOf(employeeId)).toBe('WALKING');
  });

  it('keeps a genuinely stationary driver in STOPPED', async () => {
    const { deviceId, employeeId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [0, 5, 10, 15, 20, 25].map((s) => ({
        clientTs: iso(t0 + s * 1000),
        lat: 30.0,
        lng: 31.2,
        speed: 0.3,
        accuracy: 5,
      })),
    });
    expect(await stateOf(employeeId)).toBe('STOPPED');
  });
});
