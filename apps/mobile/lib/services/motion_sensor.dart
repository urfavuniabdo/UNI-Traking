import 'dart:async';
import 'dart:math' as math;

import 'package:sensors_plus/sensors_plus.dart';

/// The phone's own witness, read off its accelerometer (§5: «الأرض هي اللي بتحكم» needs a second
/// witness when the coordinates have no opinion — the 2026-10-26 ghost claimed 137 km/h for eleven
/// minutes for a device nobody touched).
///
/// Two numbers come out of a trailing [window] of raw |a| samples, and both are what the backend's
/// `groundSpeed` asks for:
///  * `motionEnergyMs2` — the standard deviation of the acceleration magnitude. A phone lying flat
///    varies by ~0.02 m/s² of sensor noise; a device carried or driven never sits that low.
///  * `stepsPerMin` — rising crossings of the window's own level, counted with a [refractory] so one
///    heel-strike is one step, and thrown out unless the intervals are gait-like. A car's potholes
///    are irregular bumps and must not be read as footsteps, or a driver gets capped at the walking
///    band.
///
/// Both are null until the window has filled, so a device that cannot measure them is judged on the
/// ground alone instead of being asserted still.
class MotionSensor {
  MotionSensor({
    Stream<AccelerometerEvent> Function({Duration samplingPeriod}) eventStream = accelerometerEventStream,
    this.samplingPeriod = const Duration(milliseconds: 100),
    this.window = const Duration(seconds: 10),
    this.refractory = const Duration(milliseconds: 300),
    this.minStepSwingMs2 = 0.7,
    this.minGaitIntervalMs = 330,
    this.maxGaitIntervalMs = 1500,
  }) : _eventStream = eventStream;

  final Stream<AccelerometerEvent> Function({Duration samplingPeriod}) _eventStream;
  final Duration samplingPeriod;
  final Duration window;
  final Duration refractory;

  /// Peak-to-peak the signal must swing before a crossing counts as a step rather than as noise.
  final double minStepSwingMs2;
  final int minGaitIntervalMs;
  final int maxGaitIntervalMs;

  static const int _minSamples = 5;
  static const int _smoothTap = 3;

  StreamSubscription<AccelerometerEvent>? _sub;
  final List<double> _mags = <double>[];
  final List<DateTime> _ts = <DateTime>[];
  final List<DateTime> _steps = <DateTime>[];
  final List<double> _tail = <double>[];

  bool? _aboveLevel;
  bool _stopped = false;

  double? _energyMs2;
  double? _stepsPerMin;

  /// Acceleration variance over the window, in m/s². Null while the sensor has nothing to say.
  double? get motionEnergyMs2 => _energyMs2;

  /// Steps per minute of a gait-like cadence; 0 for a device that is carried but not walked with.
  double? get stepsPerMin => _stepsPerMin;

  Future<void> start() async {
    if (_sub != null) return;
    _stopped = false;
    _sub = _eventStream(samplingPeriod: samplingPeriod).listen(_onSample, onError: (Object _) => reset());
  }

  Future<void> stop() async {
    _stopped = true;
    final StreamSubscription<AccelerometerEvent>? sub = _sub;
    _sub = null;
    await sub?.cancel();
    reset();
  }

  void reset() {
    _mags.clear();
    _ts.clear();
    _steps.clear();
    _tail.clear();
    _aboveLevel = null;
    _energyMs2 = null;
    _stepsPerMin = null;
  }

  void _onSample(AccelerometerEvent e) {
    if (_stopped) return;
    pushSample(math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z), DateTime.now());
  }

  /// Feed one |a| reading. Exposed so the window arithmetic is testable without a device.
  void pushSample(double mag, DateTime at) {
    if (_ts.isNotEmpty && !at.isAfter(_ts.last)) return; // the sensor is monotonic; a replayed frame is not news
    _mags.add(mag);
    _ts.add(at);
    while (_ts.length > 1 && at.difference(_ts.first) > window) {
      _mags.removeAt(0);
      _ts.removeAt(0);
      _steps.removeWhere((DateTime s) => at.difference(s) > window);
    }
    if (_mags.length < _minSamples) {
      _energyMs2 = null;
      _stepsPerMin = null;
      return;
    }

    final double mean = _mags.reduce((double a, double b) => a + b) / _mags.length;
    final double variance = _mags.map((double m) => (m - mean) * (m - mean)).reduce((double a, double b) => a + b) / _mags.length;
    _energyMs2 = math.sqrt(variance);

    final double swing = _mags.reduce(math.max) - _mags.reduce(math.min);
    _tail.add(mag);
    if (_tail.length > _smoothTap) _tail.removeAt(0);
    final double smoothed = _tail.reduce((double a, double b) => a + b) / _tail.length;

    // One step = one pass from under the window's level to over it. Counting crossings, not peaks,
    // is what lets a walking phone's large swing still read as two steps a second.
    final bool above = smoothed > mean;
    if (_aboveLevel != null && above && !_aboveLevel!) {
      if (_steps.isEmpty || at.difference(_steps.last) >= refractory) _steps.add(at);
    }
    _aboveLevel = above;

    _stepsPerMin = swing >= minStepSwingMs2 && _cadence() ? _steps.length * 60.0 / window.inSeconds : 0;
  }

  /// Feet are periodic; road bumps are not. Two steps are all the pattern an honest cadence needs.
  bool _cadence() {
    if (_steps.length < 2) return false;
    final List<int> gaps = <int>[
      for (int i = 1; i < _steps.length; i++) _steps[i].difference(_steps[i - 1]).inMilliseconds,
    ];
    if (gaps.any((int g) => g < minGaitIntervalMs || g > maxGaitIntervalMs)) return false;
    final double mean = gaps.reduce((int a, int b) => a + b) / gaps.length;
    final double spread = gaps.map((int g) => (g - mean).abs()).reduce((double a, double b) => math.max(a, b));
    return mean <= 0 || spread / mean <= 0.5;
  }
}
