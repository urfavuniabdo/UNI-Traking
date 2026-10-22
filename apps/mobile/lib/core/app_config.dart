/// Compile-time configuration injected via `--dart-define`.
///
/// Build examples (see README):
///   flutter run --dart-define=API_URL=http://10.0.2.2:3000/api/v1
///   flutter build apk --dart-define=API_URL=https://api.traccer.eg/api/v1
///
/// Default is the Android-emulator alias to the host `localhost:3000` (apps/api PORT=3000).
class AppConfig {
  const AppConfig._();

  static const String apiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );

  /// Socket.IO namespace `/rt` lives on the API host; derive the base origin.
  static String get socketUrl {
    final Uri u = Uri.parse(apiUrl);
    return '${u.scheme}://${u.host}${u.hasPort ? ':${u.port}' : ''}';
  }

  static const String appVersion =
      String.fromEnvironment('APP_VERSION', defaultValue: '0.1.0');

  /// Obfuscated shared_preferences keys (see SessionStore limitation note).
  static const String deviceIdKey = 'tk.x1';
  static const String accessTokenKey = 'tk.a2';
  static const String refreshTokenKey = 'tk.r3';
  static const String userJsonKey = 'tk.u4';
  static const String sessionAliveKey = 'tk.s5';
  static const String lastSeqKey = 'tk.q6';
  static const String soundKey = 'tk.n7';
  static const String darkModeKey = 'tk.d8';
  static const String isCheckedInKey = 'tk.c9';
  static const String onboardedKey = 'tk.o10';
  static const String mustChangePasswordKey = 'tk.m11';
}
