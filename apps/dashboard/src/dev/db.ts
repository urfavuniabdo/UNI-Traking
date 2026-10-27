import type {
  AlertPayload,
  AttendanceRecord,
  DailyReport,
  DeviceInfo,
  Employee,
  ExceptionRow,
  FencesResponse,
  MileageRow,
  NotificationLogEntry,
  RuleSettings,
  Site,
  SyncIssue,
  SyncMatrixRow,
  SyncRun,
  SyncSource,
  TimesheetRow,
  Zone,
} from '@/api/types';
import { AR_ALERT_TEXT, type AlertType, type MotionState, type Severity } from '@shared';

let seq = 1000;
export const nid = (p: string) => `${p}-${(seq++).toString(36)}`;

/** deterministic pseudo random */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export interface DriverSim {
  userId: string;
  name: string;
  phone: string;
  identifier: string;
  city: 'القاهرة' | 'الإسكندرية' | 'الجيزة';
  zoneId: string;
  center: [number, number];
  waypoints: [number, number][];
  wpIndex: number;
  progress: number;
  lat: number;
  lng: number;
  speed: number;
  bearing: number;
  motionState: MotionState;
  online: boolean;
  tracking: boolean;
  gpsEnabled: boolean;
  dataEnabled: boolean;
  battery: number;
  lastSeen: string;
  scenario?: 'speeding' | 'stopped-long' | 'offline-buffer' | 'outside-zone' | 'walking';
  sinceOffline?: string;
}

const CITIES: Record<string, [number, number]> = {
  cairo: [30.0444, 31.2357],
  alex: [31.2001, 29.9187],
  giza: [30.0333, 31.2333],
};

function loop(cx: number, cy: number, seed: number): [number, number][] {
  const r = rng(seed);
  const pts: [number, number][] = [];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rad = 0.012 + r() * 0.014;
    pts.push([+(cy + Math.sin(a) * rad).toFixed(5), +(cx + Math.cos(a) * rad * 1.25).toFixed(5)]);
  }
  return pts;
}

interface DriverSeed {
  name: string;
  city: DriverSim['city'];
  key: string;
  scenario?: DriverSim['scenario'];
  phone: string;
}

export const DRIVER_SEEDS: DriverSeed[] = [
  { name: 'أحمد محمود', city: 'القاهرة', key: 'ahmed', phone: '+201001552233' },
  { name: 'مصطفى السيد', city: 'الجيزة', key: 'mostafa', scenario: 'speeding', phone: '+201001448877' },
  { name: 'حسن علي', city: 'القاهرة', key: 'hassan', scenario: 'stopped-long', phone: '+201110022334' },
  { name: 'كريم فؤاد', city: 'الإسكندرية', key: 'kareem', scenario: 'offline-buffer', phone: '+201223344556' },
  { name: 'عمرو ذكي', city: 'القاهرة', key: 'amr', scenario: 'outside-zone', phone: '+201066778899' },
  { name: 'ياسر عبد الله', city: 'الإسكندرية', key: 'yasser', phone: '+201099887766' },
  { name: 'طارق نور', city: 'الجيزة', key: 'tarek', phone: '+201144556677' },
  { name: 'سعيد حسن', city: 'القاهرة', key: 'saeed', phone: '+201277889900' },
  { name: 'وائل سمير', city: 'الإسكندرية', key: 'wael', phone: '+201033221100' },
  { name: 'إبراهيم خالد', city: 'الجيزة', key: 'ebrahim', phone: '+201123456789' },
  { name: 'شريف منير', city: 'القاهرة', key: 'sherif', scenario: 'walking', phone: '+201288776655' },
  { name: 'محمود جابر', city: 'الإسكندرية', key: 'mahmoud', phone: '+201065432198' },
  { name: 'عادل رجب', city: 'الجيزة', key: 'adel', phone: '+201177766554' },
  { name: 'فتحي شعبان', city: 'القاهرة', key: 'fathy', phone: '+201233344455' },
];

