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
      for (final MapEntry<String, Object?> entry in parsed.entries) {
        _strings[entry.key] = entry.value.toString();
      }
    } catch (_) {
      // keep fallback
    }
    _loaded = true;
  }

  /// t('checkIn') → "بدء اليوم". Missing keys return the key itself (easy to spot).
  static String t(String key) => _strings[key] ?? key;

  static const Map<String, String> _fallback = <String, String>{
    'appName': 'UNI Tracking',
    'checkIn': 'بدء اليوم',
    'dismiss': 'إخفاء',
    'checkOut': 'إنهاء اليوم',
    'insideFence': 'داخل النطاق',
    'outsideFence': 'خارج النطاق',
    'fenceUnknown': 'جارٍ التحقق من النطاق',
    'trackingWorking': 'التتبع: يعمل',
    'trackingStopped': 'التتبع: متوقف',
    'gpsOn': 'تحديد الموقع: مُفعّل',
    'gpsOff': 'تحديد الموقع: مُعطّل',
    'dataConnected': 'الإنترنت: متصل',
    'dataOffline': 'الإنترنت: غير متصل',
    'offlineBuffer': 'البيانات المحفوظة',
    'points': 'نقطة',
    'helpRequest': 'طلب مساعدة طارئة',
    'holdToHelp': 'استمر بالضغط ثلاث ثوانٍ ثم ارفع الإصبع للإرسال',
    'helpSent': 'تم إرسال طلب المساعدة الطارئة إلى الإدارة',
    'holdToFinish': 'استمر بالضغط ثلاث ثوانٍ لتأكيد إنهاء اليوم',
    'releaseToFinish': 'ارفع إصبعك لتأكيد الإنهاء',
    'contactSupervisor': 'اتصل بالمشرف',
    'history': 'سجل الحضور',
    'leaveTodayStatus': 'يومك إجازة معتمدة — لا حاجة لبدء اليوم',
    'leaveTodayButton': 'إجازة معتمدة',
    'notifications': 'التنبيهات',
    'settings': 'الإعدادات',
    'logout': 'تسجيل الخروج',
    'noConnection': 'لا يوجد اتصال بالخادم',
  };
}
