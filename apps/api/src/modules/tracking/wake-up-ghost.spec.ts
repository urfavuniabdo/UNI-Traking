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
import { D0203_2026_10_26 } from './fixtures/d0203-2026-10-26';

// The acceptance replay of the real day in fixtures/d0203-2026-10-26.ts — see the describe block.
const DB = 'file:../tmp-ghost.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(180_000);

let prisma: PrismaService;
let positions: PositionsService;

/**
 * The day replayed on *today's* date: the classification is time-relative (windows, holds, sweeps),
 * so the fixes keep their exact 18:32:29Z→21:06:25Z clock times and their real gaps — only the
 * calendar date moves, which keeps the replay inside the 72 h replay window forever.
 */
const TODAY = new Date().toISOString().slice(0, 10);
const FIXES: PositionItemDto[] = D0203_2026_10_26.map(([ts, lat, lng, speed, accuracy]) => ({
  clientTs: `${TODAY}${ts.slice(10)}`,
  lat,
  lng,
  speed,
  accuracy,
}));

/** The wake-up block: 20 minutes of stand-by, then a phone nobody touched claimed 137 km/h. */
const at = (clock: string): number => FIXES.findIndex((f) => f.clientTs.slice(11, 19) >= clock);
const GHOST_END = at('19:03:44'); // the last fix of the burst
const STANDBY_AFTER = at('19:09:47'); // two fixes 258 s and 105 s apart, 10 m from home — he is sitting
const WALK_START = at('19:19:42'); // the walk he really took, 3-6 km/h at 3 m accuracy

async function mkDriver(): Promise<{ employeeId: string; deviceId: string }> {
  const org = await prisma.orgUnit.create({ data: { code: 'ghost-org', name: 'Org' } });
  const zone = await prisma.zone.create({
    data: { code: 'ghost-zone', name: 'Zone', orgUnitId: org.id, lat: 30.1006, lng: 31.3804, radiusM: 5000 },
  });
  const emp = await prisma.employee.create({
    data: { externalId: 'D0203', name: 'وائل جمال', phone: '+2010999999903', kind: 'DRIVER', orgUnitId: org.id, zoneId: zone.id },
  });
  const user = await prisma.user.create({
    data: { identifier: 'ghost-user', passwordHash: 'x', role: 'DRIVER', name: emp.name, employeeId: emp.id },
  });
  const device = await prisma.device.create({
    data: { deviceId: 'ghost-dev', employeeId: emp.id, userId: user.id, platform: 'android', tracking: true, gpsEnabled: true, online: true, batteryPct: 60, lastSeenAt: new Date() },
  });
  return { employeeId: emp.id, deviceId: device.deviceId };
}

const stateOf = async (employeeId: string): Promise<string | null> => {
  const snap = await positions.liveSnapshot();
  return snap.positions.find((p) => p.employeeId === employeeId)?.motionState ?? null;
};

/** Feed the device's own upload in the segments the day has. */
async function feed(deviceId: string, from: number, to: number, batchSeq: number): Promise<void> {
  await positions.ingestBatch({ deviceId, batchSeq, positions: FIXES.slice(from, to + 1) });
}

