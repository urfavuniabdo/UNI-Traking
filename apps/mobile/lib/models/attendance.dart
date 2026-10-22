import '../core/traccer_constants.dart';

/// Attendance record / check-in result (CONTRACT §3).
///
/// A check-in/out never 401s on OUT_OF_FENCE unless `strictReject=true` (then the
/// API returns 422 `FENCE_VIOLATION`). OUT_OF_FENCE is recorded with `exception: true`
/// and raises `CHECK_IN_OUT_OF_FENCE` for both sides.
class AttendanceResult {
  const AttendanceResult({
    required this.status,
    this.recordId,
    this.fenceName,
    this.distanceToCenterM,
    this.allowedFences = const <String>[],
    this.exception = false,
    this.replayed = false,
    this.checkInAt,
    this.checkOutAt,
  });

  final String status; // VALID | OUT_OF_FENCE (AttendanceStatus)
  final String? recordId;
  final String? fenceName;
  final double? distanceToCenterM;
  final List<String> allowedFences;
  final bool exception;
  final bool replayed;
  final DateTime? checkInAt;
  final DateTime? checkOutAt;

  bool get isValid => status == AttendanceStatus.valid;
  bool get isOutOfFence => status == AttendanceStatus.outOfFence;

  static AttendanceResult fromJson(Map<String, Object?> json) {
    final Object? fences = json['allowedFences'];
    return AttendanceResult(
      status: (json['status'] ?? AttendanceStatus.valid) as String,
      recordId: json['id'] as String? ?? json['recordId'] as String?,
      fenceName: json['fenceName'] as String?,
      distanceToCenterM: (json['distanceToCenterM'] as num?)?.toDouble(),
      allowedFences:
          fences is List ? fences.map((Object? e) => e.toString()).toList() : const <String>[],
      exception: (json['exception'] ?? false) as bool,
      replayed: (json['replayed'] ?? false) as bool,
      checkInAt: DateTime.tryParse((json['checkInAt'] ?? '') as String),
      checkOutAt: DateTime.tryParse((json['checkOutAt'] ?? '') as String),
    );
  }
}

/// A historical day row from `/attendance/me/today` and the history list.
class AttendanceDay {
  const AttendanceDay({
    required this.date,
    this.checkInAt,
    this.checkOutAt,
    this.status,
    this.exception = false,
    this.fenceName,
  });

  final DateTime date;
  final DateTime? checkInAt;
  final DateTime? checkOutAt;
  final String? status;
  final bool exception;
  final String? fenceName;

  static AttendanceDay fromJson(Map<String, Object?> json) => AttendanceDay(
        date: DateTime.tryParse((json['date'] ?? json['checkInAt'] ?? '') as String) ??
            DateTime.now(),
        checkInAt: DateTime.tryParse((json['checkInAt'] ?? '') as String),
        checkOutAt: DateTime.tryParse((json['checkOutAt'] ?? '') as String),
        status: json['status'] as String?,
        exception: (json['exception'] ?? false) as bool,
        fenceName: json['fenceName'] as String?,
      );
}

/// "Today" snapshot: the current open record + live state (drives the home screen).
class TodayState {
  const TodayState({
    required this.isCheckedIn,
    this.record,
    this.fenceName,
    this.insideFence,
  });

  final bool isCheckedIn;
  final AttendanceDay? record;
  final String? fenceName;
  final bool? insideFence; // null = unknown / not yet computed

  static const TodayState notCheckedIn =
      TodayState(isCheckedIn: false);

  static TodayState fromJson(Map<String, Object?> json) {
    final Object? rec = json['record'] ?? json;
    final bool checkedIn = (json['isCheckedIn'] ??
            json['checkedIn'] ??
            (rec is Map && rec['checkOutAt'] == null && rec['checkInAt'] != null)) as bool;
    return TodayState(
      isCheckedIn: checkedIn,
      record: rec is Map<String, Object?>
          ? AttendanceDay.fromJson(rec)
          : null,
      fenceName: json['fenceName'] as String?,
      insideFence: json['insideFence'] as bool?,
    );
  }
}
