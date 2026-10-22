// TODO(flutterfire): Generate this file with the real config:
//
//   dart pub global activate flutterfire_cli
//   flutterfire configure --project=<your-firebase-project-id>
//
// That overwrites this whole file. Until then:
//   * On ANDROID place `android/app/google-services.json`.
//   * On IOS place `ios/Runner/GoogleService-Info.plist`.
//   With those native files present, `Firebase.initializeApp()` reads them automatically
//   and `currentPlatform` below can stay `null` (we only need explicit options for web).
//
// main.dart wraps initialize() in try/catch and degrades gracefully if this isn't configured
// yet — attendance + tracking + socket alerts still work; only closed-app push is affected.
import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;

class DefaultFirebaseOptions {
  static FirebaseOptions? get currentPlatform {
    switch (defaultTargetPlatform) {
      case TargetPlatform.iOS:
      case TargetPlatform.android:
        // Use the on-device google-services.json / GoogleService-Info.plist.
        return null;
      default:
        // No web/desktop config yet.
        return null;
    }
  }

  // Reference shape once `flutterfire configure` fills this in:
  // ignore: unused_element
  static const FirebaseOptions _example = FirebaseOptions(
    apiKey: 'REPLACE_ME',
    appId: 'REPLACE_ME',
    messagingSenderId: 'REPLACE_ME',
    projectId: 'REPLACE_ME',
  );
}
