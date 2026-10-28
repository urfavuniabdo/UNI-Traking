/**
 * Shared contract constants — must stay in sync with:
 *  - docs/CONTRACT.md
 *  - apps/mobile/lib/core/traccer_constants.dart
 */

export const ROLES = {
  /** IT Admin — يرى كل شيء: دوره تشخيص لا صلاحيات. */
  ADMIN: 'ADMIN',
  /** Tracking Admin — حركة السواقين وتنبيهاتها فقط. */
  SUPERVISOR: 'SUPERVISOR',
  /** HR Admin — حضور وانصراف وأقسام وإعدادات وإجازات؛ لا رحلات ولا مراقبة حية. */
  HR: 'HR',
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
  'HELP_REQUESTED',
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
  /**
   * A phone does not walk — it drifts. Standing still in a city, the fix wandered 40 m out and back
   * inside 7 minutes (net displacement: 1.4 m) while the point-to-point steps read 5-15 km/h, and the
   * driver was shown as ماشي without moving his feet. So movement is judged on the NET displacement
   * of a window of recent fixes — the mean of its older half to the mean of its newer half:
   *  - MAX_NET_WINDOW_S: the window slides so a long silence cannot dilute a real walk away. 90 s is
   *    the measured sweet spot: a 4.8 km/h walk still confirms 25 s after he starts, while a driver
   *    who stops carries no walk evidence for even one fix longer.
   *  - MOVED_CIRCLE_FACTOR: the net must clear this many accuracy circles (of the mean pair, which
   *    shrinks with the square root of the fixes averaged), because 12 m of "accuracy" on a parked
   *    phone is really 20-40 m of wander. Anything inside that bubble is subtracted out of his
   *    speed, so a driver who never leaves it reads 0 km/h and STOPPED.
   *  - MIN_NET_SAMPLES: below this many fixes the wander is not averaged enough to tell a 3 km/h
   *    drift burst from a 3 km/h walk, so an immature window may only prove a VEHICLE (net above
   *    WALK_MAX_KMH) — never a walk. Measured on his own two uploads: 0 of his standing and pacing
   *    bursts read as a move, and a real walk is on the board 25 s after his first step.
   */
  MAX_NET_WINDOW_S: 90,
  MOVED_CIRCLE_FACTOR: 2,
  MIN_NET_SAMPLES: 6,
  /**
   * A window is never allowed to starve below this many fixes. Sliding it strictly on time left a
   * driver who stops reporting every 90 s (a phone dozing after he sat down) with a single fix: the
   * coordinates had no opinion, so stationarity was never *proven*, hysteresis needed three
   * disagreeing samples, and he stayed RIDING for the rest of the day — two fixes 105 and 258 s
   * apart 10 m from each other being the clearest evidence of standing there is. The time slide
   * keeps the newest fixes and the pair survives, and the stationary allowance grows with the span.
   */
  MIN_WINDOW_FIXES: 2,
  /**
   * How long an *immature* move must hold before it may state a driver who is standing still.
   * Telematics rules state their conditions as a duration ("faster than X **for more than 5 s**"),
   * and a phone that dozed and woke with a cached position from the other side of the city produces
   * exactly one fast, confident, false sample — with the window starved by 105-258 s fix gaps, the
   * vehicle-proof path was the only one left open to it. One extra sample at the device's own cadence
   * is what that costs a driver who really set off, which is why the clock is not longer.
   * A window that already averaged MIN_NET_SAMPLES fixes of one-direction travel *is* sustained
   * evidence and states him at once.
   */
  MOVE_CONFIRM_S: 15,
  /**
   * The first minute of a tracking session is not ground. A receiver waking from cold reports a
   * solution that is internally consistent (tight claimed accuracy, plausible Doppler, zero steps)
   * while its positions wander — a driver standing at home since check-in produced 58 s of fixes
   * that zig-zagged ~150 m around a spot 950 m from where he actually was, and every guard passed
   * because the fiction never contradicted itself. The fixes stay stored and replayable, but they
   * found no place in the trace, no line, no mileage and no stop anchor. 60 s covers a cold start;
   * the first real fix usually lands inside it and everything after is ground as usual.
   */
  CONVERGENCE_WARMUP_S: 60,
  /**
   * The largest speed change consecutive fixes may demand and still be ground. The ceiling sits at
   * 0.6 g: a real vehicle hard-braked from 50 km/h to a stop in two seconds is ~7 m/s² and every
   * telematics platform believes that, so anything below it stays his speed. What it refuses is the
   * receiver waking up — a driver standing in his apartment produced 0.9 → 77 → 136 → 12.9 km/h
   * inside 16 s, with reported accelerations up to 8.1 m/s², every one of them internally consistent
   * and none of it ground. Steps above the ceiling keep the previous speed: noise, not motion.
   */
  MAX_ACCEL_MS2: 6.0,
  /**
   * Steps per minute that prove feet on the ground. No GPS reading can separate a man walking in
   * place from a man riding, and every production classifier settles it from the IMU instead
   * (walking is a 0.5-3 Hz oscillation of ~1.5-2 m/s²). At this rate or above the phone's owner is
   * on foot: the state may be WALKING, never RIDING, whatever speed the fix suggests.
   */
  STEPS_PER_MIN_ON_FOOT: 12,
  /**
   * Acceleration variance (m/s²) under which the phone itself says «nothing is moving me». Every
   * fleet device decides motion from the accelerometer for the same reason the GPS cannot be trusted
   * alone at the worst moment: when a receiver wakes from a long idle it delivers a solution that is
   * internally consistent — position, Doppler and bearing all agreeing with each other — and simply
   * fictional (2026-10-26: 33 fixes, 137 km/h, 1.9 km of route, all of it inside a living room). A
   * device lying flat measures 0.01-0.05; a car on any road never drops below a few tenths, and a
   * walking hand 1-2. Devices with no sensor samples send null and are judged on the ground alone.
   */
  STILL_ENERGY_MS2: 0.12,
} as const;

