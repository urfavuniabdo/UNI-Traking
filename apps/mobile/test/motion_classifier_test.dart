import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/traccer_constants.dart';
import 'package:traccer/services/motion_classifier.dart';

void main() {
  DateTime t(int s) => DateTime.utc(2026, 10, 22, 6, 0, s * 5); // 5s apart (> minInterval)
  DateTime sec(int s) => DateTime.utc(2026, 10, 22, 6, 0).add(Duration(seconds: s));

  // D0203's courtyard, byte for byte: [seconds, lat, lng, accuracyM]. 119 m of pacing that walked
  // back — the phone reported a couple of km/h of Doppler the whole time.
  const List<List<Object>> courtyardTrace = <List<Object>>[
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

  // The same uploads with 10 m of one-way westward travel piled onto every fix from the second
  // cluster on — the walk the raw trace never contained.
  List<String> feedCourtyard(MotionClassifier c, {required bool translated}) {
    const double mPerDegLng = 96315;
    final List<String> seen = <String>[];
    for (int i = 0; i < courtyardTrace.length; i++) {
      final List<Object> p = courtyardTrace[i];
      final bool walked = translated && i >= 6;
      seen.add(c.addSample(
        speedKmh: (p[0] as int) > 480 ? 1.2 : 0.3, // the Doppler of a phone carried in a hand
        accuracyM: p[3] as double,
        ts: DateTime.utc(2026, 10, 26, 8, 22, 38).add(Duration(seconds: p[0] as int)),
        lat: p[1] as double,
        lng: (p[2] as double) - (walked ? 10.0 * (i - 5) / mPerDegLng : 0),
      ));
    }
    return seen;
  }

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
      // Two fixes are not a window: 6.7 m of mean-to-mean travel is inside the wander bubble, so
      // the phone must not put a walk on the wire until the coordinates have averaged enough.
      c.addSample(speedKmh: 0.4, accuracyM: 4, ts: t(1), lat: 30.00006, lng: 31.2);
      expect(c.lastRawSpeedKmh, lessThan(1.5),
          reason: 'an immature window keeps the drift inside the bubble instead of selling it as speed');
      // ~6.7 m every 5 s keeps going, and by a minute of it the window has proved the walk: the
      // displacement travels with the fix, because that is the number the backend's own state reads.
      for (int i = 2; i <= 12; i++) {
        c.addSample(speedKmh: 0.4, accuracyM: 4, ts: t(i), lat: 30.0 + 0.00006 * i, lng: 31.2);
      }
      expect(c.lastRawSpeedKmh, greaterThan(4));
      // a sub-min-interval fix is never judged, so no stale speed rides along on it
      c.addSample(speedKmh: 90, accuracyM: 4, ts: t(12).add(const Duration(seconds: 1)), lat: 30.0, lng: 31.2);
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

    test('his recorded courtyard trace (real coordinates) stays واقف', () {
      // D0203, 2026-10-26 08:22→08:32 UTC — the exact coordinates his phone uploaded. He paced:
      // 119 m of path that walked back, 7.5 m of net travel. The old point-to-point rule read that
      // scatter as motion; §5 judges on the net, and a board that calls pacing «ماشي» is the board
      // that called standing still «ماشي». Proving his steps actually moved needs the accelerometer.
      final MotionClassifier c = MotionClassifier();
      final List<String> seen = feedCourtyard(c, translated: false);
      expect(seen[5], MotionStates.stopped, reason: 'the two standing minutes must not read as motion');
      expect(seen.last, MotionStates.stopped, reason: '119 m out-and-back is not travel');
    });

    test('the same cadence translated so the metres go somewhere leaves واقف', () {
      // The walk this trace never contained: his own scatter with 10 m of one-way westward travel
      // added to every fix — what §5 needs to see before it lets a phone off "stopped".
      final MotionClassifier c = MotionClassifier();
      final List<String> seen = feedCourtyard(c, translated: true);
      expect(seen[5], MotionStates.stopped);
      expect(<String>[MotionStates.walking, MotionStates.riding], contains(seen.last),
          reason: 'the coordinates prove the travel; the device only picks the band');
    });

    test('bandFor uses the exact contract thresholds', () {
      final MotionClassifier c = MotionClassifier();
      expect(c.bandFor(1.5), MotionStates.stopped); // <= 1.5
      expect(c.bandFor(1.6), MotionStates.walking);
      expect(c.bandFor(7.0), MotionStates.walking); // <= 7
      expect(c.bandFor(7.1), MotionStates.riding);
    });

    // ---------------------------------------------------------------- IMU (§5)

    test('a run the coordinates prove is a ride — until his feet say otherwise', () {
      // 33 m every 5 s = 24 km/h of one-way travel: the ground vouches for the fact, the device for
      // the number. STEPS_PER_MIN_ON_FOOT is the only thing that tells a striding man from a crawling
      // car, because both sit in the same GPS band.
      List<String> run(MotionClassifier c, {double? steps}) {
        final List<String> seen = <String>[];
        for (int i = 0; i < 10; i++) {
          seen.add(c.addSample(
            speedKmh: 24,
            accuracyM: 6,
            ts: sec(i * 5),
            lat: 30.0 + 0.0003 * i,
            lng: 31.2,
            stepsPerMin: steps,
          ));
        }
        return seen;
      }

      final MotionClassifier wheels = MotionClassifier();
      expect(run(wheels).last, MotionStates.riding);

      final MotionClassifier feet = MotionClassifier();
      final List<String> seen = run(feet, steps: 96); // a measured stride, not a guess
      expect(seen.last, MotionStates.walking, reason: 'steps on the ground cap him at the walking band');
      expect(feet.lastRawSpeedKmh, lessThanOrEqualTo(Motion.walkMaxKmh));
    });

    test('a phone nobody touched is واقف whatever the receiver claims', () {
      // The 2026-10-26 wake-up burst: the chip reported 137 km/h for eleven minutes while the
      // accelerometer never varied by more than its own noise. STILL_ENERGY_MS2 is that witness.
      final MotionClassifier c = MotionClassifier();
      for (int i = 0; i < 8; i++) {
        c.addSample(speedKmh: 0.5, accuracyM: 8, ts: sec(i * 10), lat: 30.0, lng: 31.2, motionEnergyMs2: 0.02);
      }
      expect(c.state, MotionStates.stopped);

      final String burst = c.addSample(
        speedKmh: 137,
        accuracyM: 8,
        ts: sec(80),
        lat: 30.0,
        lng: 31.2047, // ~450 m away: a whole neighbourhood in one 10 s step
        motionEnergyMs2: 0.02,
      );
      expect(burst, MotionStates.stopped, reason: 'a flat device has not been carried anywhere');
      expect(c.lastRawSpeedKmh, lessThanOrEqualTo(Motion.stationarySpeedKmh));
    });

    test('a move has to hold before it re-states a standing driver', () {
      // A two-minute silence starves the window, so the first fixes after it are the immature claim
      // MOVE_CONFIRM_S exists for: he stays واقف until the travel persists.
      final MotionClassifier c = MotionClassifier();
      for (int i = 0; i < 6; i++) {
        c.addSample(speedKmh: 0.2, accuracyM: 6, ts: sec(i * 5), lat: 30.0, lng: 31.2);
      }
      expect(c.state, MotionStates.stopped);

      String s = c.state;
      for (int i = 0; i < 3; i++) {
        // 45 m every 3 s: 54 km/h of net travel — the most a body can reach in 3 s from standstill —
        // proved by a window of three fixes, which is younger than §5 asks for a walk.
        s = c.addSample(speedKmh: 54, accuracyM: 6, ts: sec(200 + i * 3), lat: 30.0, lng: 31.2 + 0.000465 * (i + 1));
      }
      expect(s, MotionStates.stopped, reason: 'an immature window cannot pull him out of واقف yet');

      for (int i = 3; i < 12; i++) {
        s = c.addSample(speedKmh: 54, accuracyM: 6, ts: sec(200 + i * 3), lat: 30.0, lng: 31.2 + 0.000465 * (i + 1));
      }
      expect(s, isNot(MotionStates.stopped), reason: 'the claim held past MOVE_CONFIRM_S, so it stands');
    });

    test('a jump no body could make is not a journey', () {
      // 0 → 200 km/h in 5 s is 11 m/s² — more than a tyre or a shoe has. MAX_ACCEL_MS2 refuses it the
      // same way the server does, so the phone never uploads a speed the dashboard would then reject.
      final MotionClassifier c = MotionClassifier();
      for (int i = 0; i < 6; i++) {
        c.addSample(speedKmh: 0.0, accuracyM: 6, ts: sec(i * 5), lat: 30.0, lng: 31.2);
      }
      expect(c.state, MotionStates.stopped);

      final String out = c.addSample(speedKmh: 200, accuracyM: 6, ts: sec(30), lat: 30.0025, lng: 31.2);
      expect(out, MotionStates.stopped, reason: 'the step demanded grip nobody has');
      expect(c.lastRawSpeedKmh, lessThan(1.5));
    });

    test('the phone\'s verdict table on a mounted day is the server\'s', () {
      // D0203, 2026-10-27 06:27→06:51 UTC — the 22 fixes his phone uploaded while it sat mounted and
      // nobody touched it: one ~35 m bubble, 0.00 km drawn, and a receiver reporting 24.1/15.9/16.7/
      // 9/16.1/57.9 km/h of Doppler. This is the table the server printed for the same fixes
      // (`mounted-phone.spec.ts`, WITHOUT WITNESS). Both sides judge the SAME way on purpose: a chip
      // that disagrees with the board is a bug even when the chip happens to be the optimistic one.
      final MotionClassifier bare = MotionClassifier();
      final List<String> rows = <String>[];
      for (final List<Object> f in mountedTrace) {
        final String state = bare.addSample(
          speedKmh: (f[4] as num).toDouble(),
          accuracyM: (f[3] as num).toDouble(),
          ts: DateTime.utc(2026, 10, 27, 6, 27).add(Duration(seconds: f[0] as int)),
          lat: f[1] as double,
          lng: f[2] as double,
        );
        rows.add('${(f[0] as int) ~/ 60}:${(f[0] as int) % 60} $state');
      }
      expect(rows.where((String r) => r.endsWith('WALKING')).toList(), <String>[
        '0:48 WALKING', // 2.7 km/h of Doppler over a 12 m step, two minutes into the day
        '0:53 WALKING',
        '24:18 WALKING', // 16.1 km/h, 78 m from the fix before it
        '24:23 WALKING', // 57.9 km/h back inside the bubble — the last verdict of the day
      ], reason: 'coordinates alone leave these four to the device, on both engines');

      // The accelerometer is what closes them. STILL_ENERGY_MS2 is a device nobody touched, and it
      // needs no window to be believed: the day ends واقف at 1.5 km/h, the same verdict the server
      // stores for these fixes with the witness on (`mounted-phone.spec.ts`, WITH WITNESS).
      final MotionClassifier witnessed = MotionClassifier();
      for (final List<Object> f in mountedTrace) {
        final String state = witnessed.addSample(
          speedKmh: (f[4] as num).toDouble(),
          accuracyM: (f[3] as num).toDouble(),
          ts: DateTime.utc(2026, 10, 27, 6, 27).add(Duration(seconds: f[0] as int)),
          lat: f[1] as double,
          lng: f[2] as double,
          stepsPerMin: 0,
          motionEnergyMs2: 0.02,
        );
        expect(state, MotionStates.stopped, reason: 'a phone nobody carried is a standing driver');
      }
      expect(witnessed.lastRawSpeedKmh, lessThanOrEqualTo(Motion.stationarySpeedKmh));
    });

    test('his feet stand the stand-by down — pacing a room is a walk', () {
      // A man pacing a 40 m room: his cluster is one place, so the line's verdict sits him down — and
      // a measured stride is the one witness that beats it. The trace is 45 s of standing and then
      // legs of 40 m out and 40 m back at 2.4 km/h, so the coordinates do translate inside a window
      // while the whole run stays a stand-by.
      List<String> pace({double? steps}) {
        final MotionClassifier c = MotionClassifier();
        final List<String> seen = <String>[];
        double metres = 0;
        int t = 0;
        for (int i = 0; i < 9; i++) {
          seen.add(c.addSample(speedKmh: 0.2, accuracyM: 6, ts: sec(t), lat: 30.0, lng: 31.2, stepsPerMin: steps));
          t += 5;
        }
        for (int cycle = 0; cycle < 2; cycle++) {
          for (final double dir in <double>[1, -1]) {
            for (int i = 0; i < 12; i++) {
              metres += 3.33 * dir;
              seen.add(c.addSample(
                speedKmh: 2.4,
                accuracyM: 6,
                ts: sec(t),
                lat: 30.0,
                lng: 31.2 + metres / 96315,
                stepsPerMin: steps,
              ));
              t += 5;
            }
          }
        }
        return seen;
      }

      // From the 90-second mark on — when the stand-by is older than the window §5 measures over —
      // the coordinates alone are refused; his stride is not.
      final List<String> bare = pace();
      final List<String> gaited = pace(steps: 96);
      expect(bare.sublist(19).every((String s) => s == MotionStates.stopped), isTrue,
          reason: 'the line refuses a journey it will draw as one dot');
      expect(gaited.sublist(19).contains(MotionStates.walking), isTrue,
          reason: 'a measured stride outranks a motionless cluster');
    });
  });
}

