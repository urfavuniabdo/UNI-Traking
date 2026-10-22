import 'dart:math' as math;

import '../core/geo.dart';
import '../core/traccer_constants.dart';

/// Dart port of the API/shared motion classifier (CONTRACT §5).
///
/// Behaviour (must match the backend so both sides agree on "واقف / ماشي / في رحلة"):
///  * accuracy worse than `Motion.accuracyRejectM` (35m) ⇒ state = UNKNOWN, sample is
///    ignored for smoothing/hysteresis (no ghost transitions from a bad fix)
///  * speed is smoothed with an EMA:  `ema = alpha*raw + (1-alpha)*ema`, alpha = 0.35
///  * instant band from the *smoothed* speed: STOPPED ≤1.5 · WALKING ≤7 · else RIDING
///  * a transition only commits after `Motion.hysteresisSamples` (3) consecutive samples
///    agree on the new band — this rejects GPS jitter around a threshold
///  * fixes closer than `Motion.minIntervalS` (2s) apart are dropped (no double-ticks)
class MotionClassifier {
  MotionClassifier({
    this.alpha = Motion.speedEmaAlpha,
    this.hysteresisSamples = Motion.hysteresisSamples,
    this.accuracyRejectM = Motion.accuracyRejectM,
    this.minIntervalS = Motion.minIntervalS,
  });

  final double alpha;
  final int hysteresisSamples;
  final double accuracyRejectM;
  final int minIntervalS;

  double? _ema;
  String _committed = MotionStates.unknown;
  String _candidate = MotionStates.unknown;
  int _candidateCount = 0;
  DateTime? _lastTs;
  _Fix? _lastPoint;

  String get state => _committed;
  double? get smoothedSpeedKmh => _ema;

  /// The best speed (km/h) the classifier used for the last accepted sample — Doppler or the
  /// metres actually covered, whichever is higher. Callers upload this so the backend judges
  /// the same number the phone did instead of a walking phone's near-zero Doppler reading.
  double get lastRawSpeedKmh => _lastRaw;

  double _lastRaw = 0;

  void reset() {
    _ema = null;
    _committed = MotionStates.unknown;
    _candidate = MotionStates.unknown;
    _candidateCount = 0;
    _lastTs = null;
    _lastPoint = null;
    _lastRaw = 0;
  }

  /// Band a *smoothed* speed maps to, per §5 thresholds.
  String bandFor(double speedKmh) {
    if (speedKmh <= Motion.stationarySpeedKmh) return MotionStates.stopped;
    if (speedKmh <= Motion.walkMaxKmh) return MotionStates.walking;
    return MotionStates.riding;
  }

  /// Feed one fix. Returns the committed state after this sample.
  String addSample({
    required double speedKmh,
    required double accuracyM,
    required DateTime ts,
    double? computedSpeedKmh,
    double? lat,
    double? lng,
  }) {
    // 1) accuracy gate
    if (accuracyM > accuracyRejectM || accuracyM <= 0) {
      _lastRaw = 0;
      return MotionStates.unknown;
    }

    // 2) min-interval gate (uses real timestamp of the fix)
    if (_lastTs != null && ts.difference(_lastTs!).inMilliseconds < minIntervalS * 1000) {
      _lastRaw = 0; // nothing was judged for this fix — don't let a stale reading travel with it
      return _committed;
    }
    _lastTs = ts;

    // 3) EMA on the best reading of this fix. A phone carried at walking pace reports a
    //    GPS-Doppler speed near zero, so what the fixes actually cover wins when it is larger;
    //    a shift inside the accuracy circle is drift, not walking, so it is not counted.
    final _Fix? prev = _lastPoint;
    double derived = 0;
    if (prev != null && lat != null && lng != null) {
      final double movedM = Geo.distanceMeters(prev.lat, prev.lng, lat, lng);
      if (movedM > accuracyM) {
        derived = Geo.speedKmhFromFixes(
          lat1: prev.lat,
          lng1: prev.lng,
          t1: prev.ts,
          lat2: lat,
          lng2: lng,
          t2: ts,
        );
      }
    }
    final double raw = <double>[speedKmh, computedSpeedKmh ?? 0, derived].reduce(math.max);
    _lastRaw = raw;
    if (lat != null && lng != null) _lastPoint = _Fix(lat, lng, ts);
    _ema = _ema == null ? raw : (alpha * raw + (1 - alpha) * _ema!);

    // 4) candidate band + 5) hysteresis commit
    final String band = bandFor(_ema!);
    if (band == _committed) {
      _candidate = band;
      _candidateCount = 0;
    } else if (band == _candidate) {
      _candidateCount++;
      if (_candidateCount >= hysteresisSamples) {
        _committed = band;
        _candidateCount = 0;
      }
    } else {
      _candidate = band;
      _candidateCount = 1;
      // From UNKNOWN there is no meaningful "committed" band yet — accept the first sample
      // so we leave UNKNOWN promptly.
      if (_committed == MotionStates.unknown) _committed = band;
    }
    return _committed;
  }
}

/// The previous fix's position and time, used to measure what the device actually covered.
class _Fix {
  const _Fix(this.lat, this.lng, this.ts);

  final double lat;
  final double lng;
  final DateTime ts;
}
