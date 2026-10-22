import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/cairo_time.dart';

void main() {
  group('CairoTime (Africa/Cairo formatting)', () {
    test('formatTime zero-pads', () {
      expect(CairoTime.formatTime(DateTime(2026, 10, 22, 9, 5)), '09:05');
      expect(CairoTime.formatTime(DateTime(2026, 10, 22, 14, 30)), '14:30');
    });

    test('formatDateAr uses Arabic month names', () {
      expect(CairoTime.formatDateAr(DateTime(2026, 10, 22)), '22 أكتوبر 2026');
      expect(CairoTime.formatDateAr(DateTime(2026, 1, 1)), '1 يناير 2026');
    });

    test('weekday Arabic labels line up with DateTime.weekday', () {
      // 22 Oct 2026 is a Thursday (weekday 4)
      final DateTime thu = DateTime(2026, 10, 22);
      expect(thu.weekday, DateTime.thursday);
      expect(CairoTime.weekdayAr[thu.weekday - 1], 'الخميس');
    });

    test('Egypt weekend is Friday + Saturday', () {
      expect(CairoTime.isWeekend(DateTime(2026, 10, 23)), isTrue); // Friday
      expect(CairoTime.isWeekend(DateTime(2026, 10, 24)), isTrue); // Saturday
      expect(CairoTime.isWeekend(DateTime(2026, 10, 22)), isFalse); // Thursday
    });

    test('elapsedLabel renders hours + minutes', () {
      expect(CairoTime.elapsedLabel(const Duration(minutes: 45)), '45 د');
      expect(CairoTime.elapsedLabel(const Duration(hours: 2, minutes: 5)), '2 س 05 د');
    });

    test('iso() emits yyyy-MM-dd', () {
      expect(CairoTime.iso(DateTime(2026, 10, 22)), '2026-10-22');
    });

    test('toCairo applies the winter +2 base offset', () {
      final DateTime utc = DateTime.utc(2026, 1, 22, 0, 0, 0);
      final DateTime cairo = CairoTime.toCairo(utc);
      expect(cairo.hour, 2);
    });
  });
}
