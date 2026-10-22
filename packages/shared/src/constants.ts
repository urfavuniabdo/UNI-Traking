/**
 * Shared contract constants — must stay in sync with:
 *  - docs/CONTRACT.md
 *  - apps/mobile/lib/core/traccer_constants.dart
 */

export const ROLES = {
  ADMIN: 'ADMIN',
  SUPERVISOR: 'SUPERVISOR',
  EMPLOYEE: 'EMPLOYEE',
  DRIVER: 'DRIVER',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

export const EMPLOYEE_KIND = { EMPLOYEE: 'EMPLOYEE', DRIVER: 'DRIVER' } as const;

export const ALERT_TYPES = [
  'GEOFENCE_EXIT',
  'GEOFENCE_ENTER',
  'CHECK_IN_OUT_OF_FENCE',
  'SPEEDING',
  'HARSH_BRAKING',
  'HARSH_ACCELERATION',
  'STOP_EXCEEDED',
  'GPS_OFF',
  'DATA_OFF',
  'APP_OFFLINE',
  'HEARTBEAT_MISSING',
  'BUFFER_REPLAYED',
  'CHECKOUT_MISSING',
  'ROUTE_GAP',
  'IDLE_LONG',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const SEVERITY = { INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' } as const;
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

export const ALERT_STATUS = { OPEN: 'OPEN', ACK: 'ACK', RESOLVED: 'RESOLVED' } as const;

export const MOTION_STATES = ['STOPPED', 'WALKING', 'RIDING', 'UNKNOWN'] as const;
export type MotionState = (typeof MOTION_STATES)[number];

/** Motion classifier — the single source of truth (mirrored in Dart). */
export const MOTION = {
  STATIONARY_SPEED_KMH: 1.5,
  WALK_MAX_KMH: 7.0,
  SPEED_EMA_ALPHA: 0.35,
  HYSTERESIS_SAMPLES: 3,
  ACCURACY_REJECT_M: 35,
  MIN_INTERVAL_S: 2,
  /**
   * Ceiling on any single GPS step — the same bound the absurd-jump guard rejects a sample with.
   * Distance aggregation uses it so a tunnel re-fix or a teleport between sites counts as a gap
   * instead of travelled ground (one teleport used to be able to add tens of km to a day).
   */
  MAX_CREDIBLE_SPEED_KMH: 250,
} as const;

export const RULE_DEFAULTS = {
  maxSpeedKmh: Number(process.env.DEFAULT_MAX_SPEED_KMH ?? 80),
  stopAlertMin: Number(process.env.STOP_ALERT_MIN ?? 30),
  geofenceGraceS: Number(process.env.GEOFENCE_GRACE_S ?? 120),
  speedSamples: 3,
  speedingCriticalS: 120,
  harshBrakingMs2: -2.2,
  harshAccelMs2: 2.8,
  cooldownS: Number(process.env.ALERT_COOLDOWN_S ?? 180),
  heartbeatIntervalS: Number(process.env.HEARTBEAT_INTERVAL_S ?? 300),
  heartbeatMissedCycles: 3,
  gapMinMin: 10,
  replayMaxAgeHours: Number(process.env.REPLAY_MAX_AGE_HOURS ?? 72),
  shiftGraceMin: Number(process.env.SHIFT_GRACE_MIN ?? 30),
  accuracyDriftM: 120,
  dedupeWindowS: 20,
} as const;

/** Which alerts the driver him/herself receives (واجهة السواق تبقى ضئيلة). */
export const DRIVER_VISIBLE_ALERTS: AlertType[] = [
  'GEOFENCE_EXIT',
  'SPEEDING',
  'STOP_EXCEEDED',
  'GPS_OFF',
  'DATA_OFF',
  'CHECK_IN_OUT_OF_FENCE',
  'CHECKOUT_MISSING',
];

export const SOCKET_EVENTS = {
  POSITION_UPDATE: 'position:update',
  ALERT_NEW: 'alert:new',
  ALERT_UPDATED: 'alert:updated',
  ATTENDANCE_CHANGED: 'attendance:changed',
  DRIVER_PRESENCE: 'driver:presence',
  NOTIFY_ME: 'notify:me',
  SUBSCRIBE_LIVE: 'subscribe:live',
  SUBSCRIBE_ROUTE: 'subscribe:route',
} as const;

export const GEO_EVENT_KINDS = [
  'GPS_OFF',
  'GPS_ON',
  'DATA_OFF',
  'DATA_ON',
  'APP_KILLED',
  'BUFFER_FLUSH',
  'HEARTBEAT_MISSING',
] as const;

export const ATTENDANCE_STATUS = {
  VALID: 'VALID',
  OUT_OF_FENCE: 'OUT_OF_FENCE',
  MISSING_CHECKOUT: 'MISSING_CHECKOUT',
  AUTO_CLOSED: 'AUTO_CLOSED',
} as const;

export const AR_ALERT_TEXT: Record<AlertType, { title: string; body: string }> = {
  GEOFENCE_EXIT: { title: 'خروج عن المنطقة المحددة', body: 'خرجت عن نطاق منطقتك المصرّح لك بها' },
  GEOFENCE_ENTER: { title: 'دخول المنطقة', body: 'عدت إلى نطاق منطقتك' },
  CHECK_IN_OUT_OF_FENCE: { title: 'بدء وردية خارج النطاق', body: 'بدأت ورديتك خارج النطاق المحدد' },
  SPEEDING: { title: 'تجاوز السرعة', body: 'السرعة أعلى من الحد المسموح في هذه المنطقة' },
  HARSH_BRAKING: { title: 'فرملة مفاجئة', body: 'تم رصد فرملة قوية مفاجئة' },
  HARSH_ACCELERATION: { title: 'تسارع مفاجئ', body: 'تم رصد تسارع قوي مفاجئ' },
  STOP_EXCEEDED: { title: 'توقف طويل', body: 'توقف تجاوز المدة المسموحة بدون إشعار' },
  GPS_OFF: { title: 'إيقاف الـ GPS', body: 'خدمة الموقع مقفلة والتتبع متوقف' },
  DATA_OFF: { title: 'إيقاف الداتا', body: 'الإنترنت مقطوع — يتم تخزين خط السير محليًا' },
  APP_OFFLINE: { title: 'التطبيق غير متصل', body: 'لم تصل بيانات من جهازك منذ فترة' },
  HEARTBEAT_MISSING: { title: 'انقطاع نبض الجهاز', body: 'الجهاز لم يرسل نبضًا في الموعد المحدد' },
  BUFFER_REPLAYED: { title: 'استعادة بيانات أوف لاين', body: 'تم رفع خط السير المخزّن محليًا وإظهاره كأنه لحظي' },
  CHECKOUT_MISSING: { title: 'إنهاء وردية غير مسجّل', body: 'انتهت الوردية ولم يتم تسجيل إنهاؤها' },
  ROUTE_GAP: { title: 'فجوة في خط السير', body: 'انقطاع في تسجيل المسار أثناء الرحلة' },
  IDLE_LONG: { title: 'سكون طويل', body: 'لم يتم رصد أي حركة لفترة طويلة' },
};

export const MOTION_STATE_AR: Record<MotionState, string> = {
  STOPPED: 'واقف',
  WALKING: 'ماشي',
  RIDING: 'في رحلة',
  UNKNOWN: 'غير معروف',
};
