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

export interface LivePosition {
  userId: string;
  employeeId: string;
  name: string;
  lat: number;
  lng: number;
  speedKmh: number | null;
  motionState: MotionState;
  insideZone: boolean | null;
  ts: string;
  replayed: boolean;
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
