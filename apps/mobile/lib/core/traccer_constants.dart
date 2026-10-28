// EXACT mirror of `packages/shared/src/constants.ts` (the single source of truth).
//
//   DO NOT edit a value here without editing the TS file too.
//   CI/local check: `node tools/generate_constants_golden.mjs` regenerates
//   `packages/shared/golden/constants.json`, and
//   `apps/mobile/test/constants_golden_test.dart` fails if this Dart file and the
//   golden JSON disagree. That keeps the Flutter classifier honest without a TS build.
//
// Contract reference: docs/CONTRACT.md §5 (motion constants), §2 (devices/heartbeat/toggle),
// §6 (alert types), §7 (socket events).
//
// ignore_for_file: constant_identifier_names

/// Motion classifier constants (CONTRACT §5). Must match MOTION in constants.ts.
class Motion {
  const Motion._();

  static const double stationarySpeedKmh = 1.5; // STOPPED ceiling
  static const double walkMaxKmh = 7.0; // WALKING ceiling, RIDING floor
  static const double speedEmaAlpha = 0.35; // EMA smoothing factor
  static const int hysteresisSamples = 3; // samples before a transition commits
  static const double accuracyRejectM = 35.0; // points worse than this are dropped/UNKNOWN
  static const int minIntervalS = 2; // min seconds between accepted fixes
  static const int maxCredibleSpeedKmh = 250; // ceiling on one GPS step; teleports count as 0 km

  /// §5 net-window movement proof (mirrors MOTION in `packages/shared/src/constants.ts`).
  static const int maxNetWindowS = 90; // the window of fixes the net displacement is measured over (a 120 s window keeps replaying old walk evidence after he stops)
  static const double movedCircleFactor = 2; // accuracy circles the net must clear to count as a move
  static const int minNetSamples = 6; // below this a window can only prove a vehicle, never a walk
  static const int minWindowFixes = 2; // under this the coordinates have no opinion at all
  static const int moveConfirmS = 15; // a standing driver leaves «واقف» only once the move has held this long
  static const int convergenceWarmupS = 60; // the day's first minute is receiver warm-up: stored, but not ground (server-side)
  static const double maxAccelMs2 = 6; // grip ceiling: a jump past this is a relocated fix, not a driver

  /// §5 the phone's own motion evidence (mirrors MOTION.STEPS_PER_MIN_ON_FOOT / STILL_ENERGY_MS2).
  static const int stepsPerMinOnFoot = 12; // at this cadence his feet are on the ground — never RIDING
  static const double stillEnergyMs2 = 0.12; // acceleration variance under which nothing moved the device

  /// Golden-keyed view for the consistency test.
  static Map<String, Object> toGoldenMap() => <String, Object>{
        'STATIONARY_SPEED_KMH': stationarySpeedKmh,
        'WALK_MAX_KMH': walkMaxKmh,
        'SPEED_EMA_ALPHA': speedEmaAlpha,
        'HYSTERESIS_SAMPLES': hysteresisSamples,
        'ACCURACY_REJECT_M': accuracyRejectM,
        'MIN_INTERVAL_S': minIntervalS,
        'MAX_CREDIBLE_SPEED_KMH': maxCredibleSpeedKmh,
        'MAX_NET_WINDOW_S': maxNetWindowS,
        'MOVED_CIRCLE_FACTOR': movedCircleFactor,
        'MIN_NET_SAMPLES': minNetSamples,
        'MIN_WINDOW_FIXES': minWindowFixes,
        'MOVE_CONFIRM_S': moveConfirmS,
        'CONVERGENCE_WARMUP_S': convergenceWarmupS,
        'MAX_ACCEL_MS2': maxAccelMs2,
        'STEPS_PER_MIN_ON_FOOT': stepsPerMinOnFoot,
        'STILL_ENERGY_MS2': stillEnergyMs2,
      };
}

/// Rules-engine defaults (mirrors RULE_DEFAULTS). Numbers are the .env fallbacks.
class RuleDefaults {
  const RuleDefaults._();

  static const double maxSpeedKmh = 80;
  static const int stopAlertMin = 30;
  static const int stopRepeatMin = 5; // a standing driver is re-paged on this cadence (§6)
  static const int geofenceGraceS = 120;
  static const int speedSamples = 3;
  static const int speedingCriticalS = 120;
  static const double harshBrakingMs2 = -2.2;
  static const double harshAccelMs2 = 2.8;
  static const int cooldownS = 180;
  static const int heartbeatIntervalS = 300; // device heartbeat cadence (§2)
  static const int heartbeatMissedCycles = 3;
  static const int gapMinMin = 10;
  static const int replayMaxAgeHours = 72;
  static const int shiftGraceMin = 30;
  static const double accuracyDriftM = 120;
  static const int dedupeWindowS = 20;
  static const int speedingHoldS = 5; // §6: speeding is raised only once it held this long

