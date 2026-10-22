import 'package:connectivity_plus/connectivity_plus.dart';

/// Single seam for data/connectivity detection (connectivity_plus).
/// Drives the DATA_OFF/DATA_ON toggle-event and whether we drain the buffer or buffer it.
class ConnectivityAdapter {
  ConnectivityAdapter([Connectivity? c]) : _c = c ?? Connectivity();

  final Connectivity _c;

  Future<bool> isOnline() async {
    final List<ConnectivityResult> results = await _c.checkConnectivity();
    return results.any((ConnectivityResult r) => r != ConnectivityResult.none);
  }

  /// Emits true/false whenever reachability flips.
  Stream<bool> onChange() => _c.onConnectivityChanged.map((List<ConnectivityResult> rs) {
        return rs.any((ConnectivityResult r) => r != ConnectivityResult.none);
      });
}
