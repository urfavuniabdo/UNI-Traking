import 'package:sqflite/sqflite.dart';

import '../core/traccer_constants.dart';
import '../models/position.dart';
import 'app_database.dart';

/// Access layer for the offline position buffer.
///
/// Mirrors traccar-client-android's `DatabaseHelper` behaviour, in Dart:
///   * write EVERY fix first (`insert`)
///   * drain OLDEST-FIRST (`takeBatch`)
///   * keep at most [Buffer.maxRows]; evict oldest on overflow (`enforceMaxRows`)
///   * mark rows uploaded after a 2xx (`markUploaded`), setting `buffered` when the upload
///     happened after a reconnect, so `/positions/batch` replays them "as if realtime" (§4).
class PositionDao {
  PositionDao([AppDatabase? database]) : _db = database ?? AppDatabase.instance;

  final AppDatabase _db;

  static const int _maxBatch = Buffer.maxBatch; // 500 contract cap
  static const int _takeDefault = Buffer.takeBatchDefault; // 300

  Future<Database> get _raw async => _db.database;

  /// Insert one fix, dedup by UNIQUE `seq`. Returns the row id, or null if it already existed.
  Future<int?> insert(TrackPosition pos) async {
    final Database db = await _raw;
    final int id = await db.insert(
      'positions',
      pos.toRow(),
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
    // enforceMaxRows is cheap enough to run on every write while tracking.
    await enforceMaxRows();
    return id == 0 ? null : id;
  }

  /// Insert many in one transaction (used by tests / bulk restores).
  Future<void> insertAll(List<TrackPosition> positions) async {
    final Database db = await _raw;
    await db.transaction((Transaction txn) async {
      for (final TrackPosition p in positions) {
        await txn.insert('positions', p.toRow(), conflictAlgorithm: ConflictAlgorithm.ignore);
      }
    });
    await enforceMaxRows();
  }

  /// Count of rows not yet uploaded.
  Future<int> pendingCount() async {
    final Database db = await _raw;
    final List<Map<String, Object?>> r = await db
        .rawQuery('SELECT COUNT(*) AS c FROM positions WHERE uploaded = 0');
    return (r.first['c'] as int?) ?? 0;
  }

  /// Oldest-first batch of pending rows (max [limit], clamped to the 500 contract cap).
  Future<List<TrackPosition>> takeBatch({int limit = _takeDefault}) async {
    final Database db = await _raw;
    final int cap = limit > _maxBatch ? _maxBatch : limit;
    final List<Map<String, Object?>> rows = await db.query(
      'positions',
      where: 'uploaded = 0',
      orderBy: 'clientTs ASC, id ASC',
      limit: cap,
    );
    return rows.map(TrackPosition.fromRow).toList(growable: false);
  }

  /// Mark rows uploaded. When [buffered] is true (drained after a reconnect) we also set the
  /// `buffered` column so the wire payload carries `buffered: true` (§4 replay-as-realtime).
  Future<void> markUploaded(List<int> ids, {required bool buffered}) async {
    if (ids.isEmpty) return;
    final Database db = await _raw;
    final Batch batch = db.batch();
    final String placeholders = List<String>.filled(ids.length, '?').join(',');
    batch.rawUpdate(
      'UPDATE positions SET uploaded = 1${buffered ? ', buffered = 1' : ''} '
      'WHERE id IN ($placeholders)',
      ids,
    );
    await batch.commit(noResult: true);
  }

  /// Evict the OLDEST rows (uploaded first) beyond [Buffer.maxRows]. Matches the traccar
  /// client's bounded-buffer strategy so the app can never fill the device's storage.
  Future<int> enforceMaxRows([int maxRows = Buffer.maxRows]) async {
    final Database db = await _raw;
    final List<Map<String, Object?>> countRes =
        await db.rawQuery('SELECT COUNT(*) AS c FROM positions');
    final int total = (countRes.first['c'] as int?) ?? 0;
    if (total <= maxRows) return 0;
    final int excess = total - maxRows;
    // Prefer dropping already-uploaded oldest rows; if still over, drop oldest buffered.
    final List<Map<String, Object?>> victims = await db.query(
      'positions',
      columns: <String>['id'],
      where: 'uploaded = 1',
      orderBy: 'clientTs ASC, id ASC',
      limit: excess,
    );
    List<int> ids = victims.map((Map<String, Object?> m) => m['id'] as int).toList();
    if (ids.length < excess) {
      final List<Map<String, Object?>> more = await db.query(
        'positions',
        columns: <String>['id'],
        orderBy: 'clientTs ASC, id ASC',
        limit: excess - ids.length,
      );
      ids = <int>[...ids, ...more.map((Map<String, Object?> m) => m['id'] as int)];
    }
    if (ids.isEmpty) return 0;
    final String placeholders = List<String>.filled(ids.length, '?').join(',');
    await db.rawDelete('DELETE FROM positions WHERE id IN ($placeholders)', ids);
    return ids.length;
  }

  /// Delete uploaded rows that are older than [age] (housekeeping; keeps DB small).
  Future<void> vacuumUploaded({Duration age = const Duration(days: 3)}) async {
    final Database db = await _raw;
    final int cutoff =
        DateTime.now().toUtc().subtract(age).millisecondsSinceEpoch;
    await db.delete('positions', where: 'uploaded = 1 AND clientTs < ?', whereArgs: <Object>[cutoff]);
  }

  Future<void> clearAll() async {
    final Database db = await _raw;
    await db.delete('positions');
  }
}
