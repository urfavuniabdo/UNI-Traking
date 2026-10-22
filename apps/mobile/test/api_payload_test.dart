import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/models/position.dart';

/// Guards the WIRE FORMAT against CONTRACT §4 so we never send a wrong key again.
void main() {
  final TrackPosition sample = TrackPosition(
    clientTs: DateTime.utc(2026, 10, 22, 6, 31, 4),
    lat: 30.0444,
    lng: 31.2357,
    speedKmh: 42.5,
    bearing: 118,
    accuracyM: 8.0,
    altitudeM: 74,
    batteryPct: 81,
    provider: 'gps',
    buffered: true,
    seq: 99,
    motionState: 'RIDING',
  );

  test('top-level batch body has exactly {deviceId, batchSeq, positions}', () {
    final Map<String, Object?> json =
        BatchPayload(deviceId: 'dev-1', batchSeq: 42, positions: <TrackPosition>[sample]).toJson();
    expect(json.keys.toSet(), <String>{'deviceId', 'batchSeq', 'positions'});
    expect(json['deviceId'], 'dev-1');
    expect(json['batchSeq'], 42);
    expect(json['positions'], isA<List<Object?>>());
  });

  test('position item keys match CONTRACT §4 (speed/accuracy/altitude names)', () {
    final Map<String, Object?> pos = sample.toJson();
    expect(
      pos.keys.toSet(),
      <String>{
        'clientTs',
        'lat',
        'lng',
        'speed', // NOT speedKmh on the wire
        'bearing',
        'accuracy', // NOT accuracyM on the wire
        'altitude',
        'battery',
        'provider',
        'motionState',
        'buffered',
      },
    );
    // The DAO stores speedKmh/accuracyM/altitudeM internally but must expose §4 names.
    expect(pos['speed'], 42.5);
    expect(pos['accuracy'], 8.0);
    expect(pos['altitude'], 74);
    expect(pos['battery'], 81);
    expect(pos['buffered'], isTrue);
    expect(pos['motionState'], 'RIDING');
  });

  test('clientTs serialises as ISO-8601 UTC', () {
    expect(sample.toJson()['clientTs'], '2026-10-22T06:31:04.000Z');
  });

  test('motionState is omitted when unknown', () {
    final TrackPosition noMotion = TrackPosition(
      clientTs: sample.clientTs,
      lat: 1,
      lng: 1,
      speedKmh: 0,
      bearing: 0,
      accuracyM: 5,
      altitudeM: 0,
      batteryPct: 50,
      provider: 'gps',
      buffered: false,
      seq: 1,
    );
    expect(noMotion.toJson().containsKey('motionState'), isFalse);
  });

  test('dedupeKey reflects the §4 idempotency tuple', () {
    expect(sample.dedupeKey(), '2026-10-22T06:31:04.000Z|30.044400|31.235700');
  });
}
