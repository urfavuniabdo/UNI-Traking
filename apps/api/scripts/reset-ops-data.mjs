#!/usr/bin/env node
/**
 * Clears the operational history — alerts, notifications, positions, trips, stops, attendance and
 * leave — while leaving the org itself (drivers, zones, sites, logins, devices, per-driver rules)
 * exactly as it is, so a test can start from a clean board without re-seeding anything.
 *
 * Dry-run by default: it prints what it WOULD delete and touches nothing until `--apply`.
 *
 *   node scripts/reset-ops-data.mjs            # preview
 *   node scripts/reset-ops-data.mjs --apply    # delete
 */
import { Client } from 'pg';

const APPLY = process.argv.includes('--apply');

// Children before parents: CallLog and NotificationLog point at Alert, StopEvent at Trip.
const TABLES = [
  'CallLog',
  'NotificationLog',
  'Alert',
  'GeoEvent',
  'RouteLine',
  'StopEvent',
  'Trip',
  'Position',
  'AttendanceRecord',
  'LeaveRequest',
  'SyncIssue',
  'SyncRun',
];

// Kept on purpose — wipe these and the test would have to re-register the phone and re-assign zones.
const KEEP = ['OrgUnit', 'Site', 'Zone', 'Employee', 'User', 'Session', 'Device', 'RuleOverride', 'Setting', 'SyncSource', 'ShiftSchedule', 'ShiftAssignment', 'UserPreference'];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Run this inside the Render shell, not from a local checkout.');
  process.exit(1);
}
// The free Postgres instance is shared with other projects; a wrong DATABASE_URL here would
// delete THAT project's history, so name the target before doing anything else.
const db = new URL(url).pathname.slice(1);
console.log(`database: ${db}`);
if (db !== 'uni_tracking') {
  console.error(`refusing to run against "${db}" — this script only clears the uni_tracking database.`);
  process.exit(1);
}

const client = new Client({ connectionString: url, ssl: url.includes('render.com') ? { rejectUnauthorized: false } : undefined });
await client.connect();

const counts = async () => {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
    out[t] = rows[0].n;
  }
  return out;
};

const before = await counts();
let total = 0;
console.log(`\n${APPLY ? 'deleting' : 'would delete'}:`);
for (const t of TABLES) {
  if (before[t] === 0) continue;
  total += before[t];
  console.log(`  ${String(before[t]).padStart(7)}  ${t}`);
}
if (total === 0) console.log('  (nothing to clear)');

if (APPLY && total > 0) {
  await client.query('BEGIN');
  for (const t of TABLES) {
    const { rowCount } = await client.query(`DELETE FROM "${t}"`);
    if (rowCount) console.log(`  deleted ${String(rowCount).padStart(7)}  ${t}`);
  }
  await client.query('COMMIT');

  const after = await counts();
  const kept = await client.query(
    `SELECT (SELECT count(*) FROM "Employee") AS employees,
            (SELECT count(*) FROM "Zone") AS zones,
            (SELECT count(*) FROM "Device") AS devices,
            (SELECT count(*) FROM "User") AS users,
            (SELECT count(*) FROM "RuleOverride") AS overrides`);
  console.log('\nafter:');
  console.log(`  remaining ops rows: ${Object.values(after).reduce((a, b) => a + b, 0)}`);
  for (const [k, v] of Object.entries(kept.rows[0])) console.log(`  kept ${k}: ${v}`);
} else if (!APPLY) {
  console.log('\nnothing was deleted — re-run with --apply.');
}

await client.end();
