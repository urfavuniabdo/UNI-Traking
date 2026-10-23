import '../core/traccer_constants.dart';

/// Own leave request (CONTRACT §3 `/leave*`) — the requester sees the same fields the
/// HR desk acts on, including who decided and what note they left.
class LeaveRequest {
  const LeaveRequest({
    required this.id,
    required this.dateFrom,
    required this.dateTo,
    required this.days,
    required this.status,
    this.reason,
    this.requestedAt,
    this.decidedByName,
    this.decidedAt,
    this.decisionNote,
  });

  final String id;
  final String dateFrom; // YYYY-MM-DD work-day key, exactly as AttendanceRecord stores it
  final String dateTo;
  final int days;
  final String status; // LeaveStatus
  final String? reason;
  final DateTime? requestedAt;
  final String? decidedByName;
  final DateTime? decidedAt;
  final String? decisionNote;

  bool get isPending => status == LeaveStatus.pending;

  static LeaveRequest fromJson(Map<String, Object?> json) {
    final String from = (json['dateFrom'] ?? '') as String;
    return LeaveRequest(
      id: (json['id'] ?? '') as String,
      dateFrom: from,
      dateTo: (json['dateTo'] ?? from) as String,
      days: (json['days'] as num?)?.toInt() ?? 1,
      status: (json['status'] ?? LeaveStatus.pending) as String,
      reason: json['reason'] as String?,
      requestedAt: DateTime.tryParse((json['requestedAt'] ?? '') as String),
      decidedByName: json['decidedByName'] as String?,
      decidedAt: DateTime.tryParse((json['decidedAt'] ?? '') as String),
      decisionNote: json['decisionNote'] as String?,
    );
  }
}

/// The `/leave/mine` envelope.
class LeavePage {
  const LeavePage({required this.items, this.total = 0, this.pendingCount = 0});

  final List<LeaveRequest> items;
  final int total;
  final int pendingCount;

  static const LeavePage empty = LeavePage(items: <LeaveRequest>[]);

  static LeavePage fromJson(Map<String, Object?> json) {
    final Object? rows = json['items'];
    return LeavePage(
      items: rows is List
          ? rows.whereType<Map<String, Object?>>().map(LeaveRequest.fromJson).toList(growable: false)
          : const <LeaveRequest>[],
      total: (json['total'] as num?)?.toInt() ?? 0,
      pendingCount: (json['pendingCount'] as num?)?.toInt() ?? 0,
    );
  }
}