const cityCenter = (c: DriverSim['city']): [number, number] =>
  c === 'القاهرة' ? CITIES.cairo : c === 'الإسكندرية' ? CITIES.alex : CITIES.giza;

export const drivers: DriverSim[] = DRIVER_SEEDS.map((d, i) => {
  const [cy, cx] = cityCenter(d.city);
  const r = rng(42 + i);
  const jitter = (): [number, number] => [+(cy + (r() - 0.5) * 0.01).toFixed(5), +(cx + (r() - 0.5) * 0.012).toFixed(5)];
  const wp = loop(cx, cy, 100 + i * 7);
  return {
    userId: `u-${d.key}`,
    name: d.name,
    phone: d.phone,
    identifier: `DRV-${String(i + 1).padStart(3, '0')}`,
    city: d.city,
    zoneId: d.city === 'القاهرة' ? 'z-cairo-1' : d.city === 'الإسكندرية' ? 'z-alex-1' : 'z-giza-1',
    center: jitter(),
    waypoints: wp,
    wpIndex: i % wp.length,
    progress: r(),
    lat: wp[i % wp.length][0],
    lng: wp[i % wp.length][1],
    speed: 20 + r() * 40,
    bearing: Math.round(r() * 360),
    motionState: 'RIDING',
    online: d.scenario !== 'offline-buffer',
    tracking: true,
    gpsEnabled: d.scenario !== 'offline-buffer',
    dataEnabled: d.scenario !== 'offline-buffer',
    battery: Math.round(40 + r() * 55),
    lastSeen: new Date().toISOString(),
    scenario: d.scenario,
    sinceOffline: d.scenario === 'offline-buffer' ? new Date(Date.now() - 42 * 60000).toISOString() : undefined,
  };
});

export const employeesExtra: Employee[] = [
  { id: 'u-emp-1', identifier: 'EMP-101', name: 'منى إبراهيم', phone: '+201000000001', role: 'EMPLOYEE', driver: false, siteId: 's-cairo', zoneId: null, active: true },
  { id: 'u-emp-2', identifier: 'EMP-102', name: 'هالة شكري', phone: '+201000000002', role: 'EMPLOYEE', driver: false, siteId: 's-alex', zoneId: null, active: true },
  { id: 'u-emp-3', identifier: 'EMP-103', name: 'رامي عبد الناصر', phone: '+201000000003', role: 'EMPLOYEE', driver: false, siteId: 's-giza', zoneId: null, active: true },
];

export const sites: Site[] = [
  { id: 's-cairo', name: 'مقر القاهرة الرئيسي', code: 'CAI-HQ', city: 'القاهرة', lat: 30.0444, lng: 31.2357, radiusM: 180, strictReject: false, attendance: { expected: 42, present: 38, outOfFence: 1 } },
  { id: 's-alex', name: 'مستودع الإسكندرية', code: 'ALX-DEP', city: 'الإسكندرية', lat: 31.2001, lng: 29.9187, radiusM: 150, strictReject: true, attendance: { expected: 18, present: 16, outOfFence: 0 } },
  { id: 's-giza', name: 'مكتب الجيزة', code: 'GIZ-OF', city: 'الجيزة', lat: 30.0333, lng: 31.2333, radiusM: 120, strictReject: false, attendance: { expected: 12, present: 11, outOfFence: 0 } },
];

