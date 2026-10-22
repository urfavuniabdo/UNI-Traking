import 'dart:convert';

/// Alert payload exactly as `packages/shared` `AlertPayload` (CONTRACT §6/§7).
/// The driver only receives the subset in `DriverVisibleAlerts.all`.
class TraccerAlert {
  const TraccerAlert({
    required this.id,
    required this.type,
    required this.severity,
    required this.userId,
    required this.userName,
    required this.title,
    required this.body,
    required this.createdAt,
    required this.status,
    this.phone,
    this.orgUnitId,
    this.zoneId,
    this.siteId,
    this.ackBy,
    this.ackAt,
    this.meta = const <String, Object?>{},
    this.channelPush = false,
    this.channelSocket = false,
  });

  final String id;
  final String type;
  final String severity; // INFO | WARNING | CRITICAL
  final String userId;
  final String userName;
  final String title;
  final String body;
  final DateTime createdAt;
  final String status; // OPEN | ACK | RESOLVED

  final String? phone;
  final String? orgUnitId;
  final String? zoneId;
  final String? siteId;
  final String? ackBy;
  final DateTime? ackAt;

  /// meta = { lat, lng, speedKmh?, stopDurationS?, threshold?, offlineSince?, bufferCount? }
  final Map<String, Object?> meta;
  final bool channelPush;
  final bool channelSocket;

  double? get lat => (meta['lat'] as num?)?.toDouble();
  double? get lng => (meta['lng'] as num?)?.toDouble();

  bool get isCritical => severity == 'CRITICAL';

  static TraccerAlert fromJson(Map<String, Object?> json) {
    final Object? channel = json['channel'];
    return TraccerAlert(
      id: (json['id'] ?? '') as String,
      type: (json['type'] ?? '') as String,
      severity: (json['severity'] ?? 'INFO') as String,
      userId: (json['userId'] ?? '') as String,
      userName: (json['userName'] ?? '') as String,
      title: (json['title'] ?? '') as String,
      body: (json['body'] ?? '') as String,
      createdAt: DateTime.tryParse((json['createdAt'] ?? '') as String) ?? DateTime.now().toUtc(),
      status: (json['status'] ?? 'OPEN') as String,
      phone: json['phone'] as String?,
      orgUnitId: json['orgUnitId'] as String?,
      zoneId: json['zoneId'] as String?,
      siteId: json['siteId'] as String?,
      ackBy: json['ackBy'] as String?,
      ackAt: DateTime.tryParse((json['ackAt'] ?? '') as String),
      meta: json['meta'] is Map<String, Object?>
          ? Map<String, Object?>.from(json['meta'] as Map)
          : const <String, Object?>{},
      channelPush: channel is Map ? (channel['push'] ?? false) as bool : false,
      channelSocket: channel is Map ? (channel['socket'] ?? false) as bool : false,
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'type': type,
        'severity': severity,
        'userId': userId,
        'userName': userName,
        'phone': phone,
        'orgUnitId': orgUnitId,
        'zoneId': zoneId,
        'siteId': siteId,
        'title': title,
        'body': body,
        'createdAt': createdAt.toUtc().toIso8601String(),
        'status': status,
        'ackBy': ackBy,
        'ackAt': ackAt?.toUtc().toIso8601String(),
        'meta': meta,
        'channel': <String, Object?>{'push': channelPush, 'socket': channelSocket},
      };

  @override
  String toString() => jsonEncode(toJson());
}

/// Socket `notify:me` payload (CONTRACT §7) — self-alert for the driver/employee.
class NotifyMePayload {
  const NotifyMePayload({required this.title, required this.body, required this.alertType});

  final String title;
  final String body;
  final String alertType;

  static NotifyMePayload fromJson(Map<String, Object?> json) => NotifyMePayload(
        title: (json['title'] ?? '') as String,
        body: (json['body'] ?? '') as String,
        alertType: (json['alertType'] ?? '') as String,
      );
}
