import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import type { MotionState } from '../../shared/constants';
import { SEVERITY, type AlertType } from '../../shared/constants';
import { PrismaService } from '../../common/prisma.service';
import { GeoService } from '../../common/geo/geo.service';
import { json, round, workDateOf, isValidLat, isValidLng } from '../../common/utils';
import {
  ALERT_DISPATCHER,
  REALTIME_PUBLISHER,
  type AlertDispatcher,
  type LivePosition,
  type RaiseAlertInput,
  type RealtimePublisher,
} from '../../common/contracts';
import { RulesService, type EmployeeContext } from '../rules/rules.service';
import { MotionClassifierService, type MotionTrack } from './motion-classifier.service';
import type { BatchResult, BatchRejectedItem, PositionBatchDto, PositionItemDto } from './dto';

interface Track {
  motion: MotionTrack;
  last: { lat: number; lng: number; ts: number; speedKmh: number | null } | null;
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
        distanceM: number;
        maxSpeed: number | null;
        lastMoveTs: number;
        replayed: boolean;
      }
    | null;
  lastRealtimeTs: number | null;
  gapsByDate: Record<string, { from: string; to: string; gapS: number }[]>;
  touchedDates: Set<string>;
}

const MAX_BATCH = 500;

@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);
  private tracks = new Map<string, Track>();
  private live = new Map<string, LivePosition>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly rules: RulesService,
    private readonly classifier: MotionClassifierService,
    @Optional() @Inject(ALERT_DISPATCHER) private readonly dispatcher?: AlertDispatcher,
    @Optional() @Inject(REALTIME_PUBLISHER) private readonly publisher?: RealtimePublisher,
  ) {}

  private hashOf(employeeId: string, clientTs: Date, lat: number, lng: number): string {
    const canonical = `${employeeId}|${clientTs.toISOString()}|${lat.toFixed(6)}|${lng.toFixed(6)}`;
    return createHash('sha1').update(canonical).digest('hex');
  }

  private newTrack(): Track {
    return {
      motion: this.classifier.newTrack(),
      last: null,
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
    if (!this.dispatcher) {
      // no dispatcher wired → still keep live cache & motion state, but skip rules
    }
    const th = ctx?.thresholds;
    const gate = this.classifier.isDroppable({ accuracyM: p.accuracyM, dtS: track.last ? (p.ts - track.last.ts) / 1000 : null, speedKmh: p.speedKmh });
    if (gate.dropped) return alertsRaised;

    const dtS = track.last ? (p.ts - track.last.ts) / 1000 : null;
    const distanceFromLast = track.last ? this.geo.distanceM(track.last, { lat: p.lat, lng: p.lng }) : 0;

    // speed: device-provided, else derived from GPS between consecutive points.
    let speed = p.speedKmh;
    if (speed === null && track.last) {
      speed = this.geo.speedKmhBetween({ lat: track.last.lat, lng: track.last.lng, at: track.last.ts }, { lat: p.lat, lng: p.lng, at: p.ts });
    }

    // absurd-jump guard → UNKNOWN, don't advance state/last
    if (th && this.classifier.isAbsurd(speed, distanceFromLast, dtS, th.accuracyDriftM)) {
      await this.prisma.position.update({ where: { id: p.id }, data: { motionState: 'UNKNOWN' } }).catch(() => undefined);
      return alertsRaised;
    }

    const res = this.classifier.classify(track.motion, speed);
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

    // --- trips (open on travel, close on 10-min stop / day change) ---
    const isTravel = state === 'RIDING' || state === 'WALKING';
    if (isTravel) {
      if (!track.openTrip || track.openTrip.workDate !== workDate) {
        if (track.openTrip) await this.finalizeTrip(track.openTrip, track.last?.ts ?? p.ts);
        const trip = await this.prisma.trip.create({
          data: { employeeId, zoneId: ctx?.zoneId ?? null, startedAt: new Date(p.ts), state: 'OPEN', replayed: p.buffered },
          select: { id: true, startedAt: true },
        });
        track.openTrip = { id: trip.id, workDate, startedAt: p.ts, distanceM: 0, maxSpeed: null, lastMoveTs: p.ts, replayed: p.buffered };
      }
      if (track.openTrip) {
        if (track.last) track.openTrip.distanceM += distanceFromLast;
        if (speed !== null) track.openTrip.maxSpeed = track.openTrip.maxSpeed === null ? speed : Math.max(track.openTrip.maxSpeed, speed);
        track.openTrip.lastMoveTs = p.ts;
        if (p.buffered) track.openTrip.replayed = true;
      }
    }

    // --- stop events (only meaningful while a trip is open) ---
    if (res.changed && state === 'STOPPED' && track.openTrip) {
      const kind = await this.stopKind(ctx, { lat: p.lat, lng: p.lng });
      const stop = await this.prisma.stopEvent.create({
        data: { employeeId, tripId: track.openTrip.id, zoneId: ctx?.zoneId ?? null, lat: p.lat, lng: p.lng, startedAt: new Date(p.ts), kind },
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

    // --- trip close after 10 min of STOPPED while tracking ---
    if (track.openTrip && track.stopStart && state === 'STOPPED' && p.ts - track.stopStart.ts > 600_000) {
      await this.finalizeTrip(track.openTrip, track.stopStart.ts);
      track.openTrip = null;
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
      const live: LivePosition = {
        userId: ctx.userId ?? employeeId,
        employeeId,
        name: ctx.employeeName,
        lat: p.lat,
        lng: p.lng,
        speedKmh: round(speed, 1),
        motionState: state,
        insideZone,
        ts: new Date(p.ts).toISOString(),
        replayed: p.buffered || p.stale,
      };
      this.live.set(employeeId, live);
      try {
        this.publisher?.position(live);
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

  /** Close an open trip: compute polyline (simplified), avg speed, end point. */
  private async finalizeTrip(open: NonNullable<Track['openTrip']>, endedAt: number): Promise<void> {
    const points = await this.prisma.position.findMany({
      where: { tripId: open.id },
      orderBy: { clientTs: 'asc' },
      select: { lat: true, lng: true },
    });
    const simplified = this.geo.simplify(points.map((pt) => ({ lat: pt.lat, lng: pt.lng })), 25);
    const distanceKm = open.distanceM / 1000;
    const hours = Math.max(1 / 3600, (endedAt - open.startedAt) / 3600_000);
    const avgSpeed = distanceKm / hours;
    const lastPt = points[points.length - 1];
    await this.prisma.trip
      .update({
        where: { id: open.id },
        data: {
          endedAt: new Date(endedAt),
          distanceKm: round(distanceKm, 3) ?? 0,
          maxSpeedKmh: round(open.maxSpeed ?? undefined, 1) ?? null,
          avgSpeedKmh: round(avgSpeed, 1) ?? null,
          startPoint: `${points[0]?.lat ?? ''},${points[0]?.lng ?? ''}`,
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

  private async rebuildRouteLine(employeeId: string, workDate: string, track: Track): Promise<void> {
    const dayStart = new Date(`${workDate}T00:00:00.000Z`);
    const dayEnd = new Date(`${workDate}T23:59:59.999Z`);
    const positions = await this.prisma.position.findMany({
      where: { employeeId, clientTs: { gte: dayStart, lte: dayEnd } },
      orderBy: { clientTs: 'asc' },
      select: { lat: true, lng: true },
    });
    if (!positions.length) return;
    const simplified = this.geo.simplify(positions.map((p) => ({ lat: p.lat, lng: p.lng })), 25);
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

  /** GET /positions/live — latest position per employee (cache first, DB fallback). */
  async liveSnapshot(since?: string): Promise<{ generatedAt: string; drivers: LivePosition[] }> {
    let drivers = [...this.live.values()];
    if (!drivers.length) drivers = await this.liveFromDb();
    const sinceMs = since ? new Date(since).getTime() : null;
    if (sinceMs) drivers = drivers.filter((d) => new Date(d.ts).getTime() > sinceMs);
    return { generatedAt: new Date().toISOString(), drivers };
  }

  private async liveFromDb(): Promise<LivePosition[]> {
    const recent = await this.prisma.position.findMany({ orderBy: { clientTs: 'desc' }, take: 2000, include: { employee: { select: { id: true, name: true, user: { select: { id: true } } } } } });
    const seen = new Map<string, LivePosition>();
    for (const p of recent) {
      if (seen.has(p.employeeId)) continue;
      seen.set(p.employeeId, {
        userId: p.employee?.user?.id ?? p.employeeId,
        employeeId: p.employeeId,
        name: p.employee?.name ?? '',
        lat: p.lat,
        lng: p.lng,
        speedKmh: round(p.speedKmh, 1),
        motionState: (p.motionState as MotionState) ?? 'UNKNOWN',
        insideZone: p.insideZone,
        ts: p.clientTs.toISOString(),
        replayed: p.buffered || p.stale,
      });
    }
    return [...seen.values()];
  }

  /** GET /positions/route?userId&date */
  async route(userId: string, date: string): Promise<unknown> {
    const employeeId = await this.employeeIdForUserId(userId);
    if (!employeeId) throw new BadRequestException('EMPLOYEE_NOT_FOUND');
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const positions = await this.prisma.position.findMany({
      where: { employeeId, clientTs: { gte: dayStart, lte: dayEnd } },
      orderBy: { clientTs: 'asc' },
    });
    const line = this.geo.simplify(positions.map((p) => ({ lat: p.lat, lng: p.lng })), 25);
    const routeLine = await this.prisma.routeLine.findUnique({ where: { employeeId_workDate: { employeeId, workDate: date } } });
    const stops = await this.prisma.stopEvent.findMany({
      where: { employeeId, startedAt: { gte: dayStart, lte: dayEnd } },
      orderBy: { startedAt: 'asc' },
    });
    const gaps = JSON.parse(routeLine?.gaps ?? '[]') as unknown[];
    return {
      userId,
      employeeId,
      date,
      replayed: positions.some((p) => p.buffered || p.stale),
      pointCount: positions.length,
      geojson: { type: 'LineString', coordinates: line.map((p) => [p.lng, p.lat]) },
      positions: positions.map((p) => ({
        ts: p.clientTs.toISOString(),
        lat: p.lat,
        lng: p.lng,
        speedKmh: round(p.speedKmh, 1),
        motionState: p.motionState,
        buffered: p.buffered,
        stale: p.stale,
      })),
      stops: stops.map((s) => ({ id: s.id, startedAt: s.startedAt.toISOString(), endedAt: s.endedAt?.toISOString() ?? null, durationS: s.durationS, kind: s.kind, lat: s.lat, lng: s.lng })),
      gaps,
    };
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

  /** GET /drivers/presence — derived from Device + latest Position. */
  async presence(): Promise<unknown[]> {
    const devices = await this.prisma.device.findMany({
      where: { employee: { isNot: null } },
      include: { employee: { select: { id: true, name: true, user: { select: { id: true } } } } },
    });
    const hb = (await this.rules.globalOverrides()).heartbeatIntervalS ?? undefined;
    const out: unknown[] = [];
    for (const d of devices) {
      if (!d.employee) continue;
      const live = this.live.get(d.employee.id);
      const ageS = d.lastSeenAt ? Math.round((Date.now() - d.lastSeenAt.getTime()) / 1000) : null;
      const offlineAfter = (hb ?? 300) * 3;
      out.push({
        userId: d.employee.user?.id ?? d.employee.id,
        employeeId: d.employee.id,
        name: d.employee.name,
        online: d.online && (ageS === null || ageS <= offlineAfter),
        tracking: d.tracking,
        gpsEnabled: d.gpsEnabled,
        lastSeen: d.lastSeenAt?.toISOString() ?? null,
        ageS,
        motionState: live?.motionState ?? 'UNKNOWN',
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
    const devices = await this.prisma.device.findMany({
      where: { tracking: true, online: true, lastSeenAt: { lt: cutoff }, employee: { isNot: null } },
      include: { employee: { select: { id: true, user: { select: { id: true } } } } },
    });
    for (const d of devices) {
      if (!d.employee) continue;
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
  }
}
