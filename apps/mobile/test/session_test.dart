import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:traccer/core/api_client.dart';
import 'package:traccer/core/api_error.dart';
import 'package:traccer/core/app_config.dart';
import 'package:traccer/core/session_store.dart';
import 'package:traccer/models/user.dart';
import 'package:traccer/state/providers.dart';

/// A JWT-shaped string whose payload expires `expiresIn` seconds from now.
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

/// Serves `/auth/refresh` and answers every other call the way the real API does: a bearer
/// that is missing or past its `exp` gets a 401.
class _SessionAdapter implements HttpClientAdapter {
  _SessionAdapter({this.refreshStatus = 200, this.refreshBody = const <String, Object?>{}});

  final int refreshStatus;
  final Map<String, Object?> refreshBody;
  final List<String> paths = <String>[];
  final List<String?> sentAuth = <String?>[];

  static bool _stale(String? bearer) {
    if (bearer == null) return true;
    final List<String> parts = bearer.replaceFirst('Bearer ', '').split('.');
    if (parts.length < 2) return true;
    final Map<String, Object?> claims = jsonDecode(
      utf8.decode(base64Url.decode(parts[1].padRight((parts[1].length + 3) ~/ 4 * 4, '='))),
    ) as Map<String, Object?>;
    final int exp = (claims['exp'] as num).toInt();
    return DateTime.now().toUtc().millisecondsSinceEpoch ~/ 1000 >= exp;
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    paths.add(options.path);
    if (options.path.endsWith('/auth/refresh')) {
      if (refreshStatus == 0) {
        throw DioException(
          requestOptions: options,
          type: DioExceptionType.connectionError,
          error: 'offline',
        );
      }
      return _json(
        refreshStatus,
        refreshBody.isNotEmpty
            ? refreshBody
            : <String, Object?>{
                'accessToken': _jwt(expiresIn: 900),
                'refreshToken': 'rt-kept',
              },
      );
    }
    final String? bearer = options.headers['Authorization'] as String?;
    sentAuth.add(bearer);
    if (_stale(bearer)) return _json(401, <String, Object?>{'message': 'UNAUTHENTICATED'});
    return _json(200, <String, Object?>{'ok': true});
  }

  ResponseBody _json(int status, Map<String, Object?> body) => ResponseBody.fromString(
        jsonEncode(body),
        status,
        headers: <String, List<String>>{
          Headers.contentTypeHeader: <String>[Headers.jsonContentType]
        },
      );

  @override
  void close({bool force = false}) {}
}

Future<SessionStore> _signedIn({required String accessToken}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    AppConfig.accessTokenKey: accessToken,
    AppConfig.refreshTokenKey: 'rt-kept',
    AppConfig.userJsonKey: jsonEncode(const AppUser(
      id: 'u1',
      identifier: 'E0101',
      name: 'أحمد',
      role: 'EMPLOYEE',
      employeeId: 'emp-1',
      phone: '01000000000',
      driver: false,
    ).toJson()),
  });
  return SessionStore.open();
}

ApiClient _client(SessionStore session, _SessionAdapter adapter) =>
    ApiClient(session: session, dio: Dio(BaseOptions(baseUrl: 'http://test'))
      ..httpClientAdapter = adapter);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('keeping the login alive', () {
    test('an expired access token is renewed before the call goes out', () async {
      final SessionStore session = await _signedIn(accessToken: _jwt(expiresIn: -60));
      final _SessionAdapter adapter = _SessionAdapter();
      final ApiClient api = _client(session, adapter);

      await api.today();

      expect(adapter.paths, contains('/auth/refresh'));
      expect(adapter.sentAuth.single, 'Bearer ${session.accessToken}');
      expect(session.refreshToken, 'rt-kept');
    });

    test('a refresh that cannot run (offline) keeps the session and never says "انتهت الجلسة"',
        () async {
      final SessionStore session = await _signedIn(accessToken: _jwt(expiresIn: -60));
      final _SessionAdapter adapter = _SessionAdapter(refreshStatus: 0);
      final ApiClient api = _client(session, adapter);
      bool ended = false;
      api.onSessionEnded = () => ended = true;

      await expectLater(api.today(), throwsA(isA<NetworkException>()));

      expect(ended, isFalse, reason: 'a dead network is not an expired login');
      expect(session.refreshToken, 'rt-kept');
      expect(session.accessToken, isNotNull);
    });

    test('a 5xx from the refresh endpoint keeps the session', () async {
      final SessionStore session = await _signedIn(accessToken: _jwt(expiresIn: -60));
      final ApiClient api = _client(
        session,
        _SessionAdapter(refreshStatus: 503, refreshBody: <String, Object?>{'message': 'booting'}),
      );
      bool ended = false;
      api.onSessionEnded = () => ended = true;

      await expectLater(api.today(), throwsA(isA<ApiException>()));

      expect(ended, isFalse);
      expect(session.refreshToken, 'rt-kept');
    });

    test('only the server retiring the session ends it — and it says so immediately', () async {
      final SessionStore session = await _signedIn(accessToken: _jwt(expiresIn: -60));
      final ApiClient api = _client(
        session,
        _SessionAdapter(
          refreshStatus: 401,
          refreshBody: <String, Object?>{'statusCode': 401, 'message': 'REFRESH_EXPIRED'},
        ),
      );
      int endedCalls = 0;
      api.onSessionEnded = () => endedCalls++;

      await expectLater(api.today(), throwsA(isA<UnauthorizedException>()));

      expect(endedCalls, 1);
      expect(session.refreshToken, isNull);
      expect(session.accessToken, isNull);
    });
  });

  group('sign-out', () {
    test('clears state and storage even when the tracking plugin refuses to answer', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SessionStore session = await _signedIn(accessToken: _jwt(expiresIn: 900));
      final _LocalOnlyApi api = _LocalOnlyApi(session);
      final ProviderContainer container = ProviderContainer(
        overrides: <Override>[
          sessionStoreProvider.overrideWithValue(session),
          apiClientProvider.overrideWithValue(api),
        ],
      );
      addTearDown(container.dispose);
      expect(container.read(authControllerProvider).user, isNotNull);

      await container.read(authControllerProvider.notifier).logout();

      expect(container.read(authControllerProvider).user, isNull);
      expect(session.accessToken, isNull);
      expect(session.user, isNull);
      expect(api.revoked, 'rt-kept');
    });
  });
}

/// No network in the sign-out test: the revoke and the device handshake are recorded locally.
class _LocalOnlyApi extends ApiClient {
  _LocalOnlyApi(SessionStore session)
      : super(session: session, dio: Dio(BaseOptions(baseUrl: 'http://test')));

  String? revoked;

  @override
  Future<void> registerDevice({
    String? token,
    required String platform,
    required String deviceId,
  }) async {}

  @override
  Future<void> revokeSession({required String? refreshToken}) async => revoked = refreshToken;
}
