# Traccer — mobile (Flutter)

تطبيق Flutter لموظفي وسوّاقي Uni Group. **واجهة السوّاق = زر تشيك ان / تشيك أوت فقط**؛
كل التتبع والتخزين أوف‑لاين والتنبيهات يعمل تلقائيًا في الخلفية. الموظف نفس الزر لكن على نطاق موقعه.

The app is **built and verified** on this machine: `flutter analyze` reports no issues,
all 47 tests pass, and a signed release APK is produced at:

```
D:\UNI Track\dist\traccer-0.1.0.apk
```

---

## Verified toolchain

| Tool | Version |
|---|---|
| Flutter / Dart | 3.47.7 / 3.13 (stable) |
| JDK | 17 (Temurin 17.0.20.1+1) |
| Android SDK | platform 36, build-tools 36.0.0, NDK 28.2.13676358 |
| Gradle / AGP / Kotlin | 9.3.1 / 9.1.0 / 2.4.0 |
| minSdk / targetSdk | 24 / 36 |

## Build & test

```bash
cd apps/mobile
flutter pub get
flutter analyze          # no issues
flutter test             # 47 tests, all passing

# Release APK — point API_URL at the machine running apps/api
flutter build apk --release \
  --dart-define=API_URL=http://192.168.1.186:3000/api/v1 \
  --dart-define=APP_VERSION=0.1.0
# → build/app/outputs/flutter-apk/app-release.apk
```

| dart-define | default | notes |
|---|---|---|
| `API_URL` | `http://10.0.2.2:3000/api/v1` | Emulator alias to host `localhost:3000`. Use the PC's LAN IP for a real phone. |
| `APP_VERSION` | `0.1.0` | Sent in `/devices/register`. |

Socket.IO origin is derived from `API_URL` (namespace `/rt`). The APK currently in `dist/`
points at `http://192.168.1.186:3000/api/v1`, so the phone must be on the same Wi‑Fi as the API.

### Install

1. Start the API (`apps/api`, `npm run start:dev`, port 3000) and keep the phone on the same network.
   Windows Defender blocks inbound :3000 by default, so from an elevated PowerShell run
   `New-NetFirewallRule -DisplayName "traccer-api" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow`
   once; without it the app sits on "غير متصل".
2. Copy `dist/traccer-0.1.0.apk` to the phone and install (allow "unknown sources").
3. Log in with a seeded account, e.g. `E0101` or `D0201`, using `ADMIN_INIT_PASSWORD`
   (default `ChangeMe123!` — the app forces a password change on first login).
4. Grant location + notification permission, including **"Allow all the time"** for drivers
   so tracking survives the app being backgrounded. The first-run onboarding screen walks
   through it and names the OEM battery-exemption path (Xiaomi/Oppo/Samsung/Huawei);
   settings can reopen it.

> `dist/traccer-0.1.0.apk` is signed with the project release key (`CN=Traccer`). Keep
> `android/key.properties` and `android/traccer-release.keystore` backed up and private —
> both are git-ignored. On a fresh clone without them, the build falls back to the debug key.

## Firebase / push (optional)

Push is the only feature that needs project-specific config. Without it the app still
logs in, checks in/out, tracks, buffers offline, and receives in-app socket alerts; the app
simply cannot be woken by FCM when fully closed.

1. Create a Firebase Android app with package `com.unigroup.traccer`.
2. Place `google-services.json` in `android/app/` (and `GoogleService-Info.plist` in `ios/Runner/`
   for iOS).
3. Rebuild. `lib/firebase_options.dart` intentionally returns `null` on mobile so the native
   config files are used.

## Tests

`flutter test` covers the motion classifier, offline buffer eviction, batch payload
(500 cap / ordering / dedupe), wire JSON vs `docs/CONTRACT.md`, Cairo date formatting, fence
distance, golden constants, and a render smoke test that pumps every screen (login, home,
history, notifications, onboarding, settings sheet) down to a 320×480 phone and fails on
any layout overflow.

## Structure

```
lib/
  main.dart                      # prefs, Firebase (best-effort), WorkManager, unclean-kill report
  app.dart                       # MaterialApp.router, RTL, Cairo theme, push+socket wiring
  router.dart                    # auth / mustChangePassword / onboarding redirects
  theme.dart                     # #2563eb, white bg, cards r16, Cairo (bundled)
  core/                          # config, API client, errors, session store, Cairo time, geo
  data/                          # SQLite write-ahead buffer + batch builder
  models/                        # user, attendance, position, alert
  services/
    tracking_service.dart        # background isolate engine
    motion_classifier.dart       # EMA + hysteresis
    alert_service.dart           # FCM + local notifications
    realtime_service.dart        # Socket.IO notify:me
    sync_scheduler.dart          # WorkManager catch-up + keep-alive
    adapters/                    # one seam per plugin
  state/providers.dart           # Riverpod auth + home (the ONE button) + tracking
  features/                      # login, change_password, onboarding, home, history,
                                 # notifications, settings
assets/
  fonts/                         # Cairo 400/600/700/800 + OFL license (offline UI)
  strings/ar.json
android/app/src/main/res/        # branded launcher: legacy PNGs + adaptive icon (mipmap-anydpi-v26)
                                 # over #2563EB, and the blue splash in drawable/launch_background.xml
                                 # master art: docs/brand/traccer-icon-1024.png
android/app/proguard-rules.pro   # REQUIRED keep rules: Flutter turns R8 on for release, and the
                                 # dart:jni bridges in the Kotlin plugins (shared_preferences) look
                                 # up kotlin.coroutines.* by name — without this the app hangs on
                                 # the splash screen with NoSuchMethodError on a real device.
```

## Background behavior

- Android foreground service type `location`, with `ACCESS_BACKGROUND_LOCATION` requested
  at runtime for drivers. Promotion to foreground happens only after the check-in gate, so a
  boot-start with no open shift stops silently instead of crash-looping on Android 14+.
- WorkManager registers a ~15-minute catch-up and a network-constrained flush.
- On some OEMs (Xiaomi/Oppo/Samsung) the user must disable battery optimisation for reliable
  background tracking; the onboarding screen explains the permission flow.

## Session store security

Tokens live in `shared_preferences` with *obfuscated* keys — this is NOT secure storage. For
production move to the platform keystore / Keychain; the whole app reads through `SessionStore`,
so it's a one-file swap (see the class doc).

## iOS

The iOS scaffold and `Info.plist` (background location, notifications, URL scheme) are present,
but an iOS build requires macOS + Xcode and was not produced here.
