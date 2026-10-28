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

/** ~100 m every 15 s: 24 km/h of ground, which is a real drive. */
const drive = (t0: number, i: number): PositionItemDto => ({
  clientTs: iso(t0 + i * 15000),
  lat: 30.0 + i * 0.0009,
  lng: 31.2,
  speed: 40,
  accuracy: 8,
});

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

  it('GPS drift that ping-pongs inside the circle ends in واقف and opens no trip', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    // today's real trace from the field: ±16 m every 3 s at ~19 m accuracy — 19 km/h on paper,
    // and not one metre of ground he is provably missing from.
    const jitter = (i: number): PositionItemDto => ({
      clientTs: iso(t0 + i * 3000),
      lat: 30.0 + (i % 2 === 1 ? 0.000144 : -0.000144),
      lng: 31.2,
      speed: 0.5,
      accuracy: 19.4,
    });
    const batch: PositionItemDto[] = [];
    batch.push({ clientTs: iso(t0), lat: 30.0, lng: 31.2, speed: 0.3, accuracy: 19.4 });
    for (let i = 1; i <= 24; i++) batch.push(jitter(i));
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: batch });

    expect(await stateOf(employeeId)).toBe('STOPPED');
    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    const rows = await prisma.position.findMany({ where: { employeeId }, orderBy: { clientTs: 'asc' } });
    expect(rows[rows.length - 1].speedKmh).toBeLessThan(1.5);

    // and the day he is shown for has to agree with the chip: no road, no route line, 0 km.
    const parked = (await positions.route(employeeId, new Date(t0).toISOString().slice(0, 10))) as {
      distanceKm: number;
      geojson: { coordinates: [number, number][] };
    };
    expect(parked.distanceKm).toBe(0);
    expect(parked.geojson.coordinates.length).toBeLessThan(4);
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
    // a session opens with the receiver's warm-up minute: stored, but not ground
    await prisma.position.create({
      data: { employeeId, clientTs: new Date(t0 - 120_000), lat: 30.0, lng: 31.2, speedKmh: 0.3, accuracyM: 8, motionState: 'STOPPED', ingestHash: 'legacy-warmup' },
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
    expect(route.points).toHaveLength(5);
    expect(route.points.filter((p) => p.credible)).toHaveLength(4);
    expect(route.points.filter((p) => p.credible).every((p) => p.motionState === 'STOPPED')).toBe(true);
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
    // a session opens with the receiver's warm-up minute: stored, but not ground
    await prisma.position.create({
      data: { employeeId, clientTs: new Date(t0 - 120_000), lat: 30.0, lng: 31.2, speedKmh: 0.3, accuracyM: 8, motionState: 'STOPPED', ingestHash: 'spike-warmup' },
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
    // the teleport, plus the warm-up fix that founded the session
    expect(route.rejectedPoints).toBe(2);
    expect(route.points.find((p) => p.lat === 30.3)?.credible).toBe(false);
    expect(route.distanceKm).toBeLessThan(0.3);
  });
});

