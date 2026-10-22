import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/app_config.dart';
import 'package:traccer/services/realtime_service.dart';

/// Live proof that the driver's realtime channel survives a 15-minute token expiry.
///
/// Opt-in because it needs a running API + two dev tokens signed with its JWT_SECRET:
///   RT_LIVE_URL=http://127.0.0.1:3100/api/v1 RT_EXPIRED_TOKEN=… RT_VALID_TOKEN=… flutter test
/// It is skipped silently otherwise.
void main() {
  final String? liveUrl = Platform.environment['RT_LIVE_URL'];
  final String? expired = Platform.environment['RT_EXPIRED_TOKEN'];
  final String? valid = Platform.environment['RT_VALID_TOKEN'];
  final bool ready = liveUrl != null && expired != null && valid != null;

  test(
    'reconnects with a minted token after the server rejects the handshake',
    () async {
      AppConfig.applyOverride(liveUrl);
      final List<bool> forces = <bool>[];
      final RealtimeService rt = RealtimeService();

      rt.connect(
        tokenProvider: ({required bool force}) async {
          forces.add(force);
          return force ? valid : expired;
        },
        userId: 'cmvjcy9m90001ck6aluakdk7t',
      );

      // The server accepts the socket, answers rt:error and drops it; the retry must come back.
      final DateTime deadline = DateTime.now().add(const Duration(seconds: 12));
      while (!rt.isConnected && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }

      expect(forces.first, isFalse, reason: 'first attempt reuses the cached token');
      expect(forces, contains(true), reason: 'a rejected handshake must force a fresh token');
      expect(rt.isConnected, isTrue, reason: 'rt:ready never arrived');
      rt.disconnect();
    },
    skip: ready ? false : 'set RT_LIVE_URL + RT_EXPIRED_TOKEN + RT_VALID_TOKEN to run',
  );
}
