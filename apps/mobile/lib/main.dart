import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'core/app_strings.dart';
import 'core/session_store.dart';
import 'firebase_options.dart';
import 'services/sync_scheduler.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Force Arabic RTL everywhere; the app's only language is Arabic (README design rule).
  await SystemChrome.setPreferredOrientations(<DeviceOrientation>[
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  // 1) Session store (SharedPreferences) must exist before any provider reads it.
  final SessionStore session = await SessionStore.open();

  // 2) Arabic strings.
  await S.load();

  // 3) Firebase is BEST-EFFORT. If google-services.json / GoogleService-Info.plist are
  //    missing we still run — attendance + socket alerts + local notifications work; only
  //    closed-app push is degraded. This keeps the app usable during integration.
  bool firebaseReady = false;
  try {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
    firebaseReady = true;
  } catch (e) {
    debugPrint('[boot] Firebase unavailable: $e — continuing in degraded mode');
  }

  // 4) WorkManager background scheduling (buffer catch-up / keep-alive).
  await initSyncScheduler();
  // Report an unclean kill (APP_KILLED) from the previous session, then open a fresh flag.
  await reportUncleanKillIfNeeded();

  runApp(
    ProviderScope(
      overrides: [
        sessionStoreProvider.overrideWithValue(session),
        firebaseReadyProvider.overrideWithValue(firebaseReady),
      ],
      child: const TraccerApp(),
    ),
  );
}
