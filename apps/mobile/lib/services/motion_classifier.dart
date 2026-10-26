import 'dart:math' as math;

import '../core/geo.dart';
import '../core/traccer_constants.dart';

/// Dart port of the API motion classifier (`MotionClassifierService`), CONTRACT §5.
///
/// Both sides judge the SAME way, on purpose — the phone and the dashboard have to agree, and every
/// divergence we shipped so far came from one side trusting a number the other one caps:
///  * accuracy worse than `Motion.accuracyRejectM` (35 m) ⇒ UNKNOWN, the sample is not judged
///  * fixes closer than `Motion.minIntervalS` (2 s) apart are dropped
///  * **the ground decides**: the anchor is the last position whose movement was confirmed; a fix
///    still inside that anchor's noise circle has not gone anywhere, so whatever the chip's Doppler
///    says, its speed is capped at `radius / time-since-anchor`. A phone lying on a desk drifts 16 m
///    in 3 s — 19 km/h on paper — and used to read as "ماشي" here while the server said "واقف".
///  * movement confirmed (past the circle) ⇒ the phone's reading stands, and the metres covered can
///    raise it (a walking phone under-reports Doppler by design)
///  * once the cap itself falls inside the stationary band, "he has not left his circle in a minute"
///    is not an estimate any more: STOPPED commits without waiting for the hysteresis samples
///  * otherwise a transition commits after `Motion.hysteresisSamples` (3) agreeing samples, on an
///    EMA (`alpha` 0.35) of the judged speed; bands: STOPPED ≤1.5 · WALKING ≤7 · else RIDING
class MotionClassifier {
  MotionClassifier({
    this.alpha = Motion.speedEmaAlpha,
    this.hysteresisSamples = Motion.hysteresisSamples,
    this.accuracyRejectM = Motion.accuracyRejectM,
    this.minIntervalS = Motion.minIntervalS,
    this.noiseFloorM = _noiseFloorM,
    this.driftCapM = _driftCapM,
  });

  final double alpha;
  final int hysteresisSamples;
  final double accuracyRejectM;
  final int minIntervalS;
  final double noiseFloorM;
  final double driftCapM;

  /// Mirrors `NOISE_FLOOR_M` / the `accuracyDriftM` ceiling in the API's ingest path.
  static const double _noiseFloorM = 12;
  static const double _driftCapM = 120;

  double? _ema;
  String _committed = MotionStates.unknown;
  String _candidate = MotionStates.unknown;
  int _candidateCount = 0;
  DateTime? _lastTs;
  _Fix? _lastPoint;
  _Fix? _anchor;

  String get state => _committed;
  double? get smoothedSpeedKmh => _ema;

  /// The speed this classifier judged for the last accepted sample — Doppler and covered metres,
  /// capped by what the coordinates can prove. Callers upload exactly this number so the backend
  /// reads the same figure the phone's own state was derived from.
  double get lastRawSpeedKmh => _lastRaw;

  double _lastRaw = 0;

  void reset() {
    _ema = null;
    _committed = MotionStates.unknown;
    _candidate = MotionStates.unknown;
    _candidateCount = 0;
    _lastTs = null;
    _lastPoint = null;
    _anchor = null;
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

    // 3) the ground truth of this fix
    final _Fix? point = lat != null && lng != null ? _Fix(lat, lng, ts) : null;
    final double? judged = _judge(speedKmh: speedKmh, accuracyM: accuracyM, point: point);
    if (point != null) _lastPoint = point;
    _lastRaw = judged ?? 0;

    // 4) a conclusive "he never left the circle" commit — no smoothing of a fact
    if (_conclusiveStop) {
      _conclusiveStop = false;
      _ema = judged ?? 0;
      _committed = MotionStates.stopped;
      _candidate = MotionStates.stopped;
      _candidateCount = 0;
      return _committed;
    }

    if (judged == null) return _committed; // nothing to go on — keep the last committed state

    // 5) EMA + 6) hysteresis commit
    _ema = _ema == null ? judged : (alpha * judged + (1 - alpha) * _ema!);
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

  bool _conclusiveStop = false;

  /// The speed the coordinates support — `groundSpeed` in the API, same arithmetic.
  double? _judge({required double speedKmh, required double accuracyM, _Fix? point}) {
    _anchor ??= point;
    if (point == null || _anchor == null) return speedKmh;

    final _Fix anchor = _anchor!;
    final double noiseRadiusM = math.min(math.max(accuracyM, noiseFloorM), driftCapM);
    final double anchorM = Geo.distanceMeters(anchor.lat, anchor.lng, point.lat, point.lng);
    final double anchorDtS = point.differenceMs(anchor) / 1000;

    // A step smaller than the noise circle is not a step: the phone ping-ponging a few metres at
    // 25 m accuracy covers "12 km/h" on paper every 5 s while going nowhere. Only the anchor window
    // carries the truth until he actually leaves the circle — and it still proves a real walk.
    final double? stepDerived = _stepEvidence(point, noiseRadiusM);
    final double? derived = _max(stepDerived, anchorDtS > 0 ? anchorM / anchorDtS * 3.6 : null);
    final double? candidate = _max(speedKmh, derived);

    if (anchorM > noiseRadiusM) {
      // confirmed travel: the anchor moves with him
      _anchor = point;
      return candidate;
    }
    if (anchorDtS <= 0) return candidate;
    final double cap = noiseRadiusM / anchorDtS * 3.6;
    _conclusiveStop = cap <= Motion.stationarySpeedKmh;
    return cap < (candidate ?? cap) ? cap : candidate;
  }

  double? _stepEvidence(_Fix point, double noiseRadiusM) {
    final _Fix? prev = _lastPoint;
    if (prev == null || prev == point) return null;
    final double stepM = Geo.distanceMeters(prev.lat, prev.lng, point.lat, point.lng);
    if (stepM <= noiseRadiusM) return null;
    final double dtS = point.differenceMs(prev) / 1000;
    if (dtS <= 0) return null;
    return stepM / dtS * 3.6;
  }

  static double? _max(double? a, double? b) {
    if (a == null || !a.isFinite) return b;
    if (b == null || !b.isFinite) return a;
    return math.max(a, b);
  }
}

/// A fix's position and time — the unit the anchor window and the step speed are measured in.
class _Fix {
  const _Fix(this.lat, this.lng, this.ts);

  final double lat;
  final double lng;
  final DateTime ts;

  double differenceMs(_Fix other) => ts.difference(other.ts).inMilliseconds.toDouble();
}
