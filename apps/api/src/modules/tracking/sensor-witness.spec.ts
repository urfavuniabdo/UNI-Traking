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

/**
 * The one case the coordinates cannot answer on their own: a burst whose own fixes are perfectly
 * self-consistent — 100 m every 3 s, 120 km/h, 3 m accuracy, a ramp no grip limit objects to. The
 * satellites really did relocate the receiver. Only the accelerometer knows nobody carried the phone.
 */
const DB = 'file:../tmp-sensor.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(180_000);

let prisma: PrismaService;
let positions: PositionsService;

const TODAY = new Date().toISOString().slice(0, 10);
const T0 = new Date(`${TODAY}T08:00:00.000Z`).getTime();
const START = { lat: 30.05, lng: 31.05 };
const STEP_LAT = 100 / 111320; // 100 m of latitude

/** The phone's own witness, or nothing at all for a device that never measured. */
const STILL = { motionEnergy: 0.02, stepsPerMin: 0 };

function fix(atS: number, lat: number, lng: number, speed: number, witness: typeof STILL | null): PositionItemDto {
  return {
    clientTs: new Date(T0 + atS * 1000).toISOString(),
    lat,
    lng,
    speed,
    accuracy: 3,
    bearing: 0,
    altitude: 110,
    battery: 80,
    provider: 'gps',
    buffered: false,
    ...(witness ?? {}),
  };
}

/** 8 fixes parked on one point, then 14 of them 100 m apart every 3 s: 120 km/h the ground agrees to. */
function theDay(witness: typeof STILL | null): PositionItemDto[] {
  const rows: PositionItemDto[] = [];
  for (let i = 0; i < 8; i++) rows.push(fix(i * 5, START.lat, START.lng, 0, witness));
  for (let k = 0; k < 14; k++) {
    rows.push(fix(40 + k * 3, START.lat + (k + 1) * STEP_LAT, START.lng, Math.min(120, 40 * (k + 1)), witness));
  }
  return rows;
}

const BURST_FROM = new Date(T0 + 40_000).toISOString();

async function mkDriver(tag: string): Promise<{ employeeId: string; deviceId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: `sensor-org-${tag}`, name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: `sensor-zone-${tag}`, name: 'Zone', orgUnitId: org.id, lat: START.lat, lng: START.lng, radiusM: 5000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: `S${tag}`, name: 'شاهد', phone: `+20109999999${tag}0`, kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: `sensor-user-${tag}`, passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: `sensor-dev-${tag}`, employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 60, lastSeenAt: new Date() },
  });
  return { employeeId: emp.id, deviceId: device.deviceId };
}

beforeAll(() => {
  try {
    rmSync('tmp-sensor.db', { force: true });
    rmSync('tmp-sensor.db-journal', { force: true });
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

describe('the accelerometer is the witness the receiver cannot bribe', () => {
  it('stores the evidence the phone uploaded, not just its conclusion', async () => {
    const { employeeId, deviceId } = await mkDriver('a');
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: theDay(STILL) });

    const rows = await prisma.position.findMany({ where: { employeeId }, orderBy: { clientTs: 'asc' } });
    expect(rows).toHaveLength(22);
    expect(rows[20].stepsPerMin).toBe(0);
    expect(rows[20].motionEnergy).toBeCloseTo(0.02, 6);
    // A phone that never measured uploads nothing, and nothing is invented for it.
    const blind = await mkDriver('b');
    await positions.ingestBatch({ deviceId: blind.deviceId, batchSeq: 1, positions: theDay(null) });
    const blindRows = await prisma.position.findMany({ where: { employeeId: blind.employeeId, clientTs: { gte: new Date(BURST_FROM) } } });
    expect(blindRows[0].stepsPerMin).toBeNull();
    expect(blindRows[0].motionEnergy).toBeNull();
  });

  it('a flat phone says سكون through the replay, and the day opens no journey', async () => {
    const { employeeId, deviceId } = await mkDriver('c');
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: theDay(STILL) });

    expect(await prisma.position.count({ where: { employeeId, clientTs: { gte: new Date(BURST_FROM) }, motionState: 'RIDING' } })).toBe(0);

    const route = (await positions.route(employeeId, TODAY)) as unknown as {
      points: { motionState: string; credible: boolean }[];
    };
    const replayed = route.points.filter((p) => p.credible);
    expect(replayed.length).toBeGreaterThan(10);
    expect(replayed.filter((p) => p.motionState === 'RIDING').length).toBe(0);
    expect(replayed[replayed.length - 1].motionState).toBe('STOPPED');

    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.alert.count({ where: { employeeId, type: 'SPEEDING' } })).toBe(0);
  });

  it('the same day without the witness is a ride — the sensor is what changed the verdict', async () => {
    const { employeeId, deviceId } = await mkDriver('d');
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: theDay(null) });

    const route = (await positions.route(employeeId, TODAY)) as unknown as {
      points: { motionState: string; credible: boolean }[];
    };
    const replayed = route.points.filter((p) => p.credible);
    expect(replayed.filter((p) => p.motionState === 'RIDING').length).toBeGreaterThan(5);
    expect(await prisma.trip.count({ where: { employeeId } })).toBeGreaterThan(0);
  });
});
