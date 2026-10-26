import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:dio/dio.dart';

import '../models/alert.dart';
import '../models/attendance.dart';
import '../models/leave.dart';
import '../models/position.dart';
import '../models/user.dart';
import 'api_error.dart';
import 'app_config.dart';
import 'session_store.dart';

/// The only place that talks HTTP to apps/api. Everything else goes through this.
///
/// Responsibilities (task brief):
///  * base URL from `--dart-define=API_URL` (default Android-emulator host alias)
///  * `Authorization: Bearer <accessToken>` on every call except `/auth/login` & `/health`
///  * single-flight refresh on 401 (one refresh even if N requests 401 at once)
///  * typed errors for FENCE_VIOLATION / ALREADY_CHECKED_IN / NO_OPEN_RECORD (§3)
///  * exponential backoff + jitter, retried ONLY on network failures (never on 4xx)
class ApiClient {
  ApiClient({required this.session, Dio? dio, math.Random? random})
      : _random = random ?? math.Random(),
        _dio = dio ??
            Dio(BaseOptions(
              baseUrl: AppConfig.apiUrl,
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 20),
              headers: <String, Object?>{'Accept': 'application/json'},
            )) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        // Async on purpose: Dio waits for `handler.next`, so the token can be renewed here
        // instead of the call going out on an expired one and eating a 401 round-trip.
        onRequest: (RequestOptions options, RequestInterceptorHandler handler) async {
          final bool public = options.path.contains('/auth/login') || options.path == '/health';
          if (!public) {
            String? token = session.accessToken;
            // The refresh call itself must never recurse into a refresh.
            if (token != null &&
                token.isNotEmpty &&
                !options.path.contains('/auth/refresh') &&
                _isExpired(token)) {
              token = await _ensureRefreshed() ?? token;
            }
            if (token != null && token.isNotEmpty) {
              options.headers['Authorization'] = 'Bearer $token';
            }
          }
          final String? device = session.deviceId;
          if (device != null && device.isNotEmpty) {
            options.headers['x-device-id'] = device;
          }
          handler.next(options);
        },
      ),
    );
  }

  final Dio _dio;
  final SessionStore session;
  final math.Random _random;

  /// Called after the SERVER retires this session (logout elsewhere, a refresh token older
  /// than the session window). The app wires it to the auth controller so the router moves to
  /// /login on the spot instead of leaving the screen up with dead tokens.
  void Function()? onSessionEnded;

  /// Guard so concurrent 401s trigger exactly one `/auth/refresh`.
  Future<String?>? _refreshFlight;

  /// Repoint this client at the server currently held in [AppConfig] (Settings override).
  void rebase() => _dio.options.baseUrl = AppConfig.apiUrl;

  /// Liveness probe for the server picker. Never throws: `false` means "unreachable or unhealthy".
  ///
  /// A sleeping Render instance accepts the connection immediately but holds it for up to a
  /// minute while the container boots, so the old 8 s read timed out on a server that was
  /// actually coming up — and the picker rolled the tester back to a dead LAN address.
  Future<bool> healthy() async {
    try {
      final Response<Object?> res = await _dio.get<Object?>(
        '/health',
        options: Options(
          connectTimeout: const Duration(seconds: 20),
          receiveTimeout: const Duration(seconds: 75),
        ),
      );
      final Object? body = res.data;
      return res.statusCode == 200 && body is Map && body['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  // ===========================================================================
  // Auth & devices (§2)
  // ===========================================================================

  /// A usable access token for out-of-band auth (the `/rt` socket handshake).
  ///
  /// The socket never sees the 401-triggered refresh below because it authenticates with a
  /// token baked into its query string, so it must ask for one here. `force: true` mints a
  /// new pair even if the cached token still looks valid.
  Future<String?> freshAccessToken({required bool force}) async {
    final String? current = session.accessToken;
    if (!force && current != null && current.isNotEmpty && !_isExpired(current)) {
      return current;
    }
    if (force) _refreshFlight = null;
    return _ensureRefreshed();
  }

  /// True when the JWT's `exp` has passed (or lands within 30s), or it can't be read at all.
  static bool _isExpired(String jwt) {
    final List<String> parts = jwt.split('.');
    if (parts.length < 2) return true;
    try {
      final String padded = parts[1].padRight((parts[1].length + 3) ~/ 4 * 4, '=');
      final Map<String, Object?> claims =
          jsonDecode(utf8.decode(base64Url.decode(padded))) as Map<String, Object?>;
      final Object? exp = claims['exp'];
      if (exp is! num) return true;
      final DateTime expiresAt =
          DateTime.fromMillisecondsSinceEpoch(exp.toInt() * 1000, isUtc: true);
      return DateTime.now().toUtc().add(const Duration(seconds: 30)).isAfter(expiresAt);
    } catch (_) {
      return true;
    }
  }

  Future<AuthTokens> login({required String identifier, required String password}) async {
    final Map<String, Object?> data = await _postJson(
      '/auth/login',
      data: <String, Object?>{'identifier': identifier, 'password': password},
      retry: false,
    );
    final AuthTokens tokens = AuthTokens.fromJson(data);
    await session.saveTokens(tokens);
    return tokens;
  }

  Future<AuthTokens> refresh(String refreshToken) async {
    final Map<String, Object?> data = await _postJson(
      '/auth/refresh',
      data: <String, Object?>{'refreshToken': refreshToken},
      retry: false,
    );
    final AuthTokens tokens = AuthTokens.fromJson(data);
    await session.saveTokens(tokens);
    return tokens;
  }

  Future<AppUser> me() async {
    final Map<String, Object?> data = await _getJson('/auth/me');
    // GET /auth/me is wrapped: {user, profile, permissions, mustChangePassword}.
    // Reading the body flat used to yield an empty user.
    final Map<String, Object?> user = <String, Object?>{
      ...?data['user'] as Map<String, Object?>?,
      'mustChangePassword': data['mustChangePassword'] ?? false,
    };
    return AppUser.fromJson(user);
  }

  /// Forced password change for first-login accounts (`changeOnLogin=true`, §8).
  /// Endpoint not spelled out in CONTRACT §2 — we POST `/auth/change-password`; if the API
  /// hasn't implemented it we surface the typed error so the caller can fall back to re-login.
  Future<void> changePassword({required String oldPassword, required String newPassword}) async {
    await _postJson(
      '/auth/change-password',
      data: <String, Object?>{'currentPassword': oldPassword, 'newPassword': newPassword},
    );
  }

  /// Best-effort server-side revoke. The caller clears the local session and paints the login
  /// screen first, so this is fired and forgotten with the token it captured beforehand —
  /// `/auth/logout` proves ownership from the refresh token, not from a still-live bearer.
  Future<void> revokeSession({required String? refreshToken}) async {
    final String? rt = refreshToken;
    if (rt == null || rt.isEmpty) return;
    try {
      await _dio.post<Map<String, Object?>>(
        '/auth/logout',
        data: <String, Object?>{'refreshToken': rt},
      );
    } on DioException {
      // Offline or the server is cold: the session row ages out on its own.
    }
  }

  Future<void> registerDevice({
    String? token,
    required String platform, // "android" | "ios"
    required String deviceId,
  }) async {
    await _postJson(
      '/devices/register',
      data: <String, Object?>{
        if (token != null && token.isNotEmpty) 'token': token,
        'platform': platform,
        'appVersion': AppConfig.appVersion,
        'deviceId': deviceId,
      },
    );
  }

  Future<void> heartbeat({
    required String deviceId,
    required bool tracking,
    required bool gpsEnabled,
    required bool online,
    int? battery,
  }) async {
    await _postJson(
      '/devices/heartbeat',
      data: <String, Object?>{
        'deviceId': deviceId,
        'battery': battery,
        'tracking': tracking,
        'gpsEnabled': gpsEnabled,
        'online': online,
      },
    );
  }

  /// kind ∈ {GPS_OFF, GPS_ON, DATA_OFF, DATA_ON, APP_KILLED, BUFFER_FLUSH} (§2 / §6).
  Future<void> toggleEvent({required String deviceId, required String kind}) async {
    await _postJson(
      '/devices/toggle-event',
      data: <String, Object?>{'deviceId': deviceId, 'kind': kind},
    );
  }

  /// «طلب مساعدة طارئة» — the driver held the circle for three seconds (§6). The server owns the
  /// identity (from the bearer token) and pushes a CRITICAL alert straight to the admins.
  Future<void> requestHelp() async {
    await _postJson('/devices/help');
  }

  // ===========================================================================
  // Attendance (§3)
  // ===========================================================================

  Future<AttendanceResult> checkIn({
    required double lat,
    required double lng,
    double? accuracy,
    required String deviceId,
  }) async {
    final Map<String, Object?> data = await _postJson(
      '/attendance/check-in',
      data: <String, Object?>{'lat': lat, 'lng': lng, 'accuracy': accuracy, 'deviceId': deviceId},
    );
    return AttendanceResult.fromJson(data);
  }

  Future<AttendanceResult> checkOut({
    required double lat,
    required double lng,
    double? accuracy,
    required String deviceId,
  }) async {
    final Map<String, Object?> data = await _postJson(
      '/attendance/check-out',
      data: <String, Object?>{'lat': lat, 'lng': lng, 'accuracy': accuracy, 'deviceId': deviceId},
    );
    return AttendanceResult.fromJson(data);
  }

  Future<TodayState> today() async {
    final Map<String, Object?> data = await _getJson('/attendance/me/today');
    return TodayState.fromJson(data);
  }

  Future<List<AttendanceDay>> history({required DateTime from, required DateTime to}) async {
    final Map<String, Object?> data = await _getJson(
      '/attendance/me/history',
      query: <String, Object?>{
        'from': _dateOnly(from),
        'to': _dateOnly(to),
        'page': 1,
        'pageSize': 100,
      },
    );
    final Object? items = data['items'];
    if (items is! List) return const <AttendanceDay>[];
    return items
        .whereType<Map<String, Object?>>()
        .map(AttendanceDay.fromJson)
        .toList(growable: false);
  }

  String _dateOnly(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  // ===========================================================================
  // Leave (§3) — own requests only; the HR desk decides them on the dashboard
  // ===========================================================================

  Future<LeaveRequest> createLeave({
    required String dateFrom,
    String? dateTo,
    String? reason,
  }) async {
    final Map<String, Object?> data = await _postJson(
      '/leave',
      data: <String, Object?>{
        'dateFrom': dateFrom,
        if (dateTo != null) 'dateTo': dateTo,
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      },
    );
    return LeaveRequest.fromJson(data);
  }

  Future<LeavePage> myLeaveRequests() async {
    final Map<String, Object?> data = await _getJson(
      '/leave/mine',
      query: <String, Object?>{'page': 1, 'pageSize': 100},
    );
    return LeavePage.fromJson(data);
  }

  Future<LeaveRequest> cancelLeave(String id) async {
    final Map<String, Object?> data = await _patchJson('/leave/${Uri.encodeComponent(id)}/cancel');
    return LeaveRequest.fromJson(data);
  }

  // ===========================================================================
  // Position ingest (§4) — the ONLY position entrypoint
  // ===========================================================================

  Future<BatchResponse> postBatch(BatchPayload payload) async {
    final Map<String, Object?> data = await _postJson('/positions/batch', data: payload.toJson());
    return BatchResponse.fromJson(data);
  }

  // ===========================================================================
  // Alerts (§6/§7) — own list only for employee/driver
  // ===========================================================================

  Future<List<TraccerAlert>> myAlerts() async {
    final List<Object?> rows = await _getList('/alerts/me');
    return rows.whereType<Map<String, Object?>>().map(TraccerAlert.fromJson).toList(growable: false);
  }

  // ===========================================================================
  // Transport internals
  // ===========================================================================

  /// Sends [action], retrying on *network* failures with exp backoff + jitter, and doing a
  /// single-flight refresh + one replay on 401.
  Future<T> _guarded<T>(Future<T> Function() action) => _send(action, retry: true);

  Future<Map<String, Object?>> _postJson(
    String path, {
    Object? data,
    bool retry = true,
  }) =>
      _send(
        () async =>
            (await _dio.post<Map<String, Object?>>(path, data: data)).data ?? <String, Object?>{},
        retry: retry,
      );

  Future<Map<String, Object?>> _patchJson(
    String path, {
    Object? data,
    bool retry = true,
  }) =>
      _send(
        () async =>
            (await _dio.patch<Map<String, Object?>>(path, data: data)).data ?? <String, Object?>{},
        retry: retry,
      );

  Future<Map<String, Object?>> _getJson(
    String path, {
    Map<String, Object?>? query,
  }) =>
      _guarded(
        () async =>
            (await _dio.get<Map<String, Object?>>(path, queryParameters: query)).data ??
            <String, Object?>{},
      );

  Future<List<Object?>> _getList(String path) => _guarded(
        () async =>
            (await _dio.get<List<Object?>>(path)).data ?? const <Object?>[],
      );

  Future<T> _send<T>(
    Future<T> Function() action, {
    required bool retry,
    int attempt = 0,
    bool allowRefresh = true,
  }) async {
    try {
      return await action();
    } on DioException catch (e) {
      // 401 -> single-flight refresh then one replay (never for login/refresh themselves).
      if (e.response?.statusCode == 401 && allowRefresh && !e.requestOptions.path.contains('/auth/')) {
        final String? newToken = await _ensureRefreshed();
        if (newToken != null) {
          return _send<T>(action, retry: retry, attempt: attempt, allowRefresh: false);
        }
        // The session is still stored — the refresh just couldn't run (offline, a cold server,
        // a 5xx). Telling him his login ended when it didn't is what sent him hunting for a
        // re-login screen that was never needed.
        if (session.refreshToken != null) {
          throw const NetworkException(message: 'لا يوجد اتصال بالخادم');
        }
        throw const UnauthorizedException();
      }
      if (retry && _isNetworkFailure(e)) {
        if (attempt < 4) {
          await _backoff(attempt);
          return _send<T>(action, retry: true, attempt: attempt + 1, allowRefresh: allowRefresh);
        }
        throw const NetworkException(message: 'تعذر الاتصال بالخادم');
      }
      throw _toApiError(e);
    }
  }

  Future<String?> _ensureRefreshed() {
    // Reuse the in-flight refresh if another request already started one.
    return _refreshFlight ??= () async {
      try {
        final String? rt = session.refreshToken;
        if (rt == null) return null;
        final AuthTokens t = await refresh(rt);
        return t.accessToken;
      } catch (e) {
        // Only the server saying "this session no longer exists" ends the login. A network
        // blip, a 5xx or a cold Render container must not log a driver out mid-shift — the
        // buffered rows and the retry loop handle those, and the next call tries again.
        if (e is ApiException && e.statusCode == 401 && _sessionIsDead(e)) await _endSession();
        return null;
      } finally {
        // allow the next 401 burst after this one settles
        Timer(const Duration(seconds: 1), () => _refreshFlight = null);
      }
    }();
  }

  /// Codes the API returns when the stored session row is gone, revoked, or older than the
  /// refresh window. Anything else (a guard rejecting a role, a malformed body) keeps it.
  bool _sessionIsDead(ApiException e) {
    final String text = '${e.code ?? ''} ${e.message}';
    return text.contains('REFRESH_EXPIRED') ||
        text.contains('INVALID_REFRESH_TOKEN') ||
        text.contains('ACCOUNT_DISABLED');
  }

  Future<void> _endSession() async {
    await session.clear();
    onSessionEnded?.call();
  }

  bool _isNetworkFailure(DioException e) =>
      e.type == DioExceptionType.connectionError ||
      e.type == DioExceptionType.connectionTimeout ||
      e.type == DioExceptionType.sendTimeout ||
      e.type == DioExceptionType.receiveTimeout ||
      (e.response == null && e.type == DioExceptionType.unknown);

  Future<void> _backoff(int attempt) async {
    // 200ms, 400ms, 800ms, 1600ms * (0.5..1.0 jitter)
    final double base = 200 * math.pow(2, attempt).toDouble();
    final double jitter = base * (0.5 + _random.nextDouble() * 0.5);
    await Future<void>.delayed(Duration(milliseconds: jitter.round()));
  }

  ApiException _toApiError(DioException e) {
    final int? status = e.response?.statusCode;
    final Object? body = e.response?.data;
    final Map<String, Object?> json =
        body is Map<String, Object?> ? body : <String, Object?>{};
    final String message = (json['message'] ?? 'خطأ في الاتصال') as String;
    // Nest's ConflictException/NotFoundException carry the CONTRACT code as the exception
    // *message* with no `code` field, so a SCREAMING_SNAKE message has to be read as one —
    // otherwise the typed handlers (double check-in, no open shift) never fire.
    final String code = ((json['code'] ?? '') as String).isNotEmpty
        ? json['code'] as String
        : (_codeLike.hasMatch(message) ? message : '');

    if (status == 401) return UnauthorizedException(message: message);
    switch (code) {
      case 'FENCE_VIOLATION':
        return FenceViolationException.fromJson(json);
      case 'ALREADY_CHECKED_IN':
        return AlreadyCheckedInException(message: message, statusCode: status, data: json);
      case 'NO_OPEN_RECORD':
        return NoOpenRecordException(message: message, statusCode: status, data: json);
      default:
        return ApiException(message: message, statusCode: status, code: code.isEmpty ? null : code, data: json);
    }
  }

  static final RegExp _codeLike = RegExp(r'^[A-Z][A-Z0-9_]{2,}$');

  void close() => _dio.close(force: true);
}
