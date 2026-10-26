import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import type { MotionState } from '../../shared/constants';
import { EMPLOYEE_KIND, MOTION, RULE_DEFAULTS, SEVERITY, type AlertType } from '../../shared/constants';
import { PrismaService } from '../../common/prisma.service';
import { GeoService, NOISE_FLOOR_M } from '../../common/geo/geo.service';
import { TraceService } from '../../common/geo/trace.service';
import { json, parseJson, round, workDateOf, isValidLat, isValidLng } from '../../common/utils';
import {
  ALERT_DISPATCHER,
  REALTIME_PUBLISHER,
  type AlertDispatcher,
  type LivePosition,
  type LivePositionBase,
  type RaiseAlertInput,
  type RealtimePublisher,
} from '../../common/contracts';
import { RulesService, type EmployeeContext } from '../rules/rules.service';
import { MotionClassifierService, type MotionTrack } from './motion-classifier.service';
import type { BatchResult, BatchRejectedItem, PositionBatchDto, PositionItemDto } from './dto';

interface Track {
  motion: MotionTrack;
  last: { lat: number; lng: number; ts: number; speedKmh: number | null } | null;
  /**
   * The fixes the net-displacement window is measured over, oldest first. A *point-to-point* step
   * cannot tell a walk from GPS wander — standing still in a courtyard wandered 40 m out and back in
   * 7 minutes and read as 6.2 km/h — so movement is judged between the means of the window's halves.
   */
  window: NetFix[];
  speedOverStreak: number;
  overRunActive: boolean;
  overSinceTs: number | null;
  overCriticalRaised: boolean;
  outsideSinceTs: number | null;
  geofenceState: 'IN' | 'OUT' | 'UNKNOWN';
  exitRaised: boolean;
  stopStart: { ts: number; lat: number; lng: number; stopId: string; alerted: boolean } | null;
  openTrip:
    | {
        id: string;
        workDate: string;
        startedAt: number;
        maxSpeed: number | null;
        lastMoveTs: number;
        replayed: boolean;
      }
    | null;
  lastRealtimeTs: number | null;
  /** wall-clock ms of the last position heard from this driver, whatever its clientTs said */
  seenAt: number;
  gapsByDate: Record<string, { from: string; to: string; gapS: number }[]>;
  touchedDates: Set<string>;
}

const MAX_BATCH = 500;

/** One fix inside the net-displacement window: where it was, when, and how far it could have lied. */
interface NetFix {
  lat: number;
  lng: number;
  ts: number;
  noiseM: number;
}

/** How many fixes the window keeps — enough means to average drift out, few enough to stay cheap. */
const NET_WINDOW_MAX_FIXES = 24;

/** A run whose device has said nothing for this long is over — check-out, a killed app or a deploy. */
const TRIP_IDLE_MS = 600_000;

/** How often the whole board's trails are re-read: the line grows live between reads, so this is cold-start only. */
const TRAILS_TTL_MS = 10_000;

/** Employee identity/geo metadata used to enrich a live item (cached; `at` = epoch ms). */
interface EmployeeMeta {
  name: string;
  externalId: string | null;
  kind: string | null;
  driver: boolean;
  userId: string | null;
  zoneId: string | null;
  zoneName: string | null;
  siteId: string | null;
  siteName: string | null;
}

/** Device health row projected for live enrichment. */
interface DeviceHealthRow {
  employeeId: string | null;
  online: boolean;
  tracking: boolean;
  gpsEnabled: boolean;
  batteryPct: number | null;
  lastSeenAt: Date | null;
}

/** RouteLine.gaps stored shape → mapped to the dashboard gap envelope. */
interface RouteGapRaw {
  from: string;
  to: string;
  gapS?: number;
}

/** A stored position row projected for the coordinate replay (`route()` read path). */
interface ReplayRow {
  lat: number;
  lng: number;
  clientTs: Date;
  speedKmh: number | null;
  accuracyM: number | null;
  bearing: number | null;
  buffered: boolean;
  stale: boolean;
}

/** A replayed position: the raw fix plus what the coordinates say about it. */
type ReplayPoint = ReplayRow & { motionState: MotionState; speedKmh: number | null; credible: boolean };

