# Traccer — mobile (Flutter)

تطبيق Flutter لموظفي وسوّاقي Uni Group. **واجهة السوّاق = زر تشيك ان / تشيك أوت فقط**؛
كل التتبع والتخزين أوف‑لاين والتنبيهات يعمل تلقائيًا في الخلفية. الموظف نفس الزر لكن على نطاق موقعه.

> ⚠️ **Flutter/Dart SDK is not installed on the machine that produced this code.**
> The app was written against pinned package versions and the binding contract
> (`docs/CONTRACT.md`), but **it has NOT been `pub get`‑ed, `analyze`‑d, `test`‑ed, or
> `build`‑ed**. Treat the first `flutter build` as a review pass — expect at most minor
> version‑range or plugin‑API tweaks, all of which are isolated to the adapter classes in
> `lib/services/adapters/`.

---

## What you must run (nothing here was executed)

```bash
# 0. Install Flutter 3.16+ / Dart 3.2+ (https://docs.flutter.dev/get-started/install)
flutter --version

# 1. From THIS directory (apps/mobile)
cd apps/mobile
flutter pub get
flutter analyze                 # 0 errors expected; fix any version-range nudges here

# 2. Unit tests — pure Dart/VM, no device/emulator needed
flutter test
#   Covers: motion classifier, buffer eviction (sqflite_common_ffi), batch payload (500 cap /
#   ordering / dedupe), wire JSON == CONTRACT §4, Cairo date formatting, fence distance,
#   and the golden-constants gate (see below).

# 3. Firebase config (push) — generates lib/firebase_options.dart
#    (Android needs android/app/google-services.json, iOS needs GoogleService-Info.plist)
dart pub global activate flutterfire_cli
flutterfire configure --project=<your-firebase-project-id>

# 4. Build & run
# Android (emulator uses API_URL default http://10.0.2.2:3000/api/v1):
flutter run -d android                                    # debug on attached device/emulator
flutter build apk --release --dart-define=API_URL=https://api.traccer.eg/api/v1

# iOS (run from macOS; the API_URL for a simulator is host loopback):
flutter build ios --release --dart-define=API_URL=http://127.0.0.1:3000/api/v1
#   For a real iPhone use your LAN/tunnel host, e.g. --dart-define=API_URL=http://192.168.1.20:3000/api/v1

# 5. BEFORE shipping: the golden-constants gate must pass
node ../../tools/generate_constants_golden.mjs   # regenerate packages/shared/golden/constants.json
flutter test test/constants_golden_test.dart     # fails if Dart mirror drifts from packages/shared
```

## Configuration

| dart-define | default | notes |
|---|---|---|
| `API_URL` | `http://10.0.2.2:3000/api/v1` | Android‑emulator alias to the host's `localhost:3000` (apps/api `PORT=3000`). Change per environment. |
| `APP_VERSION` | `0.1.0` | Sent in `/devices/register`. |

Socket.IO base origin is derived from `API_URL` (namespace `/rt`).

## Structure

```
lib/
  main.dart                      # bootstrap: prefs, Firebase (best-effort), WorkManager, APP_KILLED
  app.dart                       # MaterialApp.router, RTL, Cairo theme, push+socket wiring
  router.dart                    # auth / mustChangePassword / onboarding redirects
  theme.dart                     # #2563eb, white bg, cards r16, thin blue shadow, dark tokens
  core/
    traccer_constants.dart       # EXACT mirror of packages/shared/src/constants.ts
    api_client.dart              # Dio + bearer + single-flight refresh + typed errors + backoff
    api_error.dart               # FENCE_VIOLATION / ALREADY_CHECKED_IN / NO_OPEN_RECORD ...
    session_store.dart           # SharedPreferences (keys obfuscated — see limitation note)
    app_config.dart  app_strings.dart  cairo_time.dart  geo.dart
  data/
    app_database.dart  position_dao.dart   # write-ahead offline buffer
    batch_builder.dart                     # pure §4 payload builder (500 cap / dedupe / order)
  models/  position.dart user.dart attendance.dart alert.dart
  services/
    tracking_service.dart        # background isolate engine + @vm:entry-point handlers
    motion_classifier.dart       # EMA .35 + 3-sample hysteresis (§5)
    alert_service.dart           # FCM + local notifications + token → /devices/register
    realtime_service.dart        # Socket.IO notify:me (§7)
    sync_scheduler.dart          # WorkManager catch-up + keep-alive + APP_KILLED
    adapters/                    # ONE seam per plugin: location, connectivity, battery,
                                 #   device, notifications, background_service
  state/providers.dart           # Riverpod: session, api, auth, home (the ONE button), tracking
  features/                      # login, change_password, onboarding, home, history,
                                 #   notifications, settings
assets/strings/ar.json           # Arabic UI copy
test/                            # pure-Dart unit tests
```

## Contract points worth a backend tweak

1. **Employee history list**: the app reads `GET /attendance` for personal history; §1 says
   EMPLOYEE/DRIVER are auto-scoped to their own records, but §3 doesn't list a dedicated
   `GET /attendance/me` paged route. A personal-history endpoint would be cleaner than relying
   on role-scoping of the admin list.
2. **Password change**: §2/§8 describe `changeOnLogin=true` but no change-password route. The
   app POSTs `/auth/change-password` (see `api_client.changePassword`); add it or point us at
   the real path.
3. **`mustChangePassword` on the login user**: §2 `user` shape doesn't carry it; the app accepts
   either `mustChangePassword` or `changeOnLogin` on the login/me payload. Pick one and put it in
   the `user` object.

## Session store security

Tokens live in `shared_preferences` with *obfuscated* keys — this is NOT secure storage. For
production move to the platform keystore / Keychain; the whole app reads through `SessionStore`,
so it's a one-file swap (see the class doc).
