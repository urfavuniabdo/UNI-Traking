import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/api_error.dart';
import '../core/session_store.dart';
import '../core/traccer_constants.dart';
import '../data/position_dao.dart';
import '../models/attendance.dart';
import '../models/user.dart';
import '../services/adapters/background_service_adapter.dart';
import '../services/adapters/connectivity_adapter.dart';
import '../services/adapters/device_adapter.dart';
import '../services/adapters/location_adapter.dart';
import '../services/adapters/notifications_adapter.dart';
import '../services/sync_scheduler.dart';

// --- Overridden in main() with real instances once prefs are ready. ---
final Provider<SessionStore> sessionStoreProvider =
    Provider<SessionStore>((_) => throw UnimplementedError('override in main()'));

/// Whether Firebase initialized (degraded mode = false; app still runs without closed-app push).
final Provider<bool> firebaseReadyProvider = Provider<bool>((_) => false);

final Provider<ApiClient> apiClientProvider =
    Provider<ApiClient>((ref) => ApiClient(session: ref.watch(sessionStoreProvider)));

final Provider<LocationAdapter> locationAdapterProvider =
    Provider<LocationAdapter>((_) => const LocationAdapter());

final Provider<ConnectivityAdapter> connectivityAdapterProvider =
    Provider<ConnectivityAdapter>((_) => ConnectivityAdapter());

final Provider<PositionDao> positionDaoProvider = Provider<PositionDao>((_) => PositionDao());

final Provider<NotificationsAdapter> notificationsProvider =
    Provider<NotificationsAdapter>((_) => NotificationsAdapter());

/// Reactive dark-mode toggle (persisted to SessionStore). The settings sheet flips it and
/// app.dart watches it so the whole tree re-themes instantly.
final StateProvider<bool> darkModeProvider = StateProvider<bool>((ref) {
  return ref.read(sessionStoreProvider).darkMode;
});

final FutureProvider<String> deviceIdProvider = FutureProvider<String>((ref) async {
  final SessionStore s = ref.watch(sessionStoreProvider);
  final String? cached = s.deviceId;
  if (cached != null) return cached;
  final String id = await DeviceAdapter().deviceId();
  await s.setDeviceId(id);
  return id;
});

// ===========================================================================
// Auth
// ===========================================================================

class AuthState {
  const AuthState({this.user, this.busy = false, this.error, this.mustChangePassword = false});
  final AppUser? user;
  final bool busy;
  final String? error;
  final bool mustChangePassword;
  bool get loggedIn => user != null && !mustChangePassword;

  AuthState copyWith({AppUser? user, bool? busy, String? error, bool? mustChangePassword}) =>
      AuthState(
        user: user ?? this.user,
        busy: busy ?? this.busy,
        error: error ?? this.error,
        mustChangePassword: mustChangePassword ?? this.mustChangePassword,
      );
}

final StateNotifierProvider<AuthController, AuthState> authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>((ref) => AuthController(ref));

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._ref) : super(const AuthState()) {
    final SessionStore session = _ref.read(sessionStoreProvider);
    final AppUser? saved = session.user;
    state = AuthState(user: saved, mustChangePassword: session.mustChangePassword);
    if (session.isLoggedIn) {
      unawaited(_ensureDeviceRegistered());
    }
  }

  final Ref _ref;

  Future<void> _ensureDeviceRegistered() async {
    try {
      final String id = await _ref.read(deviceIdProvider.future);
      await _ref.read(apiClientProvider).registerDevice(
            platform: DeviceAdapter().platform,
            deviceId: id,
          );
    } on Exception {
      // Offline or backend down — the push bootstrap retries after login.
    }
  }

  Future<bool> login(String identifier, String password) async {
    state = state.copyWith(busy: true, error: null);
    try {
      final ApiClient api = _ref.read(apiClientProvider);
      final AuthTokens t = await api.login(identifier: identifier, password: password);
      final AppUser user = t.user ?? await api.me();
      final bool mustChange = t.mustChangePassword || user.mustChangePassword;
      await _ref.read(sessionStoreProvider).saveUser(user);
      await _ref.read(sessionStoreProvider).setMustChangePassword(mustChange);
      await _ensureDeviceRegistered();
      state = AuthState(user: user, mustChangePassword: mustChange);
      return !mustChange;
    } on ApiException catch (e) {
      state = state.copyWith(busy: false, error: _ar(e));
      return false;
    } catch (_) {
      state = state.copyWith(busy: false, error: 'تعذر الاتصال بالخادم');
      return false;
    }
  }

  Future<bool> changePassword(String identifier, String oldPw, String newPw) async {
    state = state.copyWith(busy: true);
    try {
      final ApiClient api = _ref.read(apiClientProvider);
      await api.changePassword(oldPassword: oldPw, newPassword: newPw);
      // Re-login so we pick up a token whose user has mustChangePassword=false.
      final AuthTokens t = await api.login(identifier: identifier, password: newPw);
      final AppUser user = t.user ?? await api.me();
      await _ref.read(sessionStoreProvider).saveUser(user);
      await _ref.read(sessionStoreProvider).setMustChangePassword(false);
      state = AuthState(user: user);
      return true;
    } on ApiException catch (e) {
      state = state.copyWith(busy: false, error: _ar(e));
      return false;
    }
  }

  Future<void> logout() async {
    try {
      await _ref.read(apiClientProvider).logout();
    } catch (_) {/* local clear below */}
    await BackgroundServiceAdapter.instance.stopTracking();
    await _ref.read(sessionStoreProvider).setCheckedIn(false);
    state = const AuthState();
  }
}

