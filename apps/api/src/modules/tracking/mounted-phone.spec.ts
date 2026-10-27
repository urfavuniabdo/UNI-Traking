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
import { D0203_2026_10_27_MOUNTED } from './fixtures/d0203-2026-10-27-mounted';
import { ALERT_DISPATCHER, REALTIME_PUBLISHER, type RealtimePublisher } from '../../common/contracts';

/**
 * The day the phone was in his hand and the board said he was travelling.
 * 22 real fixes pulled from GET /positions/route on 2026-10-27: every one of them lands inside a
 * ~35 m bubble, the day's net distance is 0.00 km — and the verdict the board still holds 42 minutes
 * later is WALKING at 57.9 km/h, because the last fix of the day was believed over the ground.
 */
const DB = 'file:../tmp-mounted.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(180_000);

let prisma: PrismaService;
let positions: PositionsService;

const DAY = '2026-10-27';

type Witness = { stepsPerMin: number; motionEnergy: number };

/** The same sky, with or without the accelerometer testifying. */
function theDay(witness: Witness | null): PositionItemDto[] {
  return D0203_2026_10_27_MOUNTED.map(([clientTs, lat, lng, speedKmh, accuracyM], i) => ({
    clientTs,
    lat,
    lng,
    speed: speedKmh,
    accuracy: accuracyM,
    bearing: 0,
    altitude: 60,
    battery: 95 - i * 0.1,
    provider: 'gps',
    buffered: false,
    ...(witness ?? {}),
  }));
}

async function mkDriver(tag: string): Promise<{ employeeId: string; deviceId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: `mounted-org-${tag}`, name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: `mounted-zone-${tag}`, name: 'Zone', orgUnitId: org.id, lat: 30.097, lng: 31.3816, radiusM: 5000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: `M${tag}`, name: 'مثبت', phone: `+20108888888${tag}0`, kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: `mounted-user-${tag}`, passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: `mounted-dev-${tag}`, employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 95, lastSeenAt: new Date() },
  });
  return { employeeId: emp.id, deviceId: device.deviceId };
}

beforeAll(() => {
  try {
    rmSync('tmp-mounted.db', { force: true });
    rmSync('tmp-mounted.db-journal', { force: true });
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

const STILL: Witness = { stepsPerMin: 0, motionEnergy: 0.02 };

async function verdicts(employeeId: string): Promise<string[]> {
  const route = (await positions.route(employeeId, DAY)) as unknown as {
    distanceKm: number;
    points: { clientTs: string; speedKmh: number | null; motionState: string; credible: boolean }[];
  };
  return route.points.map((p) => `${p.clientTs.slice(11, 19)} ${String(p.speedKmh).padStart(5)} ${p.motionState}${p.credible ? '' : ' (rej)'}`);
}

describe('a phone nobody carried is a standing driver', () => {
  it('ends the day standing still when the accelerometer testifies', async () => {
    const { employeeId, deviceId } = await mkDriver('a');
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: theDay(STILL) });

    const seen = await verdicts(employeeId);
    // eslint-disable-next-line no-console
    console.log('WITH WITNESS\n' + seen.join('\n'));
    const live = await positions.liveSnapshot();
    const row = live.positions.find((p) => p.employeeId === employeeId);
    // eslint-disable-next-line no-console
    console.log('LIVE:', JSON.stringify({ speed: row?.speedKmh, state: row?.motionState, ts: row?.ts }));

    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.alert.count({ where: { employeeId, type: { in: ['SPEEDING', 'HARSH_ACCELERATION', 'HARSH_BRAKING'] } } })).toBe(0);
    expect(row?.motionState).toBe('STOPPED');
    expect(row?.speedKmh).toBeLessThanOrEqual(1.5);
  });

  it('does not hold a travelling verdict for a fix the ground never backed', async () => {
    const { employeeId, deviceId } = await mkDriver('b');
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: theDay(null) });

    const seen = await verdicts(employeeId);
    // eslint-disable-next-line no-console
    console.log('WITHOUT WITNESS\n' + seen.join('\n'));
    const route = (await positions.route(employeeId, DAY)) as unknown as { distanceKm: number };
    const live = await positions.liveSnapshot();
    const row = live.positions.find((p) => p.employeeId === employeeId);
    // eslint-disable-next-line no-console
    console.log('DAY KM:', route.distanceKm, 'LIVE:', JSON.stringify({ speed: row?.speedKmh, state: row?.motionState, ts: row?.ts }));

    // A day that went nowhere may not be reported as motion, whatever the Doppler field claimed.
    expect(route.distanceKm).toBe(0);
    expect(row?.motionState).toBe('STOPPED');
    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
  });
});
