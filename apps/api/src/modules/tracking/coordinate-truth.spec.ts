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

// Isolated temp DB: the coordinates, not the phone's speed field, decide the motion state (§5).
const DB = 'file:../tmp-ground.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(120_000);

let prisma: PrismaService;
let positions: PositionsService;

const iso = (ms: number): string => new Date(ms).toISOString();

async function mkDriver(): Promise<{ employeeId: string; deviceId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: 'ground-org', name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: 'ground-zone', name: 'Zone', orgUnitId: org.id, lat: 30.0, lng: 31.2, radiusM: 100000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: 'ground-ext', name: 'سائق واقف', phone: '+2010999999902', kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: 'ground-user', passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: 'ground-dev', employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 77, lastSeenAt: new Date() },
  });
  return { employeeId: emp.id, deviceId: device.deviceId };
}

const stateOf = async (employeeId: string): Promise<string | null> => {
  const snap = await positions.liveSnapshot();
  return snap.positions.find((p) => p.employeeId === employeeId)?.motionState ?? null;
};

beforeAll(() => {
  try {
    rmSync('tmp-ground.db', { force: true });
    rmSync('tmp-ground.db-journal', { force: true });
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
  // forget yesterday's drivers: a sweep must only see the run the current test opened
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

describe('the coordinates decide the motion state (§5)', () => {
  it('a parked phone reporting 150 km/h stays واقف and never opens a trip', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    // the stationary keep-alive cadence: the same position every minute, a chip reading a stale speed
    const parked = (i: number): PositionItemDto => ({
      clientTs: iso(t0 + i * 60000),
      lat: 30.0,
      lng: 31.2,
      speed: i === 1 ? 150 : 0.3,
      accuracy: 8,
    });
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [parked(0), parked(1), parked(2), parked(3)] });

    expect(await stateOf(employeeId)).toBe('STOPPED');
    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    const rows = await prisma.position.findMany({ where: { employeeId }, orderBy: { clientTs: 'asc' } });
    expect(rows.every((r) => r.motionState === 'STOPPED')).toBe(true);
  });

  it('a real drive out of the site still opens a trip and reads في رحلة', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    const drive = (i: number): PositionItemDto => ({
      clientTs: iso(t0 + i * 15000),
      lat: 30.0 + i * 0.0009, // ~100 m per sample → 24 km/h of ground
      lng: 31.2,
      speed: 40,
      accuracy: 8,
    });
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [drive(0), drive(1), drive(2), drive(3), drive(4), drive(5)] });

    expect(await stateOf(employeeId)).toBe('RIDING');
    const trip = await prisma.trip.findFirst({ where: { employeeId } });
    expect(trip).not.toBeNull();
    const snap = await positions.liveSnapshot();
    expect(snap.positions.find((p) => p.employeeId === employeeId)?.speedKmh).toBeGreaterThan(7);
  });

  it('GET /positions/route re-reads the day: a fake ride an older build stored is not a journey', async () => {
    const { employeeId } = await mkDriver();
    const t0 = Date.now();
    const store = (i: number, lat: number, speed: number, state: 'RIDING' | 'STOPPED') =>
      prisma.position.create({
        data: {
          employeeId,
          clientTs: new Date(t0 + i * 60000),
          lat,
          lng: 31.2,
          speedKmh: speed,
          accuracyM: 8,
          motionState: state,
          ingestHash: `legacy-${i}-${lat}`,
        },
      });
    // what the cached-fix build used to leave behind: the phone never moved, its speed said otherwise
    await store(0, 30.0, 150, 'RIDING');
    await store(1, 30.0, 155, 'RIDING');
    await store(2, 30.0, 140, 'RIDING');
    await store(3, 30.0, 0.3, 'STOPPED');

    const route = (await positions.route(employeeId, new Date(t0).toISOString().slice(0, 10))) as {
      distanceKm: number;
      points: { motionState: string; credible: boolean; speedKmh: number | null }[];
      geojson: { coordinates: number[][] };
    };
    expect(route.points).toHaveLength(4);
    expect(route.points.every((p) => p.credible)).toBe(true);
    expect(route.points.every((p) => p.motionState === 'STOPPED')).toBe(true);
    expect(route.distanceKm).toBe(0);
    expect(route.points.reduce((s, p) => s + (p.speedKmh ?? 0), 0)).toBeLessThan(1.5);
  });

  it('GET /positions/route drops a fix that is only reachable faster than GPS allows', async () => {
    const { employeeId } = await mkDriver();
    const t0 = Date.now();
    const store = (i: number, lat: number) =>
      prisma.position.create({
        data: {
          employeeId,
          clientTs: new Date(t0 + i * 60000),
          lat,
          lng: 31.2,
          speedKmh: 30,
          accuracyM: 8,
          motionState: 'RIDING',
          ingestHash: `spike-${i}-${lat}`,
        },
      });
    await store(0, 30.0);
    await store(1, 30.3); // 33 km in a minute — a re-fix, not ground
    await store(2, 30.0009);
    await store(3, 30.0018);

    const route = (await positions.route(employeeId, new Date(t0).toISOString().slice(0, 10))) as {
      rejectedPoints: number;
      points: { lat: number; credible: boolean }[];
      distanceKm: number;
    };
    expect(route.rejectedPoints).toBe(1);
    expect(route.points.find((p) => p.lat === 30.3)?.credible).toBe(false);
    expect(route.distanceKm).toBeLessThan(0.3);
  });
});

