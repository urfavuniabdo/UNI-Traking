import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:traccer/core/api_client.dart';
import 'package:traccer/core/app_strings.dart';
import 'package:traccer/core/session_store.dart';
import 'package:traccer/core/traccer_constants.dart';
import 'package:traccer/data/position_dao.dart';
import 'package:traccer/features/auth/login_screen.dart';
import 'package:traccer/features/history/history_screen.dart';
import 'package:traccer/features/home/home_screen.dart';
import 'package:traccer/features/leave/leave_screen.dart';
import 'package:traccer/features/notifications/notifications_screen.dart';
import 'package:traccer/features/onboarding/onboarding_screen.dart';
import 'package:traccer/features/settings/settings_sheet.dart';
import 'package:traccer/models/alert.dart';
import 'package:traccer/models/attendance.dart';
import 'package:traccer/models/leave.dart';
import 'package:traccer/models/user.dart';
import 'package:traccer/state/providers.dart';
import 'package:traccer/theme.dart';

Future<void> _loadFont(String family, String path) async {
  final Uint8List bytes = await File(path).readAsBytes();
  final FontLoader loader = FontLoader(family)
    ..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
  await loader.load();
}

class _FakeApi extends ApiClient {
  _FakeApi(
    SessionStore session, {
    TodayState? today,
    List<AttendanceDay>? history,
    List<TraccerAlert>? alerts,
    List<LeaveRequest>? leave,
  })  : _today = today ?? const TodayState(isCheckedIn: false),
        _history = history,
        _alerts = alerts,
        _leave = leave,
        super(session: session);

  final TodayState _today;
  final List<AttendanceDay>? _history;
  final List<TraccerAlert>? _alerts;
  final List<LeaveRequest>? _leave;

  @override
  Future<TodayState> today() async => _today;

  @override
  Future<List<AttendanceDay>> history({
    required DateTime from,
    required DateTime to,
  }) async =>
      _history ?? const <AttendanceDay>[];

  @override
  Future<List<TraccerAlert>> myAlerts() async => _alerts ?? const <TraccerAlert>[];

  @override
  Future<LeavePage> myLeaveRequests() async =>
      LeavePage(items: _leave ?? const <LeaveRequest>[]);

  @override
  Future<LeaveRequest> createLeave({
    required String dateFrom,
    String? dateTo,
    String? reason,
  }) async =>
      LeaveRequest(id: 'lv-new', dateFrom: dateFrom, dateTo: dateTo ?? dateFrom, days: 1, status: LeaveStatus.pending);

  @override
  Future<LeaveRequest> cancelLeave(String id) async =>
      LeaveRequest(id: id, dateFrom: '2026-10-22', dateTo: '2026-10-22', days: 1, status: LeaveStatus.cancelled);
}

class _FakeDao extends PositionDao {
  @override
  Future<int> pendingCount() async => 0;
}

