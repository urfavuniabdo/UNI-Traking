import 'package:battery_plus/battery_plus.dart';

/// Single seam for battery level (battery_plus).
/// Feeds `battery` into `/devices/heartbeat` (§2) and each position row (§4).
class BatteryAdapter {
  BatteryAdapter([Battery? b]) : _b = b ?? Battery();

  final Battery _b;

  /// 0..100. Returns null on unsupported/permission cases so callers can omit the field.
  Future<int?> level() async {
    try {
      return await _b.batteryLevel;
    } catch (_) {
      return null;
    }
  }

  Stream<int> onLevelChange() {
    try {
      return _b.onBatteryLevelChanged;
    } catch (_) {
      return const Stream<int>.empty();
    }
  }
}
