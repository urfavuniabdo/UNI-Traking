import type { AlertPayload, LivePosition, RoutePoint, RouteResponse } from '@/api/types';
import { AR_ALERT_TEXT, type MotionState } from '@shared';
import { alerts, drivers, fencesSnapshot, zones, type DriverSim } from './db';
import { busEmit } from './bus';
import { haversineM, pointInPolygon } from '@/utils/format';

let timer: ReturnType<typeof setInterval> | null = null;
let kareemCycle = 0;

function motionFromSpeed(kmh: number): MotionState {
  if (kmh <= 1.5) return 'STOPPED';
  if (kmh <= 7) return 'WALKING';
  return 'RIDING';
}

function outsideZone(d: DriverSim): boolean {
  const z = zones.find((x) => x.id === d.zoneId);
  if (!z) return false;
  if (z.shape === 'CIRCLE') return haversineM(d.lat, d.lng, z.lat, z.lng) > (z.radiusM ?? 0);
  return !pointInPolygon(d.lat, d.lng, z.polygon ?? []);
}

function move(d: DriverSim, tickMin: number) {
  const target = d.waypoints[d.wpIndex];
  const dist = haversineM(d.lat, d.lng, target[0], target[1]);
  const stepM = Math.max(60, (d.speed * 1000) / 60) * tickMin * (d.scenario === 'walking' ? 0.12 : 1);
  if (dist < stepM) {
    d.wpIndex = (d.wpIndex + 1) % d.waypoints.length;
  }
  const t = Math.min(1, stepM / Math.max(1, dist));
  const nt = d.waypoints[d.wpIndex];
  d.lat = +(d.lat + (nt[0] - d.lat) * t).toFixed(5);
  d.lng = +(d.lng + (nt[1] - d.lng) * t).toFixed(5);
  d.bearing = Math.round((Math.atan2(nt[1] - d.lng, nt[0] - d.lat) * 180) / Math.PI + 360) % 360;

  // scenario shaping
  if (d.scenario === 'speeding') d.speed = 88 + Math.random() * 14;
  else if (d.scenario === 'stopped-long') d.speed = 0.4;
  else if (d.scenario === 'walking') d.speed = 3.2 + Math.random();
  else d.speed = Math.max(4, Math.min(70, d.speed + (Math.random() - 0.5) * 8));
  d.motionState = motionFromSpeed(d.speed);
}

