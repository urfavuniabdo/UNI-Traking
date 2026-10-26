import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/traccer_constants.dart';
import 'package:traccer/services/motion_sensor.dart';

/// The accelerometer window, fed by hand: no device, no plugin, just the arithmetic §5 leans on.
void main() {
  const double g = 9.81;
  final DateTime t0 = DateTime.utc(2026, 10, 26, 18, 0);
  DateTime cursor = t0;

  /// `stepMs` apart, on one clock that keeps running across feeds.
  void feed(MotionSensor s, List<double> mags, {int stepMs = 100}) {
    for (final double m in mags) {
      s.pushSample(m, cursor);
      cursor = cursor.add(Duration(milliseconds: stepMs));
    }
  }

  /// A heel-strike is one bump per step: 2 Hz for a man, and nothing at all for a phone on a table.
  List<double> sine({required int seconds, required double periodMs, required double amplitude}) => <double>[
        for (int i = 0; i < seconds * 10; i++)
          g + amplitude * (i % (periodMs / 100) < (periodMs / 200) ? 1 : -1).toDouble(),
      ];

  group('MotionSensor', () {
    test('nothing is asserted before the window has filled', () {
      final MotionSensor s = MotionSensor();
      feed(s, <double>[g, g + 0.4, g - 0.4]);
      expect(s.motionEnergyMs2, isNull, reason: 'three samples cannot tell still from moving');
      expect(s.stepsPerMin, isNull);
    });

    test('a phone lying flat says so in m/s², and §5 listens', () {
      final MotionSensor s = MotionSensor();
      feed(s, <double>[
        for (int i = 0; i < 120; i++) g + (i.isEven ? 0.015 : -0.015),
      ]);
      expect(s.motionEnergyMs2, isNotNull);
      expect(s.motionEnergyMs2!, lessThan(Motion.stillEnergyMs2),
          reason: 'sensor noise alone must read as « nobody touched this device »');
      expect(s.stepsPerMin, 0, reason: 'a wiggle of 15 mm/s² is not a footstep');
    });

    test('a walk is counted at the cadence it was taken at', () {
      final MotionSensor s = MotionSensor();
      feed(s, sine(seconds: 12, periodMs: 500, amplitude: 1.4)); // 2 Hz = 120 steps/min
      expect(s.motionEnergyMs2!, greaterThan(Motion.stillEnergyMs2));
      expect(s.stepsPerMin, isNotNull);
      expect(s.stepsPerMin!, greaterThanOrEqualTo(Motion.stepsPerMinOnFoot));
      expect(s.stepsPerMin!, closeTo(120, 25));
    });

    test('a slow stroll still clears the on-foot bar', () {
      final MotionSensor s = MotionSensor();
      feed(s, sine(seconds: 12, periodMs: 1100, amplitude: 1.1)); // ~55 steps/min
      expect(s.stepsPerMin!, greaterThanOrEqualTo(Motion.stepsPerMinOnFoot));
    });

    test('road bumps are not footsteps: the cadence has to be a gait', () {
      // A car throws the phone at irregular intervals — a pothole every few seconds, none between.
      final MotionSensor s = MotionSensor();
      feed(s, <double>[
        for (int i = 0; i < 120; i++)
          g + (i == 8 || i == 40 || i == 96 ? 2.5 : 0.05 * ((i % 3) - 1)),
      ]);
      expect(s.motionEnergyMs2!, greaterThan(Motion.stillEnergyMs2),
          reason: 'the device is clearly not lying flat');
      expect(s.stepsPerMin, 0, reason: 'three irregular bumps are not a man walking');
    });

    test('the window forgets: stopping the walk stops the steps', () {
      final MotionSensor s = MotionSensor();
      feed(s, sine(seconds: 12, periodMs: 500, amplitude: 1.4));
      expect(s.stepsPerMin!, greaterThan(Motion.stepsPerMinOnFoot));
      feed(s, <double>[for (int i = 0; i < 120; i++) g + (i.isEven ? 0.02 : -0.02)]);
      expect(s.stepsPerMin, 0, reason: 'a 10 s window of standing must not still report his last stride');
      expect(s.motionEnergyMs2!, lessThan(Motion.stillEnergyMs2));
    });

    test('a duplicated or out-of-order event is dropped, not averaged in', () {
      final MotionSensor s = MotionSensor();
      feed(s, sine(seconds: 3, periodMs: 500, amplitude: 1.4));
      final double? before = s.motionEnergyMs2;
      s.pushSample(g + 40, t0); // the sensor is monotonic: this is a replayed frame
      expect(s.motionEnergyMs2, before);
    });
  });
}
