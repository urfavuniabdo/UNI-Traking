import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as socket_io;

import '../core/app_config.dart';
import '../core/traccer_constants.dart';
import '../models/alert.dart';

/// Supplies the socket handshake token. `force: true` must return a freshly minted token.
typedef RtTokenProvider = Future<String?> Function({required bool force});

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
  bool _opening = false;
  RtTokenProvider? _tokenProvider;
  String? _userId;
  bool _disposed = false;
  int _authRetries = 0;
  int _generation = 0;
  Timer? _retryTimer;

  /// Reconnects after a rejected handshake with a *newly minted* token, backing off up to 30s.
  /// The frozen query token is why the old code died for good after the 15-minute TTL.
  void _retryWithFreshToken() {
    if (_disposed || _opening || _retryTimer != null) return;
    _authRetries++;
    _connected = false;
    onStatus?.call(false);
    final int seconds = math.min(30, 1 << math.min(_authRetries, 5));
    rtLog('retry $seconds s later (attempt $_authRetries)');
    _retryTimer = Timer(Duration(seconds: seconds), () {
      _retryTimer = null;
      if (!_disposed) unawaited(_open(force: true));
    });
  }

  bool get isConnected => _connected;

  void connect({required RtTokenProvider tokenProvider, String? userId}) {
    if (_socket != null || _opening) return;
    _disposed = false;
    _authRetries = 0;
    _tokenProvider = tokenProvider;
    _userId = userId;
    unawaited(_open(force: false));
  }

  Future<void> _open({required bool force}) async {
    if (_disposed) return;
    _opening = true;
    try {
      final RtTokenProvider provider = _tokenProvider!;
      final String? token = await provider(force: force);
      if (_disposed) return;
      _socket?.dispose();
      _generation++;
      _socket = _build(token, _generation);
      _socket!.connect();
    } finally {
      _opening = false;
    }
  }

  socket_io.Socket _build(String? token, int gen) {
    final String url = '${AppConfig.socketUrl}/rt';
    final socket_io.Socket socket = socket_io.io(
      url,
      socket_io.OptionBuilder()
          .setTransports(<String>['websocket'])
          .enableReconnection()
          .disableAutoConnect()
          .setQuery(<String, Object?>{'token': token, 'userId': _userId})
          .setExtraHeaders(<String, String>{'Authorization': 'Bearer $token'})
          .build(),
    );

    socket.onConnect((_) {
      // Join the personal room explicitly (namespace auth may already do it server-side).
      if (_userId != null && _userId!.isNotEmpty) {
        socket.emit(
          SocketEvents.subscribeLive,
          <String, Object?>{'userIds': <String>[_userId!]},
        );
      }
    });
    // A bad token still emits `connect` first: the server only answers with `rt:ready` once
    // it has verified it, so that — not `connect` — is the proof the channel is live.
    socket.on(SocketEvents.rtReady, (dynamic _) {
      if (gen != _generation) return;
      _connected = true;
      _authRetries = 0;
      onStatus?.call(true);
    });
    socket.on(SocketEvents.rtError, (dynamic data) {
      if (gen != _generation) return;
      rtLog('handshake rejected: $data');
      _retryWithFreshToken();
    });
    socket.onDisconnect((_) {
      if (gen != _generation) return;
      _connected = false;
      onStatus?.call(false);
    });
    socket.onConnectError((dynamic data) {
      if (gen != _generation) return;
      rtLog('connect_error: $data');
      _retryWithFreshToken();
    });

    socket.on(SocketEvents.notifyMe, (dynamic data) {
      final Map<String, Object?>? json = _asMap(data);
      if (json == null) return;
      onNotifyMe?.call(NotifyMePayload.fromJson(json));
    });

    return socket;
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
    _disposed = true;
    _generation++;
    _retryTimer?.cancel();
    _retryTimer = null;
    _socket?.dispose();
    _socket = null;
    _connected = false;
  }
}

/// Debug helper so accidental `print` lint doesn't fire in this file.
void rtLog(String m) => debugPrint('[rt] $m');
