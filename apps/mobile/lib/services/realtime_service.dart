import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;

import '../core/app_config.dart';
import '../core/traccer_constants.dart';
import '../models/alert.dart';

/// Single seam for Socket.IO (CONTRACT §7, namespace `/rt`).
///
/// Only the events that matter to a driver/employee are consumed here:
///   * `notify:me`  → { title, body, alertType } (self alert; forwarded to AlertService)
/// Push (FCM) mirrors the same events while the app is closed, so this is the *foreground*
/// path. The client joins its own room (`user:<id>`) server-side based on the auth token.
class RealtimeService {
  RealtimeService({this.onNotifyMe, this.onStatus});

  final void Function(NotifyMePayload payload)? onNotifyMe;
  final void Function(bool connected)? onStatus;

  socket_io.Socket? _socket;
  bool _connected = false;

  bool get isConnected => _connected;

  void connect({required String accessToken, String? userId}) {
    if (_socket != null) return;
    final String url = '${AppConfig.socketUrl}/rt';
    final socket_io.Socket socket = socket_io.io(
      url,
      socket_io.OptionBuilder()
          .setTransports(<String>['websocket'])
          .enableReconnection()
          .disableAutoConnect()
          .setQuery(<String, Object?>{'token': accessToken, 'userId': userId})
          .setExtraHeaders(<String, String>{'Authorization': 'Bearer $accessToken'})
          .build(),
    );

    socket.onConnect((_) {
      _connected = true;
      onStatus?.call(true);
      // Join the personal room explicitly (namespace auth may already do it server-side).
      if (userId != null && userId.isNotEmpty) {
        socket.emit('subscribe:live', <String, Object?>{'userIds': <String>[userId]});
      }
    });
    socket.onDisconnect((_) {
      _connected = false;
      onStatus?.call(false);
    });

    socket.on(SocketEvents.notifyMe, (dynamic data) {
      final Map<String, Object?>? json = _asMap(data);
      if (json == null) return;
      onNotifyMe?.call(NotifyMePayload.fromJson(json));
    });

    socket.connect();
    _socket = socket;
  }

  Map<String, Object?>? _asMap(dynamic data) {
    if (data is Map<String, Object?>) return data;
    if (data is String) {
      try {
        final Object? decoded = jsonDecode(data);
        return decoded is Map<String, Object?> ? decoded : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
    _connected = false;
  }
}

/// Debug helper so accidental `print` lint doesn't fire in this file.
void rtLog(String m) => debugPrint('[rt] $m');
