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

  /// The same signal flattened to what the UI actually needs: is the switch on right now?
  Stream<bool> serviceOnOff() => serviceStatus().map((ServiceStatus s) => s == ServiceStatus.enabled);

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
  ///   interval 5s · distanceFilter 10m · highest accuracy.
  ///
  /// `intervalDuration` does NOT keep a stationary driver emitting: FusedLocation applies
  /// `distanceFilter` as a gate, so a phone that has not moved 10 m delivers nothing. The
  /// engine's own idle poll (TrackingEngine) is what keeps a stopped driver fresh on the map.
  /// The filter stays at 10m because a walking person covers 25m in ~20s, and the motion
  /// classifier needs three samples to commit a state — at 25m a short walk never reads
  /// as walking.
  Stream<Position> positionStream() {
    final AndroidSettings settings = AndroidSettings(
      accuracy: LocationAccuracy.best,
      distanceFilter: 10, // metres
      intervalDuration: const Duration(seconds: 5),
    );
    return Geolocator.getPositionStream(locationSettings: settings);
  }

  /// One-shot fix for the check-in flow.
  ///
  /// Android 12+ lets the user grant *approximate* location, which lands ~3 km off and
  /// silently corrupts fence validation — so a first fix that coarse gets one GNSS retry.
  static const double _approximateAccuracyM = 1000;

  Future<Position?> currentFix() async {
    try {
      final Position first = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.best,
        timeLimit: const Duration(seconds: 15),
      );
      if (first.accuracy <= _approximateAccuracyM) return first;
      return await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.best,
        timeLimit: const Duration(seconds: 10),
      );
    } catch (_) {
      // fall back to last known so check-in still works
      return Geolocator.getLastKnownPosition();
    }
  }
}

enum PermissionResult { denied, grantedWhenInUse, grantedAlways }
