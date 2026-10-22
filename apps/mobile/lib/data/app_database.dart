import 'dart:async';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// Opens the app-local SQLite DB that hosts the offline write-ahead position buffer.
///
/// Write-ahead means: every fix is committed to `positions` BEFORE any network call, so a
/// crash never loses points (task robustness rule #4). Rows are deleted/flagged only after a
/// 2xx from `/positions/batch` (§4 idempotency makes replays safe regardless).
class AppDatabase {
  AppDatabase._();
  static final AppDatabase instance = AppDatabase._();

  static const String _name = 'traccer_positions.db';
  static const int _version = 1;

  /// DDL, exposed so the (device-free) unit tests can build the same table via sqflite_common_ffi.
  static const String createPositionsSql = '''
      CREATE TABLE positions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        clientTs   INTEGER NOT NULL,
        lat        REAL    NOT NULL,
        lng        REAL    NOT NULL,
        speedKmh   REAL    NOT NULL,
        bearing    REAL    NOT NULL,
        accuracyM  REAL    NOT NULL,
        altitudeM  REAL    NOT NULL DEFAULT 0,
        batteryPct INTEGER NOT NULL DEFAULT 0,
        provider   TEXT    NOT NULL,
        buffered   INTEGER NOT NULL DEFAULT 0,
        seq        INTEGER NOT NULL UNIQUE,
        uploaded   INTEGER NOT NULL DEFAULT 0,
        motionState TEXT
      )
    ''';
  static const List<String> createIndexSql = <String>[
    'CREATE INDEX idx_positions_uploaded ON positions (uploaded, clientTs)',
    'CREATE INDEX idx_positions_seq ON positions (seq)',
  ];

  Database? _db;
  Completer<Database>? _opening;

  Future<Database> get database async {
    if (_db != null) return _db!;
    // single-flight the open so concurrent DAO users don't double-create
    _opening ??= Completer<Database>();
    if (_opening!.isCompleted || _db != null) return _db!;
    try {
      final String path = p.join(await getDatabasesPath(), _name);
      final Database db = await openDatabase(
        path,
        version: _version,
        onCreate: _onCreate,
        onConfigure: (Database d) async => d.execute('PRAGMA foreign_keys = ON'),
      );
      _db = db;
      _opening!.complete(db);
      return db;
    } catch (e, s) {
      _opening!.completeError(e, s);
      _opening = null;
      rethrow;
    }
  }

  /// For unit tests: open an in-memory DB and inject it (avoids a device/emulator).
  Future<void> useForTesting(Database db) async {
    _db = db;
    final Completer<Database> c = Completer<Database>();
    c.complete(db);
    _opening = c;
  }

  Future<void> _onCreate(Database db, int v) async {
    await db.execute(createPositionsSql);
    for (final String sql in createIndexSql) {
      await db.execute(sql);
    }
  }

  Future<void> close() async {
    await _db?.close();
    _db = null;
    _opening = null;
  }
}
