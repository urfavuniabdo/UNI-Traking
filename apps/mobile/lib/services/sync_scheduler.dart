import 'dart:ui' show DartPluginRegistrant;

import 'package:flutter/foundation.dart';
import 'package:workmanager/workmanager.dart';

import '../core/api_client.dart';
import '../core/session_store.dart';
import '../core/traccer_constants.dart';
import '../data/batch_builder.dart';
import '../data/position_dao.dart';
import '../models/position.dart';
import 'adapters/battery_adapter.dart';
import 'adapters/connectivity_adapter.dart';
import 'adapters/location_adapter.dart';

/// Task identifiers.
const String kTaskCatchUp = 'traccer.catchup';
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
/// The unique name is fixed so `replace` collapses repeats instead of queueing them.
Future<void> scheduleCatchUp() async {
  await Workmanager().registerOneOffTask(
    kTaskCatchUp,
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
    existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
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

  // The heartbeat is what keeps a device visible on the dashboard, and an idle employee
  // buffers no positions at all — so it has to run before both short-circuits below.
  await _beat(api, deviceId, session, online: online);

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

/// Report real device state; a hardcoded `gpsEnabled: false` would flip the dashboard's
/// GPS indicator off for a phone that is sitting perfectly still.
Future<void> _beat(ApiClient api, String deviceId, SessionStore session, {required bool online}) async {
  try {
    await api.heartbeat(
      deviceId: deviceId,
      tracking: session.isCheckedIn && (session.user?.isDriver ?? false),
      gpsEnabled: await const LocationAdapter().isServiceEnabled(),
      online: online,
      battery: await BatteryAdapter().level(),
    );
  } on Exception {/* offline / expired token — the next cycle retries */}
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
