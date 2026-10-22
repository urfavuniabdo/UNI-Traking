import 'dart:async';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// Single seam for local notifications (flutter_local_notifications).
/// Declares the two channels the app owns and nothing else:
///   * `traccer_alerts`   — high importance, sound + vibration (CONTRACT §6 push mirror)
///   * `traccer_tracking` — low-importance ongoing notification for the foreground service
class NotificationsAdapter {
  NotificationsAdapter() : _plugin = FlutterLocalNotificationsPlugin();

  final FlutterLocalNotificationsPlugin _plugin;
  final StreamController<String?> _tapController = StreamController<String?>.broadcast();

  /// Emits the notification payload on tap (we always route to `/me`).
  Stream<String?> get onTapped => _tapController.stream;

  static const String alertsChannelId = 'traccer_alerts';
  static const String trackingChannelId = 'traccer_tracking';

  AndroidFlutterLocalNotificationsPlugin? get _android =>
      _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();

  Future<void> init() async {
    const AndroidInitializationSettings android =
        AndroidInitializationSettings('@mipmap/ic_launcher');
    const DarwinInitializationSettings ios = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );

    await _plugin.initialize(
      const InitializationSettings(android: android, iOS: ios),
      onDidReceiveNotificationResponse: (NotificationResponse r) =>
          _tapController.add(r.payload),
      // Android 12+ heads-up tap also comes through the background handler.
      onDidReceiveBackgroundNotificationResponse: _backgroundTap,
    );

    // Create channels explicitly so importance/vibration are fixed regardless of first show.
    await _android?.createNotificationChannel(
      const AndroidNotificationChannel(
        alertsChannelId,
        'تنبيهات UNI Tracking',
        description: 'تنبيهات الحضور والتتبع',
        importance: Importance.high,
        enableVibration: true,
        playSound: true,
      ),
    );
    await _android?.createNotificationChannel(
      const AndroidNotificationChannel(
        trackingChannelId,
        'التتبع يعمل',
        description: 'إشعار خدمة التتبع في الخلفية',
        importance: Importance.low,
      ),
    );
  }

  static void _backgroundTap(NotificationResponse r) {
    // A cold-start tap is routed by main() reading the launch payload; nothing else here.
  }

  /// Fire an alert notification. Tap opens `/me` (never a chat) — handled by the app router.
  Future<void> showAlert({
    required int id,
    required String title,
    required String body,
    required bool playSound,
  }) async {
    await _plugin.show(
      id,
      title,
      body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          alertsChannelId,
          'تنبيهات UNI Tracking',
          channelDescription: 'تنبيهات الحضور والتتبع',
          importance: Importance.high,
          priority: Priority.high,
          playSound: playSound,
          enableVibration: true,
          category: AndroidNotificationCategory.alarm,
        ),
        iOS: const DarwinNotificationDetails(
          presentAlert: true,
          presentSound: true,
          interruptionLevel: InterruptionLevel.timeSensitive,
        ),
      ),
      payload: 'traccer://me',
    );
  }

  Future<void> requestPermission() async {
    await _android?.requestNotificationsPermission();
    await _plugin
        .resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>()
        ?.requestPermissions(alert: true, badge: true, sound: true);
  }

  Future<void> cancel(int id) => _plugin.cancel(id);
}
