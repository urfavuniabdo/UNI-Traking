import type { AlertType, LeaveStatus, MotionState, Severity, Role } from '@shared';
import { ALERT_TYPES, MOTION_STATES, SEVERITY } from '@shared';

export type { AlertType, MotionState, Severity, Role };
export { ALERT_TYPES, MOTION_STATES, SEVERITY };

export type AlertStatus = 'OPEN' | 'ACK' | 'RESOLVED';
export type AttendanceStatus = 'VALID' | 'OUT_OF_FENCE' | 'MISSING_CHECKOUT' | 'AUTO_CLOSED' | 'LEAVE';
export type WhaStatus = 'PENDING' | 'SENT' | 'NO_PROVIDER';

export interface ApiUser {
  id: string;
  identifier: string;
  name: string;
  role: Role;
  employeeId: string;
  phone: string;
  siteId?: string | null;
  zoneId?: string | null;
  driver: boolean;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: ApiUser;
  mustChangePassword?: boolean;
}

export interface AlertMeta {
  lat?: number;
  lng?: number;
  speedKmh?: number;
  stopDurationS?: number;
  threshold?: number;
  offlineSince?: string;
  bufferCount?: number;
  fenceName?: string;
  distanceToCenterM?: number;
}

export interface AlertPayload {
  id: string;
  type: AlertType;
  severity: Severity;
  userId: string;
  userName: string;
  phone: string;
  orgUnitId?: string | null;
  zoneId?: string | null;
  siteId?: string | null;
  title: string;
  body: string;
  createdAt: string;
  status: AlertStatus;
  ackBy?: string | null;
  ackAt?: string | null;
  meta: AlertMeta;
  channel: { push: boolean; socket: boolean; whatsapp?: WhaStatus | null };
}

export interface LivePosition {
  userId: string;
  userName?: string;
  lat: number;
  lng: number;
  speedKmh: number;
  motionState: MotionState;
  ts: string;
  battery?: number;
  accuracy?: number;
  online: boolean;
  tracking: boolean;
  gpsEnabled: boolean;
  dataEnabled: boolean;
  lastSeen: string;
  // The API enriches the live record from the employee/zone joins (CONTRACT §7).
  employeeId?: string;
  name?: string;
  externalId?: string;
  driver?: boolean;
  insideZone?: boolean;
  zoneId?: string | null;
  zoneName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  replayed?: boolean;
}

export interface RoutePoint {
  clientTs: string;
  lat: number;
  lng: number;
  speedKmh: number;
  bearing?: number;
  accuracy?: number;
  motionState: MotionState;
  buffered: boolean;
  /** false = the server refused this fix as ground: kept in the list, never on the line. */
  credible?: boolean;
}

export interface RouteStop {
  startTs: string;
  endTs: string;
  lat: number;
  lng: number;
  durationMin: number;
  /** StopEvent identity from `GET /positions/route`; the mock feed omits it. */
  id?: string;
  kind?: 'PLANNED' | 'UNPLANNED' | 'UNKNOWN';
}

export interface RouteGap {
  fromTs: string;
  toTs: string;
  minutes: number;
}

export interface RouteResponse {
  userId: string;
  userName: string;
  date: string;
  geojson: { type: 'LineString'; coordinates: [number, number][] };
  /**
   * The day's ground: one entry per place the driver stood at, in order. A parked hour collapses to
   * a single point, so the map draws his stand-by dot and no line. Absent on older payloads.
   */
  trace?: { clientTs: string; lat: number; lng: number; speedKmh?: number; motionState?: MotionState }[];
  points: RoutePoint[];
  stops: RouteStop[];
  gaps: RouteGap[];
  distanceKm: number;
  replayedPoints: number;
  pointCount?: number;
  replayed?: boolean;
}

/** One present driver's recent line, from `GET /positions/trails`. */
export interface DashboardTrail {
  userId: string;
  employeeId: string;
  name: string;
  motionState: MotionState;
  lastTs: string;
  distanceKm: number;
  /** the credible trace, thinned to 8 m — the shape of the line, without the jitter */
  line: [number, number][];
  pointCount: number;
  stops: { id: string; kind: string; lat: number; lng: number; startTs: string; endTs: string | null; durationMin: number }[];
  gaps: { from: [number, number]; to: [number, number]; minutes: number }[];
}

export interface TrailsResponse {
  windowMin: number;
  serverTs: string;
  trails: DashboardTrail[];
}

export type GeoShape = 'CIRCLE' | 'POLYGON';
/** An alert that knows where it happened, so the map can put a symbol on the exact spot. */
export interface MapEvent {
  id: string;
  type: AlertType;
  lat: number;
  lng: number;
  title: string;
  ts: string;
  severity: Severity;
}

/** `GET /alerts` answers with `alerts` on the current API and `data` on the older one. */
export interface AlertsResponse {
  alerts?: AlertPayload[];
  data?: AlertPayload[];
  meta?: { total: number; page: number; pageSize: number };
}

export interface Site {
  id: string;
  name: string;
  code: string;
  city: string;
  lat: number;
  lng: number;
  radiusM: number;
  strictReject: boolean;
  attendance: { expected: number; present: number; outOfFence: number };
}

