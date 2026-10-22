/// Configuration for the app: a compile-time default plus a runtime server override.
///
/// Build examples (see README):
///   flutter run --dart-define=API_URL=http://10.0.2.2:3000/api/v1
///   flutter build apk --dart-define=API_URL=https://uni-tracking.onrender.com/api/v1
///
/// Default is the Android-emulator alias to the host `localhost:3000` (apps/api PORT=3000).
/// A tester can point the app at another host from Settings without a rebuild; the override
/// lives in shared_preferences and [SessionStore.open] replays it in every isolate.
class AppConfig {
  const AppConfig._();

  static const String buildApiUrl = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://10.0.2.2:3000/api/v1',
  );

  static String _apiUrl = buildApiUrl;

  /// Currently dialled API base, always ending in `/api/v1`.
  static String get apiUrl => _apiUrl;

  /// Accepts a bare host (`uni-tracking.onrender.com`), an origin, or a full API URL.
  /// A scheme-less LAN/loopback host gets `http://` (a dev server), anything else `https://`.
  static String normalize(String raw) {
    String s = raw.trim();
    if (s.isEmpty) return buildApiUrl;
    if (!s.startsWith('http://') && !s.startsWith('https://')) {
      s = _isPrivateHost(s) ? 'http://$s' : 'https://$s';
    }
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s.endsWith('/api/v1') ? s : '$s/api/v1';
  }

  static bool _isPrivateHost(String authority) {
    final String host = authority.split('//').last.split(RegExp(r'[:/]')).first.toLowerCase();
    return host == 'localhost' ||
        host.endsWith('.local') ||
        host == '127.0.0.1' ||
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        RegExp(r'^172\.(1[6-9]|2\d|3[01])\.').hasMatch(host);
  }

  static void applyOverride(String? raw) {
    final String s = (raw ?? '').trim();
    _apiUrl = s.isEmpty ? buildApiUrl : normalize(s);
  }

  /// Socket.IO namespace `/rt` lives on the API host; derive the base origin.
  static String get socketUrl {
    final Uri u = Uri.parse(_apiUrl);
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
  static const String serverUrlKey = 'tk.v12';
}
