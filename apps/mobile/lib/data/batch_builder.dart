import '../core/traccer_constants.dart';
import '../models/position.dart';

/// Pure, device-free batch assembly for `POST /positions/batch` (CONTRACT §4).
///
/// Rules enforced here (and unit-tested in `test/batch_payload_test.dart`):
///  * hard cap [Buffer.maxBatch] = 500 points per request
///  * oldest-first ordering by `clientTs`
///  * client-side dedupe by the idempotency tuple `(clientTs, lat, lng)`
///  * `buffered: true` propagates onto any point that was stored offline and now replays
class BatchBuilder {
  const BatchBuilder._();

  static List<TrackPosition> dedupe(List<TrackPosition> input) {
    final Set<String> seen = <String>{};
    final List<TrackPosition> out = <TrackPosition>[];
    for (final TrackPosition p in input) {
      final String key = p.dedupeKey();
      if (seen.add(key)) out.add(p);
    }
    return out;
  }

  static List<TrackPosition> oldestFirst(List<TrackPosition> input) {
    final List<TrackPosition> out = List<TrackPosition>.from(input);
    out.sort((TrackPosition a, TrackPosition b) {
      final int c = a.clientTs.compareTo(b.clientTs);
      return c != 0 ? c : a.seq.compareTo(b.seq);
    });
    return out;
  }

  /// Build the wire payload. Splits into >1 request if [positions] exceeds the cap — the
  /// caller should loop using [split]. This single helper returns the FIRST ≤500 chunk.
  static BatchPayload build({
    required String deviceId,
    required int batchSeq,
    required List<TrackPosition> positions,
    bool forceBuffered = false,
  }) {
    final List<TrackPosition> ordered = oldestFirst(dedupe(positions));
    final List<TrackPosition> capped =
        ordered.length > Buffer.maxBatch ? ordered.sublist(0, Buffer.maxBatch) : ordered;
    final List<TrackPosition> flagged = forceBuffered
        ? capped.map((TrackPosition p) => p.copyWith(buffered: true)).toList(growable: false)
        : capped;
    return BatchPayload(deviceId: deviceId, batchSeq: batchSeq, positions: flagged);
  }

  /// Split a large backlog into ≤500-item payloads, preserving global oldest-first order.
  static List<BatchPayload> split({
    required String deviceId,
    required int startBatchSeq,
    required List<TrackPosition> positions,
    bool forceBuffered = false,
  }) {
    final List<TrackPosition> ordered = oldestFirst(dedupe(positions));
    final List<BatchPayload> out = <BatchPayload>[];
    for (int i = 0; i < ordered.length; i += Buffer.maxBatch) {
      final int end =
          (i + Buffer.maxBatch) > ordered.length ? ordered.length : i + Buffer.maxBatch;
      final List<TrackPosition> chunk = ordered.sublist(i, end);
      final List<TrackPosition> flagged = forceBuffered
          ? chunk.map((TrackPosition p) => p.copyWith(buffered: true)).toList(growable: false)
          : chunk;
      out.add(BatchPayload(deviceId: deviceId, batchSeq: startBatchSeq + i, positions: flagged));
    }
    return out;
  }
}
