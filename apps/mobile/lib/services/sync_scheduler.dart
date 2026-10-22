import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/foundation.dart';
import 'package:workmanager/workmanager.dart';

import '../core/api_client.dart';
import '../core/session_store.dart';
import '../core/traccer_constants.dart';
import '../data/batch_builder.dart';
import '../data/position_dao.dart';
import '../models/position.dart';
import 'adapters/connectivity_adapter.dart';

/// Task identifiers.
const String kTaskCatchUp = 'traccer.catchup';
const String kTaskHeartbeat = 'traccer.heartbeat';
const String kKeepAliveTag = 'traccer.keepalive';

/// Top-level WorkManager dispatcher. Runs in its own isolate, so it re-opens everything.
@pragma('vm:entry-point')
void traccerBackgroundDispatcher() {
  Workmanager().executeTask((String task, Map<String, dynamic>? inputData) async {
    DartPluginRegistrant.ensureInitialized();
    try {
      switch (task) {
        case kTaskCatchUp:
          return await _catchUpUpload();
        case kTaskHeartbeat:
          return await _heartbeatOnly();
        default:
          return true;
      }
    } catch (e) {
      debugPrint('[workmanager] $task failed: $e');
      return false; // tell WorkManager to retry per its backoff
    }
  });
}

Future<void> initSyncScheduler() async {
  await Workmanager().initialize(traccerBackgroundDispatcher);
}

/// Kick a one-off catch-up whenever we (re)connect or the app launches.
Future<void> scheduleCatchUp() async {
  await Workmanager().registerOneOffTask(
    '$kTaskCatchUp-${DateTime.now().millisecondsSinceEpoch}',
    kTaskCatchUp,
    constraints: Constraints(networkType: NetworkType.connected),
    existingWorkPolicy: ExistingWorkPolicy.replace,
  );
}

/// A ~15-min periodic safety net: flush the buffer + heartbeat even if the foreground
/// service was killed. The actual location service auto-restarts via autoStart+boot receiver
/// (see BackgroundServiceAdapter); this keeps data flowing meanwhile.
Future<void> scheduleKeepAlive() async {
  await Workmanager().registerPeriodicTask(
    kKeepAliveTag,
    kTaskCatchUp,
    frequency: const Duration(minutes: 15),
    constraints: Constraints(networkType: NetworkType.connected),
    existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
  );
}

Future<void> cancelKeepAlive() => Workmanager().cancelByTag(kKeepAliveTag);

// ---------------------------------------------------------------------------
// In-isolate catch-up upload (no full engine — just drain the offline buffer).
// ---------------------------------------------------------------------------

Future<bool> _catchUpUpload() async {
  final SessionStore session = await SessionStore.open();
  final String? deviceId = session.deviceId;
  if (deviceId == null || !session.isLoggedIn) return true; // nothing to do

  final PositionDao dao = PositionDao();
  final ApiClient api = ApiClient(session: session);
  final bool online = await ConnectivityAdapter().isOnline();
  if (!online) return false;

  final List<TrackPosition> pending = await dao.takeBatch(limit: Buffer.takeBatchDefault);
  if (pending.isEmpty) return true;

  final DateTime now = DateTime.now().toUtc();
  final List<TrackPosition> replay = pending
      .where((TrackPosition p) => now.difference(p.clientTs) > Buffer.drainInterval)
      .map((TrackPosition p) => p.copyWith(buffered: true))
      .toList(growable: false);

  final List<BatchPayload> chunks = BatchBuilder.split(
    deviceId: deviceId,
    startBatchSeq: session.lastSeq,
    positions: replay,
  );
  for (final BatchPayload payload in chunks) {
    await api.postBatch(payload);
    await dao.markUploaded(
      payload.positions.map((TrackPosition p) => p.id ?? p.seq).toList(growable: false),
      buffered: true,
    );
  }
  await api.toggleEvent(deviceId: deviceId, kind: 'BUFFER_FLUSH');
  return true;
}

Future<bool> _heartbeatOnly() async {
  final SessionStore session = await SessionStore.open();
  final String? deviceId = session.deviceId;
  if (deviceId == null || !session.isLoggedIn) return true;
  final ApiClient api = ApiClient(session: session);
  final bool online = await ConnectivityAdapter().isOnline();
  await api.heartbeat(
    deviceId: deviceId,
    tracking: false,
    gpsEnabled: false,
    online: online,
  );
  return true;
}

/// Detect an unclean previous exit and report APP_KILLED (§2). Called once at app launch.
Future<void> reportUncleanKillIfNeeded() async {
  final SessionStore session = await SessionStore.open();
  final String? deviceId = session.deviceId;
  if (deviceId == null) return;
  if (session.sessionWasAlive) {
    // Previous session never marked clean shutdown → it was killed/crashed.
    final ApiClient api = ApiClient(session: session);
    try {
      await api.toggleEvent(deviceId: deviceId, kind: 'APP_KILLED');
    } on Exception {/* offline; the next heartbeat/toggle covers it */}
  }
  // Fresh session start.
  await session.markSessionAlive(session.isCheckedIn);
}