describe('the line answers to the state (§5)', () => {
  it('fixes that left and came back through a silence are not a route for a driver who never moved', async () => {
    const { employeeId } = await mkDriver();
    const t0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T08:00:00.000Z`);
    const store = (sec: number, lat: number, accuracyM = 8, speedKmh = 0.2) =>
      prisma.position.create({
        data: {
          employeeId,
          clientTs: new Date(t0 + sec * 1000),
          lat,
          lng: 31.2,
          speedKmh,
          accuracyM,
          motionState: 'STOPPED',
          ingestHash: `ghost-${sec}-${lat}`,
        },
      });
    // a day off his phone, to the metre: parked in the yard with the fix wandering 20 m around him,
    // and three positions from across the city the device published when it woke from a doze.
    // The session's first fix is the warm-up minute: stored, but not ground.
    await prisma.position.create({
      data: { employeeId, clientTs: new Date(t0 - 90_000), lat: 30.0, lng: 31.2, speedKmh: 0.2, accuracyM: 8, motionState: 'STOPPED', ingestHash: 'ghost-warmup' },
    });
    await store(0, 30.0);
    await store(30, 30.00005);
    await store(60, 30.0001);
    await store(120, 30.0);
    await store(210, 30.00015);
    await store(420, 30.011, 10, 12.3); // 1.22 km out, 3.5 min after anyone last saw him
    await store(423, 30.01102, 13); // its companion, same place
    await store(900, 30.00002); // back in the yard across an 8-minute silence
    await store(1400, 30.0222, 11, 9.7); // 2.47 km
    await store(1900, 30.0095, 5, 16);
    await store(1904, 30.00956, 9);
    await store(1930, 30.00005, 10, 150.9); // and back, 25 s later — 145 km/h on paper
    await store(2000, 30.0001);
    await store(2400, 30.0);
    // a stop the engine recorded a few metres off the man himself — the marker belongs on his spot
    await prisma.stopEvent.create({
      data: { employeeId, startedAt: new Date(t0 + 30_000), endedAt: new Date(t0 + 600_000), durationS: 570, kind: 'UNPLANNED', lat: 30.0003, lng: 31.2 },
    });

    const route = (await positions.route(employeeId, new Date(t0).toISOString().slice(0, 10))) as {
      distanceKm: number;
      rejectedPoints: number;
      points: { credible: boolean; motionState: string }[];
      trace: { lat: number; lng: number }[];
      stops: { lat: number; lng: number }[];
      geojson: { coordinates: [number, number][] };
    };
    // the five ghost fixes, plus the warm-up fix that founded the session
    expect(route.rejectedPoints).toBe(6);
    expect(route.points.filter((p) => p.credible).every((p) => p.motionState === 'STOPPED')).toBe(true);
    // 7.7 km of ghosts became the ground he stood on: nothing moved, so nothing is drawn.
    expect(route.distanceKm).toBe(0);
    expect(route.geojson.coordinates.every(([, lat]) => Math.abs(lat - 30.0) < 0.002)).toBe(true);
    // and the hour of jitter around his stand-by spot is ONE point, not a star of spokes.
    expect(route.trace).toHaveLength(1);
    expect(route.geojson.coordinates.length).toBeLessThanOrEqual(1);
    expect(route.stops).toHaveLength(1);
    expect(route.stops[0].lat).toBe(route.trace[0].lat);
    expect(route.stops[0].lng).toBe(route.trace[0].lng);
  });

  it('a round trip the device reported all the way keeps its road', async () => {
    const { employeeId } = await mkDriver();
    const t0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T08:00:00.000Z`);
    const step = (sec: number, i: number) =>
      prisma.position.create({
        data: {
          employeeId,
          clientTs: new Date(t0 + sec * 1000),
          lat: 30.0 + i * 0.0009, // 100 m every 15 s: a witnessed 24 km/h
          lng: 31.2,
          speedKmh: 24,
          accuracyM: 8,
          motionState: 'RIDING',
          ingestHash: `roundtrip-${sec}-${i}`,
        },
      });
    for (let i = 0; i <= 20; i++) await step(i * 15, i);
    for (let i = 19; i >= 0; i--) await step((40 - i) * 15, i);
    // he was parked at the yard before setting off: the session's warm-up minute, stored not ground
    for (let i = 0; i < 3; i++) {
      await prisma.position.create({
        data: { employeeId, clientTs: new Date(t0 - 100_000 + i * 20_000), lat: 30.0, lng: 31.2, speedKmh: 0.2, accuracyM: 8, motionState: 'STOPPED', ingestHash: `roundtrip-warm-${i}` },
      });
    }

    const route = (await positions.route(employeeId, new Date(t0).toISOString().slice(0, 10))) as {
      distanceKm: number;
      rejectedPoints: number;
      trace: unknown[];
      geojson: { coordinates: [number, number][] };
    };
    // the session's warm-up minute: three parked fixes stored before the road, none of it ground
    expect(route.rejectedPoints).toBe(3);
    expect(route.distanceKm).toBeGreaterThan(3.5);
    // a man who really travelled 2 km out and back is not a stand-by: every step is on the line
    expect(route.trace.length).toBeGreaterThan(35);
  });
});

