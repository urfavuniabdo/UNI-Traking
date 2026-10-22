import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:traccer/core/api_client.dart';
import 'package:traccer/core/api_error.dart';
import 'package:traccer/core/app_config.dart';
import 'package:traccer/core/session_store.dart';

/// Nest serialises `ConflictException('ALREADY_CHECKED_IN')` as
/// `{statusCode, message, error}` — the CONTRACT code lands in `message`, there is no
/// `code` field. Reading it wrong makes the driver see a raw code and skips the typed
/// recovery (a double check-in has to flip the button to تشيك أوت, not shrug).
class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.status, this.body);

  final int status;
  final Map<String, Object?> body;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      ResponseBody.fromString(
        jsonEncode(body),
        status,
        headers: <String, List<String>>{
          Headers.contentTypeHeader: <String>[Headers.jsonContentType]
        },
      );

  @override
  void close({bool force = false}) {}
}

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

void main() {
  Future<ApiClient> serve(int status, Map<String, Object?> body) async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      AppConfig.accessTokenKey: _jwt(expiresIn: 3600),
      AppConfig.refreshTokenKey: 'rt-test',
    });
    final SessionStore session = await SessionStore.open();
    return ApiClient(session: session, dio: Dio()..httpClientAdapter = _StubAdapter(status, body));
  }

  test('code carried in `message` becomes the typed exception', () async {
    final ApiClient api = await serve(409, <String, Object?>{
      'statusCode': 409,
      'message': 'ALREADY_CHECKED_IN',
      'error': 'Conflict'
    });
    await expectLater(
      api.checkIn(lat: 30.0444, lng: 31.2357, deviceId: 'dev-1'),
      throwsA(isA<AlreadyCheckedInException>()),
    );
  });

  test('NO_OPEN_RECORD on check-out is typed too', () async {
    final ApiClient api = await serve(409, <String, Object?>{
      'statusCode': 409,
      'message': 'NO_OPEN_RECORD',
      'error': 'Conflict'
    });
    await expectLater(
      api.checkOut(lat: 30.0444, lng: 31.2357, deviceId: 'dev-1'),
      throwsA(isA<NoOpenRecordException>()),
    );
  });

  test('an explicit `code` still wins', () async {
    final ApiClient api = await serve(422, <String, Object?>{
      'statusCode': 422,
      'code': 'FENCE_VIOLATION',
      'message': 'خارج النطاق',
      'fenceName': 'المقر الرئيسي',
      'distanceToCenterM': 4200,
      'allowedFences': <Object>['المقر الرئيسي']
    });
    await expectLater(
      api.checkIn(lat: 30.1, lng: 31.4, deviceId: 'dev-1'),
      throwsA(isA<FenceViolationException>()),
    );
  });

  test('a human sentence is never mistaken for a code', () async {
    final ApiClient api = await serve(400, <String, Object?>{
      'statusCode': 400,
      'message': 'lat must be a number',
      'error': 'Bad Request'
    });
    final ApiException e = await api
        .checkIn(lat: 30.1, lng: 31.4, deviceId: 'dev-1')
        .then<ApiException>((_) => throw StateError('should have failed'))
        .catchError((Object err) => err as ApiException);
    expect(e.code, isNull);
    expect(e.message, 'lat must be a number');
  });
}