/// [seconds offset from 06:27:00 UTC, lat, lng, accuracyM, Doppler km/h] — the phone's own upload,
/// pulled from GET /positions/route while it sat mounted. DO NOT EDIT.
const List<List<Object>> mountedTrace = <List<Object>>[
  <Object>[4, 30.097025, 31.38128833333333, 7.5, 0],
  <Object>[13, 30.096945, 31.38135166666667, 6.6, 0],
  <Object>[18, 30.096925, 31.381465, 6, 0],
  <Object>[30, 30.09699166666667, 31.38154833333333, 5.5, 0.3],
  <Object>[38, 30.097035, 31.38164333333333, 6, 1.2],
  <Object>[48, 30.097015, 31.38153333333333, 5.7, 2.7],
  <Object>[53, 30.09693333333333, 31.38146166666667, 6.1, 0],
  <Object>[61, 30.096845, 31.38138833333333, 7.8, 0],
  <Object>[66, 30.09693833333333, 31.38142666666667, 6.2, 0],
  <Object>[676, 30.09693666666667, 31.38128833333333, 9.7, 0],
  <Object>[681, 30.09723333333333, 31.38134833333334, 8, 24.1],
  <Object>[686, 30.09694333333334, 31.38124, 4.8, 0],
  <Object>[691, 30.09703, 31.38159166666667, 5.6, 0],
  <Object>[814, 30.09693833333333, 31.38159166666667, 1.9, 0],
  <Object>[1409, 30.09686333333333, 31.38169666666667, 2.7, 0],
  <Object>[1414, 30.096695, 31.38173166666666, 4.7, 0],
  <Object>[1419, 30.09685, 31.38166333333334, 5.9, 0],
  <Object>[1424, 30.097025, 31.381555, 7, 15.9],
  <Object>[1429, 30.09706666666667, 31.38179166666666, 7.3, 16.7],
  <Object>[1453, 30.09755666666667, 31.38206, 9.4, 9],
  <Object>[1458, 30.097755, 31.38202333333334, 9.9, 16.1],
  <Object>[1463, 30.09705, 31.381835, 8.9, 57.9],
];
