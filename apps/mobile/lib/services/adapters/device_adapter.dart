import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';

/// Single seam for stable device identification (device_info_plus).
/// `deviceId` is what `/devices/register` and every ingest/heartbeat is keyed on (§2/§4).
class DeviceAdapter {
  DeviceAdapter([DeviceInfoPlugin? d]) : _d = d ?? DeviceInfoPlugin();

  final DeviceInfoPlugin _d;

  String get platform => defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android';

  /// Stable-per-install identifier. Persisted once in SessionStore so it never changes even
  /// if the OS vendor id would (Android `id` rotates on some OEMs after OTA).
  Future<String> deviceId() async {
    try {
      if (defaultTargetPlatform == TargetPlatform.android) {
        final AndroidDeviceInfo info = await _d.androidInfo;
        return 'and-${info.id}';
      }
      if (defaultTargetPlatform == TargetPlatform.iOS) {
        final IosDeviceInfo info = await _d.iosInfo;
        return 'ios-${info.identifierForVendor ?? info.model}';
      }
    } catch (_) {
      // fall through to a generated id below
    }
    return 'gen-${DateTime.now().microsecondsSinceEpoch}';
  }
}
