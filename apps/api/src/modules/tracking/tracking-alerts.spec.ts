import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../common/prisma.module';
import { PrismaService } from '../../common/prisma.service';
import { GeoModule } from '../../common/geo/geo.module';
import { RulesService } from '../rules/rules.service';
import { SettingsService } from '../rules/settings.service';
import { AlertDispatchService } from '../notify/alert-dispatch.service';
import { PushService } from '../notify/push.service';
import { MotionClassifierService } from './motion-classifier.service';
import { PositionsService } from './positions.service';
import { workDateOf } from '../../common/utils';
import { ALERT_DISPATCHER, REALTIME_PUBLISHER, type RealtimePublisher } from '../../common/contracts';

// Isolated temp sqlite DB for the realtime-tracking integration tests.
// Placed one level up (apps/api/) so it matches the .gitignore pattern `apps/api/tmp-*.db`.
const DB = 'file:../tmp-track-alerts.db';
process.env.DATABASE_URL = DB;
process.env.ALERT_COOLDOWN_S = '180';

jest.setTimeout(120_000);

let prisma: PrismaService;
let positions: PositionsService;
let settings: SettingsService;
let rules: RulesService;
const mockPublisher: jest.Mocked<RealtimePublisher> = {
  position: jest.fn(),
  alert: jest.fn(),
  attendance: jest.fn(),
  presence: jest.fn(),
};

const iso = (ms: number): string => new Date(ms).toISOString();

async function reset() {
  await prisma.setting.deleteMany();
  await prisma.notificationLog.deleteMany();
  await prisma.callLog.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.position.deleteMany();
  await prisma.stopEvent.deleteMany();
  await prisma.trip.deleteMany();
  await prisma.routeLine.deleteMany();
  await prisma.geoEvent.deleteMany();
  await prisma.userPreference.deleteMany();
  await prisma.attendanceRecord.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.device.deleteMany();
  await prisma.ruleOverride.deleteMany();
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
    data: { deviceId: `dev-${seq}`, employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 77, lastSeenAt: new Date() },
  });
  return { employeeId: emp.id, userId: user.id, deviceId: device.deviceId, zoneId: zone.id };
}

beforeAll(() => {
  try {
    rmSync('tmp-track-alerts.db', { force: true });
    rmSync('tmp-track-alerts.db-journal', { force: true });
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
      SettingsService,
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
  settings = moduleRef.get(SettingsService);
  rules = moduleRef.get(RulesService);
});

beforeEach(async () => {
  await reset();
  rules.invalidate();
  mockPublisher.position.mockClear();
  mockPublisher.alert.mockClear();
});

afterAll(async () => {
  try {
    await prisma?.$disconnect();
  } catch {
    /* ignore */
  }
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

  it('a driver who never takes a trip still trips his own 5-minute stop override', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    await prisma.ruleOverride.create({ data: { employeeId, stopAlertMin: 5 } });
    const t0 = Date.now();
    // the parked keep-alive: the same coordinates every minute, so no trip ever opens
    const parked = Array.from({ length: 8 }, (_, i) => ({
      clientTs: iso(t0 + i * 60000),
      lat: 30.0,
      lng: 30.0,
      speed: 0,
      accuracy: 6,
    }));
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: parked });

    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    expect(await countByType(employeeId, 'STOP_EXCEEDED')).toBe(1);
    const alert = await prisma.alert.findFirst({ where: { employeeId, type: 'STOP_EXCEEDED' } });
    expect(JSON.parse(alert?.meta ?? '{}').threshold).toBe(5);
  });
});

