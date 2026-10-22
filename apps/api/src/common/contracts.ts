import type { AlertType, MotionState, Role, Severity } from '../shared/constants';

/** طبقة الفصل بين الموديولات — التنفيذ في NotifyModule/RulesModule والحَقن بالـ token. */
export const ALERT_DISPATCHER = 'ALERT_DISPATCHER';
export const REALTIME_PUBLISHER = 'REALTIME_PUBLISHER';
export const GEOLINE_WORKER = 'GEOLINE_WORKER';

export interface RaiseAlertInput {
  type: AlertType;
  severity: Severity;
  employeeId: string;
  /** مستخدم التنبيه له شخصيًا (السواق/الموظف) — يُستخدم لـ notify:me و push الخاص به */
  targetUserId?: string;
  zoneId?: string;
  siteId?: string;
  title?: string;
  body?: string;
  meta: Record<string, unknown>;
  at?: Date;
  /** true لو التنبيه ناتج عن دفعة معاد بثها بعد أوف لاين */
  replayed?: boolean;
  /** تجاوز cooldown صراحةً (تصاعد الخطورة مثلًا) */
  force?: boolean;
}

export interface RaisedAlert {
  id: string;
  type: AlertType;
  severity: Severity;
  suppressed: boolean;
}

export interface AlertDispatcher {
  raise(input: RaiseAlertInput): Promise<RaisedAlert | undefined>;
}

/**
 * The enriched live item consumed by BOTH the HTTP `GET /positions/live`
 * envelope and the socket `position:update` event.
 *
 * Keying contract: the dashboard keys its live store / map markers by the EMPLOYEE id,
 * so `id` === `userId` === `employeeId` all resolve to the same value. The real login
 * user id (distinct from the employee id in the API) is intentionally NOT used as the
 * live key, otherwise the Live page driver cards never resolve to a position.
 */
export interface LivePosition {
  /** canonical live key — always the employee id. */
  id: string;
  /** dashboard live-store key (kept equal to `employeeId` so cards resolve). */
  userId: string;
  employeeId: string;
  name: string;
  /** alias of `name` for the map tooltip consumer (`userName`). */
  userName: string;
  externalId: string | null;
  kind: string | null;
  driver: boolean;
  lat: number;
  lng: number;
  speedKmh: number | null;
  motionState: MotionState;
  insideZone: boolean | null;
  ts: string;
  replayed: boolean;
  accuracy: number | null;
  battery: number | null;
  zoneId: string | null;
  zoneName: string | null;
  siteId: string | null;
  siteName: string | null;
  /** Login user id behind this employee — used only for socket room routing. */
  authUserId: string | null;
  // ---- device-health flags read from the Device row ingest already maintains ----
  online: boolean;
  tracking: boolean;
  gpsEnabled: boolean;
  dataEnabled: boolean;
  lastSeen: string | null;
}

/**
 * Internal per-employee realtime position the tracking cache holds. Enrichment
 * (device health + employee/geo metadata) is applied at the read/broadcast boundary
 * to produce a full `LivePosition`; keeping the cache lean avoids touching the
 * verified ingest path semantics.
 */
export interface LivePositionBase {
  employeeId: string;
  name: string;
  lat: number;
  lng: number;
  speedKmh: number | null;
  motionState: MotionState;
  insideZone: boolean | null;
  ts: string;
  replayed: boolean;
  accuracy: number | null;
}

export interface RealtimePublisher {
  position(p: LivePosition): void;
  alert(alertPayload: unknown, audience: { userIds: string[]; roles: Role[] }): void;
  attendance(p: { userId: string; kind: 'IN' | 'OUT'; status: string; ts: string }): void;
  presence(p: { userId: string; online: boolean; tracking: boolean; gpsEnabled: boolean; lastSeen: string }): void;
}

export interface FenceEvaluation {
  inside: boolean;
  fenceId?: string;
  fenceName?: string;
  distanceToCenterM: number;
}