// ===========================================================================
// Tracking status (bridged from the background isolate's 'ui' channel)
// ===========================================================================

class TrackingUiEvent {
  const TrackingUiEvent(this.event, this.data);
  final String event;
  final Map<String, Object?> data;
}

final StreamProvider<TrackingUiEvent> trackingEventsProvider =
    StreamProvider<TrackingUiEvent>((ref) async* {
  final BackgroundServiceAdapter svc = BackgroundServiceAdapter.instance;
  final StreamController<TrackingUiEvent> controller =
      StreamController<TrackingUiEvent>.broadcast(sync: true);
  svc.onFromService('ui', (Map<String, dynamic>? data) {
    controller.add(TrackingUiEvent(
      (data?['event'] ?? '') as String,
      (data?['data'] as Map?)?.cast<String, Object?>() ?? <String, Object?>{},
    ));
  });
  ref.onDispose(controller.close);
  yield* controller.stream;
});

/// Live home-screen snapshot derived from events + DB, so an offline backlog still shows.
class HomeState {
  const HomeState({
    this.checkedIn = false,
    this.tracking = false,
    this.gpsEnabled = true,
    this.online = true,
    this.pendingCount = 0,
    this.insideFence,
    this.fenceName,
    this.shiftStart,
    this.motionState,
    this.busy = false,
    this.notice,
    this.fenceViolation,
    this.amberOutOfFence = false,
  });

  final bool checkedIn;
  final bool tracking;
  final bool gpsEnabled;
  final bool online;
  final int pendingCount;
  final bool? insideFence;
  final String? fenceName;
  final DateTime? shiftStart;
  final String? motionState;
  final bool busy;
  final String? notice;
  final FenceViolationException? fenceViolation; // null unless a check-in was hard-rejected
  final bool amberOutOfFence; // OUT_OF_FENCE accepted → admins alerted (amber banner)

  HomeState copyWith({
    bool? checkedIn,
    bool? tracking,
    bool? gpsEnabled,
    bool? online,
    int? pendingCount,
    bool? insideFence,
    String? fenceName,
    DateTime? shiftStart,
    String? motionState,
    bool? busy,
    Object? notice = _unset,
    Object? fenceViolation = _unset,
    bool? amberOutOfFence,
  }) =>
      HomeState(
        checkedIn: checkedIn ?? this.checkedIn,
        tracking: tracking ?? this.tracking,
        gpsEnabled: gpsEnabled ?? this.gpsEnabled,
        online: online ?? this.online,
        pendingCount: pendingCount ?? this.pendingCount,
        insideFence: insideFence ?? this.insideFence,
        fenceName: fenceName ?? this.fenceName,
        shiftStart: shiftStart ?? this.shiftStart,
        motionState: motionState ?? this.motionState,
        busy: busy ?? this.busy,
        notice: notice == _unset ? this.notice : notice as String?,
        fenceViolation:
            fenceViolation == _unset ? this.fenceViolation : fenceViolation as FenceViolationException?,
        amberOutOfFence: amberOutOfFence ?? this.amberOutOfFence,
      );
}

