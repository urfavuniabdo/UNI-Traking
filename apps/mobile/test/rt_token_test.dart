import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:traccer/core/api_client.dart';
import 'package:traccer/core/app_config.dart';
import 'package:traccer/core/session_store.dart';

/// A JWT-shaped string whose payload claims expire `expiresIn` seconds from now.
String _jwt({required int expiresIn}) {
  String seg(Map<String, Object?> claims) =>
      base64Url.encode(utf8.encode(jsonEncode(claims))).replaceAll('=', '');
  final int exp =
      DateTime.now().toUtc().add(Duration(seconds: expiresIn)).millisecondsSinceEpoch ~/ 1000;
  return '${seg(<String, Object?>{'alg': 'HS256'})}.${seg(<String, Object?>{
        'sub': 'u1',
        'exp': exp
      })}.sig';
}

class _RecordingAdapter implements HttpClientAdapter {
  final List<String> paths = <String>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    paths.add(options.path);
    if (options.path.endsWith('/auth/refresh')) {
      return ResponseBody.fromString(
        jsonEncode(<String, Object?>{
          'accessToken': _jwt(expiresIn: 3600),
          'refreshToken': 'rt-new',
        }),
        200,
        headers: <String, List<String>>{
          Headers.contentTypeHeader: <String>[Headers.jsonContentType]
        },
      );
    }
    return ResponseBody.fromString('{}', 404);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  late _RecordingAdapter adapter;
  late SessionStore session;
  late ApiClient api;

  Future<void> signIn({required String accessToken}) async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      AppConfig.accessTokenKey: accessToken,
      AppConfig.refreshTokenKey: 'rt-old',
    });
    session = await SessionStore.open();
    adapter = _RecordingAdapter();
    api = ApiClient(session: session, dio: Dio()..httpClientAdapter = adapter);
  }

  group('freshAccessToken (the /rt handshake)', () {
    test('hands back a still-valid token without touching the network', () async {
      await signIn(accessToken: _jwt(expiresIn: 3600));
      expect(await api.freshAccessToken(force: false), session.accessToken);
      expect(adapter.paths, isEmpty);
    });

    test('refreshes an expired token instead of shipping it to the socket', () async {
      await signIn(accessToken: _jwt(expiresIn: -60));
      final String stale = session.accessToken!;
      final String? next = await api.freshAccessToken(force: false);
      expect(next, isNot(stale));
      expect(adapter.paths, <String>['/auth/refresh']);
    });

    test('force mints a new token even when the cached one is valid', () async {
      await signIn(accessToken: _jwt(expiresIn: 3600));
      await api.freshAccessToken(force: true);
      expect(adapter.paths, <String>['/auth/refresh']);
    });

    test('a token about to expire counts as expired', () async {
      await signIn(accessToken: _jwt(expiresIn: 10));
      await api.freshAccessToken(force: false);
      expect(adapter.paths, <String>['/auth/refresh']);
    });

    test('an unparseable token is treated as expired', () async {
      await signIn(accessToken: 'not-a-jwt');
      await api.freshAccessToken(force: false);
      expect(adapter.paths, <String>['/auth/refresh']);
    });

    test('the refreshed token is persisted, so the next call is free', () async {
      await signIn(accessToken: _jwt(expiresIn: -60));
      final String? next = await api.freshAccessToken(force: false);
      expect(session.accessToken, next);
      adapter.paths.clear();
      expect(await api.freshAccessToken(force: false), next);
      expect(adapter.paths, isEmpty);
    });
  });
}
