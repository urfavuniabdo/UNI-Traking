import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

/// Single seam for ALL location/permission platform calls (geolocator + permission_handler).
/// Keeping it here means a plugin bump or a permissions-policy change touches one file only.
class LocationAdapter {
  const LocationAdapter();

  /// Is the system Location/GPS service turned on? (drives the GPS_ON/GPS_OFF toggle-event)
  Future<bool> isServiceEnabled() => Geolocator.isLocationServiceEnabled();

  /// Emits enabled/disabled as the user toggles GPS in system settings.
  Stream<ServiceStatus> serviceStatus() => Geolocator.getServiceStatusStream();

  /// Ask the OS for the permission tiers we need. Returns granted status.
  Future<PermissionResult> requestPermissions({required bool background}) async {
    final ph.PermissionStatus whenInUse = await ph.Permission.locationWhenInUse.request();
    if (!whenInUse.isGranted) return PermissionResult.denied;
    if (!background) return PermissionResult.grantedWhenInUse;
    final ph.PermissionStatus always = await ph.Permission.locationAlways.request();
    return always.isGranted
        ? PermissionResult.grantedAlways
        : PermissionResult.grantedWhenInUse; // background denied → still usable in foreground
  }

  /// Battery-optimization ignore helper. On Android the OEM sheet tells the user how to
  /// disable battery optimization; here we just jump to the right system screen.
  /// `permission_handler.openAppSettings()` opens the app's settings page (where the
  /// "unrestricted battery / ignore optimizations" toggle lives on most OEMs).
  Future<bool> openSystemSettings() => ph.openAppSettings();
  Future<bool> openLocationSettings() => Geolocator.openLocationSettings();

  /// The live tracking stream, tuned per CONTRACT §5 / task brief:
  ///   interval 5s · distanceFilter 25m · highest accuracy.
  Stream<Position> positionStream() {
    const LocationSettings settings = LocationSettings(
      accuracy: LocationAccuracy.best,
      distanceFilter: 25, // metres
    );
    return Geolocator.getPositionStream(locationSettings: settings);
  }

  /// One-shot fix for the check-in flow.
  Future<Position?> currentFix() async {
    try {
      return await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 15),
      );
    } catch (_) {
      // fall back to last known so check-in still works
      return Geolocator.getLastKnownPosition();
    }
  }
}

enum PermissionResult { denied, grantedWhenInUse, grantedAlways }
