import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/traccer_constants.dart';
import 'package:traccer/data/batch_builder.dart';
import 'package:traccer/models/position.dart';

TrackPosition p(int sec, double lat, double lng, {int? seq}) => TrackPosition(
      clientTs: DateTime.utc(2026, 10, 22, 6, 0, sec),
      lat: lat,
      lng: lng,
      speedKmh: 10,
      bearing: 0,
      accuracyM: 5,
      altitudeM: 0,
      batteryPct: 90,
      provider: 'gps',
      buffered: false,
      seq: seq ?? sec,
    );

void main() {
  group('BatchBuilder', () {
    test('orders oldest-first', () {
      final BatchPayload out = BatchBuilder.build(
        deviceId: 'd1',
        batchSeq: 1,
        positions: <TrackPosition>[p(30, 1, 1, seq: 3), p(10, 1, 1, seq: 1), p(20, 1, 1, seq: 2)],
      );
      expect(out.positions.map((TrackPosition e) => e.clientTs.second).toList(), <int>[10, 20, 30]);
    });

    test('dedupes by (clientTs, lat, lng) idempotency tuple', () {
      final BatchPayload out = BatchBuilder.build(
        deviceId: 'd1',
        batchSeq: 1,
        positions: <TrackPosition>[
          p(10, 30.1, 31.2, seq: 1),
          p(10, 30.1, 31.2, seq: 2), // duplicate time+coords, different seq
          p(11, 30.1, 31.2, seq: 3), // same coords, later time -> kept
        ],
      );
      expect(out.positions.length, 2);
    });

    test('caps a single payload at 500 points (CONTRACT §4)', () {
      final List<TrackPosition> many =
          List<TrackPosition>.generate(650, (int i) => p(i, 30.0 + i / 10000, 31.0, seq: i));
      final BatchPayload out = BatchBuilder.build(deviceId: 'd', batchSeq: 7, positions: many);
      expect(out.positions.length, Buffer.maxBatch);
      expect(out.positions.length, 500);
    });

    test('split produces only <=500 chunks and covers all deduped points', () {
      final List<TrackPosition> many =
          List<TrackPosition>.generate(1200, (int i) => p(i, 30.0, 31.0 + i / 100000, seq: i));
      final List<BatchPayload> chunks =
          BatchBuilder.split(deviceId: 'd', startBatchSeq: 100, positions: many);
      expect(chunks, isNotEmpty);
      for (final BatchPayload c in chunks) {
        expect(c.positions.length, lessThanOrEqualTo(Buffer.maxBatch));
        expect(c.deviceId, 'd');
      }
      final int total = chunks.fold(0, (int s, BatchPayload c) => s + c.positions.length);
      expect(total, 1200);
    });

    test('forceBuffered flags every point as a replay', () {
      final BatchPayload out = BatchBuilder.build(
        deviceId: 'd',
        batchSeq: 1,
        positions: <TrackPosition>[p(1, 1, 1, seq: 1), p(2, 1, 2, seq: 2)],
        forceBuffered: true,
      );
      expect(out.hasBuffered, isTrue);
      expect(out.positions.every((TrackPosition x) => x.buffered), isTrue);
    });
  });
}