beforeAll(() => {
  try {
    rmSync('tmp-ghost.db', { force: true });
    rmSync('tmp-ghost.db-journal', { force: true });
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

/**
 * The acceptance replay of a real day: apps/api/src/modules/tracking/fixtures/d0203-2026-10-26.ts —
 * driver D0203, 2026-10-26, the twenty minutes his receiver spent waking up on his apartment floor
 * while he sat there. What the coordinates can answer, they answer here; what they cannot (a burst
 * whose own fixes are self-consistent at 100 km/h over 100 m) is stated as it is, and the motion
 * sensor is what closes it.
 */
describe('the day his receiver woke up (D0203, 2026-10-26)', () => {
  const WALK_CLOCK = FIXES[WALK_START].clientTs.slice(11, 19); // 19:19:42 — the day's one real journey

  /** The day replayed end to end, exactly as the device uploaded it, in the device's own batches. */
  async function replayTheDay(): Promise<{ employeeId: string }> {
    const driver = await mkDriver();
    await feed(driver.deviceId, 0, GHOST_END, 1);
    await feed(driver.deviceId, GHOST_END + 1, STANDBY_AFTER, 2);
    await feed(driver.deviceId, STANDBY_AFTER + 1, FIXES.length - 1, 3);
    return driver;
  }

  const routeOf = async (employeeId: string): Promise<{
    distanceKm: number;
    rejectedPoints: number;
    points: { clientTs: string; lat: number; lng: number; motionState: string; credible: boolean; speedKmh: number | null }[];
    trace: { clientTs: string; lat: number; lng: number; speedKmh: number | null }[];
    geojson: { coordinates: [number, number][] };
  }> => (await positions.route(employeeId, TODAY)) as never;

  const clock = (ts: string): string => new Date(ts).toISOString().slice(11, 19);
  const when = (hhmmss: string): Date => new Date(`${TODAY}T${hhmmss}.000Z`);

  it('the wake-up block gives the drawn line no ground', async () => {
    const { employeeId } = await replayTheDay();
    const route = await routeOf(employeeId);

    // 509 m in 67 s and 137 km/h from a phone nobody touched: refused, kept in the list, out of the line.
    expect(route.rejectedPoints).toBeGreaterThan(10);
    const blockDrops = route.points.filter((p) => clock(p.clientTs) >= '18:52:03' && clock(p.clientTs) <= '19:03:44' && !p.credible);
    expect(blockDrops.length).toBeGreaterThan(8);

    // The 509 m the block claimed never became part of his day: no point of the drawn line is there.
    const ghost = route.points.find((p) => clock(p.clientTs) === '18:53:01');
    expect(ghost?.credible).toBe(false);
    if (!ghost) throw new Error('the replay lost the fix the burst peaked on');
    expect(route.trace.filter((p) => Math.abs(p.lat - ghost.lat) + Math.abs(p.lng - ghost.lng) < 0.0004)).toEqual([]);

    // His day's ground starts when he actually set off: the whole 18:32→19:21 of stand-by — burst
    // included — folded into the one point of the place he sat, stamped at his first real step.
    expect(clock(route.trace[0].clientTs) >= '19:19:00').toBe(true);

    // His day is the walk he took, not the 1.907 km the ghost used to draw.
    expect(route.distanceKm).toBeGreaterThan(0.6);
    expect(route.distanceKm).toBeLessThan(1.5);
    expect(route.geojson.coordinates.length).toBeGreaterThan(4);
  });

  it('his state comes back to سكون when the burst ends — a journey cannot outlive the ground', async () => {
    const { employeeId } = await replayTheDay();

    // The complaint this whole pass answers: once the chip said «رحلة» it never went back. Two fixes
    // 258 s and 105 s apart, 10 m from home, put him back in his bubble, so they commit it at once.
    const rows = await prisma.position.findMany({ where: { employeeId }, orderBy: { clientTs: 'asc' } });
    const standby = rows.filter((r) => clock(r.clientTs.toISOString()) >= '19:08:02' && clock(r.clientTs.toISOString()) <= '19:09:47');
    expect(standby.map((r) => r.motionState)).toEqual(['STOPPED', 'STOPPED']);
    expect(await stateOf(employeeId)).toBe('STOPPED');
  });

  it('the block opens no journey, and pages the supervisor about no speed at all', async () => {
    const { employeeId } = await replayTheDay();

    // A journey starts where the line starts: the walk, never the 18:52 wake-up.
    expect(await prisma.trip.count({ where: { employeeId, startedAt: { lt: when(WALK_CLOCK) } } })).toBe(0);
    expect(await prisma.alert.count({ where: { employeeId, type: 'SPEEDING' } })).toBe(0);
  });

  it('the walk he really took still reads ماشي, and his journey reports it as a walk', async () => {
    const { employeeId } = await replayTheDay();

    const walkRows = await prisma.position.findMany({
      where: { employeeId, clientTs: { gte: when(WALK_CLOCK), lte: when('19:26:00') } },
      orderBy: { clientTs: 'asc' },
    });
    expect(walkRows.length).toBeGreaterThan(20);
    expect(walkRows.filter((r) => r.motionState === 'WALKING').length).toBeGreaterThan(walkRows.length / 2);

    const journey = await prisma.trip.findFirst({ where: { employeeId, startedAt: { gte: when(WALK_CLOCK) } }, orderBy: { startedAt: 'asc' } });
    expect(journey).not.toBeNull();
    expect(journey?.distanceKm).toBeGreaterThan(0.4);
    // 5.8 km/h, from the fixes the line stands behind: the receiver's 137 km/h is not his top speed.
    expect(journey?.maxSpeedKmh).toBeLessThan(12);
    expect(journey?.avgSpeedKmh).toBeLessThan(12);
  });

  it('the day ends with him on his feet, not on the road', async () => {
    const { employeeId } = await replayTheDay();
    const route = await routeOf(employeeId);

    // Whatever a receiver claims for four seconds, the whole day cannot be more walking than this —
    // the states it commits are the same ones the line, the trip and the reports are built from.
    const counts = route.points.reduce<Record<string, number>>((a, p) => {
      if (p.credible) a[p.motionState] = (a[p.motionState] ?? 0) + 1;
      return a;
    }, {});
    expect((counts.WALKING ?? 0) + (counts.STOPPED ?? 0)).toBeGreaterThan(200);
    expect(counts.RIDING ?? 0).toBeLessThan(20);
  });
});
