import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;

/// Minimal Arabic string table loaded from `assets/strings/ar.json`.
/// Falls back to a baked-in map so the app never renders blank before init completes.
class S {
  S._();

  static final Map<String, String> _strings = <String, String>{..._fallback};
  static bool _loaded = false;

  static Future<void> load() async {
    if (_loaded) return;
    try {
      final String raw = await rootBundle.loadString('assets/strings/ar.json');
      final Map<String, dynamic> parsed = jsonDecode(raw) as Map<String, dynamic>;
      parsed.forEach((String k, Object? v) => _strings[k] = v.toString());
    } catch (_) {
      // keep fallback
    }
    _loaded = true;
  }

  /// t('checkIn') → "تشيك ان". Missing keys return the key itself (easy to spot).
  static String t(String key) => _strings[key] ?? key;

  static const Map<String, String> _fallback = <String, String>{
    'appName': 'Traccer',
    'checkIn': 'تشيك ان',
    'checkOut': 'تشيك أوت',
    'insideFence': 'داخل النطاق',
    'outsideFence': 'خارج النطاق',
    'fenceUnknown': 'جارٍ التحقق من النطاق',
    'trackingWorking': 'التتبع: يعمل',
    'trackingStopped': 'التتبع: متوقف',
    'gpsOn': 'GPS: مفتوح',
    'gpsOff': 'GPS: مغلق',
    'dataConnected': 'الداتا: متصلة',
    'dataOffline': 'الداتا: غير متصلة',
    'offlineBuffer': 'مخزون أوف لاين',
    'points': 'نقطة',
    'emergencyStop': 'إيقاف التتبع الطارئ',
    'contactSupervisor': 'اتصل بالمشرف',
    'history': 'سجل الحضور',
    'notifications': 'التنبيهات',
    'settings': 'الإعدادات',
    'logout': 'تسجيل الخروج',
    'noConnection': 'لا يوجد اتصال بالخادم',
  };
}
