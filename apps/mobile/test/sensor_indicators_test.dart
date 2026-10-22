import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:traccer/core/api_client.dart';
import 'package:traccer/core/session_store.dart';
import 'package:traccer/data/position_dao.dart';
import 'package:traccer/models/attendance.dart';
import 'package:traccer/services/adapters/connectivity_adapter.dart';
import 'package:traccer/services/adapters/location_adapter.dart';
import 'package:traccer/state/providers.dart';

class _FakeLocation extends LocationAdapter {
  final StreamController<bool> controller = StreamController<bool>.broadcast();
  bool service = true;

  @override
  Future<bool> isServiceEnabled() async => service;

  @override
  Stream<bool> serviceOnOff() => controller.stream;
}

class _FakeConnectivity extends ConnectivityAdapter {
  final StreamController<bool> controller = StreamController<bool>.broadcast();
  bool online = true;

  @override
  Future<bool> isOnline() async => online;

  @override
  Stream<bool> onChange() => controller.stream;
}

class _FakeDao extends PositionDao {
  @override
  Future<int> pendingCount() async => 0;
}

/// Records the toggle kinds the home screen manages to deliver, and can fail the first
/// attempt at a given kind to stand in for "the network died at that exact moment".
class _RecordingApi extends ApiClient {
  _RecordingApi(SessionStore session, {this.failFirstFor = const <String>{}})
      : super(session: session);

  final Set<String> failFirstFor;
  final Set<String> _alreadyFailed = <String>{};
  final List<String> posted = <String>[];

  @override
  Future<TodayState> today() async => const TodayState(isCheckedIn: false);

  @override
  Future<void> toggleEvent({required String deviceId, required String kind}) async {
    if (failFirstFor.contains(kind) && !_alreadyFailed.contains(kind)) {
      _alreadyFailed.add(kind);
      throw Exception('offline');
    }
    posted.add(kind);
  }
}

Future<ProviderContainer> _boot({
  required _FakeLocation loc,
  required _FakeConnectivity conn,
  required _RecordingApi api,
}) async {
  final ProviderContainer container = ProviderContainer(
    overrides: <Override>[
      sessionStoreProvider.overrideWithValue(await _session()),
      apiClientProvider.overrideWithValue(api),
      locationAdapterProvider.overrideWithValue(loc),
      connectivityAdapterProvider.overrideWithValue(conn),
      positionDaoProvider.overrideWithValue(_FakeDao()),
      trackingEventsProvider.overrideWith((Ref ref) => const Stream<TrackingUiEvent>.empty()),
    ],
  );
  addTearDown(container.dispose);
  container.read(homeControllerProvider);
  await Future<void>.delayed(const Duration(milliseconds: 20));
  return container;
}

Future<SessionStore> _session() async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    'tk.a2': 'access',
    'tk.r3': 'refresh',
    'tk.x1': 'dev-1',
  });
  return SessionStore.open();
}

HomeState _state(ProviderContainer c) => c.read(homeControllerProvider);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the chips read the real device instead of the optimistic defaults', () async {
    final _FakeLocation loc = _FakeLocation()..service = false;
    final _FakeConnectivity conn = _FakeConnectivity()..online = false;
    final ProviderContainer c =
        await _boot(loc: loc, conn: conn, api: _RecordingApi(await _session()));

    expect(_state(c).gpsEnabled, isFalse);
    expect(_state(c).online, isFalse);
  });

  test('flipping the GPS switch updates the chip at once and tells the server', () async {
    final _FakeLocation loc = _FakeLocation();
    final _FakeConnectivity conn = _FakeConnectivity();
    final _RecordingApi api = _RecordingApi(await _session());
    final ProviderContainer c = await _boot(loc: loc, conn: conn, api: api);

    loc.controller.add(false);
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(_state(c).gpsEnabled, isFalse);
    expect(api.posted, <String>['GPS_OFF']);
  });

  test('a DATA_OFF that cannot be delivered is replayed before the DATA_ON after it',
      () async {
    final _FakeLocation loc = _FakeLocation();
    final _FakeConnectivity conn = _FakeConnectivity();
    final _RecordingApi api = _RecordingApi(await _session(), failFirstFor: <String>{'DATA_OFF'});
    final ProviderContainer c = await _boot(loc: loc, conn: conn, api: api);

    // Link drops: the chip reacts, the DATA_OFF post fails because there is no network.
    conn.online = false;
    conn.controller.add(false);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(_state(c).online, isFalse);
    expect(api.posted, isEmpty, reason: 'the admin cannot be told while the link is down');

    // Link returns: DATA_ON is queued behind the outage it is ending.
    conn.controller.add(true);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(_state(c).online, isTrue);
    expect(api.posted, <String>['DATA_OFF', 'DATA_ON']);
  });
}