describe('a journey ends when the ground stops (§5)', () => {
  it('check-out (tracking off) closes the run with the length it actually covered', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    // the session's warm-up minute: parked at the yard, stored but not ground
    await prisma.position.create({
      data: { employeeId, clientTs: new Date(t0 - 120_000), lat: 30.0, lng: 31.2, speedKmh: 0.3, accuracyM: 8, motionState: 'STOPPED', ingestHash: 'checkout-warmup' },
    });
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
    // §5's own arithmetic applied to the trip row: five fixes folded into the one place he sat
    // covered no ground, so the journey has no top speed — the 150 the row carried was the phone
    // asserting while its receiver was waking up, and the dashboard would have shown a car doing
    // 150 km/h next to a dot that never moved.
    expect(trip?.maxSpeedKmh).toBe(0);
  });

  it('waiting an hour at a customer keeps the run open — the phone is still talking', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    // the session's warm-up minute: parked at the yard, stored but not ground
    await prisma.position.create({
      data: { employeeId, clientTs: new Date(t0 - 120_000), lat: 30.0, lng: 31.2, speedKmh: 0.3, accuracyM: 8, motionState: 'STOPPED', ingestHash: 'waiting-warmup' },
    });
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

  it('a stop that outlived its journey does not end before it began', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2), drive(t0, 3)],
    });
    // he parks at the customer and the device keeps talking for a quarter of an hour
    const waiting = Array.from({ length: 12 }, (_, i) => ({
      clientTs: iso(t0 + 90_000 + i * 60_000),
      lat: 30.0027,
      lng: 31.2,
      speed: 0,
      accuracy: 8,
    }));
    await positions.ingestBatch({ deviceId, batchSeq: 2, positions: waiting });
    const opened = await prisma.stopEvent.findFirst({ where: { employeeId } });
    expect(opened).not.toBeNull();
    expect(opened?.endedAt).toBeNull();

    // then the device goes quiet and the sweep ends the run at the last step that had ground under
    // it — a moment from the drive, BEFORE he parked. That clock is the trip's, not the stop's.
    await positions.closeStaleTrips(t0 + 750_000 + 600_001);

    const closed = await prisma.stopEvent.findFirst({ where: { employeeId } });
    expect(closed?.endedAt).not.toBeNull();
    expect(closed!.endedAt!.getTime()).toBeGreaterThanOrEqual(closed!.startedAt.getTime());
    // it ends when the day last saw him standing there
    expect(closed?.endedAt?.getTime()).toBe(t0 + 750_000);
    expect(closed?.durationS).toBeGreaterThan(0);
  });

  it('a check-out stamped behind the phone\'s own clock cannot end a stop early', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    // parked from the first fix of the day: a stop with no journey ever opened to close it
    const parked = Array.from({ length: 6 }, (_, i) => ({
      clientTs: iso(t0 + i * 60_000),
      lat: 30.0,
      lng: 31.2,
      speed: 0,
      accuracy: 8,
    }));
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: parked });
    const stop = await prisma.stopEvent.findFirst({ where: { employeeId } });
    expect(stop).not.toBeNull();

    // the server's clock runs half a minute behind the device's — the end may not land before the start
    await positions.closeOpenTrips(employeeId, stop!.startedAt.getTime() - 30_000);

    const done = await prisma.stopEvent.findFirst({ where: { employeeId } });
    expect(done?.endedAt).not.toBeNull();
    expect(done!.endedAt!.getTime()).toBeGreaterThanOrEqual(done!.startedAt.getTime());
    expect(done?.durationS).toBeGreaterThanOrEqual(0);
  });

  it('a re-check-in on the same day cannot leave a second OPEN run behind', async () => {
    const { employeeId, deviceId } = await mkDriver();
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

type Trail = {
  employeeId: string;
  name: string;
  distanceKm: number;
  line: [number, number][];
  pointCount: number;
  stops: { id: string; lat: number; lng: number; durationMin: number }[];
  gaps: unknown[];
};

describe('GET /positions/trails — every present driver gets his own line (§5)', () => {
  const trailOf = async (employeeId: string): Promise<Trail | undefined> => {
    positions['trailsCache'] = null; // each assertion reads the board, not the previous read's cache
    const res = (await positions.trails(90)) as { trails: Trail[] };
    return res.trails.find((t) => t.employeeId === employeeId);
  };

  it('the line is the ground he covered: the drive is in it, the teleport is not', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    // the session's warm-up minute: parked, stored but not ground — the drive itself stays whole
    await prisma.position.create({
      data: { employeeId, clientTs: new Date(t0 - 120_000), lat: 30.0, lng: 31.2, speedKmh: 0.3, accuracyM: 8, motionState: 'STOPPED', ingestHash: 'trail-warmup' },
    });
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2), drive(t0, 3), drive(t0, 4), drive(t0, 5)],
    });
    // a cached fix from the other side of the city published in the middle of the run
    await prisma.position.create({
      data: {
        employeeId,
        clientTs: new Date(t0 + 90_000),
        lat: 30.3,
        lng: 31.2,
        speedKmh: 30,
        accuracyM: 8,
        motionState: 'RIDING',
        ingestHash: 'trail-spike',
      },
    });

    const trail = await trailOf(employeeId);
    expect(trail?.name).toBe('سائق واقف');
    expect(trail?.pointCount).toBe(6);
    expect(trail?.line.some(([lat]) => lat === 30.3)).toBe(false);
    expect(trail?.line.length).toBeGreaterThanOrEqual(2);
    expect(trail?.distanceKm).toBeGreaterThan(0.3);
    expect(trail?.distanceKm).toBeLessThan(0.7);
  });

  it('a driver whose device went quiet is off the trails — the board shows him as absent, not on the road', async () => {
    const { employeeId, deviceId } = await mkDriver();
    const t0 = Date.now();
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [drive(t0, 0), drive(t0, 1), drive(t0, 2)] });
    expect(await trailOf(employeeId)).toBeDefined();

    await prisma.device.update({ where: { deviceId: 'ground-dev' }, data: { online: false, lastSeenAt: new Date(t0 - 4_000_000) } });
    expect(await trailOf(employeeId)).toBeUndefined();
  });
});