export const zones: Zone[] = [
  {
    id: 'z-cairo-1', name: 'نطاق القاهرة الشرقية', code: 'Z-CAI-E', city: 'القاهرة', shape: 'CIRCLE',
    lat: 30.061, lng: 31.28, radiusM: 3200, strictReject: false, maxSpeedKmh: 70, stopAlertMin: 25,
    driverCount: 5, activeDriverIds: ['u-ahmed', 'u-hassan', 'u-amr', 'u-sherif', 'u-fathy'],
  },
  {
    id: 'z-cairo-2', name: 'نطاق القاهرة الغربية', code: 'Z-CAI-W', city: 'القاهرة', shape: 'POLYGON',
    lat: 30.05, lng: 31.2, polygon: [[30.08, 31.16], [30.08, 31.23], [30.02, 31.23], [30.02, 31.16]],
    strictReject: false, maxSpeedKmh: 80, stopAlertMin: 30, driverCount: 0, activeDriverIds: [],
  },
  {
    id: 'z-alex-1', name: 'نطاق وسط الإسكندرية', code: 'Z-ALX-C', city: 'الإسكندرية', shape: 'CIRCLE',
    lat: 31.196, lng: 29.93, radiusM: 2800, strictReject: false, maxSpeedKmh: 60, stopAlertMin: 30,
    driverCount: 4, activeDriverIds: ['u-kareem', 'u-yasser', 'u-wael', 'u-mahmoud'],
  },
  {
    id: 'z-giza-1', name: 'نطاق الجيزة', code: 'Z-GIZ', city: 'الجيزة', shape: 'POLYGON',
    lat: 30.03, lng: 31.22, polygon: [[30.06, 31.19], [30.06, 31.26], [30.0, 31.26], [30.0, 31.19]],
    strictReject: true, maxSpeedKmh: 90, stopAlertMin: 30,
    driverCount: 5, activeDriverIds: ['u-mostafa', 'u-tarek', 'u-ebrahim', 'u-saeed', 'u-adel'],
  },
];

export const employees: Employee[] = [
  ...drivers.map<Employee>((d, i) => ({
    id: d.userId,
    identifier: d.identifier,
    name: d.name,
    phone: d.phone,
    role: 'DRIVER',
    driver: true,
    siteId: null,
    zoneId: d.zoneId,
    zoneName: zones.find((z) => z.id === d.zoneId)?.name ?? null,
    active: true,
    maxSpeedKmh: d.scenario === 'speeding' ? 80 : null,
    stopAlertMin: null,
    motionMinutes: { stopped: 40 + i * 6, walking: 12 + i * 2, riding: 120 + i * 9 },
    openAlerts: 0,
  })),
  ...employeesExtra,
];

export const devices: DeviceInfo[] = drivers.map((d, i) => ({
  id: `dev-${i + 1}`,
  deviceId: `AND-${1000 + i}`,
  platform: i % 5 === 0 ? 'ios' : 'android',
  appVersion: i % 3 === 0 ? '1.4.2' : '1.4.1',
  token: `fcm:${d.identifier.toLowerCase().replace('-', '')}${'x'.repeat(14)}`,
  lastSeen: d.lastSeen,
  battery: d.battery,
  tracking: d.tracking,
  gpsEnabled: d.gpsEnabled,
  online: d.online,
}));

// ─── Alerts ────────────────────────────────────────────────────────────────
function mkAlert(over: Partial<AlertPayload> & { type: AlertType; userId: string; severity: Severity }): AlertPayload {
  const drv = drivers.find((d) => d.userId === over.userId) ?? drivers[0];
  const txt = AR_ALERT_TEXT[over.type];
  return {
    id: nid('al'),
    type: over.type,
    severity: over.severity,
    userId: over.userId,
    userName: over.userName ?? drv.name,
    phone: over.phone ?? drv.phone,
    orgUnitId: 'ou-1',
    zoneId: over.zoneId ?? drv.zoneId,
    siteId: over.siteId ?? null,
    title: over.title ?? txt.title,
    body: over.body ?? txt.body,
    createdAt: over.createdAt ?? new Date().toISOString(),
    status: over.status ?? 'OPEN',
    ackBy: over.ackBy ?? null,
    ackAt: over.ackAt ?? null,
    meta: over.meta ?? { lat: drv.lat, lng: drv.lng },
    channel: over.channel ?? { push: true, socket: true, whatsapp: 'SENT' },
  };
}

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

