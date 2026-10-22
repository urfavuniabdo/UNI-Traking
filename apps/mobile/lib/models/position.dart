import 'dart:convert';

import '../core/traccer_constants.dart';

/// A single position fix. Mirrors a row of the `positions` DAO table AND the
/// CONTRACT §4 `/positions/batch` `positions[]` item.
///
/// `clientTs` is the capture time on the device (the idempotency anchor). When a
/// row is uploaded after a reconnect we set `buffered = true` and keep the ORIGINAL
/// `clientTs` so the server replays it "as if realtime" (dedup-safe).
class TrackPosition {
  const TrackPosition({
    required this.clientTs,
    required this.lat,
    required this.lng,
    required this.speedKmh,
    required this.bearing,
    required this.accuracyM,
    required this.altitudeM,
    required this.batteryPct,
    required this.provider,
    required this.buffered,
    required this.seq,
    this.uploaded = false,
    this.motionState,
    this.id,
  });

  final DateTime clientTs;
  final double lat;
  final double lng;
  final double speedKmh;
  final double bearing;
  final double accuracyM;
  final double altitudeM;
  final int batteryPct;
  final String provider; // "gps" | "network" | "fused"
  final bool buffered; // true when uploaded after a reconnect
  final int seq; // monotonic client sequence — UNIQUE dedupe key in the DAO
  final bool uploaded;
  final String? motionState; // STOPPED/WALKING/RIDING/UNKNOWN
  final int? id; // sqflite rowid

  /// Dedup key tuple per CONTRACT §4: `(clientTs, lat, lng)` (+ `batchSeq` per device).
  String dedupeKey() =>
      '${clientTs.toUtc().toIso8601String()}|${lat.toStringAsFixed(6)}|${lng.toStringAsFixed(6)}';

  TrackPosition copyWith({bool? buffered, bool? uploaded, String? motionState, int? id}) =>
      TrackPosition(
        clientTs: clientTs,
        lat: lat,
        lng: lng,
        speedKmh: speedKmh,
        bearing: bearing,
        accuracyM: accuracyM,
        altitudeM: altitudeM,
        batteryPct: batteryPct,
        provider: provider,
        buffered: buffered ?? this.buffered,
        seq: seq,
        uploaded: uploaded ?? this.uploaded,
        motionState: motionState ?? this.motionState,
        id: id ?? this.id,
      );

  /// DAO row map. Column names match `position_dao.dart`'s schema exactly.
  Map<String, Object?> toRow() => <String, Object?>{
        if (id != null) 'id': id,
        'clientTs': clientTs.toUtc().millisecondsSinceEpoch,
        'lat': lat,
        'lng': lng,
        'speedKmh': speedKmh,
        'bearing': bearing,
        'accuracyM': accuracyM,
        'altitudeM': altitudeM,
        'batteryPct': batteryPct,
        'provider': provider,
        'buffered': buffered ? 1 : 0,
        'seq': seq,
        'uploaded': uploaded ? 1 : 0,
        'motionState': motionState,
      };

  static TrackPosition fromRow(Map<String, Object?> r) => TrackPosition(
        id: (r['id'] as int?) ?? (r['seq'] as int?),
        clientTs: DateTime.fromMillisecondsSinceEpoch(
          (r['clientTs'] as int?) ?? 0,
          isUtc: true,
        ),
        lat: (r['lat'] as num?)?.toDouble() ?? 0,
        lng: (r['lng'] as num?)?.toDouble() ?? 0,
        speedKmh: (r['speedKmh'] as num?)?.toDouble() ?? 0,
        bearing: (r['bearing'] as num?)?.toDouble() ?? 0,
        accuracyM: (r['accuracyM'] as num?)?.toDouble() ?? 0,
        altitudeM: (r['altitudeM'] as num?)?.toDouble() ?? 0,
        batteryPct: (r['batteryPct'] as num?)?.toInt() ?? 0,
        provider: (r['provider'] as String?) ?? 'gps',
        buffered: ((r['buffered'] as int?) ?? 0) == 1,
        seq: (r['seq'] as int?) ?? 0,
        uploaded: ((r['uploaded'] as int?) ?? 0) == 1,
        motionState: r['motionState'] as String?,
      );

  /// JSON item for the wire (CONTRACT §4). Only the keys the backend declares.
  Map<String, Object?> toJson() => <String, Object?>{
        'clientTs': clientTs.toUtc().toIso8601String(),
        'lat': lat,
        'lng': lng,
        'speed': speedKmh,
        'bearing': bearing,
        'accuracy': accuracyM,
        'altitude': altitudeM,
        'battery': batteryPct,
        'provider': provider,
        if (motionState != null) 'motionState': motionState,
        'buffered': buffered,
      };

  @override
  String toString() => jsonEncode(toJson());
}

/// Top-level body of `POST /positions/batch`.
///
/// `{ deviceId, batchSeq, positions: [...] }` — max [Buffer.maxBatch] per request.
class BatchPayload {
  const BatchPayload({
    required this.deviceId,
    required this.batchSeq,
    required this.positions,
  });

  final String deviceId;
  final int batchSeq;
  final List<TrackPosition> positions;

  Map<String, Object?> toJson() => <String, Object?>{
        'deviceId': deviceId,
        'batchSeq': batchSeq,
        'positions': positions.map((TrackPosition p) => p.toJson()).toList(),
      };

  bool get hasBuffered => positions.any((TrackPosition p) => p.buffered);
}

/// Response of `POST /positions/batch` (CONTRACT §4).
class BatchResponse {
  const BatchResponse({
    required this.accepted,
    required this.deduped,
    required this.rejected,
    required this.alertsRaised,
    required this.nextServerTs,
  });

  final int accepted;
  final int deduped;
  final List<RejectItem> rejected;
  final int alertsRaised;
  final DateTime nextServerTs;

  static BatchResponse fromJson(Map<String, Object?> json) {
    final Object? rej = json['rejected'];
    return BatchResponse(
      accepted: (json['accepted'] as num?)?.toInt() ?? 0,
      deduped: (json['deduped'] as num?)?.toInt() ?? 0,
      rejected: rej is List
          ? rej
              .whereType<Map<String, Object?>>()
              .map((Map<String, Object?> m) => RejectItem(
                    index: (m['index'] as num?)?.toInt() ?? -1,
                    reason: (m['reason'] as String?) ?? 'unknown',
                  ))
              .toList()
          : const <RejectItem>[],
      alertsRaised: (json['alertsRaised'] as num?)?.toInt() ?? 0,
      nextServerTs: DateTime.tryParse((json['nextServerTs'] as String?) ?? '') ??
          DateTime.now().toUtc(),
    );
  }
}

class RejectItem {
  const RejectItem({required this.index, required this.reason});
  final int index;
  final String reason;
}

/// Convenience for the classifier default state.
const String kDefaultMotionState = MotionStates.unknown;