/// Sentinel so `copyWith(fenceViolation: null)` can actually clear the field.
const Object _unset = Object();

final StateNotifierProvider<HomeController, HomeState> homeControllerProvider =
    StateNotifierProvider<HomeController, HomeState>((ref) => HomeController(ref));

/// The ONE button. Everything else on `/home` is read-only indicators.
class HomeController extends StateNotifier<HomeState> {
  HomeController(this._ref) : super(const HomeState()) {
    state = HomeState(checkedIn: _ref.read(sessionStoreProvider).isCheckedIn);
    _bootstrap();
  }

  final Ref _ref;
  StreamSubscription<bool>? _gpsSwitchSub;
  StreamSubscription<bool>? _dataSub;
  final List<String> _unpostedToggles = <String>[];

  Future<void> _bootstrap() async {
    await refreshToday();
    await _watchSensors();
    await _refreshPending();
    // Wired before the best-effort platform calls below: losing this subscription would
    // leave the screen deaf to every tracking event with nothing on screen to show it.
    _ref.listen<AsyncValue<TrackingUiEvent>>(trackingEventsProvider, (_, AsyncValue<TrackingUiEvent> next) {
      next.whenData(_applyEvent);
    });
    final SessionStore session = _ref.read(sessionStoreProvider);
    final bool driver = session.user?.isDriver ?? false;
    try {
      if (driver && session.isCheckedIn) {
        // Cold start with an open shift: the foreground tracking service must resume.
        await BackgroundServiceAdapter.instance.startTracking();
        state = state.copyWith(tracking: true);
      }
      // Any signed-in device, driver or not, owns the keepalive: an employee who never
      // tracks still has to keep lastSeenAt fresh or the dashboard shows them as offline.
      if (session.isLoggedIn) await initKeepAliveFromHome();
    } catch (_) {/* WorkManager / background service unavailable — indicators still work */}
  }

  void _applyEvent(TrackingUiEvent e) {
    switch (e.event) {
      case 'STATUS':
        state = state.copyWith(
          tracking: e.data['tracking'] as bool? ?? state.tracking,
          gpsEnabled: e.data['gpsEnabled'] as bool? ?? state.gpsEnabled,
          online: e.data['online'] as bool? ?? state.online,
          pendingCount: (e.data['pending'] as num?)?.toInt() ?? state.pendingCount,
          motionState: (e.data['motionState'] as String?) ?? state.motionState,
        );
        break;
      case 'FIX':
        state = state.copyWith(motionState: (e.data['motion'] as String?) ?? state.motionState);
        break;
      default:
        break;
    }
  }

  Future<void> refreshToday() async {
    try {
      final TodayState today = await _ref.read(apiClientProvider).today();
      state = state.copyWith(
        checkedIn: today.isCheckedIn,
        shiftStart: today.record?.checkInAt,
        fenceName: today.fenceName ?? state.fenceName,
        insideFence: today.insideFence ?? state.insideFence,
      );
      await _ref.read(sessionStoreProvider).setCheckedIn(today.isCheckedIn);
    } on ApiException {
      // offline-tolerant: keep local checkedIn flag
    }
  }

  Future<void> _refreshPending() async {
    state = state.copyWith(pendingCount: await _ref.read(positionDaoProvider).pendingCount());
  }

  /// The GPS/data chips used to be driven only by the tracking isolate, so for anyone who
  /// isn't tracking they sat on HomeState's optimistic defaults and lied. Read the device.
  Future<void> _watchSensors() async {
    final LocationAdapter loc = _ref.read(locationAdapterProvider);
    final ConnectivityAdapter conn = _ref.read(connectivityAdapterProvider);
    try {
      state = state.copyWith(
        gpsEnabled: await loc.isServiceEnabled(),
        online: await conn.isOnline(),
      );
      _gpsSwitchSub = loc.serviceOnOff().listen(
            (bool on) => _onSensor('GPS', on),
            onError: (Object _) {/* plugin gone mid-session */},
          );
      _dataSub = conn.onChange().listen(
            (bool on) => _onSensor('DATA', on),
            onError: (Object _) {/* plugin gone mid-session */},
          );
    } catch (_) {
      // No platform (unit tests, or a plugin that failed to bind): keep the optimistic chips
      // rather than showing a fault that isn't there.
    }
  }

