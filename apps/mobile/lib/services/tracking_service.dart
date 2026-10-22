import 'dart:async';
import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:geolocator/geolocator.dart';

import '../core/api_client.dart';
import '../core/geo.dart';
import '../core/session_store.dart';
import '../core/traccer_constants.dart';
import '../data/batch_builder.dart';
import '../data/position_dao.dart';
import '../models/position.dart';
import 'adapters/battery_adapter.dart';
import 'adapters/connectivity_adapter.dart';
import 'adapters/device_adapter.dart';
import 'adapters/location_adapter.dart';
import 'motion_classifier.dart';

/// The background tracking brain. It owns:
///   * the live GPS stream (foreground service on Android / BG task on iOS)
///   * the CONTRACT §5 accuracy-drop + speed back-fill + motion classification
///   * the write-ahead offline buffer (every fix hits sqflite BEFORE any network call)
///   * the 30s drain loop + reconnect catch-up (offline looks realtime via `buffered`)
///   * the 300s heartbeat (§2) and GPS/DATA toggle-events (§2/§6)
///
/// The driver never touches this: [start] is fired at check-in, [stop] at check-out.
class TrackingEngine {
  TrackingEngine({
    required this.api,
    required this.dao,
    required this.session,
    required this.location,
    required this.connectivity,
    required this.battery,
    required this.deviceId,
    this.onUiEvent,
  });

  final ApiClient api;
  final PositionDao dao;
  final SessionStore session;
  final LocationAdapter location;
  final ConnectivityAdapter connectivity;
  final BatteryAdapter battery;
  final String deviceId;

  /// Callback the isolate uses to push live status to the UI.
  final void Function(String event, Map<String, Object?> data)? onUiEvent;

  final MotionClassifier _classifier = MotionClassifier();

  StreamSubscription<Position>? _posSub;
  StreamSubscription<bool>? _connSub;
  StreamSubscription<ServiceStatus>? _gpsSub;
  Timer? _drainTimer;
  Timer? _heartbeatTimer;

  bool _tracking = false;
  bool _online = true;
  bool _gpsOn = true;
  bool _outage = false; // became offline since the last clean upload
  int _batchSeq = 0;
  Position? _lastFix;

  bool get isTracking => _tracking;

  Future<void> start() async {
    if (_tracking) return;
    _tracking = true;
    _online = await connectivity.isOnline();
    _gpsOn = await location.isServiceEnabled();
    _batchSeq = session.lastSeq;

    // 1) live fixes
    _posSub = location.positionStream().listen(_onFix, onError: (Object e) {
      _emit('GPS_ERROR', {'message': '$e'});
    });

    // 2) data connectivity → DATA_OFF/DATA_ON + catch-up
    _connSub = connectivity.onChange().listen(_onConnectivity);

    // 3) GPS service toggles → GPS_OFF/GPS_ON
    _gpsSub = location.serviceStatus().listen(_onServiceStatus);

    // 4) drain + heartbeat timers
    _drainTimer = Timer.periodic(Buffer.drainInterval, (_) => _drain());
    _heartbeatTimer = Timer.periodic(
      const Duration(seconds: RuleDefaults.heartbeatIntervalS),
      (_) => _heartbeat(),
    );

    unawaited(_heartbeat()); // immediate, so the dashboard sees the driver instantly
    _emit('STATUS', await _statusSnapshot());
  }

  Future<void> stop() async {
    _tracking = false;
    await _posSub?.cancel();
    await _connSub?.cancel();
    await _gpsSub?.cancel();
    _drainTimer?.cancel();
    _heartbeatTimer?.cancel();
    _posSub = null;
    _connSub = null;
    _gpsSub = null;
    _drainTimer = null;
    _heartbeatTimer = null;
    _lastFix = null;
    _classifier.reset();
    await _drain(catchUp: true); // flush the tail before dying
    await session.markSessionAlive(false); // clean shutdown → no APP_KILLED next launch
    _emit('STATUS', await _statusSnapshot());
  }

  // ---------------------------------------------------------------------------
  // Fix pipeline
  // ---------------------------------------------------------------------------

