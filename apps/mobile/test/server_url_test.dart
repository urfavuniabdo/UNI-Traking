import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:traccer/core/app_config.dart';
import 'package:traccer/core/session_store.dart';

void main() {
  tearDown(() => AppConfig.applyOverride(null));

  group('AppConfig.normalize', () {
    test('accepts a bare host and upgrades it to https + /api/v1', () {
      expect(AppConfig.normalize('uni-tracking.onrender.com'),
          'https://uni-tracking.onrender.com/api/v1');
    });

    test('keeps an already complete url untouched', () {
      const String full = 'https://uni-tracking.onrender.com/api/v1';
      expect(AppConfig.normalize(full), full);
    });

    test('trims whitespace and trailing slashes', () {
      expect(AppConfig.normalize('  http://192.168.1.5:3000/api/v1/  '),
          'http://192.168.1.5:3000/api/v1');
    });

    test('keeps a non-default port', () {
      expect(AppConfig.normalize('localhost:3000'), 'http://localhost:3000/api/v1');
    });

    test('a scheme-less LAN host stays http, a public one becomes https', () {
      expect(AppConfig.normalize('192.168.1.186:3000'), 'http://192.168.1.186:3000/api/v1');
      expect(AppConfig.normalize('api.example.com'), 'https://api.example.com/api/v1');
    });

    test('empty input falls back to the build-time url', () {
      expect(AppConfig.normalize('   '), AppConfig.buildApiUrl);
    });
  });

  group('override lifetime', () {
    test('socketUrl follows the override, not the build default', () {
      AppConfig.applyOverride('https://uni-tracking.onrender.com/api/v1');
      expect(AppConfig.apiUrl, 'https://uni-tracking.onrender.com/api/v1');
      expect(AppConfig.socketUrl, 'https://uni-tracking.onrender.com');
    });

    test('clearing the override restores the build default', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SessionStore store = await SessionStore.open();
      await store.setServerUrl('uni-tracking.onrender.com');
      expect(AppConfig.apiUrl, 'https://uni-tracking.onrender.com/api/v1');

      await store.setServerUrl(null);
      expect(AppConfig.apiUrl, AppConfig.buildApiUrl);
      expect(store.serverUrl, isNull);
    });

    test('an override equal to the build default is not stored', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});
      final SessionStore store = await SessionStore.open();
      await store.setServerUrl(AppConfig.buildApiUrl);
      expect(store.serverUrl, isNull);
    });

    test('SessionStore.open replays a stored override (background isolates)', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        AppConfig.serverUrlKey: 'https://uni-tracking.onrender.com/api/v1',
      });
      await SessionStore.open();
      expect(AppConfig.apiUrl, 'https://uni-tracking.onrender.com/api/v1');
    });

    test('sign-out keeps the server but wipes identity', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        AppConfig.accessTokenKey: 'a',
        AppConfig.refreshTokenKey: 'r',
      });
      final SessionStore store = await SessionStore.open();
      await store.setServerUrl('uni-tracking.onrender.com');
      await store.clear();
      expect(store.isLoggedIn, isFalse);
      expect(store.serverUrl, 'https://uni-tracking.onrender.com/api/v1');
    });
  });
}
