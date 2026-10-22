import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:traccer/core/traccer_constants.dart';

/// Golden consistency gate: `apps/mobile/lib/core/traccer_constants.dart` MUST equal
/// `packages/shared/golden/constants.json`, which `tools/generate_constants_golden.mjs`
/// produces from `packages/shared/src/constants.ts`.
///
/// If someone changes the TS, they must re-run the generator AND move the Dart mirror,
/// otherwise this test fails — that's the whole point (no Flutter/TS build required).
void main() {
  late Map<String, Object?> golden;

  setUpAll(() {
    final File f = File('../../packages/shared/golden/constants.json');
    expect(f.existsSync(), isTrue,
        reason: 'golden missing — run: node tools/generate_constants_golden.mjs');
    golden = jsonDecode(f.readAsStringSync()) as Map<String, Object?>;
  });

  double num(Object? v) => (v! as num).toDouble();

  test('MOTION thresholds match the golden', () {
    final Map<String, Object?> g = golden['MOTION']! as Map<String, Object?>;
    final Map<String, Object?> d = Motion.toGoldenMap();
    for (final String k in g.keys) {
      expect(d[k], isNotNull, reason: 'Dart missing MOTION.$k');
      expect(num(d[k]), num(g[k]), reason: 'MOTION.$k mismatch');
    }
    expect(d.length, g.length);
  });

  test('RULE_DEFAULTS match the golden', () {
    final Map<String, Object?> g = golden['RULE_DEFAULTS']! as Map<String, Object?>;
    final Map<String, Object?> d = RuleDefaults.toGoldenMap();
    for (final String k in g.keys) {
      expect(d[k], isNotNull, reason: 'Dart missing RULE_DEFAULTS.$k');
      expect(num(d[k]), num(g[k]), reason: 'RULE_DEFAULTS.$k mismatch');
    }
    expect(d.length, g.length);
  });

  test('enum lists match the golden (order + content)', () {
    List<String> arr(String key) => (golden[key]! as List).cast<String>();
    expect(MotionStates.all, arr('MOTION_STATES'));
    expect(AlertTypes.all, arr('ALERT_TYPES'));
    expect(DriverVisibleAlerts.all, arr('DRIVER_VISIBLE_ALERTS'));
    expect(GeoEventKinds.all, arr('GEO_EVENT_KINDS'));
    expect(Severity.all, arr('SEVERITY'));
    expect(Roles.all, arr('ROLES'));
    expect(AttendanceStatus.all, arr('ATTENDANCE_STATUS'));
  });

  test('Arabic alert copy matches the golden exactly', () {
    final Map<String, Object?> g = golden['AR_ALERT_TEXT']! as Map<String, Object?>;
    final Map<String, Object?> d = ArAlertText.toGoldenMap();
    expect(d.keys.toSet(), g.keys.toSet());
    for (final String k in g.keys) {
      final Map<String, Object?> gEntry = g[k]! as Map<String, Object?>;
      final Map<String, Object?> dEntry = d[k]! as Map<String, Object?>;
      expect(dEntry['title'], gEntry['title'], reason: 'AR title $k');
      expect(dEntry['body'], gEntry['body'], reason: 'AR body $k');
    }
  });

  test('motion-state Arabic labels match the golden', () {
    final Map<String, Object?> g = golden['MOTION_STATE_AR']! as Map<String, Object?>;
    for (final String k in g.keys) {
      expect(MotionStates.ar[k], g[k], reason: 'MOTION_STATE_AR.$k');
    }
  });

  test('invariant asserts hold', () {
    expect(assertMotionThresholdsConsistent, returnsNormally);
  });
}