  Future<void> _onFix(Position p) async {
    // CONTRACT §5: drop fixes worse than ACCURACY_REJECT_M.
    if (p.accuracy > Motion.accuracyRejectM) {
      _emit('FIX_DROPPED', {'reason': 'accuracy', 'accuracy': p.accuracy});
      return;
    }

    final DateTime now = DateTime.now().toUtc();

    // Compute speed when the device didn't provide a usable one.
    double speed = p.speed * 3.6; // m/s -> km/h
    double bearing = p.heading;
    if (speed <= 0.01 && _lastFix != null) {
      speed = Geo.speedKmhFromFixes(
        lat1: _lastFix!.latitude,
        lng1: _lastFix!.longitude,
        t1: DateTime.fromMillisecondsSinceEpoch(_lastFix!.timestamp.millisecondsSinceEpoch),
        lat2: p.latitude,
        lng2: p.longitude,
        t2: now,
      );
      bearing = Geo.bearingDegrees(_lastFix!.latitude, _lastFix!.longitude, p.latitude, p.longitude);
    }
    _lastFix = p;

    final String motion = _classifier.addSample(
      speedKmh: p.speed * 3.6, // raw device speed (may be 0)
      accuracyM: p.accuracy,
      ts: now,
      computedSpeedKmh: speed,
    );

    final int seq = await session.nextSeq();
    final int? batteryPct = await battery.level();

    final TrackPosition row = TrackPosition(
      clientTs: p.timestamp.isUtc
          ? p.timestamp
          : p.timestamp.toUtc(), // capture time on the device (§4)
      lat: p.latitude,
      lng: p.longitude,
      speedKmh: speed,
      bearing: bearing,
      accuracyM: p.accuracy,
      altitudeM: p.altitude,
      batteryPct: batteryPct ?? 0,
      provider: _providerOf(p),
      buffered: false, // decided at upload time
      seq: seq,
      motionState: motion,
    );

    await dao.insert(row); // WRITE-AHEAD: DB first, never lose a point on crash
    if (_online) _scheduleQuickDrain();
    _emit('FIX', {'lat': row.lat, 'lng': row.lng, 'speed': speed, 'motion': motion});
  }

  String _providerOf(Position p) {
    if (p.isMocked) return 'mock';
    return 'gps';
  }

  // ---------------------------------------------------------------------------
  // Drain / offline
  // ---------------------------------------------------------------------------

  Timer? _quickDrain;
  void _scheduleQuickDrain() {
    _quickDrain?.cancel();
    _quickDrain = Timer(const Duration(seconds: 6), () => _drain());
  }

  Future<void> _drain({bool catchUp = false}) async {
    if (!_online) return;
    final List<TrackPosition> pending = await dao.takeBatch(limit: Buffer.takeBatchDefault);
    if (pending.isEmpty) return;

    final DateTime now = DateTime.now().toUtc();
    // A row is a "replay" (offline-buffered) if it sat longer than one drain window.
    final List<TrackPosition> replay = pending
        .where((TrackPosition p) =>
            now.difference(p.clientTs) > Buffer.drainInterval + const Duration(seconds: 15))
        .toList(growable: false);
    final List<TrackPosition> realtime =
        pending.where((TrackPosition p) => !replay.contains(p)).toList(growable: false);

    final List<TrackPosition> flaggedReplay =
        replay.map((TrackPosition p) => p.copyWith(buffered: true)).toList(growable: false);

    final List<BatchPayload> payloads = <BatchPayload>[
      ...BatchBuilder.split(
        deviceId: deviceId,
        startBatchSeq: _nextBatchSeq(realtime.length),
        positions: realtime,
      ),
      ...BatchBuilder.split(
        deviceId: deviceId,
        startBatchSeq: _nextBatchSeq(flaggedReplay.length),
        positions: flaggedReplay,
        forceBuffered: false, // already flagged per-row
      ),
    ];

    try {
      for (final BatchPayload payload in payloads) {
        if (payload.positions.isEmpty) continue;
        final BatchResponse resp = await api.postBatch(payload);
        // Uploaded rows have unique seq; map ids by seq to mark them.
        final List<int> ids = payload.positions
            .map((TrackPosition p) => p.id ?? p.seq)
            .toList(growable: false);
        await dao.markUploaded(ids, buffered: payload.hasBuffered);
        _emit('UPLOADED', {'accepted': resp.accepted, 'deduped': resp.deduped});
      }
      if (catchUp || _outage) {
        _outage = false;
        await _safeToggle('BUFFER_FLUSH');
      }
      final int still = await dao.pendingCount();
      _emit('STATUS', await _statusSnapshot(pending: still));
    } on Exception {
      // stay offline-ish; rows remain uploaded=0 for the next drain/heartbeat cycle.
      _outage = true;
    }
  }

  int _nextBatchSeq(int _) {
    _batchSeq += 1;
    return _batchSeq;
  }

