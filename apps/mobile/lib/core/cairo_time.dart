import 'package:intl/intl.dart' show DateFormat;

/// Arabic / Africa-Cairo date & time formatting used by the UI and unit tests.
///
/// The phone's own clock IS Cairo time for our deployment, so `DateTime` values handed to
/// these helpers are device-local. `toCairo` is a best-effort re-anchor for UTC payloads.
class CairoTime {
  const CairoTime._();

  static const List<String> weekdayAr = <String>[
    'الاثنين',
    'الثلاثاء',
    'الأربعاء',
    'الخميس',
    'الجمعة',
    'السبت',
    'الأحد',
  ];

  static const List<String> monthAr = <String>[
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
  ];

  /// Egypt weekend is Friday + Saturday (weekday 5 and 6).
  static bool isWeekend(DateTime d) => d.weekday == DateTime.friday || d.weekday == DateTime.saturday;

  /// Africa/Cairo is UTC+2 (winter) / UTC+3 (summer DST reinstated 2023). We expose the
  /// winter base offset; the phone's own clock already reflects DST, so `toCairo` is only
  /// used when converting a raw UTC timestamp to a displayable instant.
  static DateTime toCairo(DateTime utc) => utc.toUtc().add(const Duration(hours: 2));

  static String two(int n) => n.toString().padLeft(2, '0');

  /// "14:05"
  static String formatTime(DateTime d) => '${two(d.hour)}:${two(d.minute)}';

  /// "22 أكتوبر 2026"
  static String formatDateAr(DateTime d) => '${d.day} ${monthAr[d.month - 1]} ${d.year}';

  /// "الاثنين 22 أكتوبر"
  static String formatDayAr(DateTime d) => '${weekdayAr[d.weekday - 1]} ${d.day} ${monthAr[d.month - 1]}';

  /// ISO-ish for the locale, used in payloads.
  static String iso(DateTime d) => DateFormat('yyyy-MM-dd').format(d);

  /// Human duration "2 س 05 د" for the shift clock.
  static String elapsedLabel(Duration e) {
    final int h = e.inHours;
    final int m = e.inMinutes % 60;
    if (h == 0) return '$m د';
    return '$h س ${two(m)} د';
  }

  /// Points label with Arabic plural-ish formatting kept simple.
  static String pointsLabel(int n) => '$n نقطة';
}