export const alerts: AlertPayload[] = [
  mkAlert({ type: 'SPEEDING', severity: 'CRITICAL', userId: 'u-mostafa', meta: { lat: 30.04, lng: 31.22, speedKmh: 96, threshold: 80 }, createdAt: ago(3) }),
  mkAlert({ type: 'GEOFENCE_EXIT', severity: 'CRITICAL', userId: 'u-amr', meta: { lat: 30.02, lng: 31.34, fenceName: 'نطاق القاهرة الشرقية', distanceToCenterM: 4200 }, createdAt: ago(8) }),
  mkAlert({ type: 'STOP_EXCEEDED', severity: 'CRITICAL', userId: 'u-hassan', meta: { lat: 30.052, lng: 31.27, stopDurationS: 2460, threshold: 1500 }, createdAt: ago(12) }),
  mkAlert({ type: 'APP_OFFLINE', severity: 'CRITICAL', userId: 'u-kareem', meta: { offlineSince: ago(42), bufferCount: 318 }, createdAt: ago(35) }),
  mkAlert({ type: 'CHECK_IN_OUT_OF_FENCE', severity: 'WARNING', userId: 'u-fathy', meta: { lat: 30.07, lng: 31.31, fenceName: 'نطاق القاهرة الشرقية', distanceToCenterM: 3600 }, createdAt: ago(210), siteId: 's-cairo' }),
  mkAlert({ type: 'HARSH_BRAKING', severity: 'WARNING', userId: 'u-tarek', meta: { lat: 30.035, lng: 31.222, speedKmh: 55 }, createdAt: ago(45), status: 'ACK', ackBy: 'u-admin', ackAt: ago(40) }),
  mkAlert({ type: 'ROUTE_GAP', severity: 'WARNING', userId: 'u-yasser', meta: { lat: 31.197, lng: 29.926 }, createdAt: ago(70) }),
  mkAlert({ type: 'GPS_OFF', severity: 'CRITICAL', userId: 'u-adel', meta: {}, createdAt: ago(95), status: 'ACK', ackBy: 'u-admin', ackAt: ago(90) }),
  mkAlert({ type: 'BUFFER_REPLAYED', severity: 'INFO', userId: 'u-kareem', meta: { bufferCount: 318 }, createdAt: ago(28) }),
  mkAlert({ type: 'CHECKOUT_MISSING', severity: 'WARNING', userId: 'u-emp-3', meta: {}, createdAt: ago(160), siteId: 's-giza', zoneId: null }),
  mkAlert({ type: 'HARSH_ACCELERATION', severity: 'INFO', userId: 'u-saeed', meta: { speedKmh: 38 }, createdAt: ago(130), status: 'RESOLVED', ackBy: 'u-admin', ackAt: ago(120) }),
  mkAlert({ type: 'IDLE_LONG', severity: 'WARNING', userId: 'u-mahmoud', meta: {}, createdAt: ago(180), status: 'RESOLVED', ackBy: 'u-admin', ackAt: ago(150) }),
  mkAlert({ type: 'HEARTBEAT_MISSING', severity: 'CRITICAL', userId: 'u-wael', meta: { offlineSince: ago(20) }, createdAt: ago(18) }),
  mkAlert({ type: 'SPEEDING', severity: 'WARNING', userId: 'u-ebrahim', meta: { speedKmh: 71, threshold: 60 }, createdAt: ago(240), status: 'ACK', ackBy: 'u-admin', ackAt: ago(230) }),
];