  void _onSensor(String kind, bool on) {
    final bool wasOn = kind == 'GPS' ? state.gpsEnabled : state.online;
    if (on == wasOn) return;
    // The chip flips on the same frame the OS tells us — no server round-trip in the way.
    state = kind == 'GPS' ? state.copyWith(gpsEnabled: on) : state.copyWith(online: on);
    final String eventType = '${kind}_${on ? 'ON' : 'OFF'}';
    if (!on) unawaited(_notifyLocal(eventType));
    unawaited(_postToggle(eventType));
  }

  Future<void> _notifyLocal(String type) async {
    final ({String title, String body})? copy = ArAlertText.byType[type];
    if (copy == null) return;
    try {
      await _ref
          .read(notificationsProvider)
          .showAlert(id: type.hashCode & 0x7fffffff, title: copy.title, body: copy.body, playSound: true);
    } on Exception {/* notifications channel unavailable */}
  }

  /// §2 toggle-event: this is what raises the admin's GPS_OFF/DATA_OFF alert server-side.
  /// DATA_OFF is exactly the moment we have no network, so failed posts are kept and
  /// replayed oldest-first on the next transition — otherwise the admin only ever learns
  /// that the connection came back.
  Future<void> _postToggle(String kind) async {
    if (!_ref.read(sessionStoreProvider).isLoggedIn) return;
    _unpostedToggles.add(kind);
    if (_unpostedToggles.length > 20) _unpostedToggles.removeAt(0);
    try {
      final String deviceId = await _ref.read(deviceIdProvider.future);
      final ApiClient api = _ref.read(apiClientProvider);
      for (final String pending in List<String>.of(_unpostedToggles)) {
        await api.toggleEvent(deviceId: deviceId, kind: pending);
        _unpostedToggles.remove(pending);
      }
    } on Exception {/* still offline — the next transition retries the whole queue */}
  }

  @override
  void dispose() {
    unawaited(_gpsSwitchSub?.cancel());
    unawaited(_dataSub?.cancel());
    super.dispose();
  }

  /// تشيك ان — request permissions → read location → POST → auto-start tracking.
  Future<void> checkIn() async {
    state = state.copyWith(busy: true, notice: null, fenceViolation: null, amberOutOfFence: false);
    final AppUser? user = _ref.read(sessionStoreProvider).user;
    try {
      final PermissionResult perm = await _ref
          .read(locationAdapterProvider)
          .requestPermissions(background: user?.isDriver ?? false);
      if (perm == PermissionResult.denied) {
        state = state.copyWith(busy: false, notice: 'لا يمكن التشيك ان بدون إذن الموقع');
        return;
      }
      final fix = await _ref.read(locationAdapterProvider).currentFix();
      if (fix == null) {
        state = state.copyWith(busy: false, notice: 'تعذّر قراءة الموقع، جرّب مرة أخرى');
        return;
      }
      final AttendanceResult res = await _ref.read(apiClientProvider).checkIn(
            lat: fix.latitude,
            lng: fix.longitude,
            accuracy: fix.accuracy,
            deviceId: await _ref.read(deviceIdProvider.future),
          );
      await _ref.read(sessionStoreProvider).setCheckedIn(true);
      // Auto-start tracking — the driver never presses a tracking button.
      if (user?.isDriver ?? false) {
        await BackgroundServiceAdapter.instance.startTracking();
      }
      await initKeepAliveFromHome();
      state = state.copyWith(
        busy: false,
        checkedIn: true,
        shiftStart: DateTime.now(),
        insideFence: res.isValid,
        fenceName: res.fenceName ?? state.fenceName,
        amberOutOfFence: res.isOutOfFence,
        notice: res.isOutOfFence
            ? 'تم التسجيل خارج النطاق — تم تنبيه المشرف'
            : null,
      );
    } on FenceViolationException catch (e) {
      state = state.copyWith(busy: false, fenceViolation: e);
    } on AlreadyCheckedInException {
      // A 409 only proves the server holds today's record — it may already be closed, and
      // then a button that says تشيك أوت can never succeed. Re-read today instead of
      // assuming, so the CTA always matches the server's truth.
      await refreshToday();
      final bool open = state.checkedIn;
      if (open && (_ref.read(sessionStoreProvider).user?.isDriver ?? false)) {
        await BackgroundServiceAdapter.instance.startTracking();
      }
      state = state.copyWith(
        busy: false,
        notice: open
            ? 'دوامك مفتوح بالفعل — اضغط تشيك أوت لإنهائه'
            : 'تم تسجيل حضورك وانتهى اليوم — لا يمكن بدء دوام آخر بنفس التاريخ',
      );
    } on NetworkException {
      state = state.copyWith(busy: false, notice: 'لا يوجد اتصال — حاول لاحقًا');
    } on ApiException catch (e) {
      state = state.copyWith(busy: false, notice: _ar(e));
    }
  }