Widget _app(Widget home, List<Override> overrides) => ProviderScope(
      overrides: overrides,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: TraccerTheme.light(),
        locale: const Locale('ar'),
        supportedLocales: const <Locale>[Locale('ar')],
        localizationsDelegates: const <LocalizationsDelegate<Object>>[
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        builder: (BuildContext context, Widget? child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: home,
      ),
    );

List<Override> _overrides({
  required SessionStore session,
  TodayState? today,
  List<AttendanceDay>? history,
  List<TraccerAlert>? alerts,
  List<LeaveRequest>? leave,
}) =>
    <Override>[
      sessionStoreProvider.overrideWithValue(session),
      apiClientProvider.overrideWithValue(
        _FakeApi(session, today: today, history: history, alerts: alerts, leave: leave),
      ),
      positionDaoProvider.overrideWithValue(_FakeDao()),
      trackingEventsProvider.overrideWith(
        (Ref ref) => const Stream<TrackingUiEvent>.empty(),
      ),
    ];

void _usePhone(WidgetTester tester, double w, double h) {
  tester.view.physicalSize = Size(w * 3, h * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

void _expectNoLayoutErrors(WidgetTester tester, String size) {
  final Object? error = tester.takeException();
  expect(error, isNull, reason: 'layout failure at $size: $error');
}

const AppUser _employee = AppUser(
  id: 'u-test',
  identifier: 'E0101',
  name: 'أحمد محمود',
  role: 'EMPLOYEE',
  employeeId: 'emp-1',
  phone: '01000000000',
  driver: false,
);

const AppUser _driver = AppUser(
  id: 'u-driver',
  identifier: 'D0201',
  name: 'مصطفى أمين',
  role: 'DRIVER',
  employeeId: 'emp-2',
  phone: '01000000002',
  driver: true,
);

TodayState _openShift() => TodayState(
      isCheckedIn: true,
      fenceName: 'المقر الرئيسي',
      insideFence: true,
      record: AttendanceDay(
        date: DateTime.now(),
        checkInAt: DateTime.now().subtract(const Duration(hours: 2)),
        fenceName: 'المقر الرئيسي',
      ),
    );

class _SheetHost extends StatelessWidget {
  const _SheetHost();

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: TextButton(
            onPressed: () => showSettingsSheet(context),
            child: Text(S.t('settings')),
          ),
        ),
      );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    await S.load();
    final String flutterRoot = Platform.environment['FLUTTER_ROOT'] ?? r'D:\flutter';
    await _loadFont(
      'MaterialIcons',
      '$flutterRoot/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    );
    await _loadFont('Cairo', r'assets\fonts\Cairo-Regular.ttf');
  });

  testWidgets('login screen renders in Arabic RTL', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    _usePhone(tester, 360, 780);

    await tester.pumpWidget(_app(
      const LoginScreen(),
      <Override>[sessionStoreProvider.overrideWithValue(session)],
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('enter')), findsOneWidget);
    expect(find.text(S.t('identifier')), findsOneWidget);
    // The login tile must be the shipped product mark, not a generic icon.
    expect(find.image(const AssetImage('assets/brand/logo.png')), findsOneWidget);
    _expectNoLayoutErrors(tester, '360x780');
  });

  testWidgets('login screen survives the smallest phone', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    _usePhone(tester, 320, 480);

    await tester.pumpWidget(_app(
      const LoginScreen(),
      <Override>[sessionStoreProvider.overrideWithValue(session)],
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('password')), findsOneWidget);
    _expectNoLayoutErrors(tester, '320x480');
  });

  testWidgets('home screen renders the shift and pins the one button',
      (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    await session.setCheckedIn(true);
    _usePhone(tester, 360, 800);

    await tester.pumpWidget(_app(
      const HomeScreen(),
      _overrides(session: session, today: _openShift()),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('checkOut')), findsOneWidget);
    expect(find.text(S.t('insideFence')), findsOneWidget);
    final Rect cta = tester.getRect(find.widgetWithText(FilledButton, S.t('checkOut')));
    expect(cta.bottom, greaterThan(800 - 120), reason: 'CTA must hug the bottom edge');
    _expectNoLayoutErrors(tester, '360x800');
  });

  testWidgets('driver before a shift sees an idle tracking chip, not a fault',
      (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_driver);
    await session.setCheckedIn(false);
    _usePhone(tester, 320, 560);

    await tester.pumpWidget(_app(
      const HomeScreen(),
      _overrides(session: session, today: const TodayState(isCheckedIn: false)),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('checkIn')), findsOneWidget);
    expect(find.text(S.t('trackingIdle')), findsOneWidget);
    expect(find.text(S.t('trackingStopped')), findsNothing);
    _expectNoLayoutErrors(tester, '320x560');
  });

  testWidgets('history groups days and labels shift status', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    _usePhone(tester, 360, 780);

    final DateTime morning = DateTime.now().subtract(const Duration(hours: 9));
    await tester.pumpWidget(_app(
      const HistoryScreen(),
      _overrides(
        session: session,
        history: <AttendanceDay>[
          AttendanceDay(date: morning, checkInAt: morning, status: AttendanceStatus.valid),
          AttendanceDay(
            date: morning.subtract(const Duration(days: 1)),
            checkInAt: morning.subtract(const Duration(days: 1)),
            checkOutAt: morning.subtract(const Duration(days: 1, hours: -6)),
            status: AttendanceStatus.valid,
          ),
        ],
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('statusOpenShift')), findsOneWidget);
    expect(find.text(S.t('statusPresent')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'history 360x780');
  });

  testWidgets('history shows the empty pane, not a blank page', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    _usePhone(tester, 360, 780);

    await tester.pumpWidget(_app(
      const HistoryScreen(),
      _overrides(session: session, history: const <AttendanceDay>[]),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('historyEmpty')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'history empty');
  });

  testWidgets('alerts expand inline on tap', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_driver);
    _usePhone(tester, 360, 780);

    final TraccerAlert alert = TraccerAlert(
      id: 'a-1',
      type: 'CHECK_IN_OUT_OF_FENCE',
      severity: 'WARNING',
      userId: 'emp-2',
      userName: 'مصطفى أمين',
      title: 'بدء وردية خارج النطاق',
      body: 'تم التسجيل على بعد 480 متر من النطاق',
      createdAt: DateTime.now(),
      status: 'OPEN',
      meta: const <String, Object?>{'lat': 30.0444, 'lng': 31.2357},
    );
    await tester.pumpWidget(_app(
      const NotificationsScreen(),
      _overrides(session: session, alerts: <TraccerAlert>[alert]),
    ));
    await tester.pumpAndSettle();

    expect(find.text(alert.title), findsOneWidget);
    expect(find.text(alert.body), findsNothing);

    await tester.tap(find.text(alert.title));
    await tester.pumpAndSettle();

    expect(find.text(alert.body), findsOneWidget);
    expect(find.text(S.t('alertOpenStatus')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'alerts 360x780');
  });

  testWidgets('alerts show the empty pane when there is nothing', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    _usePhone(tester, 360, 780);

    await tester.pumpWidget(_app(
      const NotificationsScreen(),
      _overrides(session: session, alerts: const <TraccerAlert>[]),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('notificationsEmpty')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'alerts empty');
  });

  testWidgets('onboarding teaches allow-always and the battery exemption',
      (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_driver);
    _usePhone(tester, 360, 740);

    await tester.pumpWidget(_app(
      const OnboardingScreen(),
      <Override>[sessionStoreProvider.overrideWithValue(session)],
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('onboardingShiftTitle')), findsOneWidget);

    await tester.tap(find.text(S.t('next')));
    await tester.pumpAndSettle();
    expect(find.text(S.t('onboardingLocation')), findsOneWidget);
    expect(find.text(S.t('onboardingAlwaysAllowPath')), findsOneWidget);

    await tester.tap(find.text(S.t('next')));
    await tester.pumpAndSettle();
    expect(find.text(S.t('onboardingBatteryTitle')), findsOneWidget);
    expect(find.text(S.t('onboardingKilledAlert')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'onboarding 360x740');
  });

  testWidgets('settings sheet is content-sized and shows identity', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    _usePhone(tester, 360, 780);

    await tester.pumpWidget(_app(
      const _SheetHost(),
      _overrides(session: session, today: const TodayState(isCheckedIn: false)),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text(S.t('settings')));
    await tester.pumpAndSettle();

    expect(find.text(_employee.name), findsOneWidget);
    expect(find.textContaining('${_employee.identifier} • ${S.t('roleEmployee')}'), findsOneWidget);
    expect(find.text(S.t('settingsNotificationsSubtitle')), findsOneWidget);
    expect(find.text(S.t('trackingIdle')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'settings sheet');
  });

  testWidgets('leave screen lists my requests with the HR decision', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    _usePhone(tester, 360, 780);

    const LeaveRequest pending = LeaveRequest(
      id: 'lv-1',
      dateFrom: '2026-11-03',
      dateTo: '2026-11-03',
      days: 1,
      status: LeaveStatus.pending,
      reason: 'ظرف عائلي',
    );
    final LeaveRequest approved = LeaveRequest(
      id: 'lv-2',
      dateFrom: '2026-10-12',
      dateTo: '2026-10-13',
      days: 2,
      status: LeaveStatus.approved,
      decidedByName: 'شؤون الموظفين',
      decidedAt: DateTime.now(),
    );
    await tester.pumpWidget(_app(
      const LeaveScreen(),
      _overrides(session: session, leave: <LeaveRequest>[pending, approved]),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('leaveFormTitle')), findsOneWidget);
    expect(find.text(LeaveStatus.ar[LeaveStatus.pending]!), findsOneWidget);
    expect(find.text(S.t('leaveCancel')), findsOneWidget);
    expect(find.text('ظرف عائلي'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.text(LeaveStatus.ar[LeaveStatus.approved]!),
      240,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pumpAndSettle();

    // An already-decided request is HR's record: the only cancel button on screen is the
    // pending one, so the approved row carries no way to undo a decision.
    expect(find.textContaining('${S.t('leaveDecidedBy')}:'), findsOneWidget);
    expect(find.text(S.t('leaveCancel')), findsOneWidget);
    _expectNoLayoutErrors(tester, 'leave 360x780');
  });

  testWidgets('an approved leave day locks بدء اليوم instead of hiding it',
      (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(_employee);
    _usePhone(tester, 360, 800);

    await tester.pumpWidget(_app(
      const HomeScreen(),
      _overrides(
        session: session,
        today: const TodayState(isCheckedIn: false, onLeave: true),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('leaveTodayStatus')), findsOneWidget);
    expect(find.text(S.t('noShift')), findsNothing);
    final FilledButton cta = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, S.t('leaveTodayButton')),
    );
    expect(cta.onPressed, isNull, reason: 'a covered day must not be startable');
    expect(find.text(S.t('checkIn')), findsNothing);
    _expectNoLayoutErrors(tester, 'home on leave 360x800');
  });
}