describe('Settings page → engine (global rules.global, inherited by a driver with no zone value or override)', () => {
  it('the «تنبيه التوقف» box alone moves STOP_EXCEEDED to 5 minutes', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    // zone has no stopAlertMin and there is no RuleOverride — the Settings box is the only source.
    await settings.patchRules({ stopAlertMin: 5 }, { id: 'admin', role: 'ADMIN' });
    const t0 = Date.now();
    const parked = Array.from({ length: 8 }, (_, i) => ({
      clientTs: iso(t0 + i * 60000),
      lat: 30.0,
      lng: 30.0,
      speed: 0,
      accuracy: 6,
    }));
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: parked });
    const alert = await prisma.alert.findFirst({ where: { employeeId, type: 'STOP_EXCEEDED' } });
    expect(JSON.parse(alert?.meta ?? '{}').threshold).toBe(5);
  });

  it('the «حد السرعة» box alone makes 40 km/h speeding when the global limit is set to 30', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    await settings.patchRules({ maxSpeedKmh: 30 }, { id: 'admin', role: 'ADMIN' });
    const t0 = Date.now();
    const mk = (offsetS: number, lat: number) => ({ clientTs: iso(t0 + offsetS * 1000), lat, lng: 30.0, speed: 40, accuracy: 5 });
    await positions.ingestBatch({ deviceId, batchSeq: 1, positions: [mk(0, 30.0), mk(5, 30.0003), mk(10, 30.0006)] });
    expect(await countByType(employeeId, 'SPEEDING')).toBe(1);
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

interface RouteEnvelope {
  employeeId: string;
  userName: string;
  distanceKm: number;
  points: { clientTs: string; buffered: boolean }[];
  replayedPoints: number;
  stops: { startTs: string; endTs: string | null; durationMin: number; kind: string; lat: number; lng: number }[];
  gaps: { fromTs: string; toTs: string; minutes: number }[];
  // legacy aliases kept for existing specs / external consumers
  positions: { ts: string }[];
  pointCount: number;
}

describe('GET /positions/live — enriched live item (read surface)', () => {
  it('carries device-health flags and is keyed by employee id', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [{ clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 20, accuracy: 5 }],
    });
    const snap = await positions.liveSnapshot();
    expect(Array.isArray(snap.positions)).toBe(true);
    expect(typeof snap.serverTs).toBe('string');
    const item = snap.positions.find((p) => p.employeeId === employeeId);
    expect(item).toBeTruthy();
    // keyed by employee id (the dashboard live-store key)
    expect(item?.id).toBe(employeeId);
    expect(item?.userId).toBe(employeeId);
    expect(item?.employeeId).toBe(employeeId);
    // device-health flags surfaced from the Device row ingest already maintains
    for (const key of ['online', 'gpsEnabled', 'dataEnabled', 'tracking', 'lastSeen', 'battery']) {
      expect(item).toHaveProperty(key);
    }
    expect(item?.online).toBe(true);
    expect(item?.tracking).toBe(true);
    expect(item?.gpsEnabled).toBe(true);
    expect(item?.dataEnabled).toBe(true);
    expect(item?.battery).toBe(77);
    expect(typeof item?.lastSeen).toBe('string');
  });

  it('broadcasts the same enriched fields on the socket position:update payload', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [{ clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 20, accuracy: 6 }],
    });
    expect(mockPublisher.position).toHaveBeenCalled();
    const calls = mockPublisher.position.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(last.employeeId).toBe(employeeId);
    expect(last.userId).toBe(employeeId);
    expect(last.id).toBe(employeeId);
    for (const key of ['online', 'gpsEnabled', 'dataEnabled', 'tracking', 'lastSeen', 'battery']) {
      expect(last).toHaveProperty(key);
    }
    expect(last.online).toBe(true);
    expect(last.accuracy).toBe(6);
  });
});

describe('GET /positions/route — dashboard envelope (rename)', () => {
  it('returns points/stops/gaps/userName/distanceKm and keeps positions/pointCount aliases', async () => {
    const { employeeId, userId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 30, accuracy: 5 },
        { clientTs: iso(t0 + 300000), lat: 30.005, lng: 30.0, speed: 40, accuracy: 5 },
      ],
    });
    // a stop with DB columns startedAt/endedAt/durationS → exposed as startTs/endTs/durationMin
    await prisma.stopEvent.create({
      data: { employeeId, startedAt: new Date(t0), endedAt: new Date(t0 + 1_200_000), durationS: 1200, kind: 'UNPLANNED', lat: 30.0, lng: 30.0 },
    });
    const date = new Date(t0).toISOString().slice(0, 10);
    const route = (await positions.route(userId, date)) as RouteEnvelope;

    expect(typeof route.userName).toBe('string');
    expect(typeof route.distanceKm).toBe('number');
    expect(Array.isArray(route.points)).toBe(true);
    expect(route.points[0]).toHaveProperty('clientTs');
    expect(typeof route.replayedPoints).toBe('number');
    expect(Array.isArray(route.stops)).toBe(true);
    expect(route.stops[0]?.startTs).toBe(new Date(t0).toISOString());
    expect(route.stops[0]?.endTs).toBe(new Date(t0 + 1_200_000).toISOString());
    expect(route.stops[0]?.durationMin).toBe(20); // 1200s → 20 min
    expect(route.stops[0]?.kind).toBe('UNPLANNED');
    expect(Array.isArray(route.gaps)).toBe(true);

    // kept aliases: `positions` (existing spec reads positions[].ts) + `pointCount`
    expect(Array.isArray(route.positions)).toBe(true);
    expect(route.positions[0]).toHaveProperty('ts');
    expect(route.pointCount).toBe(2);
    expect(route.employeeId).toBe(employeeId);
  });
});

