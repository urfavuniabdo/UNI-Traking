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

  /// Golden-keyed view for the consistency test.
  static Map<String, Object> toGoldenMap() => <String, Object>{
        'STATIONARY_SPEED_KMH': stationarySpeedKmh,
        'WALK_MAX_KMH': walkMaxKmh,
        'SPEED_EMA_ALPHA': speedEmaAlpha,
        'HYSTERESIS_SAMPLES': hysteresisSamples,
        'ACCURACY_REJECT_M': accuracyRejectM,
        'MIN_INTERVAL_S': minIntervalS,
        'MAX_CREDIBLE_SPEED_KMH': maxCredibleSpeedKmh,
      };
}

/// Rules-engine defaults (mirrors RULE_DEFAULTS). Numbers are the .env fallbacks.
class RuleDefaults {
  const RuleDefaults._();

  static const double maxSpeedKmh = 80;
  static const int stopAlertMin = 30;
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

  static Map<String, Object> toGoldenMap() => <String, Object>{
        'maxSpeedKmh': maxSpeedKmh,
        'stopAlertMin': stopAlertMin,
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
    stopped: 'واقف',
    walking: 'ماشي',
    riding: 'في رحلة',
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

  static const Map<String, String> ar = <String, String>{
    pending: 'قيد المراجعة',
    approved: 'مقبولة',
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
      body: 'خرجت عن نطاق منطقتك المصرّح لك بها'
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
      title: 'إيقاف الـ GPS',
      body: 'خدمة الموقع مقفلة والتتبع متوقف'
    ),
    'DATA_OFF': (
      title: 'إيقاف الداتا',
      body: 'الإنترنت مقطوع — يتم تخزين خط السير محليًا'
    ),
    'APP_OFFLINE': (
      title: 'التطبيق غير متصل',
      body: 'لم تصل بيانات من جهازك منذ فترة'
    ),
    'HEARTBEAT_MISSING': (
      title: 'انقطاع نبض الجهاز',
      body: 'الجهاز لم يرسل نبضًا في الموعد المحدد'
    ),
    'BUFFER_REPLAYED': (
      title: 'استعادة بيانات أوف لاين',
      body: 'تم رفع خط السير المخزّن محليًا وإظهاره كأنه لحظي'
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
