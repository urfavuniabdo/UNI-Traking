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
import 'package:traccer/data/position_dao.dart';
import 'package:traccer/features/home/home_screen.dart';
import 'package:traccer/models/alert.dart';
import 'package:traccer/models/attendance.dart';
import 'package:traccer/models/user.dart';
import 'package:traccer/state/providers.dart';
import 'package:traccer/theme.dart';

/// The two held confirmations on the driver's home screen: ending the day and asking for help
/// must both need three continuous seconds, and a plain tap must never fire either one.
Future<void> _loadFont(String family, String path) async {
  final Uint8List bytes = await File(path).readAsBytes();
  final FontLoader loader = FontLoader(family)
    ..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
  await loader.load();
}

class _FakeApi extends ApiClient {
  _FakeApi(SessionStore session, {required TodayState today})
      : _today = today,
        super(session: session);

  final TodayState _today;

  @override
  Future<TodayState> today() async => _today;

  @override
  Future<List<AttendanceDay>> history({required DateTime from, required DateTime to}) async =>
      const <AttendanceDay>[];

  @override
  Future<List<TraccerAlert>> myAlerts() async => const <TraccerAlert>[];
}

class _FakeDao extends PositionDao {
  @override
  Future<int> pendingCount() async => 0;
}

/// Records what the screen actually asked for, so a tap can be proven to have done nothing.
class _SpyHome extends HomeController {
  _SpyHome(super.ref);

  int checkInCalls = 0;
  int checkOutCalls = 0;
  int helpCalls = 0;

  @override
  Future<void> checkIn() async => checkInCalls++;

  @override
  Future<void> checkOut() async => checkOutCalls++;

  @override
  Future<void> requestHelp() async => helpCalls++;
}

void _usePhone(WidgetTester tester, double w, double h) {
  tester.view.physicalSize = Size(w * 3, h * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
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

  const AppUser driver = AppUser(
    id: 'u-driver',
    identifier: 'D0201',
    name: 'مصطفى أمين',
    role: 'DRIVER',
    employeeId: 'emp-2',
    phone: '01000000002',
    driver: true,
  );

  const AppUser employee = AppUser(
    id: 'u-employee',
    identifier: 'E0101',
    name: 'أحمد محمود',
    role: 'EMPLOYEE',
    employeeId: 'emp-1',
    phone: '01000000000',
    driver: false,
  );

  final DateTime morning = DateTime.now().subtract(const Duration(hours: 3));
  TodayState openShift() => TodayState(
        isCheckedIn: true,
        fenceName: 'المقر الرئيسي',
        insideFence: true,
        record: AttendanceDay(date: morning, checkInAt: morning, fenceName: 'المقر الرئيسي'),
      );

  Future<_SpyHome> pumpHome(
    WidgetTester tester, {
    required AppUser user,
    required bool checkedIn,
    double width = 360,
    double height = 780,
  }) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(user);
    await session.setCheckedIn(checkedIn);
    _usePhone(tester, width, height);

    late _SpyHome spy;
    await tester.pumpWidget(
      ProviderScope(
        overrides: <Override>[
          sessionStoreProvider.overrideWithValue(session),
          apiClientProvider.overrideWithValue(
            _FakeApi(session, today: checkedIn ? openShift() : const TodayState(isCheckedIn: false)),
          ),
          positionDaoProvider.overrideWithValue(_FakeDao()),
          trackingEventsProvider.overrideWith(
            (Ref ref) => const Stream<TrackingUiEvent>.empty(),
          ),
          homeControllerProvider.overrideWith((Ref ref) => spy = _SpyHome(ref)),
        ],
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
          home: const HomeScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return spy;
  }

  testWidgets('a tap on إنهاء اليوم does not end the day', (WidgetTester tester) async {
    final _SpyHome spy = await pumpHome(tester, user: driver, checkedIn: true);
    expect(find.text(S.t('holdToFinish')), findsOneWidget);

    await tester.tap(find.widgetWithText(FilledButton, S.t('checkOut')));
    await tester.pumpAndSettle();

    expect(spy.checkOutCalls, 0, reason: 'a slip of the thumb must never close the day');
    expect(find.widgetWithText(SnackBar, S.t('holdToFinish')), findsOneWidget);
  });

  testWidgets('three continuous seconds end the day — once', (WidgetTester tester) async {
    final _SpyHome spy = await pumpHome(tester, user: driver, checkedIn: true);

    final TestGesture hold = await tester.startGesture(
      tester.getCenter(find.widgetWithText(FilledButton, S.t('checkOut'))),
    );
    await tester.pump(const Duration(milliseconds: 1500));
    expect(spy.checkOutCalls, 0, reason: 'halfway through the hold nothing has happened yet');
    expect(find.text(S.t('holdToFinish')), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 1800));
    expect(find.text(S.t('releaseToFinish')), findsOneWidget, reason: 'the hold is complete');

    await hold.up();
    await tester.pumpAndSettle();

    expect(spy.checkOutCalls, 1);
  });

  testWidgets('بدء اليوم stays a single tap', (WidgetTester tester) async {
    final _SpyHome spy = await pumpHome(tester, user: driver, checkedIn: false);

    await tester.tap(find.widgetWithText(FilledButton, S.t('checkIn')));
    await tester.pumpAndSettle();

    expect(spy.checkInCalls, 1);
    expect(find.text(S.t('holdToFinish')), findsNothing);
  });

  testWidgets('the help circle is a driver’s request and needs the full hold',
      (WidgetTester tester) async {
    final _SpyHome spy = await pumpHome(tester, user: driver, checkedIn: true);
    final Finder help = find.text(S.t('helpRequest'));
    expect(help, findsOneWidget);

    await tester.tap(help);
    await tester.pumpAndSettle();
    expect(spy.helpCalls, 0);
    expect(find.widgetWithText(SnackBar, S.t('holdToHelp')), findsOneWidget);

    final TestGesture hold = await tester.startGesture(tester.getCenter(help));
    await tester.pump(const Duration(milliseconds: 3200));
    await hold.up();
    await tester.pumpAndSettle();

    expect(spy.helpCalls, 1);
  });

  // What the phone showed and the widget test did not: an unchilded DecoratedBox collapses to
  // zero and a CircularProgressIndicator at value 0 paints nothing, so the "circle" was only
  // ever its label. The disc has to be wider than the word inside it.
  testWidgets('the help circle is a disc the size of the band, not the size of its label',
      (WidgetTester tester) async {
    await pumpHome(tester, user: driver, checkedIn: true);
    final Size disc = tester.getSize(find.byType(CircularProgressIndicator));
    final Size label = tester.getSize(find.text(S.t('helpRequest')));
    expect(disc.width, disc.height, reason: 'a circle, not an ellipse');
    expect(disc.width, greaterThan(label.width * 1.4));
  });

  testWidgets('an employee sees no help circle', (WidgetTester tester) async {
    await pumpHome(tester, user: employee, checkedIn: false);
    expect(find.text(S.t('helpRequest')), findsNothing);
  });

  testWidgets('a short phone still frames the CTA and the circle without a layout failure',
      (WidgetTester tester) async {
    await pumpHome(tester, user: driver, checkedIn: true, width: 320, height: 520);
    expect(tester.takeException(), isNull);

    final Rect cta = tester.getRect(find.widgetWithText(FilledButton, S.t('checkOut')));
    expect(cta.bottom, greaterThan(520 - 120), reason: 'CTA must hug the bottom edge');
    expect(find.text(S.t('helpRequest')), findsOneWidget);
  });
}