const META_TTL_MS = 60_000;

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);
  private tracks = new Map<string, Track>();
  private live = new Map<string, LivePositionBase>();
  /** cached employee identity/geo metadata (rarely changes; refreshed lazily). */
  private metaCache = new Map<string, { at: number; value: EmployeeMeta }>();
  /** the whole board's trails, re-read at most every TRAILS_TTL_MS. */
  private trailsCache: { at: number; windowMin: number; payload: unknown } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly trace: TraceService,
    private readonly rules: RulesService,
    private readonly classifier: MotionClassifierService,
    @Optional() @Inject(ALERT_DISPATCHER) private readonly dispatcher?: AlertDispatcher,
    @Optional() @Inject(REALTIME_PUBLISHER) private readonly publisher?: RealtimePublisher,
  ) {}

  private hashOf(employeeId: string, clientTs: Date, lat: number, lng: number): string {
    const canonical = `${employeeId}|${clientTs.toISOString()}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
    return createHash('sha1').update(canonical).digest('hex');
  }

  /**
   * Adds a fix to the net window and slides it: older than MAX_NET_WINDOW_S (or more than
   * NET_WINDOW_MAX_FIXES of them) falls off the front, so a long walk is judged on the last two
   * minutes and not on where the day started.
   */
  private pushWindow(window: NetFix[], fix: NetFix): void {
    window.push(fix);
    while (window.length > 1 && fix.ts - window[0].ts > MOTION.MAX_NET_WINDOW_S * 1000) window.shift();
    while (window.length > NET_WINDOW_MAX_FIXES) window.shift();
  }

  /**
   * The net-displacement evidence of a window: the mean of its older half to the mean of its newer
   * half, over the whole window. GPS wander is zero-mean noise, so it cancels out of a mean — a
   * driver standing still in a courtyard measured 21 m between the two means over 40 s while his
   * fixes scattered 40 m around him, and every point-to-point rule in the pipeline called that
   * "ماشي". Shorter sub-windows were tried and are worse: they throw away the averaging that makes
   * the mean trustworthy, and his own standing burst then read as a move.
   */
  private netEvidence(window: NetFix[]): { anchorM: number; anchorDtS: number | null; netSamples: number; noiseRadiusM: number } {
    const mean = (rows: NetFix[]): NetFix => ({
      lat: rows.reduce((a, r) => a + r.lat, 0) / rows.length,
      lng: rows.reduce((a, r) => a + r.lng, 0) / rows.length,
      ts: Math.round(rows.reduce((a, r) => a + r.ts, 0) / rows.length),
      noiseM: Math.round(rows.reduce((a, r) => a + r.noiseM, 0) / rows.length),
    });
    const noiseRadiusM = mean(window).noiseM;
    if (window.length < 2) return { anchorM: 0, anchorDtS: null, netSamples: window.length, noiseRadiusM };
    const half = Math.ceil(window.length / 2);
    const older = mean(window.slice(0, half));
    const newer = mean(window.slice(half));
    const anchorDtS = (newer.ts - older.ts) / 1000;
    if (anchorDtS <= 0) return { anchorM: 0, anchorDtS: null, netSamples: window.length, noiseRadiusM };
    return { anchorM: this.geo.distanceM(older, newer), anchorDtS, netSamples: window.length, noiseRadiusM };
  }

  private newTrack(): Track {
    return {
      motion: this.classifier.newTrack(),
      last: null,
      window: [],
      speedOverStreak: 0,
      overRunActive: false,
      overSinceTs: null,
      overCriticalRaised: false,
      outsideSinceTs: null,
      geofenceState: 'UNKNOWN',
      exitRaised: false,
      stopStart: null,
      openTrip: null,
      lastRealtimeTs: null,
      seenAt: 0,
      gapsByDate: {},
      touchedDates: new Set(),
    };
  }

  /** POST /positions/batch — the only position entry point (CONTRACT §4). */
  async ingestBatch(dto: PositionBatchDto): Promise<BatchResult> {
    const now = new Date();
    const rejected: BatchRejectedItem[] = [];
    let accepted = 0;
    let deduped = 0;
    let alertsRaised = 0;
    const items = dto?.positions ?? [];
    if (!Array.isArray(items)) throw new BadRequestException('POSITIONS_REQUIRED');
    if (items.length > MAX_BATCH) throw new BadRequestException('BATCH_TOO_LARGE');

    const device = await this.prisma.device.findUnique({
      where: { deviceId: dto.deviceId },
      include: { user: { select: { employeeId: true } } },
    });
    const employeeId = device?.employeeId ?? device?.user?.employeeId ?? null;
    if (!employeeId) {
      items.forEach((_, i) => rejected.push({ index: i, reason: 'NO_EMPLOYEE' }));
      return { accepted, deduped, rejected, alertsRaised, nextServerTs: now.toISOString() };
    }

    const ctx = await this.rules.context(employeeId);

    // An office EMPLOYEE is attendance-only (CONTRACT §3/§4): nothing he uploads may open a
    // trip, a stop, a route line, an alert or a live marker. His app never starts the location
    // service, so reaching here means a stale/misconfigured client — refuse before any write.
    if (ctx && ctx.kind !== EMPLOYEE_KIND.DRIVER) throw new BadRequestException('TRACKING_NOT_ALLOWED_FOR_EMPLOYEE');

    // batchSeq: monotonic update, but out-of-order (lower) batches are still ingested.
    if (device) {
      const seq = Number(dto.batchSeq) || 0;
      if (seq > device.lastBatchSeq) {
        await this.prisma.device.update({ where: { id: device.id }, data: { lastBatchSeq: seq } }).catch(() => undefined);
      }
    }

    const replayWindow = (ctx?.thresholds.replayMaxAgeHours ?? 72) * 3600_000;
    const track = this.tracks.get(employeeId) ?? this.newTrack();
    this.tracks.set(employeeId, track);
    const baselineRealtimeTs = track.lastRealtimeTs;

    // 1) per-item validate + idempotent store
    const stored: {
      id: string;
      ts: number;
      lat: number;
      lng: number;
      speedKmh: number | null;
      accuracyM: number | null;
      buffered: boolean; // device-buffered
      stale: boolean;
    }[] = [];
    let deviceBufferedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as PositionItemDto;
      const v = this.validateItem(item);
      if (v) {
        rejected.push({ index: i, reason: v });
        continue;
      }
      const clientTs = new Date(item.clientTs);
      const tsMs = clientTs.getTime();
      const buffered = item.buffered === true || now.getTime() - tsMs > 180_000; // 3 min
      const deviceBuffered = item.buffered === true;
      const stale = now.getTime() - tsMs > replayWindow;
      if (deviceBuffered) deviceBufferedCount++;

      const ingestHash = this.hashOf(employeeId, clientTs, item.lat, item.lng);
      try {
        const created = await this.prisma.position.create({
          data: {
            employeeId,
            deviceId: device?.id ?? null,
            clientTs,
            serverTs: now,
            lat: item.lat,
            lng: item.lng,
            speedKmh: Number.isFinite(item.speed as number) ? item.speed ?? null : null,
            bearing: Number.isFinite(item.bearing as number) ? item.bearing ?? null : null,
            accuracyM: Number.isFinite(item.accuracy as number) ? item.accuracy ?? null : null,
            altitudeM: Number.isFinite(item.altitude as number) ? item.altitude ?? null : null,
            batteryPct: Number.isFinite(item.battery as number) ? Math.round(item.battery as number) : null,
            provider: item.provider ?? null,
            motionState: 'UNKNOWN',
            buffered,
            stale,
            ingestHash,
          },
          select: { id: true },
        });
        accepted++;
        stored.push({
          id: created.id,
          ts: tsMs,
          lat: item.lat,
          lng: item.lng,
          speedKmh: Number.isFinite(item.speed as number) ? (item.speed as number) : null,
          accuracyM: Number.isFinite(item.accuracy as number) ? (item.accuracy as number) : null,
          buffered: deviceBuffered,
          stale,
        });
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') deduped++;
        else rejected.push({ index: i, reason: `DB_${(err as { code?: string }).code ?? 'ERR'}` });
      }
    }

    // 2) process ONLY newly accepted points, strictly ordered by clientTs (preserves realtime look)
    stored.sort((a, b) => a.ts - b.ts);
    for (const p of stored) {
      alertsRaised += await this.processPoint(ctx, employeeId, p, track);
    }

    // 3) offline-replay gap filled → BUFFER_REPLAYED (INFO)
    const replayGap =
      baselineRealtimeTs != null
        ? stored.filter((p) => p.buffered && p.ts < baselineRealtimeTs).length
        : 0;
    if (deviceBufferedCount > 0 && this.dispatcher) {
      const r = await this.dispatcher.raise({
        type: 'BUFFER_REPLAYED' as AlertType,
        severity: SEVERITY.INFO,
        employeeId,
        targetUserId: ctx?.userId ?? undefined,
        zoneId: ctx?.zoneId ?? undefined,
        meta: { count: Math.max(replayGap, deviceBufferedCount), buffered: deviceBufferedCount, replayGap },
        replayed: true,
      });
      if (r && !r.suppressed) alertsRaised++;
    }

    // 4) persist per-day route lines (rebuilt from the full day of stored positions)
    for (const date of track.touchedDates) {
      await this.rebuildRouteLine(employeeId, date, track);
    }

    this.tracks.set(employeeId, track);
    return { accepted, deduped, rejected, alertsRaised, nextServerTs: now.toISOString() };
  }

  private validateItem(item: PositionItemDto): string | null {
    if (!item || typeof item !== 'object') return 'BAD_ITEM';
    if (!item.clientTs || Number.isNaN(new Date(item.clientTs).getTime())) return 'BAD_CLIENTTS';
    if (!isValidLat(Number(item.lat)) || !isValidLng(Number(item.lng))) return 'BAD_COORDS';
    if (item.speed !== undefined && item.speed !== null && !Number.isFinite(Number(item.speed))) return 'BAD_SPEED';
    return null;
  }

  /** Full rules/trip/stop pipeline for one accepted, usable position (in clientTs order). */
  private async processPoint(
    ctx: EmployeeContext | null,
    employeeId: string,
    p: { id: string; ts: number; lat: number; lng: number; speedKmh: number | null; accuracyM: number | null; buffered: boolean; stale: boolean },
    track: Track,
  ): Promise<number> {
    let alertsRaised = 0;
    track.seenAt = Date.now();
    if (!this.dispatcher) {
      // no dispatcher wired → still keep live cache & motion state, but skip rules
    }
    const th = ctx?.thresholds;
    const gate = this.classifier.isDroppable({ accuracyM: p.accuracyM, dtS: track.last ? (p.ts - track.last.ts) / 1000 : null, speedKmh: p.speedKmh });
    if (gate.dropped) return alertsRaised;

    const dtS = track.last ? (p.ts - track.last.ts) / 1000 : null;
    const distanceFromLast = track.last ? this.geo.distanceM(track.last, { lat: p.lat, lng: p.lng }) : 0;

    // Speed comes from the coordinates first. The phone's own reading only stands when the ground
    // agrees he went somewhere — and "somewhere" is the net displacement of a window, not the step
    // from the last fix: a fix that never left its noise circle is a parked phone whatever its
    // Doppler claims (a cached last-known position used to read as 150 km/h and open a trip for a
    // driver sitting still, and a parked phone's 40 m wander out-and-back read as a 6 km/h stroll).
    const noiseRadiusM = Math.min(Math.max(p.accuracyM ?? 0, NOISE_FLOOR_M), th?.accuracyDriftM ?? NOISE_FLOOR_M);
    this.pushWindow(track.window, { lat: p.lat, lng: p.lng, ts: p.ts, noiseM: noiseRadiusM });
    const net = this.netEvidence(track.window);
    const ground = this.classifier.groundSpeed({
      deviceKmh: p.speedKmh,
      stepM: distanceFromLast,
      stepDtS: dtS,
      ...net,
    });
    const speed = ground.speedKmh;

    // absurd-jump guard → the point is not credible ground. Mark it, then start the window again
    // from here: a driver who genuinely was relocated must not stay "behind" his own position.
    if (th && this.classifier.isAbsurd(speed, distanceFromLast, dtS, th.accuracyDriftM)) {
      await this.prisma.position.update({ where: { id: p.id }, data: { motionState: 'UNKNOWN' } }).catch(() => undefined);
      track.window = [{ lat: p.lat, lng: p.lng, ts: p.ts, noiseM: noiseRadiusM }];
      track.last = { lat: p.lat, lng: p.lng, ts: p.ts, speedKmh: null };
      return alertsRaised;
    }

    // Two fixes and a span is all the rule needs; the window only keeps growing more confident
    // from here. The first minute of a day therefore judges on a small bubble, not on nothing.
    const res = ground.stationary ? this.classifier.confirmStationary(track.motion, speed) : this.classifier.classify(track.motion, speed);
    const state: MotionState = res.state;

    const workDate = workDateOf(new Date(p.ts));
    track.touchedDates.add(workDate);
    if (!p.buffered) track.lastRealtimeTs = Math.max(track.lastRealtimeTs ?? p.ts, p.ts);

    // --- geofence (computes insideZone for the stored row) ---
    let insideZone: boolean | null = null;
    if (ctx?.zoneFence && th) {
      const hit = this.geo.test(ctx.zoneFence, { lat: p.lat, lng: p.lng });
      insideZone = hit.inside;
      if (!hit.inside) {
        if (track.outsideSinceTs === null) track.outsideSinceTs = p.ts;
        const outsideS = (p.ts - track.outsideSinceTs) / 1000;
        if (outsideS >= th.geofenceGraceS && !track.exitRaised && this.dispatcher) {
          const r = await this.dispatcher.raise({
            type: 'GEOFENCE_EXIT' as AlertType,
            severity: SEVERITY.CRITICAL,
            employeeId,
            targetUserId: ctx.userId ?? undefined,
            zoneId: ctx.zoneId ?? undefined,
            meta: { lat: p.lat, lng: p.lng, distanceToCenterM: hit.distanceToCenterM, threshold: th.geofenceGraceS, outsideS: Math.round(outsideS) },
            replayed: p.buffered,
          });
          if (r && !r.suppressed) alertsRaised++;
          track.exitRaised = true;
        }
        track.geofenceState = 'OUT';
      } else {
        if (track.geofenceState === 'OUT' && this.dispatcher) {
          const r = await this.dispatcher.raise({
            type: 'GEOFENCE_ENTER' as AlertType,
            severity: SEVERITY.INFO,
            employeeId,
            targetUserId: ctx.userId ?? undefined,
            zoneId: ctx.zoneId ?? undefined,
            meta: { lat: p.lat, lng: p.lng, distanceToCenterM: hit.distanceToCenterM },
            replayed: p.buffered,
          });
          if (r && !r.suppressed) alertsRaised++;
        }
        track.outsideSinceTs = null;
        track.exitRaised = false;
        track.geofenceState = 'IN';
      }
    }

    // --- trips (open on confirmed travel, close on 10-min stop / day change) ---
    // `ground.moved` is required: a trip is a journey from somewhere to somewhere, and the first
    // fix of a track has no "from" yet — believing its speed alone invented trips for parked phones.
    const isTravel = (state === 'RIDING' || state === 'WALKING') && ground.moved;
    if (isTravel) {
      if (!track.openTrip || track.openTrip.workDate !== workDate) {
        if (track.openTrip) await this.finalizeTrip(employeeId, track.openTrip, track.last?.ts ?? p.ts);
        const trip = await this.prisma.trip.create({
          data: { employeeId, zoneId: ctx?.zoneId ?? null, startedAt: new Date(p.ts), state: 'OPEN', replayed: p.buffered },
          select: { id: true, startedAt: true },
        });
        track.openTrip = { id: trip.id, workDate, startedAt: p.ts, maxSpeed: null, lastMoveTs: p.ts, replayed: p.buffered };
      }
      if (track.openTrip) {
        if (speed !== null) track.openTrip.maxSpeed = track.openTrip.maxSpeed === null ? speed : Math.max(track.openTrip.maxSpeed, speed);
        track.openTrip.lastMoveTs = p.ts;
        if (p.buffered) track.openTrip.replayed = true;
      }
    }

    // --- stop events ---
    // Timed whether or not a trip is open: a driver parked at the yard all day never opens one, and
    // tying the timer to a trip meant his long stop could never be reported to anyone.
    if (res.changed && state === 'STOPPED' && !track.stopStart) {
      const kind = await this.stopKind(ctx, { lat: p.lat, lng: p.lng });
      const stop = await this.prisma.stopEvent.create({
        data: { employeeId, tripId: track.openTrip?.id ?? null, zoneId: ctx?.zoneId ?? null, lat: p.lat, lng: p.lng, startedAt: new Date(p.ts), kind },
        select: { id: true },
      });
      track.stopStart = { ts: p.ts, lat: p.lat, lng: p.lng, stopId: stop.id, alerted: false };
    } else if (state === 'STOPPED' && track.stopStart && this.dispatcher && th) {
      const durationS = (p.ts - track.stopStart.ts) / 1000;
      if (!track.stopStart.alerted && durationS > th.stopAlertMin * 60) {
        const r = await this.dispatcher.raise({
          type: 'STOP_EXCEEDED' as AlertType,
          severity: SEVERITY.CRITICAL,
          employeeId,
          targetUserId: ctx?.userId ?? undefined,
          zoneId: ctx?.zoneId ?? undefined,
          meta: { lat: p.lat, lng: p.lng, stopDurationS: Math.round(durationS), threshold: th.stopAlertMin },
          replayed: p.buffered,
        });
        if (r && !r.suppressed) alertsRaised++;
        track.stopStart.alerted = true;
        await this.prisma.stopEvent.update({ where: { id: track.stopStart.stopId }, data: { alerted: true } }).catch(() => undefined);
      }
    } else if (res.changed && state !== 'STOPPED' && track.stopStart) {
      const durationS = Math.round((p.ts - track.stopStart.ts) / 1000);
      await this.prisma.stopEvent.update({ where: { id: track.stopStart.stopId }, data: { endedAt: new Date(p.ts), durationS } }).catch(() => undefined);
      track.stopStart = null;
    }

    // --- route gaps (> gapMinMin minutes between consecutive tracking samples) ---
    if (track.openTrip && th && track.last && dtS !== null && dtS > th.gapMinMin * 60) {
      const list = (track.gapsByDate[workDate] ??= []);
      list.push({ from: new Date(track.last.ts).toISOString(), to: new Date(p.ts).toISOString(), gapS: Math.round(dtS) });
      if (this.dispatcher) {
        const r = await this.dispatcher.raise({
          type: 'ROUTE_GAP' as AlertType,
          severity: SEVERITY.WARNING,
          employeeId,
          targetUserId: ctx?.userId ?? undefined,
          zoneId: ctx?.zoneId ?? undefined,
          meta: { from: list[list.length - 1].from, to: list[list.length - 1].to, gapS: Math.round(dtS) },
          replayed: p.buffered,
        });
        if (r && !r.suppressed) alertsRaised++;
      }
    }

    // --- overspeed ---
    if (th && speed !== null) {
      if (speed > th.maxSpeedKmh) {
        if (!track.overRunActive) {
          track.overRunActive = true;
          track.overSinceTs = p.ts;
          track.overCriticalRaised = false;
        }
        track.speedOverStreak += 1;
        if (track.speedOverStreak >= th.speedSamples && this.dispatcher) {
          const durationS = track.overSinceTs ? Math.round((p.ts - track.overSinceTs) / 1000) : 0;
          const r = await this.dispatcher.raise({
            type: 'SPEEDING' as AlertType,
            severity: SEVERITY.WARNING,
            employeeId,
            targetUserId: ctx.userId ?? undefined,
            zoneId: ctx.zoneId ?? undefined,
            meta: { lat: p.lat, lng: p.lng, speedKmh: round(speed, 1), threshold: th.maxSpeedKmh, samples: track.speedOverStreak, durationS },
            replayed: p.buffered,
          });
          if (r && !r.suppressed) alertsRaised++;
          if (durationS >= th.speedingCriticalS && !track.overCriticalRaised) {
            const c = await this.dispatcher.raise({
              type: 'SPEEDING' as AlertType,
              severity: SEVERITY.CRITICAL,
              employeeId,
              targetUserId: ctx.userId ?? undefined,
              zoneId: ctx.zoneId ?? undefined,
              meta: { lat: p.lat, lng: p.lng, speedKmh: round(speed, 1), threshold: th.maxSpeedKmh, durationS },
              replayed: p.buffered,
              force: true,
            });
            if (c && !c.suppressed) alertsRaised++;
            track.overCriticalRaised = true;
          }
        }
      } else {
        track.speedOverStreak = 0;
        track.overRunActive = false;
        track.overSinceTs = null;
        track.overCriticalRaised = false;
      }
    }

    // --- harsh braking / acceleration ---
    if (th && track.last && track.last.speedKmh !== null && speed !== null && dtS !== null && dtS > 0 && dtS <= 30) {
      const accel = this.geo.accelerationMs2(track.last.speedKmh, speed, dtS);
      const h = this.classifier.harsh(accel, th.harshBrakingMs2, th.harshAccelMs2);
      if (h && this.dispatcher) {
        const r = await this.dispatcher.raise({
          type: h.type as AlertType,
          severity: h.severity,
          employeeId,
          targetUserId: ctx?.userId ?? undefined,
          zoneId: ctx?.zoneId ?? undefined,
          meta: { lat: p.lat, lng: p.lng, accelMs2: round(accel ?? 0, 2), speedKmh: round(speed, 1), prevSpeedKmh: round(track.last.speedKmh, 1), dtS: round(dtS, 1) },
          replayed: p.buffered,
        });
        if (r && !r.suppressed) alertsRaised++;
      }
    }

    // --- persist derived fields + trip link + update live cache + realtime broadcast ---
    await this.prisma.position
      .update({
        where: { id: p.id },
        data: { motionState: state, insideZone, tripId: track.openTrip?.id ?? null },
      })
      .catch(() => undefined);

    if (ctx) {
      // cache stays lean (base only); enrichment (device health + geo meta) is applied
      // at the broadcast/read boundary so the ingest semantics stay untouched.
      const base: LivePositionBase = {
        employeeId,
        name: ctx.employeeName,
        lat: p.lat,
        lng: p.lng,
        speedKmh: round(speed, 1),
        motionState: state,
        insideZone,
        ts: new Date(p.ts).toISOString(),
        replayed: p.buffered || p.stale,
        accuracy: p.accuracyM,
      };
      this.live.set(employeeId, base);
      try {
        this.publisher?.position(await this.enrichOne(base));
      } catch (e) {
        this.logger.warn(`position broadcast failed: ${(e as Error)?.message}`);
      }
    }

    track.last = { lat: p.lat, lng: p.lng, ts: p.ts, speedKmh: speed };
    return alertsRaised;
  }

  /** Stop kind = PLANNED when inside one of the employee's site fences. */
  private async stopKind(ctx: EmployeeContext | null, p: { lat: number; lng: number }): Promise<string> {
    if (!ctx) return 'UNPLANNED';
    for (const site of ctx.siteFences) {
      const hit = this.geo.test(site, p);
      if (hit.inside) return 'PLANNED';
    }
    return 'UNPLANNED';
  }

  /**
   * Close a journey from what its positions actually say, not from a counter a process was
   * holding: the jump-free trace of its window gives the length, the top speed and the line. A trip
   * can be closed long after the process that opened it died (a deploy, a check-out, a kill), and
   * it must still be able to tell the truth about the ground it covered.
   */
  private async finalizeTrip(employeeId: string, open: NonNullable<Track['openTrip']>, endedAt: number): Promise<void> {
    const rows = await this.prisma.position.findMany({
      where: { employeeId, clientTs: { gte: new Date(open.startedAt), lte: new Date(endedAt) } },
      orderBy: { clientTs: 'asc' },
      select: { lat: true, lng: true, clientTs: true, speedKmh: true, accuracyM: true, bearing: true, buffered: true, stale: true },
    });
    const trace = this.trace.groundTrace(rows);
    let distanceM = 0;
    let maxStepKmh = 0;
    for (let i = 1; i < trace.length; i++) {
      const a = trace[i - 1];
      const b = trace[i];
      distanceM += this.trace.stepMetres(a, b);
      const dtS = (b.clientTs.getTime() - a.clientTs.getTime()) / 1000;
      if (dtS > 0) maxStepKmh = Math.max(maxStepKmh, (this.geo.distanceM(a, b) / dtS) * 3.6);
    }
    const distanceKm = distanceM / 1000;
    const hours = Math.max(1 / 3600, (endedAt - open.startedAt) / 3600_000);
    const avgSpeed = distanceKm / hours;
    const simplified = this.geo.simplify(trace.map((pt) => ({ lat: pt.lat, lng: pt.lng })), 25);
    const lastPt = trace[trace.length - 1];
    await this.prisma.trip
      .update({
        where: { id: open.id },
        data: {
          endedAt: new Date(Math.max(endedAt, open.startedAt)),
          distanceKm: round(distanceKm, 3) ?? 0,
          maxSpeedKmh: round(Math.max(maxStepKmh, open.maxSpeed ?? 0), 1) ?? null,
          avgSpeedKmh: round(avgSpeed, 1) ?? null,
          startPoint: trace[0] ? `${trace[0].lat},${trace[0].lng}` : '',
          endPoint: lastPt ? `${lastPt.lat},${lastPt.lng}` : null,
          polyline: this.geo.geoJsonLine(simplified),
          state: 'CLOSED',
          replayed: Boolean(open.replayed),
        },
      })
      .catch(() => undefined);
    // close any dangling stop on this trip
    await this.prisma.stopEvent
      .updateMany({ where: { tripId: open.id, endedAt: null }, data: { endedAt: new Date(endedAt), durationS: Math.max(0, Math.round((endedAt - open.startedAt) / 1000)) } })
      .catch(() => undefined);
  }

  /**
   * Ends the journey a driver is on right now. Check-out (through the device reporting tracking
   * stopped) lands here: a trip left OPEN is a vehicle the dashboard still shows on the road.
   */
  async closeOpenTrips(employeeId: string, at: number = Date.now()): Promise<number> {
    let closed = 0;
    const track = this.tracks.get(employeeId);
    const open = track?.openTrip;
    if (open) {
      await this.finalizeTrip(employeeId, open, Math.max(at, open.startedAt));
      track.openTrip = null;
      track.stopStart = null;
      closed++;
    }
    // A stop taken with no trip open (a driver parked at the yard all day) has no trip to close it,
    // so the end of the run is what ends it.
    const dangling = await this.prisma.stopEvent.findMany({ where: { employeeId, endedAt: null }, select: { id: true, startedAt: true } });
    for (const s of dangling) {
      await this.prisma.stopEvent
        .update({ where: { id: s.id }, data: { endedAt: new Date(at), durationS: Math.max(0, Math.round((at - s.startedAt.getTime()) / 1000)) } })
        .catch(() => undefined);
    }
    const orphans = await this.prisma.trip.findMany({ where: { employeeId, state: 'OPEN' }, orderBy: { startedAt: 'asc' } });
    for (const t of orphans) {
      await this.closeOrphanTrip(t.employeeId, t);
      closed++;
    }
    return closed;
  }

  /**
   * Scheduled every 60s — a run whose driver stopped reporting is over. Standing still is not
   * silence: a driver waiting 40 minutes at a customer is still on his journey (and STOP_EXCEEDED
   * is there to say so), so only a device that went quiet ends the trip here.
   */
  @Interval(60_000)
  async scheduledTripSweep(): Promise<void> {
    try {
      await this.closeStaleTrips();
    } catch (err) {
      this.logger.warn(`trip sweep failed: ${(err as Error)?.message}`);
    }
  }

  async closeStaleTrips(now: number = Date.now()): Promise<number> {
    let closed = 0;
    const owned = new Set<string>();
    for (const [employeeId, track] of this.tracks) {
      const open = track.openTrip;
      if (!open) continue;
      owned.add(open.id);
      if (track.seenAt > 0 && now - track.seenAt > TRIP_IDLE_MS) {
        await this.finalizeTrip(employeeId, open, open.lastMoveTs);
        track.openTrip = null;
        closed++;
      }
    }
    const orphans = await this.prisma.trip.findMany({
      where: { state: 'OPEN', startedAt: { lt: new Date(now - TRIP_IDLE_MS) } },
      orderBy: { startedAt: 'asc' },
      take: 200,
    });
    for (const t of orphans) {
      if (owned.has(t.id)) continue;
      await this.closeOrphanTrip(t.employeeId, t);
      closed++;
    }
    return closed;
  }

  /**
   * An OPEN row no process holds any more (a deploy wiped the in-memory tracks, the app died
   * mid-shift): its own positions are the only witness, so it closes at its last fix with the
   * length and the line re-read from the ground. For a driver who never left the yard that is zero,
   * which is the truth the trip table had been missing.
   */
  private async closeOrphanTrip(employeeId: string, t: { id: string; startedAt: Date; replayed: boolean; maxSpeedKmh: number | null }): Promise<void> {
    const last = await this.prisma.position.findFirst({
      where: { employeeId, clientTs: { gte: t.startedAt } },
      orderBy: { clientTs: 'desc' },
      select: { clientTs: true },
    });
    const startedAt = t.startedAt.getTime();
    const endedAt = Math.max(startedAt, last?.clientTs.getTime() ?? startedAt);
    await this.finalizeTrip(
      employeeId,
      { id: t.id, workDate: workDateOf(t.startedAt), startedAt, maxSpeed: t.maxSpeedKmh, lastMoveTs: endedAt, replayed: t.replayed },
      endedAt,
    );
  }

  /**
   * Re-derives a whole day from the raw coordinates with the current ground rule (the same
   * classifier the live pipeline runs). The phone's speed field never decides anything here, so a
   * day recorded by an older build — a parked phone re-publishing its cached position at 150 km/h —
   * reads as what actually happened: he never moved. Points the rule rejects stay in the list,
   * flagged `credible: false`, and out of the line, the stops and the mileage.
   */
  private replayDay(rows: ReplayRow[]): ReplayPoint[] {
    const motion = this.classifier.newTrack();
    const drift = RULE_DEFAULTS.accuracyDriftM;
    const out: ReplayPoint[] = [];
    let last: { lat: number; lng: number; ts: number } | null = null;
    const window: NetFix[] = [];
    const day = this.trace.dropSpikes(rows);
    this.trace.dropOutAndBack(day);
    day.forEach(({ row: r, credible }, i) => {
      const ts = r.clientTs.getTime();
      if (!credible) {
        out.push({ ...r, motionState: 'UNKNOWN' as MotionState, speedKmh: round(r.speedKmh, 1), credible: false });
        return;
      }
      const dtS = last ? (ts - last.ts) / 1000 : null;
      const stepM = last ? this.geo.distanceM(last, r) : 0;
      const noiseRadiusM = Math.min(Math.max(r.accuracyM ?? 0, NOISE_FLOOR_M), drift);
      if (this.classifier.isDroppable({ accuracyM: r.accuracyM, dtS, speedKmh: r.speedKmh }).dropped) {
        out.push({ ...r, motionState: 'UNKNOWN' as MotionState, speedKmh: round(r.speedKmh, 1), credible: false });
        return;
      }
      // The day's first fix has no "where from" behind it, so it is read against the window ahead —
      // the evidence the live pipeline gets one sample later. A phone parked since check-in stops
      // showing a journey that started before it had anywhere to have come from.
      const deviceKmh = window.length ? r.speedKmh : (this.forwardSpeedKmh(day, i, noiseRadiusM) ?? r.speedKmh);
      this.pushWindow(window, { lat: r.lat, lng: r.lng, ts, noiseM: noiseRadiusM });
      const net = this.netEvidence(window);
      const ground = this.classifier.groundSpeed({
        deviceKmh,
        stepM,
        stepDtS: dtS,
        ...net,
      });
      const speed = ground.speedKmh;
      if (this.classifier.isAbsurd(speed, stepM, dtS, drift)) {
        window.length = 0;
        this.pushWindow(window, { lat: r.lat, lng: r.lng, ts, noiseM: noiseRadiusM });
        last = { lat: r.lat, lng: r.lng, ts };
        out.push({ ...r, motionState: 'UNKNOWN' as MotionState, speedKmh: round(speed, 1), credible: false });
        return;
      }
      const res = ground.stationary
        ? this.classifier.confirmStationary(motion, speed)
        : this.classifier.classify(motion, speed);
      last = { lat: r.lat, lng: r.lng, ts };
      out.push({ ...r, motionState: res.state, speedKmh: round(speed, 1), credible: true });
    });
    return out;
  }

  /** Speed from the window *ahead* of a sample — available only where the day is replayed whole. */
  private forwardSpeedKmh(windowed: { row: ReplayRow }[], i: number, noiseRadiusM: number): number | null {
    const r = windowed[i]?.row;
    const n = windowed[i + 1]?.row;
    if (!r || !n) return null;
    const dtS = (n.clientTs.getTime() - r.clientTs.getTime()) / 1000;
    if (!(dtS > 0)) return null;
    const d = this.geo.distanceM(r, n);
    const kmh = (d / dtS) * 3.6;
    if (kmh > MOTION.MAX_CREDIBLE_SPEED_KMH) return null;
    return d <= noiseRadiusM ? 0 : kmh;
  }

  private async rebuildRouteLine(employeeId: string, workDate: string, track: Track): Promise<void> {
    const dayStart = new Date(`${workDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${workDate}T23:59:59.999Z`);
    const positions = await this.prisma.position.findMany({
      where: { employeeId, clientTs: { gte: dayStart, lte: dayEnd } },
      orderBy: { clientTs: 'asc' },
      select: { lat: true, lng: true, clientTs: true, accuracyM: true },
    });
    if (!positions.length) return;
    // The same trace GET /positions/route draws, so the stored line can never disagree with it.
    const simplified = this.geo.simplify(this.trace.groundTrace(positions).map((p) => ({ lat: p.lat, lng: p.lng })), 25);
    await this.prisma.routeLine
      .upsert({
        where: { employeeId_workDate: { employeeId, workDate } },
        create: { employeeId, workDate, geojson: this.geo.geoJsonLine(simplified), gaps: json(track.gapsByDate[workDate] ?? []) },
        update: { geojson: this.geo.geoJsonLine(simplified), gaps: json(track.gapsByDate[workDate] ?? []) },
      })
      .catch(() => undefined);
  }

  // ---------- read endpoints ----------

  private async employeeIdForUserId(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } });
    if (user?.employeeId) return user.employeeId;
    const emp = await this.prisma.employee.findUnique({ where: { id: userId }, select: { id: true } });
    return emp?.id ?? null;
  }

  // ---------- live enrichment helpers ----------

  /** Employee identity/geo metadata (cached TTL; ingest never mutates these often). */
  private async metaFor(employeeId: string): Promise<EmployeeMeta> {
    const hit = this.metaCache.get(employeeId);
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit.value;
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        name: true,
        externalId: true,
        kind: true,
        zoneId: true,
        siteId: true,
        zone: { select: { name: true } },
        site: { select: { name: true } },
        user: { select: { id: true } },
      },
    });
    const value: EmployeeMeta = {
      name: emp?.name ?? '',
      externalId: emp?.externalId ?? null,
      kind: emp?.kind ?? null,
      driver: emp?.kind === 'DRIVER',
      userId: emp?.user?.id ?? null,
      zoneId: emp?.zoneId ?? null,
      zoneName: emp?.zone?.name ?? null,
      siteId: emp?.siteId ?? null,
      siteName: emp?.site?.name ?? null,
    };
    this.metaCache.set(employeeId, { at: Date.now(), value });
    return value;
  }

  /** offline window = 3 × heartbeat interval, in seconds. */
  private async offlineWindowS(): Promise<number> {
    let hb = 300;
    try {
      hb = (await this.rules.globalOverrides()).heartbeatIntervalS ?? 300;
    } catch {
      /* defaults */
    }
    return hb * 3;
  }

  /** Compose base live + employee meta + device health into the enriched LivePosition. */
  private compose(base: LivePositionBase, meta: EmployeeMeta | undefined, dev: DeviceHealthRow | undefined, offlineAfterS: number): LivePosition {
    const ageS = dev?.lastSeenAt ? (Date.now() - dev.lastSeenAt.getTime()) / 1000 : null;
    const online = !!dev?.online && (ageS === null || ageS <= offlineAfterS);
    const name = meta?.name || base.name;
    return {
      // dashboard keys its live store / map by the EMPLOYEE id → id === userId === employeeId.
      id: base.employeeId,
      userId: base.employeeId,
      employeeId: base.employeeId,
      name,
      userName: name,
      externalId: meta?.externalId ?? null,
      kind: meta?.kind ?? null,
      driver: meta?.driver ?? false,
      lat: base.lat,
      lng: base.lng,
      speedKmh: base.speedKmh,
      motionState: base.motionState,
      insideZone: base.insideZone,
      ts: base.ts,
      replayed: base.replayed,
      accuracy: base.accuracy,
      battery: dev?.batteryPct ?? null,
      zoneId: meta?.zoneId ?? null,
      zoneName: meta?.zoneName ?? null,
      siteId: meta?.siteId ?? null,
      siteName: meta?.siteName ?? null,
      authUserId: meta?.userId ?? null,
      online,
      tracking: dev?.tracking ?? false,
      gpsEnabled: dev?.gpsEnabled ?? false,
      dataEnabled: !!dev?.online, // no separate data column → DATA state is `online`
      lastSeen: dev?.lastSeenAt?.toISOString() ?? null,
    };
  }

  /** Enrich ONE base row (single device read + cached meta) — used for the socket broadcast. */
  private async enrichOne(base: LivePositionBase): Promise<LivePosition> {
    const offlineAfterS = await this.offlineWindowS();
    const [meta, dev] = await Promise.all([
      this.metaFor(base.employeeId),
      this.prisma.device.findFirst({
        where: { employeeId: base.employeeId },
        orderBy: { lastSeenAt: 'desc' },
        select: { employeeId: true, online: true, tracking: true, gpsEnabled: true, batteryPct: true, lastSeenAt: true },
      }),
    ]);
    return this.compose(base, meta, (dev as DeviceHealthRow | null) ?? undefined, offlineAfterS);
  }

  /** Batch-enrich base rows (one device query + cached metas) — used for the HTTP snapshot. */
  private async enrichMany(bases: LivePositionBase[]): Promise<LivePosition[]> {
    if (!bases.length) return [];
    const offlineAfterS = await this.offlineWindowS();
    const ids = [...new Set(bases.map((b) => b.employeeId))];
    const [devs, metas] = await Promise.all([
      this.prisma.device.findMany({
        where: { employeeId: { in: ids } },
        orderBy: { lastSeenAt: 'desc' },
        select: { employeeId: true, online: true, tracking: true, gpsEnabled: true, batteryPct: true, lastSeenAt: true },
      }),
      Promise.all(ids.map((id) => this.metaFor(id))),
    ]);
    const devByEmp = new Map<string, DeviceHealthRow>();
    for (const d of devs) if (d.employeeId && !devByEmp.has(d.employeeId)) devByEmp.set(d.employeeId, d as DeviceHealthRow);
    const metaByEmp = new Map<string, EmployeeMeta>(ids.map((id, i) => [id, metas[i]]));
    return bases.map((b) => this.compose(b, metaByEmp.get(b.employeeId), devByEmp.get(b.employeeId), offlineAfterS));
  }

  /** GET /positions/live → { positions, serverTs } — enriched per employee. */
  async liveSnapshot(since?: string): Promise<{ positions: LivePosition[]; serverTs: string }> {
    let bases = [...this.live.values()];
    if (!bases.length) bases = await this.liveFromDb();
    const sinceMs = since ? new Date(since).getTime() : null;
    if (sinceMs) bases = bases.filter((d) => new Date(d.ts).getTime() > sinceMs);
    const positions = await this.enrichMany(bases);
    return { positions, serverTs: new Date().toISOString() };
  }

  private async liveFromDb(): Promise<LivePositionBase[]> {
    const recent = await this.prisma.position.findMany({ orderBy: { clientTs: 'desc' }, take: 2000, include: { employee: { select: { id: true, name: true } } } });
    const seen = new Map<string, LivePositionBase>();
    for (const p of recent) {
      if (seen.has(p.employeeId)) continue;
      seen.set(p.employeeId, {
        employeeId: p.employeeId,
        name: p.employee?.name ?? '',
        lat: p.lat,
        lng: p.lng,
        speedKmh: round(p.speedKmh, 1),
        motionState: (p.motionState as MotionState) ?? 'UNKNOWN',
        insideZone: p.insideZone,
        ts: p.clientTs.toISOString(),
        replayed: p.buffered || p.stale,
        accuracy: p.accuracyM,
      });
    }
    return [...seen.values()];
  }

  /**
   * GET /positions/route?userId&date → { userName, distanceKm, points, replayedPoints, stops, gaps }.
   * `userId` historically accepted a login user id; the dashboard passes the EMPLOYEE id —
   * both are resolved (user id first, else employee id) via employeeIdForUserId().
   * The day is re-derived from the coordinates (replayDay), so the states, the speeds, the line and
   * the mileage all say what the ground shows rather than what an old phone build reported.
   * Legacy `positions` / `pointCount` keys are kept as aliases (existing spec + consumers depend on them).
   */
  async route(userId: string, date: string): Promise<unknown> {
    const employeeId = await this.employeeIdForUserId(userId);
    if (!employeeId) throw new BadRequestException('EMPLOYEE_NOT_FOUND');
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const rows = await this.prisma.position.findMany({
      where: { employeeId, clientTs: { gte: dayStart, lte: dayEnd } },
      orderBy: { clientTs: 'asc' },
      select: { lat: true, lng: true, clientTs: true, speedKmh: true, accuracyM: true, bearing: true, buffered: true, stale: true },
    });
    const replayed = this.replayDay(rows);
    const fixes = replayed.filter((p) => p.credible);
    // What the day looks like on the ground: every stand-by reduced to the one place it was.
    const trace = this.trace.collapseStays(fixes);
    const line = this.geo.simplify(trace.map((p) => ({ lat: p.lat, lng: p.lng })), 25);
    const routeLine = await this.prisma.routeLine.findUnique({ where: { employeeId_workDate: { employeeId, workDate: date } } });
    const stopRows = await this.prisma.stopEvent.findMany({
      where: { employeeId, startedAt: { gte: dayStart, lte: dayEnd } },
      orderBy: { startedAt: 'asc' },
    });

    // distance (km): the ground under the credible trace — a step inside the noise circle counts zero.
    let distanceM = 0;
    for (let i = 1; i < trace.length; i++) distanceM += this.trace.stepMetres(trace[i - 1], trace[i]);

    const points = replayed.map((p) => ({
      clientTs: p.clientTs.toISOString(),
      lat: p.lat,
      lng: p.lng,
      speedKmh: p.speedKmh,
      bearing: p.bearing,
      accuracy: p.accuracyM,
      motionState: p.motionState,
      buffered: p.buffered,
      stale: p.stale,
      credible: p.credible,
    }));

    const rawGaps = parseJson<RouteGapRaw[]>(routeLine?.gaps ?? '[]', []);
    const gaps = rawGaps.map((g) => ({ fromTs: g.from, toTs: g.to, minutes: Math.round((g.gapS ?? 0) / 60) }));

    return {
      userId,
      employeeId,
      date,
      userName: (await this.metaFor(employeeId)).name,
      distanceKm: round(distanceM / 1000, 2) ?? 0,
      replayed: rows.some((p) => p.buffered || p.stale),
      replayedPoints: rows.filter((p) => p.buffered || p.stale).length,
      /** fixes the trace refused: too far apart to be ground, or rejected at ingest. */
      rejectedPoints: Math.max(0, rows.length - fixes.length),
      geojson: { type: 'LineString', coordinates: line.map((p) => [p.lng, p.lat]) },
      /**
       * The day's ground: one point per place he stood at, in the order he reached them. A stand-by
       * is a single point here, not the star of drift jitter its fixes describe.
       */
      trace: trace.map((p) => ({
        clientTs: p.clientTs.toISOString(),
        lat: p.lat,
        lng: p.lng,
        speedKmh: p.speedKmh,
        motionState: p.motionState,
      })),
      points,
      stops: this.trace.groundedStops(trace, stopRows).map((s) => ({
        id: s.id,
        kind: s.kind,
        lat: s.lat,
        lng: s.lng,
        startTs: s.startedAt.toISOString(),
        endTs: s.endedAt?.toISOString() ?? null,
        durationMin: Math.round((s.durationS ?? 0) / 60),
      })),
      gaps,
      // ---- backward-compat aliases (existing tracking spec + external consumers read these) ----
      positions: points.filter((p) => p.credible).map((p) => ({ ts: p.clientTs, lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, motionState: p.motionState, buffered: p.buffered, stale: p.stale })),
      pointCount: rows.length,
    };
  }

  /**
   * GET /positions/trails?minutes — the recent line of every driver the board shows present, in one
   * read. Each trail is replayed from its own coordinates exactly like a day's route, so the line is
   * ground he covered: no cached-fix teleport, no segment across the city, and his stops marked.
   * The board draws one coloured line per driver and grows it from the live socket between reads.
   */
  async trails(minutes = 90): Promise<unknown> {
    const windowMin = Math.min(720, Math.max(5, Math.round(minutes) || 90));
    const now = Date.now();
    if (this.trailsCache && this.trailsCache.windowMin === windowMin && now - this.trailsCache.at < TRAILS_TTL_MS) {
      return this.trailsCache.payload;
    }
    const bases = [...this.live.values()];
    const enriched = await this.enrichMany(bases.length ? bases : await this.liveFromDb());
    const drivers = enriched.filter((p) => p.driver && p.online);
    const ids = drivers.map((d) => d.employeeId);
    const from = new Date(now - windowMin * 60_000);
    const trails: unknown[] = [];
    if (ids.length) {
      const [rows, stopRows] = await Promise.all([
        this.prisma.position.findMany({
          where: { employeeId: { in: ids }, clientTs: { gte: from } },
          orderBy: { clientTs: 'asc' },
          select: { employeeId: true, lat: true, lng: true, clientTs: true, speedKmh: true, accuracyM: true, bearing: true, buffered: true, stale: true },
        }),
        this.prisma.stopEvent.findMany({
          where: { employeeId: { in: ids }, startedAt: { gte: from } },
          orderBy: { startedAt: 'asc' },
        }),
      ]);
      const byEmp = new Map<string, ReplayRow[]>();
      for (const r of rows) {
        const list = byEmp.get(r.employeeId) ?? [];
        list.push({ lat: r.lat, lng: r.lng, clientTs: r.clientTs, speedKmh: r.speedKmh, accuracyM: r.accuracyM, bearing: r.bearing, buffered: r.buffered, stale: r.stale });
        byEmp.set(r.employeeId, list);
      }
      for (const d of drivers) {
        const replayed = this.replayDay(byEmp.get(d.employeeId) ?? []);
        const fixes = replayed.filter((p) => p.credible);
        const trace = this.trace.collapseStays(fixes);
        let distanceM = 0;
        const gaps: { from: [number, number]; to: [number, number]; minutes: number }[] = [];
        for (let i = 1; i < trace.length; i++) {
          const a = { lat: trace[i - 1].lat, lng: trace[i - 1].lng, at: trace[i - 1].clientTs.getTime() };
          const b = { lat: trace[i].lat, lng: trace[i].lng, at: trace[i].clientTs.getTime() };
          distanceM += this.trace.stepMetres(trace[i - 1], trace[i]);
          const dtMin = (b.at - a.at) / 60_000;
          // Silence only if the device really went quiet: a collapsed stand-by spans minutes of fixes.
          const silent = fixes.every((f, k) => k === 0 || f.clientTs.getTime() <= a.at || f.clientTs.getTime() >= b.at);
          if (dtMin > RULE_DEFAULTS.gapMinMin && silent) {
            gaps.push({ from: [a.lat, a.lng], to: [b.lat, b.lng], minutes: Math.round(dtMin) });
          }
        }
        trails.push({
          userId: d.userId,
          employeeId: d.employeeId,
          name: d.name,
          motionState: d.motionState,
          lastTs: d.ts,
          distanceKm: round(distanceM / 1000, 2) ?? 0,
          /** the drawn line: the credible trace thinned to 8 m, so detail survives and jitter doesn't */
          line: this.geo.simplify(trace.map((p) => ({ lat: p.lat, lng: p.lng })), 8).map((p) => [p.lat, p.lng]),
          pointCount: trace.length,
          stops: this.trace.groundedStops(trace, stopRows.filter((s) => s.employeeId === d.employeeId)).map((s) => ({
              id: s.id,
              kind: s.kind,
              lat: s.lat,
              lng: s.lng,
              startTs: s.startedAt.toISOString(),
              endTs: s.endedAt?.toISOString() ?? null,
              durationMin: Math.round((s.durationS ?? 0) / 60),
            })),
          gaps,
        });
      }
    }
    const payload = { windowMin, serverTs: new Date(now).toISOString(), trails };
    this.trailsCache = { at: now, windowMin, payload };
    return payload;
  }

  /** GET /trips?userId&from&to */
  async trips(userId: string, from?: string, to?: string): Promise<unknown[]> {
    const employeeId = await this.employeeIdForUserId(userId ?? '');
    if (!employeeId) return [];
    const where: Record<string, unknown> = { employeeId };
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.gte = new Date(from);
      if (to) range.lte = new Date(to);
      where.startedAt = range;
    }
    const rows = await this.prisma.trip.findMany({ where, orderBy: { startedAt: 'desc' }, take: 500 });
    return rows.map((t) => ({
      id: t.id,
      employeeId: t.employeeId,
      zoneId: t.zoneId,
      startedAt: t.startedAt.toISOString(),
      endedAt: t.endedAt?.toISOString() ?? null,
      distanceKm: t.distanceKm,
      maxSpeedKmh: t.maxSpeedKmh,
      avgSpeedKmh: t.avgSpeedKmh,
      state: t.state,
      replayed: t.replayed,
      geojson: t.polyline ? JSON.parse(t.polyline) : null,
    }));
  }

  /**
   * GET /drivers/presence — derived from Device + latest Position.
   * Item keys match the enriched live snapshot exactly (so the dashboard's two sources agree).
   */
  async presence(): Promise<unknown[]> {
    const devices = await this.prisma.device.findMany({
      where: { employee: { isNot: null } },
      select: { employeeId: true, online: true, tracking: true, gpsEnabled: true, batteryPct: true, lastSeenAt: true },
    });
    const offlineAfterS = await this.offlineWindowS();
    const out: unknown[] = [];
    for (const dev of devices) {
      const employeeId = dev.employeeId;
      if (!employeeId) continue;
      const meta = await this.metaFor(employeeId);
      const base = this.live.get(employeeId);
      if (base) {
        out.push(this.compose(base, meta, dev as DeviceHealthRow, offlineAfterS));
        continue;
      }
      // device with no position yet → same keys, no coordinates.
      const ageS = dev.lastSeenAt ? (Date.now() - dev.lastSeenAt.getTime()) / 1000 : null;
      out.push({
        id: employeeId,
        userId: employeeId,
        employeeId,
        name: meta.name,
        userName: meta.name,
        externalId: meta.externalId,
        kind: meta.kind,
        driver: meta.driver,
        lat: null,
        lng: null,
        speedKmh: null,
        motionState: 'UNKNOWN',
        insideZone: null,
        ts: null,
        replayed: false,
        accuracy: null,
        battery: dev.batteryPct,
        zoneId: meta.zoneId,
        zoneName: meta.zoneName,
        siteId: meta.siteId,
        siteName: meta.siteName,
        online: !!dev.online && (ageS === null || ageS <= offlineAfterS),
        tracking: dev.tracking,
        gpsEnabled: dev.gpsEnabled,
        dataEnabled: !!dev.online,
        lastSeen: dev.lastSeenAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  /** Scheduled every 60s — never let a sweep crash the app. */
  @Interval(60_000)
  async scheduledHeartbeatSweep(): Promise<void> {
    try {
      await this.heartbeatSweep();
    } catch (err) {
      this.logger.warn(`heartbeat sweep failed: ${(err as Error)?.message}`);
    }
  }

  /**
   * @Interval heartbeat sweep: drivers whose day is open but whose device heartbeat is stale
   * → APP_OFFLINE / HEARTBEAT_MISSING (CRITICAL, cooldown-managed), GPS_OFF when disabled.
   */
  async heartbeatSweep(): Promise<void> {
    if (!this.dispatcher) return;
    let hb = 300;
    const missed = 3;
    try {
      const g = await this.rules.globalOverrides();
      hb = g.heartbeatIntervalS ?? 300;
    } catch {
      /* defaults */
    }
    const thresholdMs = hb * missed * 1000;
    const cutoff = new Date(Date.now() - thresholdMs);
    // "Offline" only means something while the day is open. A registered device that never started a
    // shift today would otherwise raise APP_OFFLINE/HEARTBEAT_MISSING forever on every sweep.
    const openToday = await this.prisma.attendanceRecord.findMany({
      where: { workDate: workDateOf(new Date()), checkOutAt: null },
      select: { employeeId: true },
    });
    const onShift = new Set(openToday.map((r) => r.employeeId));
    const devices = await this.prisma.device.findMany({
      where: { tracking: true, online: true, lastSeenAt: { lt: cutoff }, employee: { isNot: null } },
      include: { employee: { select: { id: true, user: { select: { id: true } } } } },
    });
    for (const d of devices) {
      if (!d.employee || !onShift.has(d.employee.id)) continue;
      const ctx = await this.rules.context(d.employee.id);
      const base: RaiseAlertInput = {
        type: 'HEARTBEAT_MISSING' as AlertType,
        severity: SEVERITY.CRITICAL,
        employeeId: d.employee.id,
        targetUserId: d.employee.user?.id ?? undefined,
        zoneId: ctx?.zoneId ?? undefined,
        meta: { offlineSince: d.lastSeenAt?.toISOString() ?? null, lastBatchSeq: d.lastBatchSeq, heartbeatIntervalS: hb },
      };
      await this.dispatcher.raise(base).catch(() => undefined);
      await this.dispatcher
        .raise({ ...base, type: 'APP_OFFLINE' as AlertType, meta: { ...base.meta } })
        .catch(() => undefined);
      await this.prisma.geoEvent
        .create({ data: { deviceId: d.id, employeeId: d.employee.id, kind: 'HEARTBEAT_MISSING', at: new Date(), meta: json(base.meta) } })
        .catch(() => undefined);
      if (!d.gpsEnabled) {
        await this.dispatcher
          .raise({ type: 'GPS_OFF' as AlertType, severity: SEVERITY.CRITICAL, employeeId: d.employee.id, targetUserId: d.employee.user?.id ?? undefined, zoneId: ctx?.zoneId ?? undefined, meta: { at: new Date().toISOString() } })
          .catch(() => undefined);
      }
    }
  }

  // test helper / housekeeping
  clearTrack(employeeId: string): void {
    this.tracks.delete(employeeId);
    this.live.delete(employeeId);
    this.metaCache.delete(employeeId);
  }
}
