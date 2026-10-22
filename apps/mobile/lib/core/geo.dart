import 'dart:math' as math;
import 'dart:typed_data';

import 'package:latlong2/latlong.dart';

/// Geodesy helpers shared by the check-in flow, the classifier and tests.
///
/// The backend uses `@turf/turf` for point-in-shape; we mirror the *result* client-side
/// only for UX (showing distance / live fence state). The server is authoritative (§3).
class Geo {
  const Geo._();

  static const double _earthRadiusM = 6371000.0;

  /// Great-circle distance in metres (haversine).
  static double distanceMeters(double lat1, double lng1, double lat2, double lng2) {
    final double dLat = _rad(lat2 - lat1);
    final double dLng = _rad(lng2 - lng1);
    final double a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(_rad(lat1)) * math.cos(_rad(lat2)) * math.sin(dLng / 2) * math.sin(dLng / 2);
    final double c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
    return _earthRadiusM * c;
  }

  static double distanceBetween(LatLng a, LatLng b) =>
      distanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);

  /// Distance from a point to a circular fence (centre + radius). Negative => outside.
  static double fenceOffsetMeters(
          {required double lat, required double lng, required LatLng center, required double radiusM}) =>
      radiusM - distanceMeters(lat, lng, center.latitude, center.longitude);

  /// Ray-casting point-in-polygon. [ring] is a closed list of lat/lng (last may repeat first).
  /// Handles the antimeridian poorly (acceptable for Egypt-only deployments).
  static bool pointInPolygon(double lat, double lng, List<LatLng> ring) {
    if (ring.length < 3) return false;
    bool inside = false;
    for (int i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      final double xi = ring[i].latitude, yi = ring[i].longitude;
      final double xj = ring[j].latitude, yj = ring[j].longitude;
      final bool intersect =
          ((yi > lng) != (yj > lng)) && (lat < (xj - xi) * (lng - yi) / ((yj - yi) + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /// Shortest distance (metres) from a point to a polygon edge, so we can show how far
  /// outside a fence the user is. Cheap approximation via vertex-to-vertex segments.
  static double distanceToPolygonMeters(double lat, double lng, List<LatLng> ring) {
    double best = double.infinity;
    for (int i = 0; i < ring.length - 1; i++) {
      final double d = _distToSegmentMeters(lat, lng, ring[i], ring[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  static double _distToSegmentMeters(double pLat, double pLng, LatLng a, LatLng b) {
    // Project on the straight line in a local equirectangular frame (fine at city scale).
    final double ax = a.longitude, ay = a.latitude;
    final double bx = b.longitude, by = b.latitude;
    final double px = pLng, py = pLat;
    final double dx = bx - ax, dy = by - ay;
    final double len2 = dx * dx + dy * dy;
    double t = len2 == 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t.clamp(0.0, 1.0);
    final double projX = ax + t * dx, projY = ay + t * dy;
    return distanceMeters(pLat, pLng, projY, projX);
  }

  /// Speed in km/h from two fixes (haversine / dt). Used when the device reports no speed.
  static double speedKmhFromFixes({
    required double lat1,
    required double lng1,
    required DateTime t1,
    required double lat2,
    required double lng2,
    required DateTime t2,
  }) {
    final double dtS = t2.difference(t1).inMilliseconds / 1000.0;
    if (dtS <= 0) return 0;
    final double m = distanceMeters(lat1, lng1, lat2, lng2);
    return (m / dtS) * 3.6; // m/s -> km/h
  }

  /// Bearing (deg) from fix1 to fix2.
  static double bearingDegrees(double lat1, double lng1, double lat2, double lng2) {
    final double dLng = _rad(lng2 - lng1);
    final double y = math.sin(dLng) * math.cos(_rad(lat2));
    final double x = math.cos(_rad(lat1)) * math.sin(_rad(lat2)) -
        math.sin(_rad(lat1)) * math.cos(_rad(lat2)) * math.cos(dLng);
    return (math.atan2(y, x).toDegrees() + 360) % 360;
  }

  /// Decodes a GeoJSON LineString ([lng,lat] pairs) into [LatLng] points for flutter_map.
  static List<LatLng> decodeLineString(dynamic coordinates) {
    final List<LatLng> out = <LatLng>[];
    if (coordinates is List) {
      for (final Object? c in coordinates) {
        if (c is List && c.length >= 2) {
          out.add(LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()));
        }
      }
    }
    return out;
  }

  /// Packs a list of [LatLng] into a compact Float64List (test/serialization helper).
  static Float64List flatten(List<LatLng> pts) {
    final Float64List buf = Float64List(pts.length * 2);
    for (int i = 0; i < pts.length; i++) {
      buf[i * 2] = pts[i].latitude;
      buf[i * 2 + 1] = pts[i].longitude;
    }
    return buf;
  }

  static double _rad(double deg) => deg * math.pi / 180;
}

extension on double {
  double toDegrees() => this * 180 / math.pi;
}
