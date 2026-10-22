@TestOn('vm')
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:traccer/data/app_database.dart';
import 'package:traccer/data/position_dao.dart';
import 'package:traccer/models/position.dart';

TrackPosition row(int sec, {int? seq, bool uploaded = false}) => TrackPosition(
      clientTs: DateTime.utc(2026, 10, 22, 6, 0, sec),
      lat: 30.0 + sec / 100000,
      lng: 31.0,
      speedKmh: 10,
      bearing: 0,
      accuracyM: 5,
      altitudeM: 0,
      batteryPct: 80,
      provider: 'gps',
      buffered: false,
      seq: seq ?? sec,
      uploaded: uploaded,
    );

void main() {
  late Database db;
  late PositionDao dao;

  setUp(() async {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    db = await databaseFactory.openDatabase(
      inMemoryDatabasePath,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (Database d, int v) async {
          await d.execute(AppDatabase.createPositionsSql);
          for (final String s in AppDatabase.createIndexSql) {
            await d.execute(s);
          }
        },
      ),
    );
    await AppDatabase.instance.useForTesting(db);
    dao = PositionDao();
  });

  tearDown(() async => db.close());

  test('dedupes insert by UNIQUE seq', () async {
    await dao.insert(row(1, seq: 100));
    await dao.insert(row(1, seq: 100)); // same seq → ignored
    expect(await dao.pendingCount(), 1);
  });

  test('takeBatch returns oldest-first and clamps to the 500 cap', () async {
    await dao.insertAll(<TrackPosition>[row(30, seq: 3), row(10, seq: 1), row(20, seq: 2)]);
    final List<TrackPosition> batch = await dao.takeBatch(limit: 2);
    expect(batch.length, 2);
    expect(batch.first.clientTs.second, 10);
    expect(batch[1].clientTs.second, 20);

    final List<TrackPosition> clamped = await dao.takeBatch(limit: 9999);
    expect(clamped.length, 3); // clamped well under 500, all returned
  });

  test('markUploaded flips uploaded + buffered', () async {
    await dao.insertAll(<TrackPosition>[row(1, seq: 1), row(2, seq: 2)]);
    final List<TrackPosition> batch = await dao.takeBatch();
    final List<int> ids = batch.map((TrackPosition p) => p.id ?? p.seq).toList();
    await dao.markUploaded(ids, buffered: true);
    expect(await dao.pendingCount(), 0);
    final List<Map<String, Object?>> check = await db.rawQuery(
      'SELECT buffered FROM positions WHERE uploaded = 1',
    );
    expect(check.every((Map<String, Object?> r) => r['buffered'] == 1), isTrue);
  });

  test('enforceMaxRows evicts the OLDEST rows', () async {
    await dao.insertAll(List<TrackPosition>.generate(10, (int i) => row(i + 1, seq: i + 1)));
    expect(await dao.pendingCount(), 10);
    final int removed = await dao.enforceMaxRows(6);
    expect(removed, 4);
    final List<TrackPosition> left = await dao.takeBatch(limit: 50);
    expect(left.length, 6);
    // the 6 survivors must be the newest (seconds 5..10), oldest 1..4 gone
    expect(left.first.clientTs.second, 5);
    expect(left.last.clientTs.second, 10);
  });
}