  // ---------------------------------------------------------------------------
  // Toggles + heartbeat
  // ---------------------------------------------------------------------------

  Future<void> _onConnectivity(bool online) async {
    if (online == _online) return;
    _online = online;
    if (!online) {
      _outage = true;
      await _safeToggle('DATA_OFF');
    } else {
      await _safeToggle('DATA_ON');
      await _drain(catchUp: true); // offline looks realtime
    }
    _emit('STATUS', await _statusSnapshot());
  }

  Future<void> _onServiceStatus(ServiceStatus status) async {
    final bool on = status == ServiceStatus.enabled;
    if (on == _gpsOn) return;
    _gpsOn = on;
    await _safeToggle(on ? 'GPS_ON' : 'GPS_OFF');
    _emit('STATUS', await _statusSnapshot());
  }

  Future<void> _safeToggle(String kind) async {
    try {
      await api.toggleEvent(deviceId: deviceId, kind: kind);
    } on Exception {
      // offline: we can't report right now; will re-report on next heartbeat once online
    }
  }

  Future<void> _heartbeat() async {
    final int? level = await battery.level();
    try {
      await api.heartbeat(
        deviceId: deviceId,
        tracking: _tracking,
        gpsEnabled: _gpsOn,
        online: _online,
        battery: level,
      );
    } on Exception {/* missed heartbeat → server raises APP_OFFLINE after 3 cycles */}
  }

  Future<Map<String, Object?>> _statusSnapshot({int? pending}) async {
    final int backlog = pending ?? await dao.pendingCount();
    return <String, Object?>{
      'tracking': _tracking,
      'gpsEnabled': _gpsOn,
      'online': _online,
      'pending': backlog,
      'motionState': _classifier.state,
    };
  }

  void _emit(String event, Map<String, Object?> data) => onUiEvent?.call(event, data);
}

// ===========================================================================
// Isolate entrypoints (must be top-level; referenced by BackgroundServiceAdapter)
// ===========================================================================

@pragma('vm:entry-point')
void trackingOnStart(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();

  final SessionStore session = await SessionStore.open();
  final String deviceId = session.deviceId ?? await DeviceAdapter().deviceId();
  await session.setDeviceId(deviceId);

  // Android: promote to a foreground service with the ongoing tracking notification.
  // Wiring the command listeners first keeps the engine reachable even when the OS
  // refuses the promotion (Android 14+ throws unless location is still granted).
  final TrackingEngine engine = TrackingEngine(
    api: ApiClient(session: session),
    dao: PositionDao(),
    session: session,
    location: const LocationAdapter(),
    connectivity: ConnectivityAdapter(),
    battery: BatteryAdapter(),
    deviceId: deviceId,
    onUiEvent: (String event, Map<String, Object?> data) =>
        service.invoke('ui', <String, Object?>{'event': event, 'data': data}),
  );

  service.on('START').listen((Map<String, dynamic>? _) async {
    await engine.start();
    if (service is AndroidServiceInstance && await service.isForegroundService()) {
      unawaited(service.setForegroundNotificationInfo(title: 'UNI Tracking', content: 'التتبع يعمل تلقائيًا'));
    }
  });

  service.on('SESSION_REFRESH').listen((Map<String, dynamic>? _) => engine.start());

  service.on('STOP').listen((Map<String, dynamic>? _) async {
    await engine.stop();
    if (service is AndroidServiceInstance) unawaited(service.stopSelf());
  });

  // The service is auto-started on boot (see BackgroundServiceAdapter autoStart), but it must
  // only actually track when a shift is open — otherwise stop and stay silent.
  if (!session.isCheckedIn) {
    if (service is AndroidServiceInstance) unawaited(service.stopSelf());
    return;
  }

  // The service is only launched at check-in, so begin immediately.
  if (service is AndroidServiceInstance) {
    try {
      await service.setAsForegroundService();
      await service.setForegroundNotificationInfo(
        title: 'UNI Tracking',
        content: 'التتبع يعمل تلقائيًا',
      );
    } catch (e) {
      debugPrint('[tracking] foreground promotion refused: $e');
    }
  }
  await session.markSessionAlive(true);
  await engine.start();
}

@pragma('vm:entry-point')
Future<bool> trackingOnIosBackground(ServiceInstance service) async {
  DartPluginRegistrant.ensureInitialized();
  // Return true to let the engine keep running for the iOS background window; it will be
  // restarted by workmanager / a launch if the task is suspended.
  return true;
}