describe('a journey ends when the ground stops (§5)', () => {
  const drive = (t0: number, i: number): PositionItemDto => ({
    clientTs: iso(t0 + i * 15000),
    lat: 30.0 + i * 0.0009,
    lng: 31.2,
    speed: 40,
    accuracy: 8,
  });

  it('check-out (tracking off) closes the run with the length it actually covered', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2), drive(t0, 3), drive(t0, 4), drive(t0, 5)],
    });
    expect(await prisma.trip.count({ where: { employeeId, state: 'OPEN' } })).toBe(1);

    const closed = await positions.closeOpenTrips(employeeId, t0 + 90_000);
    expect(closed).toBe(1);

    const trip = await prisma.trip.findFirst({ where: { employeeId } });
    expect(trip?.state).toBe('CLOSED');
    expect(trip?.endedAt?.getTime()).toBeGreaterThanOrEqual(t0 + 90_000);
    expect(trip?.distanceKm).toBeGreaterThan(0.3);
    expect(trip?.distanceKm).toBeLessThan(0.7); // ~500 m of the five 100 m steps
    expect(trip?.endPoint).not.toBeNull();
    expect(trip?.polyline).not.toBeNull();
    expect(await prisma.trip.count({ where: { employeeId, state: 'OPEN' } })).toBe(0);
  });

  it('a run nobody ended closes itself once the driver stopped moving', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2), drive(t0, 3)],
    });

    const closed = await positions.closeStaleTrips(t0 + 700_000);
    expect(closed).toBeGreaterThanOrEqual(1);

    const trip = await prisma.trip.findFirst({ where: { employeeId } });
    expect(trip?.state).toBe('CLOSED');
    // it ends at the last step that had ground under it, not at the sweep time
    expect(trip?.endedAt?.getTime()).toBe(t0 + 45_000);
    expect(await prisma.trip.count({ where: { employeeId, state: 'OPEN' } })).toBe(0);
  });

  it('an OPEN row left by a dead process is rebuilt from its own positions', async () => {
    const { employeeId } = await mkDriver();
    const t0 = Date.now();
    const startedAt = new Date(t0);
    // a parked driver whose trip row was never closed: the day's fixes are the only witness
    for (let i = 0; i < 5; i++) {
      await prisma.position.create({
        data: {
          employeeId,
          clientTs: new Date(t0 + i * 60000),
          lat: 30.0,
          lng: 31.2,
          speedKmh: 0.3,
          accuracyM: 8,
          motionState: 'STOPPED',
          ingestHash: `orphan-${i}`,
        },
      });
    }
    await prisma.trip.create({
      data: { employeeId, startedAt, state: 'OPEN', distanceKm: 0, maxSpeedKmh: 150, replayed: false },
    });

    const closed = await positions.closeStaleTrips(Date.now() + 700_000);
    expect(closed).toBe(1);

    const trip = await prisma.trip.findFirst({ where: { employeeId }, orderBy: { startedAt: 'asc' } });
    expect(trip?.state).toBe('CLOSED');
    expect(trip?.endedAt?.getTime()).toBe(t0 + 240_000); // its last fix
    expect(trip?.distanceKm).toBe(0); // he never moved — the honest answer
    expect(trip?.maxSpeedKmh).toBe(150); // what the phone claimed is kept, the ground is not
  });

  it('waiting an hour at a customer keeps the run open — the phone is still talking', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2), drive(t0, 3)],
    });
    // parked at the same spot for 60 minutes, reporting every 5 minutes
    const waiting = Array.from({ length: 12 }, (_, i) => ({
      clientTs: iso(t0 + 60_000 + i * 300_000),
      lat: 30.0027,
      lng: 31.2,
      speed: 0,
      accuracy: 8,
    }));
    await positions.ingestBatch({ deviceId, batchSeq: 2, positions: waiting });

    const trip = await prisma.trip.findFirst({ where: { employeeId } });
    expect(trip?.state).toBe('OPEN'); // he is on the job, just not on the move
    expect(await stateOf(employeeId)).toBe('STOPPED'); // and the dashboard says واقف
    expect(await prisma.stopEvent.count({ where: { employeeId } })).toBe(1);

    await positions.closeOpenTrips(employeeId, t0 + 700_000);
    const done = await prisma.trip.findFirst({ where: { employeeId } });
    // the length of the run is the driving only — the hour of waiting covered no ground
    expect(done?.distanceKm).toBeLessThan(0.4);
    expect(done?.distanceKm).toBeGreaterThan(0.1);
    expect(done?.endedAt?.getTime()).toBe(t0 + 700_000);
  });

  it('a re-check-in on the same day cannot leave a second OPEN run behind', async () => {    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2)] });
    await positions.closeOpenTrips(employeeId, t0 + 60_000);

    const t1 = t0 + 3_600_000;
    await positions.ingestBatch({
      deviceId,
      batchSeq: 2,
      positions: [drive(t1, 0), drive(t1, 1), drive(t1, 2)],
    });

    const rows = await prisma.trip.findMany({ where: { employeeId }, orderBy: { startedAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe('CLOSED');
    expect(rows[1].state).toBe('OPEN');
    expect(await positions.closeOpenTrips(employeeId, t1 + 60_000)).toBe(1);
    expect(await prisma.trip.count({ where: { employeeId, state: 'OPEN' } })).toBe(0);
  });
});
