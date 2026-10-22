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
import { ALERT_DISPATCHER, REALTIME_PUBLISHER, type RealtimePublisher } from '../../common/contracts';

// Isolated temp sqlite DB for the realtime-tracking integration tests.
const DB = 'file:./tmp-track-alerts.db';
process.env.DATABASE_URL = DB;
process.env.ALERT_COOLDOWN_S = '180';

jest.setTimeout(120_000);

let prisma: PrismaService;
let positions: PositionsService;
const mockPublisher: jest.Mocked<RealtimePublisher> = {
  position: jest.fn(),
  alert: jest.fn(),
  attendance: jest.fn(),
  presence: jest.fn(),
};

const iso = (ms: number): string => new Date(ms).toISOString();

async function reset() {
  await prisma.notificationLog.deleteMany();
  await prisma.callLog.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.position.deleteMany();
  await prisma.stopEvent.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.routeLine.deleteMany();
  await prisma.geoEvent.deleteMany();
  await prisma.userPreference.deleteMany();
  await prisma.device.deleteMany();
  await prisma.user.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.zone.deleteMany();
  await prisma.site.deleteMany();
  await prisma.orgUnit.deleteMany();
}

let seq = 0;
async function mkDriver(opts: { lat: number; lng: number; radiusM: number }) {
  seq += 1;
  const org = await prisma.orgUnit.create({ data: { code: `org-${seq}`, name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: `z-${seq}`, name: 'Zone', orgUnitId: org.id, lat: opts.lat, lng: opts.lng, radiusM: opts.radiusM },
  });
  const emp = await prisma.employee.create({
    data: { externalId: `ext-${seq}`, name: `سائق ${seq}`, phone: `+20100000000${seq}`, kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: `u-${seq}`, passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: `dev-${seq}`, employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, lastSeenAt: new Date(), online: true },
  });
  return { employeeId: emp.id, userId: user.id, deviceId: device.deviceId, zoneId: zone.id };
}

beforeAll(() => {
  try {
    rmSync('prisma/tmp-track-alerts.db', { force: true });
    rmSync('prisma/tmp-track-alerts.db-journal', { force: true });
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
      { provide: REALTIME_PUBLISHER, useValue: mockPublisher },
    ],
  }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  positions = moduleRef.get(PositionsService);
});

beforeEach(async () => {
  await reset();
  mockPublisher.position.mockClear();
  mockPublisher.alert.mockClear();
});

const countByType = async (employeeId: string, type: string): Promise<number> =>
  prisma.alert.count({ where: { employeeId, type } });

describe('POST /positions/batch — idempotency (CONTRACT §4)', () => {
  it('a duplicate batch is fully deduped and raises no double alerts', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    const batch = {
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0 + 5000), lat: 30.0002, lng: 30.0, speed: 120, accuracy: 5 },
        { clientTs: iso(t0 + 10000), lat: 30.0004, lng: 30.0, speed: 120, accuracy: 5 },
        { clientTs: iso(t0 + 15000), lat: 30.0006, lng: 30.0, speed: 120, accuracy: 5 },
      ],
    };
    const r1 = await positions.ingestBatch(batch);
    expect(r1.accepted).toBe(3);
    expect(r1.deduped).toBe(0);
    expect(r1.alertsRaised).toBeGreaterThanOrEqual(1); // SPEEDING fired once
    const speeding1 = await countByType(employeeId, 'SPEEDING');

    // Re-send the exact same batch → everything deduped, pipeline not re-run.
    const r2 = await positions.ingestBatch(batch);
    expect(r2.accepted).toBe(0);
    expect(r2.deduped).toBe(3);
    expect(r2.alertsRaised).toBe(0);
    expect(await countByType(employeeId, 'SPEEDING')).toBe(speeding1);
  });

  it('rejects invalid items with reasons but still ingests the valid ones', async () => {
    const { deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    const res = await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0), lat: 999, lng: 30.0, accuracy: 5 }, // BAD_COORDS
        { clientTs: 'not-a-date', lat: 30.0, lng: 30.0 }, // BAD_CLIENTTS
        { clientTs: iso(t0 + 5000), lat: 30.0, lng: 30.001, accuracy: 5 }, // ok
      ],
    });
    expect(res.rejected.map((r) => r.reason)).toEqual(['BAD_COORDS', 'BAD_CLIENTTS']);
    expect(res.accepted).toBe(1);
  });
});

describe('Overspeed → SPEEDING with cooldown (§6)', () => {
  it('raises SPEEDING after speedSamples consecutive fast samples, then cooldown suppresses', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    const mk = (offsetS: number, lat: number) => ({ clientTs: iso(t0 + offsetS * 1000), lat, lng: 30.0, speed: 120, accuracy: 5 });
    const b1 = await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [mk(0, 30.0), mk(5, 30.0003), mk(10, 30.0006)] });
    expect(b1.alertsRaised).toBe(1);
    expect(await countByType(employeeId, 'SPEEDING')).toBe(1);

    // A follow-up batch of fast points, still inside the cooldown window & below the critical duration.
    const b2 = await positions.ingestBatch({ deviceId, batchSeq: 2, positions: [mk(20, 30.0009), mk(25, 30.0012)] });
    expect(b2.alertsRaised).toBe(0);
    expect(await countByType(employeeId, 'SPEEDING')).toBe(1);
  });
});

