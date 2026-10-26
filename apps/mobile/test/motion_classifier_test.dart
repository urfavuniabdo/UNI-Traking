import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/traccer_constants.dart';
import 'package:traccer/services/motion_classifier.dart';

void main() {
  DateTime t(int s) => DateTime.utc(2026, 10, 22, 6, 0, s * 5); // 5s apart (> minInterval)
  DateTime sec(int s) => DateTime.utc(2026, 10, 22, 6, 0).add(Duration(seconds: s));

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

    test('a parked phone drifting 16 m at 19 m accuracy does not claim walking forever', () {
      final MotionClassifier c = MotionClassifier();
      c.addSample(speedKmh: 0.3, accuracyM: 19.4, ts: sec(0), lat: 30.0, lng: 31.2);
      expect(c.state, MotionStates.stopped);
      // today's real trace: the phone ping-pongs ±16 m — 19 km/h on paper over 3 s
      String s = c.state;
      for (int i = 1; i <= 24; i++) {
        s = c.addSample(
          speedKmh: 0.5,
          accuracyM: 19.4,
          ts: sec(i * 3),
          lat: 30.0 + (i.isOdd ? 0.000144 : -0.000144),
          lng: 31.2,
        );
      }
      expect(s, MotionStates.stopped, reason: 'never leaving the circle is a fact, not an estimate');
      expect(c.lastRawSpeedKmh, lessThan(1.0),
          reason: 'the speed on the wire is the capped one, so the backend cannot read a '
              'drift burst as travel');
    });

    test('he walks, then stops — the phone comes back to واقف and stops feeding the spike', () {
      final MotionClassifier c = MotionClassifier();
      c.addSample(speedKmh: 0.2, accuracyM: 6, ts: sec(0), lat: 30.0, lng: 31.2);
      // ~4.8 km/h of real ground, the chip still reporting a third of that
      String s = c.state;
      for (int i = 1; i <= 12 && s != MotionStates.walking; i++) {
        s = c.addSample(
          speedKmh: 1.5,
          accuracyM: 6,
          ts: sec(i * 5),
          lat: 30.0 + 0.00006 * i,
          lng: 31.2,
        );
      }
      expect(s, MotionStates.walking);

      // he stands up his foot and puts the phone down; the last cached Doppler rides along
      for (int i = 13; i <= 26; i++) {
        s = c.addSample(
          speedKmh: 18,
          accuracyM: 6,
          ts: sec(i * 5),
          lat: 30.00072 + (i.isEven ? 0.000009 : -0.000009),
          lng: 31.2,
        );
      }
      expect(s, MotionStates.stopped, reason: 'a stale 18 km/h inside the circle cannot hold a state');
      expect(c.lastRawSpeedKmh, lessThan(1.5));
    });

    test('his recorded stroll (real coordinates) leaves واقف', () {
      // D0203, 2026-10-26 08:22→08:32 UTC: two minutes standing, then he walked — the exact
      // coordinates the phone uploaded. The chip only ever reported a couple of km/h, which is
      // what a hand-held phone does on foot, so the metres have to carry it.
      final MotionClassifier c = MotionClassifier();
      final List<List<Object>> trace = <List<Object>>[
        <Object>[0, 30.0969929, 31.3816802, 11.7],
        <Object>[25, 30.0970702, 31.3816164, 8.3],
        <Object>[59, 30.0970292, 31.3817134, 8.1],
        <Object>[78, 30.0969442, 31.3816749, 8.6],
        <Object>[98, 30.0969868, 31.3815794, 6.1],
        <Object>[490, 30.0970333, 31.3816817, 3.0],
        <Object>[504, 30.0969900, 31.3815550, 5.5],
        <Object>[507, 30.0969233, 31.3814200, 5.3],
        <Object>[516, 30.0970432, 31.3815958, 13.3],
        <Object>[547, 30.0969083, 31.3812100, 9.3],
        <Object>[553, 30.0969033, 31.3813683, 7.8],
        <Object>[565, 30.0970452, 31.3815992, 11.7],
      ];
      String s = MotionStates.unknown;
      final List<String> seen = <String>[];
      for (final List<Object> p in trace) {
        s = c.addSample(
          speedKmh: (p[0] as int) > 480 ? 1.2 : 0.3, // the Doppler of a phone carried on foot
          accuracyM: p[3] as double,
          ts: DateTime.utc(2026, 10, 26, 8, 22, 38).add(Duration(seconds: p[0] as int)),
          lat: p[1] as double,
          lng: p[2] as double,
        );
        seen.add(s);
      }
      expect(seen[5], MotionStates.stopped, reason: 'the two standing minutes must not read as motion');
      expect(s, isNot(MotionStates.stopped),
          reason: 'he covered 0.3 km on foot inside the window — the phone has to say so');
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
