import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:traccer/core/geo.dart';

void main() {
  group('Geo fence/distance', () {
    // Cairo reference points ~1.11 km per 0.01 deg latitude.
    test('haversine distance is sane', () {
      final double d = Geo.distanceMeters(30.0444, 31.2357, 30.0544, 31.2357);
      expect(d, closeTo(1112, 60));
    });

    test('fenceOffsetMeters: inside is positive, outside is negative', () {
      const LatLng center = LatLng(30.0444, 31.2357);
      // ~111m north of centre, radius 500 -> inside by ~389m
      expect(Geo.fenceOffsetMeters(lat: 30.0454, lng: 31.2357, center: center, radiusM: 500),
          greaterThan(0));
      // ~1.1km north -> outside
      expect(Geo.fenceOffsetMeters(lat: 30.0544, lng: 31.2357, center: center, radiusM: 500),
          lessThan(0));
    });

    test('pointInPolygon ray casting', () {
      const List<LatLng> square = <LatLng>[
        LatLng(30.0, 31.0),
        LatLng(30.0, 31.1),
        LatLng(30.1, 31.1),
        LatLng(30.1, 31.0),
        LatLng(30.0, 31.0), // closed
      ];
      expect(Geo.pointInPolygon(30.05, 31.05, square), isTrue);
      expect(Geo.pointInPolygon(30.2, 31.2, square), isFalse);
    });

    test('speedKmhFromFixes converts m over dt to km/h', () {
      // 1112 m in 100 s ≈ 11.12 m/s ≈ 40 km/h
      final double kmh = Geo.speedKmhFromFixes(
        lat1: 30.0444, lng1: 31.2357, t1: DateTime.utc(2026, 1, 1, 0, 0, 0),
        lat2: 30.0544, lng2: 31.2357, t2: DateTime.utc(2026, 1, 1, 0, 1, 40),
      );
      expect(kmh, closeTo(40, 4)); // 1112m / 100s * 3.6 ≈ 40 km/h
    });

    test('decodeLineString reads GeoJSON [lng,lat] pairs', () {
      final List<LatLng> pts =
          Geo.decodeLineString(<dynamic>[<dynamic>[31.2357, 30.0444], <dynamic>[31.3, 30.1]]);
      expect(pts.first.latitude, 30.0444);
      expect(pts.first.longitude, 31.2357);
    });
  });
}
