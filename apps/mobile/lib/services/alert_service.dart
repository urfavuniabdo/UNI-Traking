import 'dart:async';
import 'dart:ui' show DartPluginRegistrant;

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../core/session_store.dart';
import '../core/traccer_constants.dart';
import '../models/alert.dart';
import 'adapters/notifications_adapter.dart';

/// Top-level FCM background handler. MUST be top-level and annotated; it runs in its own
/// isolate, so it rebuilds its own SessionStore/ApiClient rather than touching the UI one.
@pragma('vm:entry-point')
Future<void> traccerFcmBackgroundHandler(RemoteMessage message) async {
  DartPluginRegistrant.ensureInitialized();
  // We can't show a heads-up notification reliably from BG, so just log + let the OS deliver
  // the OS-rendered FCM notification (the server already sets notification.title/body).
  debugPrint('[fcm-bg] ${message.messageId} ${message.data}');
}

/// Single seam for push + alert presentation.
///
///  * FirebaseMessaging onMessage / onBackground / onLaunch (FCM/APNs mirror of §7 events)
///  * local notification via NotificationsAdapter (channel `traccer_alerts`, sound+vibrate)
///  * tap ALWAYS opens `/me` — never a chat (product rule)
///  * on token refresh → POST `/devices/register` (§2, idempotent by deviceId)
///  * foreground socket `notify:me` payloads are surfaced here too (see RealtimeService)
class AlertService {
  AlertService({
    required this.notifications,
    required this.session,
    required this.api,
    required this.deviceId,
    this.onAlertTap,
  });

  final NotificationsAdapter notifications;
  final SessionStore session;
  final ApiClient api;
  final String deviceId;
  final void Function(String payload)? onAlertTap;

  FirebaseMessaging? _messaging;
  StreamSubscription<RemoteMessage>? _fgSub;
  StreamSubscription<RemoteMessage>? _openedSub;
  StreamSubscription<String>? _tokenSub;

  bool get _driver => session.user?.isDriver ?? false;

  /// Ask for push permission and start all handlers. Safe to call once at app bootstrap.
  Future<void> init() async {
    await notifications.init();
    await notifications.requestPermission();

    final FirebaseMessaging messaging = FirebaseMessaging.instance;
    _messaging = messaging;

    await messaging.requestPermission(alert: true, sound: true, badge: true);
    FirebaseMessaging.onBackgroundMessage(traccerFcmBackgroundHandler);

    // Foreground push → local heads-up.
    _fgSub = FirebaseMessaging.onMessage.listen(_handleMessage);

    // Tapped a notification (background or terminated launch) → route to /me.
    _openedSub = FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage m) {
      onAlertTap?.call('traccer://me');
    });

    // Cold start from a notification.
    final RemoteNotification? initial = (await messaging.getInitialMessage())?.notification;
    if (initial != null) onAlertTap?.call('traccer://me');

    // Token + refresh → register device (§2).
    final String? token = await messaging.getToken();
    if (token != null) await _register(token);
    _tokenSub = messaging.onTokenRefresh.listen(_register);
  }

  Future<void> _register(String token) async {
    try {
      await api.registerDevice(token: token, platform: const DeviceAdapterPlatform().name, deviceId: deviceId);
    } on Exception catch (e) {
      debugPrint('[alert] register failed: $e');
    }
  }

  Future<void> _handleMessage(RemoteMessage message) async {
    final Map<String, Object?> data = message.data;
    final String alertType = (data['alertType'] ?? data['type'] ?? '') as String;

    // Driver only sees the subset in DRIVER_VISIBLE_ALERTS (§6).
    if (_driver && alertType.isNotEmpty && !DriverVisibleAlerts.all.contains(alertType)) {
      return;
    }

    final String title = message.notification?.title ??
        (data['title'] as String?) ??
        _fallbackAr(alertType).title;
    final String body = message.notification?.body ??
        (data['body'] as String?) ??
        _fallbackAr(alertType).body;

    await notifications.showAlert(
      id: message.hashCode & 0x7fffffff,
      title: title,
      body: body,
      playSound: session.soundEnabled,
    );
    onAlertTap?.call('traccer://me');
  }

  /// `notify:me` payload from the socket (CONTRACT §7) while the app is open.
  Future<void> handleNotifyMe(NotifyMePayload payload) async {
    await notifications.showAlert(
      id: payload.hashCode & 0x7fffffff,
      title: payload.title,
      body: payload.body,
      playSound: session.soundEnabled,
    );
  }

  ({String title, String body}) _fallbackAr(String type) {
    final entry = ArAlertText.byType[type];
    return (title: entry?.title ?? 'تنبيه UNI Tracking', body: entry?.body ?? '');
  }

  Future<void> dispose() async {
    await _fgSub?.cancel();
    await _openedSub?.cancel();
    await _tokenSub?.cancel();
    await _messaging?.deleteToken();
  }
}

/// Tiny wrapper so we can request permission + name without importing Platform in the header.
class DeviceAdapterPlatform {
  const DeviceAdapterPlatform();
  String get name {
    switch (defaultTargetPlatform) {
      case TargetPlatform.iOS:
        return 'ios';
      default:
        return 'android';
    }
  }
}