describe('STOP_EXCEEDED (§5/§6)', () => {
  it('fires exactly once when a stop run exceeds stopAlertMin', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    const travel = [0, 1, 2].map((i) => ({ clientTs: iso(t0 + i * 6000), lat: 30.0 + i * 0.001, lng: 30.0, speed: 40, accuracy: 5 }));
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: travel });
    // long stopped run (25 samples @ 300s) — crosses 30-min stop threshold and hysteresis.
    const stopped = Array.from({ length: 25 }, (_, i) => ({
      clientTs: iso(t0 + 18000 + i * 300000),
      lat: 30.003,
      lng: 30.0,
      speed: 0,
      accuracy: 5,
    }));
    await positions.ingestBatch({ deviceId, batchSeq: 2, positions: stopped });
    expect(await countByType(employeeId, 'STOP_EXCEEDED')).toBe(1);
    const stop = await prisma.stopEvent.findFirst({ where: { employeeId } });
    expect(stop?.alerted).toBe(true);
  });
});

describe('GEOFENCE_EXIT grace period (§6)', () => {
  it('fires only after the driver has been outside the zone for geofenceGraceS', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100 });
    const t0 = Date.now();
    const p = (offsetS: number, lat: number) => ({ clientTs: iso(t0 + offsetS * 1000), lat, lng: 30.0, speed: 10, accuracy: 5 });
    // inside at t0, then outside from 60s; the 120s grace is crossed at 180s.
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [p(0, 30.0), p(60, 30.02), p(120, 30.02), p(180, 30.02)],
    });
    expect(await countByType(employeeId, 'GEOFENCE_EXIT')).toBe(1);
    // returning inside the zone emits GEOFENCE_ENTER
    await positions.ingestBatch({ deviceId, batchSeq: 2, positions: [p(240, 30.0)] });
    expect(await countByType(employeeId, 'GEOFENCE_ENTER')).toBe(1);
  });
});

describe('Offline replay BUFFER_REPLAYED + clientTs ordering (§4/§7)', () => {
  it('flags a replayed batch and the route stays ordered by clientTs', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    // realtime points (recent, not buffered) establish the realtime frontier
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 20, accuracy: 5 },
        { clientTs: iso(t0 + 5000), lat: 30.0003, lng: 30.0, speed: 20, accuracy: 5 },
      ],
    });
    // a batch of buffered points OLDER than the frontier, delivered out of order
    const res = await positions.ingestBatch({
      deviceId,
      batchSeq: 2,
      positions: [
        { clientTs: iso(t0 - 300000), lat: 30.01, lng: 30.0, speed: 25, accuracy: 5, buffered: true },
        { clientTs: iso(t0 - 500000), lat: 30.02, lng: 30.0, speed: 25, accuracy: 5, buffered: true },
        { clientTs: iso(t0 - 400000), lat: 30.015, lng: 30.0, speed: 25, accuracy: 5, buffered: true },
      ],
    });
    expect(res.accepted).toBe(3);
    expect(await countByType(employeeId, 'BUFFER_REPLAYED')).toBe(1);
    const br = await prisma.alert.findFirst({ where: { employeeId, type: 'BUFFER_REPLAYED' } });
    expect(br?.replayed).toBe(true);

    // Verify DB-level ordering directly (route() sorts by clientTs).
    const rows = await prisma.position.findMany({ where: { employeeId }, orderBy: { clientTs: 'asc' } });
    const times = rows.map((r) => r.clientTs.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(rows.every((r) => r.buffered || r.clientTs.getTime() >= t0)).toBe(true);
  });

  it('GET /positions/route returns a GeoJSON LineString ordered by clientTs', async () => {
    const { employeeId, userId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0 + 10000), lat: 30.001, lng: 30.0, speed: 30, accuracy: 5 },
        { clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 30, accuracy: 5 },
      ],
    });
    const date = new Date(t0).toISOString().slice(0, 10);
    const route = (await positions.route(userId, date)) as {
      geojson: { type: string; coordinates: number[][] };
      positions: { ts: string }[];
      employeeId: string;
    };
    expect(route.employeeId).toBe(employeeId);
    expect(route.geojson.type).toBe('LineString');
    const ts = route.positions.map((p) => new Date(p.ts).getTime());
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});

describe('HARSH_BRAKING from GPS (§6)', () => {
  it('raises HARSH_BRAKING when deceleration ≤ -2.2 m/s²', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    const res = await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 60, accuracy: 5 },
        { clientTs: iso(t0 + 3000), lat: 30.0001, lng: 30.0, speed: 20, accuracy: 5 },
      ],
    });
    expect(res.alertsRaised).toBeGreaterThanOrEqual(1);
    expect(await countByType(employeeId, 'HARSH_BRAKING')).toBe(1);
    const alert = await prisma.alert.findFirst({ where: { employeeId, type: 'HARSH_BRAKING' } });
    expect(JSON.parse(alert?.meta ?? '{}').accelMs2).toBeLessThanOrEqual(-2.2);
  });
});
