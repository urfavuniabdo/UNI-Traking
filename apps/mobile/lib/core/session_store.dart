import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/user.dart';
import 'app_config.dart';

/// Lightweight session store backed by `shared_preferences`.
///
/// SECURITY LIMITATION (documented honestly, per task brief):
///   We intentionally avoid `flutter_secure_storage` here. `shared_preferences` on Android
///   writes plain XML to the app sandbox and on iOS to a plist — it is NOT hardware-backed
///   and is readable on a rooted/jailbroken device. Keys are *obfuscated* (tk.x1 etc.) only
///   to avoid casual grep, NOT to provide real protection.
///
///   For production the tokens + refresh secret should move to the platform keystore /
///   Keychain (e.g. `flutter_secure_storage` or `reactive_safe_area`-free encrypted prefs).
///   Everything in the app already reads/writes through this single class, so swapping the
///   backing store is a one-file change with no UI impact.
class SessionStore {
  SessionStore(this._prefs);

  final SharedPreferences _prefs;

  static Future<SessionStore> open() async {
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    // Replays the tester's server override in this isolate before any ApiClient is built.
    AppConfig.applyOverride(prefs.getString(AppConfig.serverUrlKey));
    return SessionStore(prefs);
  }

  // --- tokens ---
  String? get accessToken => _prefs.getString(AppConfig.accessTokenKey);
  String? get refreshToken => _prefs.getString(AppConfig.refreshTokenKey);

  Future<void> saveTokens(AuthTokens t) async {
    await _prefs.setString(AppConfig.accessTokenKey, t.accessToken);
    await _prefs.setString(AppConfig.refreshTokenKey, t.refreshToken);
    if (t.user != null) await saveUser(t.user!);
  }

  // --- user ---
  AppUser? get user {
    final String? raw = _prefs.getString(AppConfig.userJsonKey);
    if (raw == null) return null;
    try {
      return AppUser.fromJson(Map<String, Object?>.from(jsonDecode(raw) as Map));
    } catch (_) {
      return null;
    }
  }

  Future<void> saveUser(AppUser u) =>
      _prefs.setString(AppConfig.userJsonKey, jsonEncode(u.toJson()));

  // --- device id (stable per install) ---
  String? get deviceId => _prefs.getString(AppConfig.deviceIdKey);
  Future<void> setDeviceId(String id) => _prefs.setString(AppConfig.deviceIdKey, id);

  // --- monotonic client sequence for positions ---
  int get lastSeq => _prefs.getInt(AppConfig.lastSeqKey) ?? 0;
  Future<int> nextSeq() async {
    final int n = lastSeq + 1;
    await _prefs.setInt(AppConfig.lastSeqKey, n);
    return n;
  }

  // --- crash / unclean-session flag (drives APP_KILLED on next launch, §2) ---
  bool get sessionWasAlive => _prefs.getBool(AppConfig.sessionAliveKey) ?? false;
  Future<void> markSessionAlive(bool alive) =>
      _prefs.setBool(AppConfig.sessionAliveKey, alive);

  // --- checked-in flag: gates the boot-restarted foreground service so it only really
  //     tracks when a shift is open (§2 auto-start + robustness). ---
  bool get isCheckedIn => _prefs.getBool(AppConfig.isCheckedInKey) ?? false;
  Future<void> setCheckedIn(bool v) => _prefs.setBool(AppConfig.isCheckedInKey, v);

  // --- onboarding acknowledged (background-location explainer shown once). ---
  bool get onboarded => _prefs.getBool(AppConfig.onboardedKey) ?? false;
  Future<void> setOnboarded(bool v) => _prefs.setBool(AppConfig.onboardedKey, v);

  /// Persists the forced-password-change requirement across app restarts (the user
  /// object returned by the API does not include the top-level `mustChangePassword`).
  bool get mustChangePassword => _prefs.getBool(AppConfig.mustChangePasswordKey) ?? false;
  Future<void> setMustChangePassword(bool v) =>
      _prefs.setBool(AppConfig.mustChangePasswordKey, v);

  // --- notification prefs ---
  bool get soundEnabled => _prefs.getBool(AppConfig.soundKey) ?? true;
  Future<void> setSoundEnabled(bool v) => _prefs.setBool(AppConfig.soundKey, v);

  bool get darkMode => _prefs.getBool(AppConfig.darkModeKey) ?? false;
  Future<void> setDarkMode(bool v) => _prefs.setBool(AppConfig.darkModeKey, v);

  // --- API host override so a tester can follow a redeployed backend without a rebuild.
  //     Deliberately survives clear(): it is device config, not identity. ---
  String? get serverUrl => _prefs.getString(AppConfig.serverUrlKey);
  Future<void> setServerUrl(String? v) async {
    final String s = (v ?? '').trim();
    if (s.isEmpty || s == AppConfig.buildApiUrl) {
      await _prefs.remove(AppConfig.serverUrlKey);
      AppConfig.applyOverride(null);
      return;
    }
    final String normalized = AppConfig.normalize(s);
    await _prefs.setString(AppConfig.serverUrlKey, normalized);
    AppConfig.applyOverride(normalized);
  }

  bool get isLoggedIn => accessToken != null && refreshToken != null;

  Future<void> clear() async {
    for (final String k in <String>[
      AppConfig.accessTokenKey,
      AppConfig.refreshTokenKey,
      AppConfig.userJsonKey,
      AppConfig.sessionAliveKey,
      AppConfig.mustChangePasswordKey,
    ]) {
      await _prefs.remove(k);
    }
  }
}