  static Map<String, Object> toGoldenMap() => <String, Object>{
        'maxSpeedKmh': maxSpeedKmh,
        'stopAlertMin': stopAlertMin,
        'stopRepeatMin': stopRepeatMin,
        'geofenceGraceS': geofenceGraceS,
        'speedSamples': speedSamples,
        'speedingCriticalS': speedingCriticalS,
        'harshBrakingMs2': harshBrakingMs2,
        'harshAccelMs2': harshAccelMs2,
        'cooldownS': cooldownS,
        'heartbeatIntervalS': heartbeatIntervalS,
        'heartbeatMissedCycles': heartbeatMissedCycles,
        'gapMinMin': gapMinMin,
        'replayMaxAgeHours': replayMaxAgeHours,
        'shiftGraceMin': shiftGraceMin,
        'accuracyDriftM': accuracyDriftM,
        'dedupeWindowS': dedupeWindowS,
        'speedingHoldS': speedingHoldS,
      };
}

/// Motion states (CONTRACT §5) — order matters for the golden comparison.
class MotionStates {
  const MotionStates._();

  static const String stopped = 'STOPPED';
  static const String walking = 'WALKING';
  static const String riding = 'RIDING';
  static const String unknown = 'UNKNOWN';

  static const List<String> all = <String>[stopped, walking, riding, unknown];

  static const Map<String, String> ar = <String, String>{
    stopped: 'متوقف',
    walking: 'يسير',
    riding: 'أثناء القيادة',
    unknown: 'غير معروف',
  };
}

/// Every alert type in the contract (§6). Order matters for the golden.
class AlertTypes {
  const AlertTypes._();

  static const List<String> all = <String>[
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
  ];
}

/// Alert types a driver him/herself receives (DRIVER_VISIBLE_ALERTS).
class DriverVisibleAlerts {
  const DriverVisibleAlerts._();

  static const List<String> all = <String>[
    'GEOFENCE_EXIT',
    'SPEEDING',
    'STOP_EXCEEDED',
    'GPS_OFF',
    'DATA_OFF',
    'CHECK_IN_OUT_OF_FENCE',
    'CHECKOUT_MISSING',
    'HELP_REQUESTED',
  ];
}

/// Device toggle/geo-event kinds (CONTRACT §2 toggle-event + §6).
class GeoEventKinds {
  const GeoEventKinds._();

  static const List<String> all = <String>[
    'GPS_OFF',
    'GPS_ON',
    'DATA_OFF',
    'DATA_ON',
    'APP_KILLED',
    'BUFFER_FLUSH',
    'HEARTBEAT_MISSING',
  ];
}

class Severity {
  const Severity._();

  static const List<String> all = <String>['INFO', 'WARNING', 'CRITICAL'];
}

class Roles {
  const Roles._();

  static const List<String> all = <String>[
    'ADMIN',
    'SUPERVISOR',
    'HR',
    'EMPLOYEE',
    'DRIVER'
  ];

  static const String admin = 'ADMIN';
  static const String supervisor = 'SUPERVISOR';
  static const String hr = 'HR';
  static const String employee = 'EMPLOYEE';
  static const String driver = 'DRIVER';
}

class AttendanceStatus {
  const AttendanceStatus._();

  static const String valid = 'VALID';
  static const String outOfFence = 'OUT_OF_FENCE';
  static const String missingCheckout = 'MISSING_CHECKOUT';
  static const String autoClosed = 'AUTO_CLOSED';
  static const String leave = 'LEAVE';

  static const List<String> all = <String>[
    valid,
    outOfFence,
    missingCheckout,
    autoClosed,
    leave,
  ];
}

/// LeaveRequest statuses (mirrors LEAVE_STATUS) — not in the golden file.
class LeaveStatus {
  const LeaveStatus._();

  static const String pending = 'PENDING';
  static const String approved = 'APPROVED';
  static const String rejected = 'REJECTED';
  static const String cancelled = 'CANCELLED';

  static const List<String> all = <String>[
    pending,
    approved,
    rejected,
    cancelled,
  ];

  /// Same Arabic the dashboard HR queue uses, so a requester and the person deciding
  /// read one wording for one status.
  static const Map<String, String> ar = <String, String>{
    pending: 'بانتظار القرار',
    approved: 'معتمدة',
    rejected: 'مرفوضة',
    cancelled: 'ملغاة',
  };
}

/// Arabic alert copy (mirrors AR_ALERT_TEXT). Keyed by alert type.
class ArAlertText {
  const ArAlertText._();