  /// تشيك أوت — auto-stops tracking.
  Future<void> checkOut() async {
    state = state.copyWith(busy: true, notice: null);
    try {
      final fix = await _ref.read(locationAdapterProvider).currentFix();
      await _ref.read(apiClientProvider).checkOut(
            lat: fix?.latitude ?? 0,
            lng: fix?.longitude ?? 0,
            accuracy: fix?.accuracy,
            deviceId: await _ref.read(deviceIdProvider.future),
          );
      await _ref.read(sessionStoreProvider).setCheckedIn(false);
      if (_ref.read(sessionStoreProvider).user?.isDriver ?? false) {
        await BackgroundServiceAdapter.instance.stopTracking();
      }
      state = state.copyWith(
        busy: false,
        checkedIn: false,
        shiftStart: null,
        tracking: false,
      );
    } on NoOpenRecordException {
      await _ref.read(sessionStoreProvider).setCheckedIn(false);
      if (_ref.read(sessionStoreProvider).user?.isDriver ?? false) {
        await BackgroundServiceAdapter.instance.stopTracking();
      }
      state = state.copyWith(busy: false, checkedIn: false, notice: 'لا توجد وردية مفتوحة');
    } on NetworkException {
      state = state.copyWith(busy: false, notice: 'لا يوجد اتصال — حاول لاحقًا');
    } on ApiException catch (e) {
      state = state.copyWith(busy: false, notice: _ar(e));
    }
  }

  void dismissFenceViolation() => state = state.copyWith(fenceViolation: null);

  void dismissNotice() => state = state.copyWith(notice: null);

  /// Emergency hold-to-stop (requires the driver to hold 3s). Fires immediately after.
  Future<void> emergencyStopTracking() async {
    await BackgroundServiceAdapter.instance.forceStop();
    // Report to admins so it's never silent power.
    try {
      await _ref.read(apiClientProvider).toggleEvent(
            deviceId: await _ref.read(deviceIdProvider.future),
            kind: 'APP_KILLED',
          );
    } on Exception {/* offline — buffered */}
    state = state.copyWith(tracking: false, notice: 'تم إيقاف التتبع الطارئ — تم تنبيه المشرف');
  }
}

/// Small helper so home can schedule the buffer keep-alive without importing workmanager.
Future<void> initKeepAliveFromHome() async {
  await scheduleKeepAlive();
  await announcePresence();
}

/// The API speaks CONTRACT codes; the driver speaks Arabic. Every screen funnels
/// failures through here so a code never reaches the UI raw.
const Map<String, String> _errorAr = <String, String>{
  'INVALID_CREDENTIALS': 'رقم الموظف أو كلمة المرور غير صحيحة',
  'ACCOUNT_DISABLED': 'الحساب موقوف — راجع المشرف',
  'NO_EMPLOYEE_PROFILE': 'لا يوجد ملف حضور مرتبط بهذا الحساب',
  'CURRENT_PASSWORD_REQUIRED': 'أدخل كلمة مرورك الحالية أولًا',
  'INVALID_REFRESH_TOKEN': 'انتهت الجلسة، سجّل الدخول مرة أخرى',
  'BAD_TOKEN': 'انتهت الجلسة، سجّل الدخول مرة أخرى',
  'ALREADY_CHECKED_IN': 'دوامك مفتوح بالفعل — سجّل الخروج أولًا',
  'NO_OPEN_RECORD': 'لا يوجد دوام مفتوح لتسجيل خروجه',
  'DEVICE_NOT_REGISTERED': 'لم يُسجَّل هذا الجهاز — أعد تسجيل الدخول',
  'DEVICE_ID_REQUIRED': 'تعذّر تعريف الجهاز — أعد تشغيل التطبيق',
};

String _ar(ApiException e) {
  if (e is NetworkException) return 'تعذر الاتصال';
  final String? code = e.code;
  if (code != null) {
    final String? known = _errorAr[code];
    if (known != null) return known;
  }
  return e.message;
}
