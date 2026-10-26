import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../tracking_service.dart'; // top-level onStart / onIosBackground entrypoints
import 'notifications_adapter.dart';

/// Single seam for `flutter_background_service` (Android foreground service + iOS tasks).
///
/// Android: an in-process foreground service with `foregroundServiceTypes: [location]` —
///          this is what lets the driver's tracking survive screen-off / app-swipe.
/// iOS:     `onBackground` returns false to let the OS suspend when not actively tracking.
///
/// All the *behaviour* lives in [TrackingEngine] (started by the entrypoint). This class only
/// wires the plugin and the start/stop lifecycle the UI triggers automatically at check-in /
/// check-out — the driver never toggles tracking manually.
class BackgroundServiceAdapter {
  BackgroundServiceAdapter._();
  static final BackgroundServiceAdapter instance = BackgroundServiceAdapter._();

  final FlutterBackgroundService _service = FlutterBackgroundService();
  static const int _notifId = 888;
  bool _configured = false;

  Future<void> configure() async {
    if (_configured) return;
    await _service.configure(
      androidConfiguration: AndroidConfiguration(
        onStart: trackingOnStart, // @pragma('vm:entry-point') in tracking_service.dart
        autoStart: true, // boot receiver restarts it; onStart no-ops unless checked-in
        isForegroundMode: true,
        notificationChannelId: NotificationsAdapter.trackingChannelId,
        initialNotificationTitle: 'UNI Tracking',
        initialNotificationContent: 'التتبع يعمل تلقائيًا',
        foregroundServiceNotificationId: _notifId,
        foregroundServiceTypes: const <AndroidForegroundType>[AndroidForegroundType.location],
      ),
      iosConfiguration: IosConfiguration(
        autoStart: false,
        onForeground: trackingOnStart,
        onBackground: trackingOnIosBackground,
      ),
    );
    _configured = true;
  }

  /// Start tracking (called right after a successful check-in).
  Future<void> startTracking() async {
    await configure();
    if (!await _service.isRunning()) {
      await _service.startService();
    }
    await WakelockPlus.enable();
    _service.invoke('START'); // (re)begin the session inside the isolate
  }

  /// Stop tracking (called right after a successful check-out). Driver never calls this.
  Future<void> stopTracking() async {
    _service.invoke('STOP');
    await WakelockPlus.disable();
  }

  Future<bool> get isRunning => _service.isRunning();

  /// Subscribe the UI to an event the isolate emits via `serviceInstance.invoke(...)`.
  void onFromService(String event, void Function(Map<String, dynamic>? data) handler) =>
      _service.on(event).listen(handler);

  /// Send an ad-hoc command to the isolate.
  void invoke(String command, [Map<String, Object?>? arg]) => _service.invoke(command, arg);
}