/**
 * The real day that forced the warm-up rule: on 2026-10-27 a driver standing at home since check-in
 * produced 16 self-consistent fixes in the first 58 s of his session — tight claimed accuracy, a
 * plausible doppler ramp, zero steps — wandering ~150 m around a spot 950 m from where he actually
 * was. No per-fix guard could refuse them: the fiction never contradicted itself. Coordinates are
 * the ones his phone really sent (12:07:07–12:08:05Z, then the truth at 12:08:58Z).
 */
describe('the first minute of a session is receiver warm-up, not ground', () => {
  /** [dtS, lat, lng, speedKmh, accuracyM, stepsPerMin, motionEnergy, liveState] — the 2026-10-27 burst. */
  const BURST: [number, number, number, number, number, number, number, string][] = [
    [0, 30.103007, 31.3882148, 15.5, 10.1, 0, 0.14, 'RIDING'],
    [3, 30.1028936, 31.3882453, 0, 9.6, 0, 0.15, 'STOPPED'],
    [7.99, 30.1027684, 31.3882164, 33.9, 8.3, 0, 0.14, 'RIDING'],
    [11, 30.1026226, 31.3881838, 1.5, 8.6, 0, 0.1, 'STOPPED'],
    [14, 30.1024463, 31.3881681, 1.5, 8.6, 0, 0.06, 'STOPPED'],
    [17, 30.1023418, 31.3881469, 1.5, 7.1, 0, 0.03, 'STOPPED'],
    [20, 30.102227, 31.3881226, 1.5, 7.1, 0, 0.02, 'STOPPED'],
    [29, 30.102313, 31.3881736, 1.5, 9.3, 0, 0.03, 'STOPPED'],
    [34, 30.1021611, 31.3881312, 1.5, 9.5, 0, 0.02, 'STOPPED'],
    [40, 30.1020107, 31.3880431, 1.5, 7.8, 0, 0.03, 'STOPPED'],
    [44, 30.1021332, 31.3880241, 1.5, 7.7, 0, 0.03, 'STOPPED'],
    [46.66, 30.1022639, 31.3880008, 1.5, 9.4, 0, 0.03, 'STOPPED'],
    [49, 30.10256, 31.3880499, 1.5, 9.3, 0, 0.03, 'STOPPED'],
    [52, 30.102665, 31.3881103, 1.5, 9.5, 0, 0.02, 'STOPPED'],
    [55, 30.1029656, 31.3882015, 1.5, 9.6, 0, 0.02, 'STOPPED'],
    [58, 30.103338, 31.38832, 0.2, 8, 0, 0.02, 'STOPPED'],
  ];
  const HOME = { lat: 30.0970471, lng: 31.3815901, acc: 26.3 };

  it('the 2026-10-27 burst is stored but finds no place, no line, no mileage, no stop', async () => {
    const { employeeId } = await mkDriver();
    const t0 = Date.now();
    for (const [dtS, lat, lng, speed, acc, steps, energy, state] of BURST) {
      await prisma.position.create({
        data: { employeeId, clientTs: new Date(t0 + dtS * 1000), lat, lng, speedKmh: speed, accuracyM: acc, stepsPerMin: steps, motionEnergy: energy, motionState: state, ingestHash: `burst-${dtS}` },
      });
    }
    // the truth, the way it arrived: at 12:08:58 the receiver locked on and stayed there
    for (let k = 0; k < 3; k++) {
      await prisma.position.create({
        data: { employeeId, clientTs: new Date(t0 + (111.1 + k * 120) * 1000), lat: HOME.lat, lng: HOME.lng, speedKmh: 1.5, accuracyM: HOME.acc, stepsPerMin: 0, motionEnergy: 0.02, motionState: 'STOPPED', ingestHash: `truth-${k}` },
      });
    }

    const route = (await positions.route(employeeId, new Date(t0).toISOString().slice(0, 10))) as {
      distanceKm: number;
      rejectedPoints: number;
      points: { credible: boolean }[];
      trace: { lat: number; lng: number }[];
      stops: unknown[];
      geojson: { coordinates: unknown[] };
    };
    expect(route.points).toHaveLength(19);
    // the burst stayed stored and readable — every one of it not ground
    expect(route.points.slice(0, 16).every((p) => p.credible === false)).toBe(true);
    expect(route.points[16].credible).toBe(true);
    expect(route.rejectedPoints).toBe(16);
    // and the board shows the day it really was: one place, no line, no kilometres
    expect(route.distanceKm).toBe(0);
    expect(route.trace).toHaveLength(1);
    expect(route.trace[0].lat).toBeCloseTo(HOME.lat, 5);
    expect(route.trace[0].lng).toBeCloseTo(HOME.lng, 5);
    expect(route.geojson.coordinates.length).toBeLessThanOrEqual(1);
    expect(route.stops).toHaveLength(0);
  });
});
