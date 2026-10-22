import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'router.dart';
import 'services/alert_service.dart';
import 'services/realtime_service.dart';
import 'state/providers.dart';
import 'theme.dart';

class TraccerApp extends ConsumerStatefulWidget {
  const TraccerApp({super.key});

  @override
  ConsumerState<TraccerApp> createState() => _TraccerAppState();
}

class _TraccerAppState extends ConsumerState<TraccerApp> {
  late final GoRouter _router = buildRouter(ref);
  AlertService? _alerts;
  RealtimeService? _rt;
  bool _bootstrapped = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrapMessaging());
  }

  /// Set up push (FCM) + the foreground socket once the user is authenticated.
  Future<void> _bootstrapMessaging() async {
    if (_bootstrapped || !mounted) return;
    _bootstrapped = true;
    final session = ref.read(sessionStoreProvider);
    if (!session.isLoggedIn) return;
    final String deviceId = await ref.read(deviceIdProvider.future);
    if (!mounted) return;

    final AlertService alerts = AlertService(
      notifications: ref.read(notificationsProvider),
      session: session,
      api: ref.read(apiClientProvider),
      deviceId: deviceId,
      onAlertTap: (_) {
        // Tap ALWAYS opens the personal screen — never a chat (product rule).
        _router.go('/me/notifications');
      },
    );
    _alerts = alerts;
    if (ref.read(firebaseReadyProvider)) {
      try {
        await alerts.init();
      } catch (e) {
        debugPrint('[boot] alert init failed: $e');
      }
    }

    // Foreground realtime (notify:me) while the app is open.
    final RealtimeService rt = RealtimeService(onNotifyMe: alerts.handleNotifyMe);
    rt.connect(accessToken: session.accessToken ?? '', userId: session.user?.id);
    _rt = rt;
  }

  @override
  void dispose() {
    _rt?.disconnect();
    _alerts?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool dark = ref.watch(darkModeProvider);
    return MaterialApp.router(
      title: 'Traccer',
      debugShowCheckedModeBanner: false,
      routerConfig: _router,
      theme: TraccerTheme.light(),
      darkTheme: TraccerTheme.dark(),
      themeMode: dark ? ThemeMode.dark : ThemeMode.light,
      locale: const Locale('ar'),
      supportedLocales: const <Locale>[Locale('ar')],
      localizationsDelegates: const <LocalizationsDelegate<Object>>[
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      // Force RTL for the whole tree (Arabic-only app).
      builder: (BuildContext context, Widget? child) => Directionality(
        textDirection: TextDirection.rtl,
        child: MediaQuery.withClampedTextScaling(
          minScaleFactor: 0.9,
          maxScaleFactor: 1.3,
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
  }
}