// ─── Attendance ────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
function att(userId: string, userName: string, siteId: string | null, siteName: string | null, zoneId: string | null, zoneName: string | null, ci: string | null, co: string | null, status: AttendanceRecord['checkInStatus'], extra: Partial<AttendanceRecord> = {}): AttendanceRecord {
  return {
    id: nid('att'), userId, userName, siteId, siteName, zoneId, zoneName,
    date: today, checkInTs: ci ? new Date(ci).toISOString() : null, checkOutTs: co ? new Date(co).toISOString() : null,
    checkInStatus: status, checkOutStatus: co ? 'VALID' : null, exception: status !== 'VALID', replayed: false, ...extra,
  };
}
const t = (h: string, m: number) => `${today}T${h}:${String(m).padStart(2, '0')}:00+02:00`;

export const attendance: AttendanceRecord[] = [
  ...drivers.map((d, i) =>
    att(
      d.userId, d.name, null, null, d.zoneId,
      zones.find((z) => z.id === d.zoneId)?.name ?? null,
      t('06', 20 + (i % 40)),
      i === 2 ? null : t('14', 5 + (i % 50)),
      d.scenario === 'outside-zone' ? 'OUT_OF_FENCE' : 'VALID',
      d.scenario === 'outside-zone' ? { distanceToCenterM: 4210, fenceName: 'نطاق القاهرة الشرقية' } : {},
    ),
  ),
  att('u-emp-1', 'منى إبراهيم', 's-cairo', 'مقر القاهرة الرئيسي', null, null, t('08', 2), null, 'VALID'),
  att('u-emp-2', 'هالة شكري', 's-alex', 'مستودع الإسكندرية', null, null, t('07', 55), t('15', 30), 'VALID'),
  att('u-emp-3', 'رامي عبد الناصر', 's-giza', 'مكتب الجيزة', null, null, t('09', 12), null, 'OUT_OF_FENCE', { distanceToCenterM: 260, fenceName: 'مكتب الجيزة' }),
];

// ─── Sync ──────────────────────────────────────────────────────────────────
export const syncSources: SyncSource[] = [
  { id: 'src-1', name: 'الداتا بيز الرئيسية (HR SQL)', kind: 'sql', enabled: true, scheduleCron: '*/15 * * * *', lastRunAt: ago(6) },
  { id: 'src-2', name: 'نظام الورديات REST', kind: 'rest', enabled: true, scheduleCron: '0 * * * *', lastRunAt: ago(38) },
  { id: 'src-3', name: 'كشف المتدربين CSV', kind: 'csv', enabled: false, scheduleCron: '—', lastRunAt: ago(1440) },
];

export const syncRuns: SyncRun[] = Array.from({ length: 9 }, (_, i) => ({
  id: `run-${i + 1}`,
  sourceId: i % 3 === 2 ? 'src-2' : 'src-1',
  sourceName: i % 3 === 2 ? 'نظام الورديات REST' : 'الداتا بيز الرئيسية (HR SQL)',
  startedAt: ago(15 * i + 4),
  finishedAt: ago(15 * i),
  status: i === 3 ? 'FAILED' : 'SUCCESS',
  created: i === 3 ? 0 : (i % 4) * 2,
  updated: i === 3 ? 0 : 3 + (i % 5),
  unchanged: i === 3 ? 0 : 140 - i * 3,
  deactivated: i === 3 ? 0 : i % 2,
  triggeredBy: i % 4 === 0 ? 'CRON' : i % 4 === 1 ? 'MANUAL' : 'WEBHOOK',
}));

export const syncIssues: SyncIssue[] = [
  { id: 'iss-1', runId: 'run-1', code: 'MISSING_PHONE', externalId: 'HR-9921', name: 'صبري عبد الحميد', detail: 'بدون رقم موبايل — لا يمكن إنشاء حساب (واتساب/طوارئ)', resolved: false, createdAt: ago(20) },
  { id: 'iss-2', runId: 'run-2', code: 'UNKNOWN_SITE', externalId: 'HR-8813', name: 'هدى مصطفى', detail: 'siteCode غير معروف: QUB-7', resolved: false, createdAt: ago(50) },
  { id: 'iss-3', runId: 'run-3', code: 'IDENTIFIER_COLLISION', externalId: 'EMP-102', name: 'سالي رأفت', detail: 'المعرّف EMP-102 مستخدم بالفعل — تم تخطي الصف', resolved: false, createdAt: ago(95) },
  { id: 'iss-4', runId: 'run-6', code: 'MISSING_PHONE', externalId: 'HR-4102', name: 'طارق حلمي', detail: 'رقى غير بصيغة E.164', resolved: true, createdAt: ago(610) },
];