/** An office employee: same device, same JWT, no tracking of any kind. */
async function mkOfficeEmployee() {
  seq += 1;
  const org = await prisma.orgUnit.create({ data: { code: `org-${seq}`, name: 'Org' } });
  const site = await prisma.site.create({
    data: { code: `site-${seq}`, name: 'Office', orgUnitId: org.id, lat: 30.0444, lng: 31.2357, radiusM: 250 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: `ext-${seq}`, name: `موظف ${seq}`, phone: `+20100000001${seq}`, kind: 'EMPLOYEE', orgUnitId: org.id, siteId: site.id },
  });
  const user = await prisma.user.create({
    data: { identifier: `u-${seq}`, passwordHash: 'x', role: 'EMPLOYEE', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: `dev-${seq}`, employeeId: emp.id, userId: user.id, platform: 'android', tracking: false, gpsEnabled: true, online: true, batteryPct: 55, lastSeenAt: new Date() },
  });
  return { employeeId: emp.id, userId: user.id, deviceId: device.deviceId };
}

describe('POST /positions/batch — an office employee is never tracked (CONTRACT §3/§4)', () => {
  it('refuses the batch outright: no position row, no trip, no alert, no live broadcast', async () => {
    const { employeeId, deviceId } = await mkOfficeEmployee();
    const t0 = Date.now();
    // The same points that open a trip + raise SPEEDING for a driver.
    await expect(
      positions.ingestBatch({
        deviceId,
        batchSeq: 1,
        positions: [
          { clientTs: iso(t0), lat: 30.0, lng: 31.23, speed: 60, accuracy: 5 },
          { clientTs: iso(t0 + 15000), lat: 30.02, lng: 31.23, speed: 190, accuracy: 5 },
          { clientTs: iso(t0 + 30000), lat: 30.04, lng: 31.23, speed: 0, accuracy: 5 },
        ],
      }),
    ).rejects.toThrow('TRACKING_NOT_ALLOWED_FOR_EMPLOYEE');

    expect(await prisma.position.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.trip.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.stopEvent.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.routeLine.count({ where: { employeeId } })).toBe(0);
    expect(await prisma.alert.count({ where: { employeeId } })).toBe(0);
    expect(mockPublisher.position).not.toHaveBeenCalled();
  });

  it('a driver on the same code path is still tracked, so the guard is per kind not global', async () => {
    const { employeeId, deviceId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 100000 });
    const t0 = Date.now();
    // 60 km/h covers a kilometre a minute — the coordinates and the phone have to say the same
    // thing, or the net-window rule is right to call the device a liar and keep him parked.
    const res = await positions.ingestBatch({
      deviceId,
      batchSeq: 1,
      positions: [
        { clientTs: iso(t0), lat: 30.0, lng: 30.0, speed: 60, accuracy: 5 },
        { clientTs: iso(t0 + 60000), lat: 30.009, lng: 30.0, speed: 60, accuracy: 5 },
        { clientTs: iso(t0 + 120000), lat: 30.018, lng: 30.0, speed: 60, accuracy: 5 },
      ],
    });
    expect(res.accepted).toBe(3);
    expect(await prisma.trip.count({ where: { employeeId } })).toBeGreaterThan(0);
  });
});

describe('heartbeat sweep — silence is only news while the day is open', () => {
  async function goQuiet(employeeId: string): Promise<void> {
    const dev = await prisma.device.findFirstOrThrow({ where: { employeeId } });
    await prisma.device.update({
      where: { id: dev.id },
      data: { lastSeenAt: new Date(Date.now() - 20 * 60_000), online: true, tracking: true },
    });
  }

  it('a registered device with no open shift raises nothing', async () => {
    const { employeeId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 1000 });
    await goQuiet(employeeId);
    await positions.heartbeatSweep();
    expect(await countByType(employeeId, 'HEARTBEAT_MISSING')).toBe(0);
    expect(await countByType(employeeId, 'APP_OFFLINE')).toBe(0);
  });

  it('the same device mid-shift raises HEARTBEAT_MISSING + APP_OFFLINE', async () => {
    const { employeeId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 1000 });
    await goQuiet(employeeId);
    await prisma.attendanceRecord.create({
      data: { employeeId, workDate: workDateOf(new Date()), status: 'VALID', checkInAt: new Date() },
    });
    await positions.heartbeatSweep();
    expect(await countByType(employeeId, 'HEARTBEAT_MISSING')).toBe(1);
    expect(await countByType(employeeId, 'APP_OFFLINE')).toBe(1);
  });

  it('stops alerting once the day is closed', async () => {
    const { employeeId } = await mkDriver({ lat: 30.0, lng: 30.0, radiusM: 1000 });
    await goQuiet(employeeId);
    const rec = await prisma.attendanceRecord.create({
      data: { employeeId, workDate: workDateOf(new Date()), status: 'VALID', checkInAt: new Date() },
    });
    await positions.heartbeatSweep();
    expect(await countByType(employeeId, 'APP_OFFLINE')).toBe(1);

    await prisma.alert.deleteMany({ where: { employeeId } });
    await prisma.attendanceRecord.update({ where: { id: rec.id }, data: { checkOutAt: new Date() } });
    await positions.heartbeatSweep();
    expect(await countByType(employeeId, 'APP_OFFLINE')).toBe(0);
  });
});
