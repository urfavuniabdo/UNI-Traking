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

  /// The live tracking stream, tuned per CONTRACT §5:
  ///   interval 5s · distanceFilter 10m · highest accuracy.
  ///
  /// `intervalDuration` does NOT keep a stationary driver emitting: FusedLocation applies
  /// `distanceFilter` as a gate, so a phone that has not moved 10 m delivers nothing. The
  /// engine's own idle poll (TrackingEngine) is what keeps a stopped driver fresh on the map.
  /// The filter stays at 10m because a walking person covers 25m in ~20s, and the motion
  /// classifier needs three samples to commit a state — at 25m a short walk never reads
  /// as walking.
  ///
  /// The feed is the platform default (fused), the operator's call on 2026-10-27: the
  /// satellites-only cut left an indoor driver with no fix at all, invisible on the live board.
  /// The cached-answer ghost that cut once stopped is guarded downstream — §5's server filters
  /// and the sensor witness.
  Stream<Position> positionStream() {
    final AndroidSettings settings = AndroidSettings(
      accuracy: LocationAccuracy.best,
      distanceFilter: 10, // metres
      intervalDuration: const Duration(seconds: 5),
    );
    return Geolocator.getPositionStream(locationSettings: settings);
  }

  /// A fix that is genuinely *now*, for the live trace.
  ///
  /// `Geolocator.getCurrentPosition` answers from FusedLocation's last-known cache, so the
  /// request rides a stream subscription instead. `distanceFilter: 0` keeps a stationary
  /// phone answering.
  ///
  /// Returns null when nothing fresh arrived: silence is honest, a repeated old point is a lie.
  Future<Position?> freshFix({Duration maxAge = const Duration(seconds: 45)}) async {
    try {
      final Position p = await Geolocator.getPositionStream(
        locationSettings: AndroidSettings(
          accuracy: LocationAccuracy.best,
          distanceFilter: 0,
          intervalDuration: const Duration(seconds: 2),
        ),
      ).first.timeout(const Duration(seconds: 12));
      if (DateTime.now().toUtc().difference(p.timestamp.toUtc()) > maxAge) return null;
      return p;
    } catch (_) {
      return null;
    }
  }

  /// One-shot fix for the check-in flow: a fresh cache, then one live attempt, then the
  /// cache whatever its age so the button still works indoors.
  ///
  /// Android 12+ lets the user grant *approximate* location, which lands ~3 km off and
  /// silently corrupts fence validation.
  ///
  /// The cache is deliberately missing from the tracking path and present here: a button that
  /// cannot be pressed indoors is worse than a check-in point read one minute late. The engine's
  /// own "a fix must be newer than the last one accepted" gate is what keeps this cache out of the line.
  ///
  /// The cache comes **first** when it is fresh: waiting for a live fix before even reading it
  /// used to spin the button twice through `freshFix`'s full 12 s timeout —
  /// half a minute of loading before the request left the device. The 45 s freshness window is
  /// `freshFix`'s own, and `_approximateAccuracyM` keeps a Wi-Fi-grade cache out.
  static const double _approximateAccuracyM = 1000;
  static const Duration _cacheMaxAge = Duration(seconds: 45);

  Future<Position?> currentFix() async {
    final Position? cached = await Geolocator.getLastKnownPosition();
    final bool cacheUsable = cached != null &&
        DateTime.now().toUtc().difference(cached.timestamp.toUtc()) <= _cacheMaxAge &&
        cached.accuracy <= _approximateAccuracyM;
    if (cacheUsable) return cached;
    return await freshFix() ?? cached;
  }
}

enum PermissionResult { denied, grantedWhenInUse, grantedAlways }