export const syncMatrix: SyncMatrixRow[] = [
  { source: 'sql HR', field: 'employees', lastSyncAt: ago(6), freshnessMin: 6, rows: 168 },
  { source: 'sql HR', field: 'phones', lastSyncAt: ago(6), freshnessMin: 6, rows: 166 },
  { source: 'rest shifts', field: 'shifts', lastSyncAt: ago(38), freshnessMin: 38, rows: 420 },
  { source: 'csv trainees', field: 'employees', lastSyncAt: ago(1440), freshnessMin: 1440, rows: 12 },
];

// ─── Notification log (delivery health) ────────────────────────────────────
export const notificationLog: NotificationLogEntry[] = [
  { id: 'nl-1', alertId: alerts[0].id, alertType: 'SPEEDING', channel: 'push', userId: 'u-mostafa', userName: 'مصطفى السيد', status: 'SENT', attempts: 1, at: ago(3) },
  { id: 'nl-2', alertId: alerts[3].id, alertType: 'APP_OFFLINE', channel: 'whatsapp', userId: 'u-kareem', userName: 'كريم فؤاد', status: 'NO_PROVIDER', attempts: 1, at: ago(35), error: 'WACLOUD_TOKEN غير مضبوط' },
  { id: 'nl-3', alertId: alerts[2].id, alertType: 'STOP_EXCEEDED', channel: 'push', userId: 'u-hassan', userName: 'حسن علي', status: 'FAILED', attempts: 3, at: ago(12), error: 'FCM 406 NotAcceptable' },
  { id: 'nl-4', alertId: alerts[12].id, alertType: 'HEARTBEAT_MISSING', channel: 'push', userId: 'u-wael', userName: 'وائل سمير', status: 'FAILED', attempts: 3, at: ago(18), error: 'timeout' },
  { id: 'nl-5', alertId: alerts[1].id, alertType: 'GEOFENCE_EXIT', channel: 'socket', userId: 'u-amr', userName: 'عمرو ذكي', status: 'SENT', attempts: 1, at: ago(8) },
];

// ─── Settings ──────────────────────────────────────────────────────────────
export const settings: RuleSettings = {
  maxSpeedKmh: 80,
  stopAlertMin: 30,
  stopRepeatMin: 5,
  geofenceGraceS: 120,
  speedingCriticalS: 120,
  cooldownS: 180,
  gapMinMin: 10,
  shiftGraceMin: 30,
  replayMaxAgeHours: 72,
  attendanceStrictReject: false,
};

export const mePreferences = {
  push: true,
  whatsapp: true,
  email: false,
  sound: true,
  types: ['GEOFENCE_EXIT', 'SPEEDING', 'STOP_EXCEEDED', 'GPS_OFF', 'DATA_OFF', 'APP_OFFLINE', 'CHECK_IN_OUT_OF_FENCE', 'CHECKOUT_MISSING'] as AlertType[],
};

// ─── Reports fixtures (deterministic) ──────────────────────────────────────
export const mileageByDriver: MileageRow[] = drivers.map((d, i) => ({
  key: d.userId,
  label: d.name,
  km: +(18 + ((i * 7) % 23) + (i % 3) * 4.5).toFixed(1),
  ridingMin: 120 + ((i * 37) % 220),
  replayedKm: i === 3 ? 4.2 : +(0.5 + (i % 4) * 0.4).toFixed(1),
}));

