import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/session_store.dart';
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
  String? _bootstrappedFor;

  @override
  void initState() {
    super.initState();
    // Login/logout happens without restarting the app: rewire push + socket on user change.
    ref.listenManual<AuthState>(authControllerProvider, (AuthState? prev, AuthState next) {
      if (prev?.user?.id != next.user?.id) unawaited(_bootstrapMessaging());
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_bootstrapMessaging()));
  }

  /// Set up push (FCM) + the foreground socket once the user is authenticated.
  Future<void> _bootstrapMessaging() async {
    if (!mounted) return;
    final SessionStore session = ref.read(sessionStoreProvider);
    final AuthState auth = ref.read(authControllerProvider);
    final String? userId = auth.user?.id;

    if (userId == null || !session.isLoggedIn) {
      _teardownMessaging();
      return;
    }
    if (_bootstrappedFor == userId) return;
    _teardownMessaging();
    _bootstrappedFor = userId;

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
    } else {
      // No Firebase config: in-app socket alerts still need the local notification channel.
      try {
        await ref.read(notificationsProvider).init();
        await ref.read(notificationsProvider).requestPermission();
      } catch (e) {
        debugPrint('[boot] local notifications init failed: $e');
      }
    }

    // Foreground realtime (notify:me) while the app is open.
    final RealtimeService rt = RealtimeService(onNotifyMe: alerts.handleNotifyMe);
    rt.connect(accessToken: session.accessToken ?? '', userId: userId);
    _rt = rt;
  }

  void _teardownMessaging() {
    _rt?.disconnect();
    _rt = null;
    unawaited(_alerts?.dispose() ?? Future<void>.value());
    _alerts = null;
    _bootstrappedFor = null;
  }

  @override
  void dispose() {
    _teardownMessaging();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool dark = ref.watch(darkModeProvider);
    return MaterialApp.router(
      title: 'UNI Tracking',
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