  static const Map<String, ({String title, String body})> byType =
      <String, ({String title, String body})>{
    'GEOFENCE_EXIT': (
      title: 'خروج عن المنطقة المحددة',
      body: 'خرجت عن نطاق المنطقة المصرّح لك بها'
    ),
    'GEOFENCE_ENTER': (title: 'دخول المنطقة', body: 'عدت إلى نطاق منطقتك'),
    'CHECK_IN_OUT_OF_FENCE': (
      title: 'بدء اليوم خارج النطاق',
      body: 'بدأت يومك خارج النطاق المحدد'
    ),
    'SPEEDING': (
      title: 'تجاوز السرعة',
      body: 'السرعة أعلى من الحد المسموح في هذه المنطقة'
    ),
    'HARSH_BRAKING': (title: 'فرملة مفاجئة', body: 'تم رصد فرملة قوية مفاجئة'),
    'HARSH_ACCELERATION': (title: 'تسارع مفاجئ', body: 'تم رصد تسارع قوي مفاجئ'),
    'STOP_EXCEEDED': (
      title: 'توقف طويل',
      body: 'توقف تجاوز المدة المسموحة بدون إشعار'
    ),
    'GPS_OFF': (
      title: 'إيقاف خدمة تحديد الموقع',
      body: 'خدمة تحديد الموقع مغلقة والتتبع متوقف'
    ),
    'DATA_OFF': (
      title: 'انقطاع الاتصال بالإنترنت',
      body: 'لا يوجد اتصال بالإنترنت — يُحفظ خط السير محليًا'
    ),
    'APP_OFFLINE': (
      title: 'انقطاع اتصال التطبيق',
      body: 'لم تصل بيانات من جهازك منذ فترة'
    ),
    'HEARTBEAT_MISSING': (
      title: 'انقطاع نبض الجهاز',
      body: 'الجهاز لم يرسل نبضًا في الموعد المحدد'
    ),
    'BUFFER_REPLAYED': (
      title: 'إعادة إرسال البيانات المحفوظة',
      body: 'تم رفع خط السير المحفوظ في الجهاز وعرضه بتوقيته الأصلي'
    ),
    'CHECKOUT_MISSING': (
      title: 'إنهاء اليوم غير مسجّل',
      body: 'انتهى اليوم ولم يتم تسجيل إنهاؤه'
    ),
    'ROUTE_GAP': (
      title: 'فجوة في خط السير',
      body: 'انقطاع في تسجيل المسار أثناء الرحلة'
    ),
    'IDLE_LONG': (title: 'سكون طويل', body: 'لم يتم رصد أي حركة لفترة طويلة'),
    'HELP_REQUESTED': (
      title: 'طلب مساعدة طارئة',
      body: 'السائق يطلب مساعدة طارئة — يرجى التواصل معه فورًا'
    ),
  };

  static Map<String, Object> toGoldenMap() => byType.map<String, Object>(
        (k, v) => MapEntry<String, Object>(k, <String, Object>{'title': v.title, 'body': v.body}),
      );
}

/// Socket event names (CONTRACT §7).
class SocketEvents {
  const SocketEvents._();

  static const String positionUpdate = 'position:update';
  static const String alertNew = 'alert:new';
  static const String alertUpdated = 'alert:updated';
  static const String attendanceChanged = 'attendance:changed';
  static const String driverPresence = 'driver:presence';
  static const String notifyMe = 'notify:me';
  static const String subscribeLive = 'subscribe:live';
  static const String subscribeRoute = 'subscribe:route';

  /// Handshake outcomes. A bad token still *connects* — the server then sends [rtError] and
  /// disconnects with "io server disconnect", which the client never auto-retries.
  static const String rtReady = 'rt:ready';
  static const String rtError = 'rt:error';
}

/// Buffer / ingest tuning that lives only on the client (CONTRACT §4, §5).
class Buffer {
  const Buffer._();

  /// Max positions per `/positions/batch` request (contract hard cap).
  static const int maxBatch = 500;
  /// A sane in-flight batch size, comfortably under the 500 cap.
  static const int takeBatchDefault = 300;
  /// Hard ceiling on rows we keep; oldest evicted first (mirrors traccar-client-android).
  static const int maxRows = 20000;
  /// Drain cadence when online.
  static const Duration drainInterval = Duration(seconds: 30);
}

/// Throws/asserts if any motion threshold disagrees with the expected golden invariants.
/// Used both as a runtime guard and from `test/constants_golden_test.dart`.
void assertMotionThresholdsConsistent() {
  assert(
    Motion.stationarySpeedKmh < Motion.walkMaxKmh,
    'STOPPED ceiling must be below WALKING ceiling',
  );
  assert(
    Motion.walkMaxKmh <= RuleDefaults.maxSpeedKmh,
    'WALKING ceiling must not exceed the max speed rule',
  );
  assert(Motion.hysteresisSamples >= 1, 'hysteresis needs at least one sample');
  assert(Motion.accuracyRejectM > 0, 'accuracy reject threshold must be positive');
  assert(Motion.speedEmaAlpha > 0 && Motion.speedEmaAlpha < 1, 'EMA alpha must be in (0,1)');
}