export const mileageByZone: MileageRow[] = zones.map((z, i) => ({
  key: z.id,
  label: z.name,
  km: +(60 + i * 23 + (i % 2) * 17).toFixed(1),
  ridingMin: 500 + i * 90,
  replayedKm: +(2 + i).toFixed(1),
}));

export const exceptions: ExceptionRow[] = [
  { type: 'OUT_OF_FENCE check-ins', count: 7, unresolved: 2 },
  { type: 'MISSING_CHECKOUT', count: 5, unresolved: 1 },
  { type: 'SPEEDING', count: 12, unresolved: 4 },
  { type: 'APP_OFFLINE', count: 6, unresolved: 2 },
  { type: 'ROUTE_GAP', count: 4, unresolved: 1 },
  { type: 'BUFFER_REPLAYED', count: 9, unresolved: 0 },
];

export function buildDailyReport(date: string): DailyReport {
  const open = alerts.filter((a) => a.status === 'OPEN').length;
  const crit = alerts.filter((a) => a.severity === 'CRITICAL').length;
  return {
    date,
    kpis: {
      present: 15,
      absent: 2,
      onLeave: 1,
      activeDrivers: drivers.filter((d) => d.online).length,
      openAlerts: open,
      criticalAlerts: crit,
      kmDriven: +mileageByDriver.reduce((s, r) => s + r.km, 0).toFixed(1),
      exceptions: exceptions.reduce((s, r) => s + r.count, 0),
      offlineMinutes: 64,
    },
    alertsByType: (['SPEEDING', 'GEOFENCE_EXIT', 'STOP_EXCEEDED', 'GPS_OFF', 'APP_OFFLINE', 'BUFFER_REPLAYED', 'ROUTE_GAP'] as AlertType[]).map((type) => ({
      type,
      count: alerts.filter((a) => a.type === type).length + type.length % 5,
    })),
    hourlyPositions: Array.from({ length: 13 }, (_, i) => ({
      hour: i + 6,
      count: [12, 34, 88, 140, 121, 96, 102, 118, 130, 94, 61, 38, 17][i],
    })),
  };
}

export const timesheet: TimesheetRow[] = drivers.flatMap((d, i) =>
  [0, 1, 2].map((day) => {
    const date = new Date(Date.now() - day * 86400000).toISOString().slice(0, 10);
    const missing = day === 0 && i === 2;
    return {
      userId: d.userId,
      userName: d.name,
      date,
      checkIn: `${date}T06:${String(20 + (i % 30)).padStart(2, '0')}:00+02:00`,
      checkOut: missing ? null : `${date}T14:${String(10 + (i % 40)).padStart(2, '0')}:00+02:00`,
      hoursWorked: missing ? 8.0 : +(7 + (i % 5) * 0.4).toFixed(1),
      status: missing ? 'MISSING_CHECKOUT' : i === 4 && day === 0 ? 'OUT_OF_FENCE' : 'VALID',
      replayed: day === 1 && i === 3,
    } satisfies TimesheetRow;
  }),
);

// ─── Auth (mock user) ──────────────────────────────────────────────────────
export const mockAdmin = {
  id: 'u-admin',
  identifier: 'admin',
  name: 'أ. مدير النظام',
  role: 'ADMIN' as const,
  employeeId: 'HR-0001',
  phone: '+201000000000',
  siteId: 's-cairo',
  zoneId: null,
  driver: false,
};

export const adminPermissions = [
  'alerts:ack',
  'alerts:resolve',
  'fences:manage',
  'rules:manage',
  'sync:run',
  'devices:read',
  'reports:read',
  'employees:read',
  'employees:rules',
  'settings:manage',
];

export function fencesSnapshot(): FencesResponse {
  return { sites, zones, outside: drivers.filter((d) => d.scenario === 'outside-zone').map((d) => d.userId) };
}
