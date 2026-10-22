import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/traccer_constants.dart';
import 'package:traccer/services/motion_classifier.dart';

void main() {
  DateTime t(int s) => DateTime.utc(2026, 10, 22, 6, 0, s * 5); // 5s apart (> minInterval)

  group('MotionClassifier', () {
    test('bad accuracy yields UNKNOWN and does not pollute state', () {
      final MotionClassifier c = MotionClassifier();
      // establish STOPPED first
      for (int i = 0; i < 4; i++) {
        c.addSample(speedKmh: 0.4, accuracyM: 5, ts: t(i));
      }
      expect(c.state, MotionStates.stopped);
      final String before = c.state;
      final String out = c.addSample(speedKmh: 40, accuracyM: 60, ts: t(10)); // acc > 35
      expect(out, MotionStates.unknown);
      expect(c.state, before, reason: 'a bad fix must not change the committed state');
    });

    test('stop -> walk -> ride transitions commit after hysteresis', () {
      final MotionClassifier c = MotionClassifier();
      // STOPPED
      for (int i = 0; i < 4; i++) {
        c.addSample(speedKmh: 0.2, accuracyM: 4, ts: t(i));
      }
      expect(c.state, MotionStates.stopped);

      // WALKING (~4 km/h sustained)
      String s = MotionStates.stopped;
      for (int i = 0; i < 10 && s != MotionStates.walking; i++) {
        s = c.addSample(speedKmh: 4, accuracyM: 4, ts: t(20 + i));
      }
      expect(s, MotionStates.walking, reason: 'sustained 4km/h must settle to WALKING');

      // RIDING (~30 km/h sustained)
      for (int i = 0; i < 15; i++) {
        s = c.addSample(speedKmh: 30, accuracyM: 4, ts: t(60 + i));
      }
      expect(c.state, MotionStates.riding);
    });

    test('jitter rejection: one fast spike from STOPPED does not jump to RIDING', () {
      final MotionClassifier c = MotionClassifier();
      for (int i = 0; i < 5; i++) {
        c.addSample(speedKmh: 0.0, accuracyM: 3, ts: t(i));
      }
      expect(c.state, MotionStates.stopped);
      final String afterSpike = c.addSample(speedKmh: 25, accuracyM: 3, ts: t(100));
      expect(afterSpike, isNot(MotionStates.riding),
          reason: 'EMA + 3-sample hysteresis must reject a single GPS spike');
    });

    test('min-interval drops fixes closer than 2s apart', () {
      final MotionClassifier c = MotionClassifier();
      c.addSample(speedKmh: 0.5, accuracyM: 4, ts: DateTime.utc(2026, 1, 1, 0, 0, 0));
      final double emaBefore = c.smoothedSpeedKmh!;
      // 1 second later → ignored
      c.addSample(speedKmh: 50, accuracyM: 4, ts: DateTime.utc(2026, 1, 1, 0, 0, 1));
      expect(c.smoothedSpeedKmh, emaBefore, reason: 'sub-2s fix must not update the EMA');
    });

    test('walking is detected even when the phone reports ~0 speed', () {
      final MotionClassifier c = MotionClassifier();
      for (int i = 0; i < 4; i++) {
        c.addSample(speedKmh: 0.2, accuracyM: 4, ts: t(i), lat: 30.0, lng: 31.2);
      }
      expect(c.state, MotionStates.stopped);

      // ~6.7 m every 5 s ≈ 4.8 km/h of real ground covered, device speed stuck near zero
      String s = MotionStates.stopped;
      for (int i = 0; i < 10 && s != MotionStates.walking; i++) {
        s = c.addSample(
          speedKmh: 0.3,
          accuracyM: 4,
          ts: t(20 + i),
          lat: 30.0 + 0.00006 * (i + 1),
          lng: 31.2,
        );
      }
      expect(s, MotionStates.walking,
          reason: 'displacement between fixes must outrank a dead GPS speed reading');
    });

    test('GPS drift inside the accuracy circle must not fake a walk', () {
      final MotionClassifier c = MotionClassifier();
      String s = MotionStates.unknown;
      for (int i = 0; i < 8; i++) {
        // ±2 m of jitter with a 25 m accuracy figure — well inside the noise
        s = c.addSample(
          speedKmh: 0,
          accuracyM: 25,
          ts: t(i),
          lat: 30.0 + (i.isEven ? 0.000018 : -0.000018),
          lng: 31.2,
        );
      }
      expect(s, MotionStates.stopped, reason: 'drift is not evidence of moving');
    });

    test('the judged speed is what goes on the wire; a dropped sample judges nothing', () {
      final MotionClassifier c = MotionClassifier();
      c.addSample(speedKmh: 0.4, accuracyM: 4, ts: t(0), lat: 30.0, lng: 31.2);
      expect(c.lastRawSpeedKmh, 0.4);
      // ~6.7 m in 5 s ≈ 4.8 km/h of ground covered while the phone still insists on 0.4
      c.addSample(speedKmh: 0.4, accuracyM: 4, ts: t(1), lat: 30.00006, lng: 31.2);
      expect(c.lastRawSpeedKmh, greaterThan(4),
          reason: 'the backend derives its own state from the uploaded speed, so the '
              'displacement has to travel with the fix');
      // a sub-min-interval fix is never judged, so no stale speed rides along on it
      c.addSample(speedKmh: 90, accuracyM: 4, ts: t(1).add(const Duration(seconds: 1)), lat: 30.0, lng: 31.2);
      expect(c.lastRawSpeedKmh, 0);
    });

    test('bandFor uses the exact contract thresholds', () {
      final MotionClassifier c = MotionClassifier();
      expect(c.bandFor(1.5), MotionStates.stopped); // <= 1.5
      expect(c.bandFor(1.6), MotionStates.walking);
      expect(c.bandFor(7.0), MotionStates.walking); // <= 7
      expect(c.bandFor(7.1), MotionStates.riding);
    });
  });
}
