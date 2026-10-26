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
///
/// The phone's own IMU is the second witness when the coordinates are silent (§5):
///  * `stepsPerMin` ≥ `Motion.stepsPerMinOnFoot` puts his feet on the ground, so the judged speed is
///    capped at `Motion.walkMaxKmh` — a man striding down a corridor and a car crawling in traffic sit
///    in the same GPS band and only the sensor tells them apart;
///  * `motionEnergyMs2` below `Motion.stillEnergyMs2` is a device nobody touched, whatever the
///    receiver claims, and STOPPED commits at once;
///  * a jump that needs more than `Motion.maxAccelMs2` is a relocated fix, not a driver — nothing new
///    is asserted about him;
///  * while he is standing, a *young* window may not state him as moving until `Motion.moveConfirmS`
///    after the coordinates first claimed it — that is what stopped his apartment's wake-up burst
///    from opening a journey that never closed.
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
  DateTime? _moveStartTs;
  _Fix? _lastPoint;
  double? _prevJudgedKmh;
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
    _moveStartTs = null;
    _prevJudgedKmh = null;
    _window.clear();
    _lastRaw = 0;
  }

  /// Band a *smoothed* speed maps to, per §5 thresholds.
  String bandFor(double speedKmh) {
    if (speedKmh <= Motion.stationarySpeedKmh) return MotionStates.stopped;
    if (speedKmh <= Motion.walkMaxKmh) return MotionStates.walking;
    return MotionStates.riding;
  }

  /// Feet or wheels is not a speed question — `onFoot` in the API, same cap.
  double? onFoot(double? stepsPerMin, double? kmh) {
    if (kmh == null) return null;
    if (stepsPerMin != null && stepsPerMin >= Motion.stepsPerMinOnFoot) {
      return math.min(kmh, Motion.walkMaxKmh);
    }
    return kmh;
  }

  /// Can a body get from `prevKmh` to `kmh` in `dtS`? One missing number is nothing to test.
  bool plausibleAccel(double? prevKmh, double? kmh, double? dtS) {
    if (prevKmh == null || kmh == null) return true;
    if (dtS == null || dtS <= 0) return true;
    return (kmh - prevKmh).abs() / 3.6 / dtS <= Motion.maxAccelMs2;
  }

  /// Feed one fix. Returns the committed state after this sample.
  String addSample({
    required double speedKmh,
    required double accuracyM,
    required DateTime ts,
    double? lat,
    double? lng,
    double? stepsPerMin,
    double? motionEnergyMs2,
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
    final _Ground ground = _groundSpeed(
      speedKmh: speedKmh,
      point: point,
      stepsPerMin: stepsPerMin,
      motionEnergyMs2: motionEnergyMs2,
    );
    if (point != null) _lastPoint = point;
    final double? judged = ground.speedKmh;
    _lastRaw = judged ?? 0;

    // 4) a conclusive "he never left the bubble" commit — no smoothing of a fact
    if (ground.stationary) {
      _ema = judged ?? 0;
      _committed = MotionStates.stopped;
      _disagreeing = 0;
      _moveStartTs = null;
      _prevJudgedKmh = judged;
      return _committed;
    }

    // 5) a move has to hold before it may re-state a standing driver, then 6) EMA + 7) hysteresis.
    final String? held = _confirmMove(ts, judged, moved: ground.moved, mature: ground.mature);
    final String next = held ?? _classify(judged);
    _prevJudgedKmh = judged;
    return next;
  }

  /// The API's `confirmMove`: null means "say what the speed says", a state means "he is held".
  String? _confirmMove(DateTime ts, double? speedKmh, {required bool moved, required bool mature}) {
    if (_committed != MotionStates.stopped) {
      _moveStartTs = null;
      return null;
    }
    if (!moved) return null;
    if (!mature) {
      _moveStartTs ??= ts;
      if (ts.difference(_moveStartTs!).inMilliseconds < Motion.moveConfirmS * 1000) return _committed;
    }
    _moveStartTs = null;
    _disagreeing = hysteresisSamples; // a proven move is stronger than the three samples would ask
    return null;
  }

  /// The API's `classify`: EMA of the judged speed, committed after `hysteresisSamples` samples that
  /// disagree with the committed state — not samples that agree with each other. A walking phone's
  /// estimate flip-flops across the 7 km/h line (3.4 → 18 → 8.3 → 4.7 km/h on the same stroll), and
  /// requiring the same band three times in a row never let him leave STOPPED.
  String _classify(double? speedKmh) {
    if (speedKmh == null || !speedKmh.isFinite) return _committed;
    _ema = _ema == null ? speedKmh : (alpha * speedKmh + (1 - alpha) * _ema!);
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
  _Ground _groundSpeed({
    required double speedKmh,
    required _Fix? point,
    double? stepsPerMin,
    double? motionEnergyMs2,
  }) {
    if (point == null) return _Ground(onFoot(stepsPerMin, speedKmh), false, false, false, false);
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
    final double? reported = _max(speedKmh, _max(stepDerived, netKmh));
    final bool mature = net.netSamples >= Motion.minNetSamples;

    // One fix is not a window: the coordinates have no opinion yet, so the phone's reading stands.
    if (net.netSamples < Motion.minWindowFixes) {
      return _Ground(onFoot(stepsPerMin, reported), false, false, false, mature);
    }

    final double bubbleM = Motion.movedCircleFactor * net.noiseRadiusM * math.sqrt(2) / math.sqrt(math.max(2, net.netSamples));
    final double allowanceM = math.max(bubbleM, Motion.stationarySpeedKmh / 3.6 * spanS);
    final double grounded = spanS > 0 ? math.max(0, net.anchorM - bubbleM) / spanS * 3.6 : 0;

    // The accelerometer is the witness the receiver cannot bribe: a phone lying flat in a pocket
    // varies by ~0.02 m/s² whatever the satellites say.
    final bool still = motionEnergyMs2 != null && motionEnergyMs2 < Motion.stillEnergyMs2;
    if (still) {
      return _Ground(onFoot(stepsPerMin, math.min(grounded, Motion.stationarySpeedKmh)), false, true, false, mature);
    }

    final bool provesVehicle = netKmh != null && netKmh > Motion.walkMaxKmh;
    final bool moved = spanS > 0 && net.anchorM > allowanceM && (mature || provesVehicle);
    if (!moved) {
      // Inside his bubble the device is not believed: what the coordinates leave over is his speed.
      final double bounded = reported == null ? grounded : math.min(reported, grounded);
      return _Ground(onFoot(stepsPerMin, bounded), false, grounded <= Motion.stationarySpeedKmh, false, mature);
    }

    // Kinematic plausibility, the last gate before the state changes: 0.9 → 136 km/h inside 16 s is
    // a phone waking from doze with a cached fix, not a driver.
    final double claimed = reported ?? grounded;
    if (!plausibleAccel(_prevJudgedKmh, claimed, stepDtS)) {
      return _Ground(_prevJudgedKmh ?? claimed, false, false, true, mature);
    }
    return _Ground(onFoot(stepsPerMin, claimed), true, false, false, mature);
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
  const _Ground(this.speedKmh, this.moved, this.stationary, this.implausible, this.mature);

  final double? speedKmh;
  final bool moved;
  final bool stationary;

  /// The step demanded more acceleration than grip allows — a relocated fix, so nothing built on it
  /// may change his state.
  final bool implausible;

  /// The window has averaged enough fixes to state a walk on its own, without the MOVE_CONFIRM_S hold.
  final bool mature;
}
