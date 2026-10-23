import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/session_store.dart';
import 'features/auth/change_password_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/history/history_screen.dart';
import 'features/home/home_screen.dart';
import 'features/leave/leave_screen.dart';
import 'features/notifications/notifications_screen.dart';
import 'features/onboarding/onboarding_screen.dart';
import 'state/providers.dart';

/// Notified whenever the auth gate / onboarding state changes so the router re-runs redirect.
class AppRefresh extends ChangeNotifier {
  void notify() => notifyListeners();
}
final AppRefresh appRefresh = AppRefresh();

GoRouter buildRouter(WidgetRef ref) {
  return GoRouter(
    initialLocation: '/home',
    refreshListenable: appRefresh,
    redirect: (BuildContext context, GoRouterState state) {
      final SessionStore session = ref.read(sessionStoreProvider);
      final AuthState auth = ref.read(authControllerProvider);
      final bool loggedIn = auth.user != null;
      final bool onLogin = state.matchedLocation == '/login';
      final bool onChange = state.matchedLocation == '/change-password';
      final bool onOnboard = state.matchedLocation == '/onboarding';

      if (!loggedIn) return '/login';
      if (auth.mustChangePassword) return onChange ? null : '/change-password';
      if (!session.onboarded && !onOnboard) return '/onboarding';
      if (onLogin) return '/home';
      return null;
    },
    routes: <RouteBase>[
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
      GoRoute(path: '/change-password', builder: (_, __) => const ChangePasswordScreen()),
      GoRoute(path: '/onboarding', builder: (_, __) => const OnboardingScreen()),
      GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
      GoRoute(path: '/history', builder: (_, __) => const HistoryScreen()),
      GoRoute(path: '/leave', builder: (_, __) => const LeaveScreen()),
      GoRoute(path: '/me/notifications', builder: (_, __) => const NotificationsScreen()),
    ],
    errorBuilder: (_, GoRouterState s) => Scaffold(
      appBar: AppBar(),
      body: Center(child: Text('صفحة غير موجودة: ${s.uri}')),
    ),
  );
}