export const RULE_DEFAULTS = {
  maxSpeedKmh: Number(process.env.DEFAULT_MAX_SPEED_KMH ?? 80),
  stopAlertMin: Number(process.env.STOP_ALERT_MIN ?? 30),
  /** While the driver keeps standing, the STOP_EXCEEDED page re-fires every this-many minutes
   *  (0 = one page per stop). Counted from the stop itself: threshold 2 + repeat 5 → pages at
   *  2, 7, 12… each stating the total standing time. A general setting — not a per-driver one. */
  stopRepeatMin: Number(process.env.STOP_REPEAT_MIN ?? 5),
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
  /** A speed condition must hold this long (seconds) before it pages the supervisor (Geotab-style). */
  speedingHoldS: Number(process.env.SPEEDING_HOLD_S ?? 5),
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
  'HELP_REQUESTED',
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
  /** يوم مُغطّى بإجازة معتمدة — صف مُولّد في التقارير، لا سجل حضور. */
  LEAVE: 'LEAVE',
} as const;

/** LeaveRequest.status — طلب الموظف/السواق وموافقة الـ HR. */
export const LEAVE_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;
export type LeaveStatus = (typeof LEAVE_STATUS)[keyof typeof LEAVE_STATUS];

export const AR_ALERT_TEXT: Record<AlertType, { title: string; body: string }> = {
  GEOFENCE_EXIT: { title: 'خروج عن المنطقة المحددة', body: 'خرجت عن نطاق المنطقة المصرّح لك بها' },
  GEOFENCE_ENTER: { title: 'دخول المنطقة', body: 'عدت إلى نطاق منطقتك' },
  CHECK_IN_OUT_OF_FENCE: { title: 'بدء اليوم خارج النطاق', body: 'بدأت يومك خارج النطاق المحدد' },
  SPEEDING: { title: 'تجاوز السرعة', body: 'السرعة أعلى من الحد المسموح في هذه المنطقة' },
  HARSH_BRAKING: { title: 'فرملة مفاجئة', body: 'تم رصد فرملة قوية مفاجئة' },
  HARSH_ACCELERATION: { title: 'تسارع مفاجئ', body: 'تم رصد تسارع قوي مفاجئ' },
  STOP_EXCEEDED: { title: 'توقف طويل', body: 'توقف تجاوز المدة المسموحة بدون إشعار' },
  GPS_OFF: { title: 'إيقاف خدمة تحديد الموقع', body: 'خدمة تحديد الموقع مغلقة والتتبع متوقف' },
  DATA_OFF: { title: 'انقطاع الاتصال بالإنترنت', body: 'لا يوجد اتصال بالإنترنت — يُحفظ خط السير محليًا' },
  APP_OFFLINE: { title: 'انقطاع اتصال التطبيق', body: 'لم تصل بيانات من جهازك منذ فترة' },
  HEARTBEAT_MISSING: { title: 'انقطاع نبض الجهاز', body: 'الجهاز لم يرسل نبضًا في الموعد المحدد' },
  BUFFER_REPLAYED: {
    title: 'إعادة إرسال البيانات المحفوظة',
    body: 'تم رفع خط السير المحفوظ في الجهاز وعرضه بتوقيته الأصلي',
  },
  CHECKOUT_MISSING: { title: 'إنهاء اليوم غير مسجّل', body: 'انتهى اليوم ولم يتم تسجيل إنهاؤه' },
  ROUTE_GAP: { title: 'فجوة في خط السير', body: 'انقطاع في تسجيل المسار أثناء الرحلة' },
  IDLE_LONG: { title: 'سكون طويل', body: 'لم يتم رصد أي حركة لفترة طويلة' },
  HELP_REQUESTED: {
    title: 'طلب مساعدة طارئة',
    body: 'السائق يطلب مساعدة طارئة — يرجى التواصل معه فورًا',
  },
};

export const MOTION_STATE_AR: Record<MotionState, string> = {
  STOPPED: 'متوقف',
  WALKING: 'يسير',
  RIDING: 'أثناء القيادة',
  UNKNOWN: 'غير معروف',
};
