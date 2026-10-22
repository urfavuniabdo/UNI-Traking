import 'dart:io';
import 'dart:typed_data';

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
import 'package:traccer/features/auth/login_screen.dart';
import 'package:traccer/features/home/home_screen.dart';
import 'package:traccer/models/attendance.dart';
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
  _FakeApi(SessionStore session) : super(session: session);

  @override
  Future<TodayState> today() async => TodayState(
        isCheckedIn: true,
        fenceName: 'المقر الرئيسي',
        insideFence: true,
        record: AttendanceDay(
          date: DateTime.now(),
          checkInAt: DateTime.now().subtract(const Duration(hours: 2)),
          fenceName: 'المقر الرئيسي',
        ),
      );
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
    tester.view.physicalSize = const Size(1080, 2280);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_app(
      const LoginScreen(),
      <Override>[sessionStoreProvider.overrideWithValue(session)],
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('enter')), findsOneWidget);
    expect(find.text(S.t('identifier')), findsOneWidget);
  });

  testWidgets('home screen renders the shift and the one button', (WidgetTester tester) async {
    final SessionStore session = await SessionStore.open();
    await session.saveUser(const AppUser(
      id: 'u-test',
      identifier: 'E0101',
      name: 'أحمد محمود',
      role: 'EMPLOYEE',
      employeeId: 'emp-1',
      phone: '01000000000',
      driver: false,
    ));
    await session.setCheckedIn(true);

    tester.view.physicalSize = const Size(1080, 2280);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(_app(
      const HomeScreen(),
      <Override>[
        sessionStoreProvider.overrideWithValue(session),
        apiClientProvider.overrideWithValue(_FakeApi(session)),
        positionDaoProvider.overrideWithValue(_FakeDao()),
        trackingEventsProvider.overrideWith((Ref ref) => const Stream<TrackingUiEvent>.empty()),
      ],
    ));
    await tester.pumpAndSettle();

    expect(find.text(S.t('checkOut')), findsOneWidget);
    expect(find.text(S.t('insideFence')), findsOneWidget);
  });
}
