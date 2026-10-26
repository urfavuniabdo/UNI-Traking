import 'dart:math' as math;

import '../core/geo.dart';
import '../core/traccer_constants.dart';

/// Dart port of the API motion classifier (`MotionClassifierService`), CONTRACT §5.
///
/// Both sides judge the SAME way, on purpose — the phone and the dashboard have to agree, and every
/// divergence we shipped so far came from one side trusting a number the other one caps:
///  * accuracy worse than `Motion.accuracyRejectM` (35 m) ⇒ UNKNOWN, the sample is not judged
///  * fixes closer than `Motion.minIntervalS` (2 s) apart are dropped
///  * **the ground decides, on the NET displacement of a window**: the mean of the older half of the
///    last `Motion.maxNetWindowS` seconds of fixes to the mean of its newer half. GPS wander is
///    zero-mean noise and cancels out of a mean, while a driver who walks translates the whole
///    window. Endpoint-to-endpoint steps (the old anchor) read his 40 m out-and-back drift as
///    6 km/h and showed «ماشي» to a man standing in a courtyard.
///  * he counts as moved when that net clears both the noise bubble around the mean pair
///    (`Motion.movedCircleFactor` circles, shrunk by √ of the fixes averaged) and what the
///    stationary band itself could wander over the same span — and a window younger than
///    `Motion.minNetSamples` fixes may only prove a vehicle (net above `Motion.walkMaxKmh`),
///    because at 2-3 fixes a drift burst and a slow walk are the same number.
///  * inside the bubble his speed is what is left *after* the bubble is subtracted — which is
///    nothing, so "he has not left his bubble in a minute" is a fact and STOPPED commits without
///    waiting for the hysteresis samples
///  * otherwise a transition commits after `Motion.hysteresisSamples` (3) samples that *disagree
///    with the committed state*, on an EMA (`alpha` 0.35) of the judged speed.
///    Bands: STOPPED ≤1.5 · WALKING ≤7 · else RIDING
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
  final double noiseFloorM;
  final double driftCapM;
  final int minIntervalS;

  /// Mirrors `NOISE_FLOOR_M` / the `accuracyDriftM` ceiling in the API's ingest path.
  static const double _noiseFloorM = 12;
  static const double _driftCapM = 120;

  /// The same cap the API puts on its net window: fixes are cheap, the sliding is what matters.
  static const int _maxWindowFixes = 24;

  double? _ema;
  String _committed = MotionStates.unknown;
  int _disagreeing = 0;
  DateTime? _lastTs;
  _Fix? _lastPoint;
  final List<_Fix> _window = <_Fix>[];

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
    _disagreeing = 0;
    _lastTs = null;
    _lastPoint = null;
    _window.clear();
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
    final _Fix? point = lat != null && lng != null ? _Fix(lat, lng, ts, math.min(math.max(accuracyM, noiseFloorM), driftCapM)) : null;
    final _Ground ground = _groundSpeed(speedKmh: speedKmh, point: point);
    if (point != null) _lastPoint = point;
    final double? judged = ground.speedKmh;
    _lastRaw = judged ?? 0;

    // 4) a conclusive "he never left the bubble" commit — no smoothing of a fact
    if (ground.stationary) {
      _ema = judged ?? 0;
      _committed = MotionStates.stopped;
      _disagreeing = 0;
      return _committed;
    }

    if (judged == null) return _committed; // nothing to go on — keep the last committed state

    // 5) EMA + 6) hysteresis commit. The count is "samples that disagree with the committed
    // state", not "samples that agree with each other": a walking phone's estimate flip-flops
    // across the 7 km/h line (3.4 → 18 → 8.3 → 4.7 km/h on the same stroll), and requiring the
    // same band three times in a row never let him leave STOPPED.
    _ema = _ema == null ? judged : (alpha * judged + (1 - alpha) * _ema!);
    final String band = bandFor(_ema!);
    if (_committed == MotionStates.unknown) {
      _committed = band;
      _disagreeing = 0;
      return _committed;
    }
    if (band == _committed) {
      _disagreeing = 0;
    } else {
      _disagreeing++;
      if (_disagreeing >= hysteresisSamples) {
        _committed = band;
        _disagreeing = 0;
      }
    }
    return _committed;
  }

  /// The speed the coordinates support — `groundSpeed` in the API, same arithmetic.
  _Ground _groundSpeed({required double speedKmh, _Fix? point}) {
    if (point == null) return _Ground(speedKmh, false, false);
    _pushWindow(point);
    final _Fix? prev = _lastPoint;
    final double stepM = prev == null ? 0 : Geo.distanceMeters(prev.lat, prev.lng, point.lat, point.lng);
    final double? stepDtS = prev == null ? null : point.ts.difference(prev.ts).inMilliseconds / 1000.0;
    final _Net net = _netEvidence();

    // A step smaller than the noise circle is not a step: the phone ping-ponging a few metres at
    // 25 m accuracy covers "12 km/h" on paper every 5 s while going nowhere.
    final double? stepDerived = stepDtS != null && stepDtS > 0 && stepM > point.noiseM ? stepM / stepDtS * 3.6 : null;
    final double spanS = net.anchorDtS ?? 0;
    final double? netKmh = spanS > 0 ? net.anchorM / spanS * 3.6 : null;
    final double? candidate = _max(speedKmh, _max(stepDerived, netKmh));

    // One fix is not a window: the coordinates have no opinion yet, so the phone's reading stands.
    if (net.netSamples < 2) return _Ground(candidate, false, false);

    final double bubbleM = Motion.movedCircleFactor * net.noiseRadiusM * math.sqrt(2) / math.sqrt(math.max(2, net.netSamples));
    final double allowanceM = math.max(bubbleM, Motion.stationarySpeedKmh / 3.6 * spanS);
    final bool provesVehicle = netKmh != null && netKmh > Motion.walkMaxKmh;
    if (spanS > 0 && net.anchorM > allowanceM && (net.netSamples >= Motion.minNetSamples || provesVehicle)) {
      return _Ground(candidate, true, false);
    }

    // What the coordinates prove past the bubble is his speed; the part inside it is noise.
    final double bounded = spanS > 0 ? math.max(0, net.anchorM - bubbleM) / spanS * 3.6 : 0;
    return _Ground(candidate == null ? null : math.min(candidate, bounded), false, bounded <= Motion.stationarySpeedKmh);
  }

  void _pushWindow(_Fix fix) {
    _window.add(fix);
    while (_window.length > 1 && fix.ts.difference(_window.first.ts).inMilliseconds > Motion.maxNetWindowS * 1000) {
      _window.removeAt(0);
    }
    while (_window.length > _maxWindowFixes) {
      _window.removeAt(0);
    }
  }

  /// Mean of the older half to mean of the newer half of the window — the API's `netEvidence`.
  _Net _netEvidence() {
    final _Fix whole = _mean(_window);
    if (_window.length < 2) return _Net(0, null, _window.length, whole.noiseM);
    final int half = (_window.length / 2).ceil();
    final _Fix older = _mean(_window.sublist(0, half));
    final _Fix newer = _mean(_window.sublist(half));
    final double anchorDtS = newer.ts.difference(older.ts).inMilliseconds / 1000.0;
    if (anchorDtS <= 0) return _Net(0, null, _window.length, whole.noiseM);
    return _Net(Geo.distanceMeters(older.lat, older.lng, newer.lat, newer.lng), anchorDtS, _window.length, whole.noiseM);
  }

  _Fix _mean(List<_Fix> rows) {
    double lat = 0, lng = 0, ms = 0, noise = 0;
    for (final _Fix r in rows) {
      lat += r.lat;
      lng += r.lng;
      ms += r.ts.millisecondsSinceEpoch;
      noise += r.noiseM;
    }
    return _Fix(lat / rows.length, lng / rows.length, DateTime.fromMillisecondsSinceEpoch((ms / rows.length).round()), (noise / rows.length).roundToDouble());
  }

  static double? _max(double? a, double? b) {
    if (a == null || !a.isFinite) return b;
    if (b == null || !b.isFinite) return a;
    return math.max(a, b);
  }
}

/// A fix's position, time and noise circle — the unit the net window is measured in.
class _Fix {
  const _Fix(this.lat, this.lng, this.ts, this.noiseM);

  final double lat;
  final double lng;
  final DateTime ts;
  final double noiseM;
}

/// The window's net-displacement evidence.
class _Net {
  const _Net(this.anchorM, this.anchorDtS, this.netSamples, this.noiseRadiusM);

  final double anchorM;
  final double? anchorDtS;
  final int netSamples;
  final double noiseRadiusM;
}

/// What the ground says about one speed: did he go anywhere, and how fast.
class _Ground {
  const _Ground(this.speedKmh, this.moved, this.stationary);

  final double? speedKmh;
  final bool moved;
  final bool stationary;
}