const cooldown = new Map<string, number>();
type RaiseInput = {
  type: AlertPayload['type'];
  severity: AlertPayload['severity'];
  userId: string;
  userName: string;
  phone: string;
  zoneId: string | null;
  siteId: string | null;
  meta: AlertPayload['meta'];
};
function raise(over: RaiseInput): void {
  const key = `${over.userId}:${over.type}`;
  const last = cooldown.get(key) ?? 0;
  if (Date.now() - last < 40000) return; // mock-side cooldown
  cooldown.set(key, Date.now());
  const txt = AR_ALERT_TEXT[over.type];
  const a: AlertPayload = {
    id: `al-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: txt.title,
    body: txt.body,
    createdAt: new Date().toISOString(),
    status: 'OPEN',
    ackBy: null,
    ackAt: null,
    channel: { push: true, socket: true, whatsapp: 'PENDING' },
    orgUnitId: 'ou-1',
    ...over,
  };
  alerts.unshift(a);
  if (alerts.length > 80) alerts.pop();
  busEmit('alert:new', a);
}

function tick() {
  const now = new Date().toISOString();
  for (const d of drivers) {
    // offline-buffer scenario: drop then come back and replay
    if (d.scenario === 'offline-buffer') {
      kareemCycle++;
      if (kareemCycle === 40) {
        d.online = false;
        d.dataEnabled = false;
        d.sinceOffline = now;
        busEmit('driver:presence', { userId: d.userId, online: false, tracking: d.tracking, gpsEnabled: d.gpsEnabled, lastSeen: now });
        raise({ type: 'APP_OFFLINE', severity: 'CRITICAL', userId: d.userId, userName: d.name, phone: d.phone, zoneId: d.zoneId, siteId: null, meta: { offlineSince: now, bufferCount: 318 } });
      }
      if (kareemCycle === 70) {
        d.online = true;
        d.dataEnabled = true;
        d.sinceOffline = undefined;
        busEmit('driver:presence', { userId: d.userId, online: true, tracking: true, gpsEnabled: true, lastSeen: now });
        raise({ type: 'BUFFER_REPLAYED', severity: 'INFO', userId: d.userId, userName: d.name, phone: d.phone, zoneId: d.zoneId, siteId: null, meta: { bufferCount: 318, lat: d.lat, lng: d.lng } });
        kareemCycle = 0;
      }
      if (!d.online) continue;
    }

    move(d, 0.4);
    d.battery = Math.max(5, d.battery - 0.05);
    d.lastSeen = now;

    const pos: LivePosition = {
      userId: d.userId,
      lat: d.lat,
      lng: d.lng,
      speedKmh: +d.speed.toFixed(1),
      motionState: d.motionState,
      ts: now,
      battery: Math.round(d.battery),
      accuracy: d.gpsEnabled ? 4 + Math.random() * 8 : 90,
      online: d.online,
      tracking: d.tracking,
      gpsEnabled: d.gpsEnabled,
      dataEnabled: d.dataEnabled,
      lastSeen: now,
    };
    busEmit('position:update', pos);

    // rule engine emulation
    if (d.scenario === 'speeding') {
      raise({ type: 'SPEEDING', severity: d.speed > 90 ? 'CRITICAL' : 'WARNING', userId: d.userId, userName: d.name, phone: d.phone, zoneId: d.zoneId, siteId: null, meta: { lat: d.lat, lng: d.lng, speedKmh: +d.speed.toFixed(0), threshold: 80 } });
    }
    if (d.scenario === 'stopped-long') {
      raise({ type: 'STOP_EXCEEDED', severity: 'CRITICAL', userId: d.userId, userName: d.name, phone: d.phone, zoneId: d.zoneId, siteId: null, meta: { lat: d.lat, lng: d.lng, stopDurationS: 2460, threshold: 1800 } });
    }
    if (d.scenario === 'outside-zone' || outsideZone(d)) {
      raise({ type: 'GEOFENCE_EXIT', severity: 'CRITICAL', userId: d.userId, userName: d.name, phone: d.phone, zoneId: d.zoneId, siteId: null, meta: { lat: d.lat, lng: d.lng, fenceName: zones.find((z) => z.id === d.zoneId)?.name, distanceToCenterM: Math.round(haversineM(d.lat, d.lng, d.center[0], d.center[1])) } });
    }
  }
  // keep fence "outside" snapshot fresh
  fencesSnapshot();
}

export function startSim(): void {
  if (timer) return;
  timer = setInterval(tick, 3000);
  // first position burst immediately
  setTimeout(tick, 800);
}

export function stopSim(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Generate a plausible day route for a driver (deterministic per user+date). */
export function buildRoute(userId: string, date: string): RouteResponse | null {
  const d = drivers.find((x) => x.userId === userId);
  if (!d) return null;
  const seedNum = Array.from(userId).reduce((s, c) => s + c.charCodeAt(0), 0);
  let s = seedNum >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0xffffffff);

  const points: RoutePoint[] = [];
  const startH = 6;
  let lat = d.waypoints[0][0];
  let lng = d.waypoints[0][1];
  let wpi = 1;
  const bufferedOnly = d.scenario === 'offline-buffer';
  for (let m = 0; m <= 8 * 60; m += 2) {
    const ts = new Date(new Date(`${date}T${String(startH).padStart(2, '0')}:00:00+02:00`).getTime() + m * 60000).toISOString();
    const target = d.waypoints[wpi % d.waypoints.length];
    const stepFrac = 0.15 + rnd() * 0.2;
    lat = lat + (target[0] - lat) * stepFrac + (rnd() - 0.5) * 0.0008;
    lng = lng + (target[1] - lng) * stepFrac + (rnd() - 0.5) * 0.0008;
    if (rnd() > 0.93) wpi++;
    let speed = 15 + rnd() * 55;
    let state: MotionState = motionFromSpeed(speed);
    // stops: ~3 parked windows
    const stopWin = m > 90 && m < 140 ? true : m > 260 && m < 330 ? true : m > 420 && m < 460 ? true : false;
    if (stopWin) {
      speed = 0.2;
      state = 'STOPPED';
    }
    // gap: 14-minute hole for ROUTE_GAP realism (skip emission) — except offline driver (replayed)
    if (!bufferedOnly && m > 180 && m < 194) continue;
    points.push({
      clientTs: ts,
      lat: +lat.toFixed(5),
      lng: +lng.toFixed(5),
      speedKmh: +speed.toFixed(1),
      bearing: Math.round(rnd() * 360),
      accuracy: +(3 + rnd() * 9).toFixed(1),
      motionState: state,
      buffered: bufferedOnly, // whole offline day arrives as a replayed buffer
    });
  }

  const stops = [
    { startTs: points[45]?.clientTs ?? '', endTs: points[70]?.clientTs ?? '', lat, lng, durationMin: 50 },
    { startTs: points[130]?.clientTs ?? '', endTs: points[165]?.clientTs ?? '', lat, lng, durationMin: 70 },
    { startTs: points[210]?.clientTs ?? '', endTs: points[230]?.clientTs ?? '', lat, lng, durationMin: 40 },
  ].filter((x) => x.startTs && x.endTs);

  const gaps = bufferedOnly
    ? []
    : [{ fromTs: points[88]?.clientTs ?? '', toTs: points[95]?.clientTs ?? '', minutes: 14 }].filter((g) => g.fromTs && g.toTs);

  let dist = 0;
  for (let i = 1; i < points.length; i++) dist += haversineM(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
  const coords = points.map((p) => [p.lng, p.lat] as [number, number]);

  return {
    userId,
    userName: d.name,
    date,
    geojson: { type: 'LineString', coordinates: coords },
    points,
    stops,
    gaps,
    distanceKm: +(dist / 1000).toFixed(1),
    replayedPoints: points.filter((p) => p.buffered).length,
  };
}