export interface Zone {
  id: string;
  name: string;
  code: string;
  city: string;
  shape: GeoShape;
  lat: number;
  lng: number;
  radiusM?: number | null;
  polygon?: [number, number][] | null;
  strictReject: boolean;
  maxSpeedKmh?: number | null;
  stopAlertMin?: number | null;
  driverCount: number;
  activeDriverIds: string[];
}

export interface FencesResponse {
  sites: Site[];
  zones: Zone[];
  outside: string[];
}

export interface Employee {
  id: string;
  identifier: string;
  name: string;
  phone: string;
  role: Role;
  driver: boolean;
  siteId?: string | null;
  zoneId?: string | null;
  zoneName?: string | null;
  siteName?: string | null;
  active: boolean;
  maxSpeedKmh?: number | null;
  stopAlertMin?: number | null;
  motionMinutes?: { stopped: number; walking: number; riding: number };
  openAlerts?: number;
}

export interface DeviceInfo {
  id: string;
  deviceId: string;
  platform: 'android' | 'ios';
  appVersion: string;
  token: string;
  lastSeen: string;
  battery?: number | null;
  tracking: boolean;
  gpsEnabled: boolean;
  online: boolean;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  userName: string;
  siteId?: string | null;
  siteName?: string | null;
  zoneId?: string | null;
  zoneName?: string | null;
  date: string;
  checkInTs?: string | null;
  checkOutTs?: string | null;
  checkInStatus: AttendanceStatus;
  checkOutStatus?: AttendanceStatus | null;
  distanceToCenterM?: number | null;
  fenceName?: string | null;
  exception: boolean;
  replayed: boolean;
}

export interface DailyReport {
  date: string;
  kpis: {
    present: number;
    absent: number;
    /** Days covered by an approved leave request — never counted as absence (§3). */
    onLeave: number;
    activeDrivers: number;
    openAlerts: number;
    criticalAlerts: number;
    kmDriven: number;
    exceptions: number;
    offlineMinutes: number;
  };
  alertsByType: { type: AlertType; count: number }[];
  hourlyPositions: { hour: number; count: number }[];
}

export interface MileageRow {
  key: string;
  label: string;
  km: number;
  ridingMin: number;
  replayedKm: number;
}

export interface ExceptionRow {
  type: string;
  count: number;
  unresolved: number;
}

export interface TimesheetRow {
  userId: string;
  userName: string;
  date: string;
  checkIn?: string | null;
  checkOut?: string | null;
  hoursWorked: number;
  status: AttendanceStatus;
  replayed: boolean;
}

export interface SyncSource {
  id: string;
  name: string;
  kind: 'sql' | 'rest' | 'csv';
  enabled: boolean;
  scheduleCron: string;
  lastRunAt?: string | null;
  webhookSecret?: string;
}

export interface SyncRun {
  id: string;
  sourceId: string;
  sourceName: string;
  startedAt: string;
  finishedAt?: string | null;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  triggeredBy: 'CRON' | 'MANUAL' | 'WEBHOOK';
}

export interface SyncIssue {
  id: string;
  runId: string;
  code: 'MISSING_PHONE' | 'UNKNOWN_SITE' | 'IDENTIFIER_COLLISION';
  externalId: string;
  name: string;
  detail: string;
  resolved: boolean;
  createdAt: string;
}

export interface SyncMatrixRow {
  source: string;
  field: string;
  lastSyncAt: string;
  freshnessMin: number;
  rows: number;
}

export interface NotificationLogEntry {
  id: string;
  alertId: string;
  alertType: AlertType;
  channel: 'push' | 'whatsapp' | 'socket';
  userId: string;
  userName: string;
  status: 'SENT' | 'PENDING' | 'FAILED' | 'NO_PROVIDER';
  attempts: number;
  at: string;
  error?: string | null;
}

export interface RuleSettings {
  maxSpeedKmh: number;
  stopAlertMin: number;
  stopRepeatMin: number;
  geofenceGraceS: number;
  speedingCriticalS: number;
  cooldownS: number;
  gapMinMin: number;
  shiftGraceMin: number;
  replayMaxAgeHours: number;
  attendanceStrictReject: boolean;
}

export interface NotificationPrefs {
  push: boolean;
  whatsapp: boolean;
  email: boolean;
  sound: boolean;
  types: AlertType[];
}

export interface SocketPositionUpdate {
  userId: string;
  lat: number;
  lng: number;
  speedKmh: number;
  motionState: MotionState;
  ts: string;
}

export interface SocketPresence {
  userId: string;
  online: boolean;
  tracking: boolean;
  gpsEnabled: boolean;
  dataEnabled?: boolean;
  lastSeen: string;
}

/** One `LeaveRequest` row as `GET /leave` returns it (CONTRACT §3). */
export interface LeaveRequestItem {
  id: string;
  employeeId: string;
  employeeName: string | null;
  employeeExternalId: string | null;
  kind: string | null;
  dateFrom: string;
  dateTo: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  requestedAt: string;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface LeaveListResponse {
  items: LeaveRequestItem[];
  total: number;
  page: number;
  pageSize: number;
  /** Queue size regardless of the active filter — the sidebar badge and the KPI card. */
  pendingCount: number;
}

export type ApiErrorCode =
  | 'FENCE_VIOLATION'
  | 'ALREADY_CHECKED_IN'
  | 'NO_OPEN_RECORD'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_ROLE_ADMIN'
  | 'FORBIDDEN_ROLE_SUPERVISOR'
  | `FORBIDDEN_ROLE:${string}`;
