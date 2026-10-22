import './smoke-polyfill';
import { mockFetch, isMockMode } from './dev/mock';
import { startSim, stopSim, buildRoute } from './dev/sim';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  const line = `${cond ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`;
  if (!cond) failures++;
  console.log(line);
}

async function get(path: string, query: Record<string, string> = {}) {
  return mockFetch('GET', path, query, undefined);
}

async function send(method: string, path: string, body: Record<string, unknown> = {}, query: Record<string, string> = {}) {
  return mockFetch(method, path, query, body);
}

async function main(): Promise<void> {
  console.log(`=== Traccer dashboard mock smoke ===  (mock mode active: ${isMockMode()})`);
  if (!isMockMode()) {
    console.error('VITE_USE_MOCK must be 1 in .env for the smoke run');
    process.exit(2);
  }
  startSim();

  // 2. auth
  const login = await send('POST', '/auth/login', { identifier: 'admin', password: 'secret' });
  check('POST /auth/login → tokens+user', login.status === 200 && !!(login.json as { accessToken?: string }).accessToken);
  const badLogin = await send('POST', '/auth/login', { identifier: '', password: '' });
  check('POST /auth/login rejects empty creds', badLogin.status === 400);
  const me = await get('/auth/me');
  check('GET /auth/me → role ADMIN', (me.json as { user: { role: string } }).user.role === 'ADMIN');

  // 4. positions
  const live = await get('/positions/live');
  const liveJson = live.json as { positions: { userId: string; motionState: string }[] };
  check('GET /positions/live → 14 drivers', live.status === 200 && liveJson.positions.length === 14, `${liveJson.positions.length}`);
  const route = await get('/positions/route', { userId: 'u-ahmed', date: '2026-10-22' });
  const routeJson = route.json as { points: unknown[]; distanceKm: number };
  check('GET /positions/route → polyline points', route.status === 200 && routeJson.points.length > 100, `${routeJson.points.length} pts, ${routeJson.distanceKm} km`);
  const replayed = buildRoute('u-kareem', '2026-10-22');
  check('offline driver route is fully buffered (replayed)', Boolean(replayed && replayed.replayedPoints === replayed.points.length));

  // places / fences
  const fences = await get('/places/fences');
  const fj = fences.json as { sites: unknown[]; zones: unknown[]; outside: string[] };
  check('GET /places/fences → sites+zones+outside', fj.sites.length >= 3 && fj.zones.length >= 4 && fj.outside.includes('u-amr'));
  const zoneCreate = await send('POST', '/places/zones', { name: 'نطاق اختبار', shape: 'POLYGON', polygon: [[30, 31], [30.1, 31.1], [30, 31.2]] });
  check('POST /places/zones creates polygon zone', zoneCreate.status === 200);
  const zonePatch = await send('PATCH', `/places/zones/${(zoneCreate.json as { id: string }).id}`, { strictReject: true });
  check('PATCH /places/zones/:id strictReject', (zonePatch.json as { strictReject: boolean }).strictReject === true);

  // what the on-map fence panel sends: geometry + name in one write, then delete
  const geoPatch = await send('PATCH', '/places/sites/s-cairo', { name: 'مقر القاهرة', lat: 30.05, lng: 31.24, radiusM: 260 });
  const gj = geoPatch.json as { name: string; lat: number; radiusM: number };
  check('PATCH /places/sites/:id moves+renames+resizes', gj.name === 'مقر القاهرة' && gj.lat === 30.05 && gj.radiusM === 260);
  const zoneRules = await send('PATCH', `/places/zones/${(zoneCreate.json as { id: string }).id}`, { maxSpeedKmh: null, stopAlertMin: null });
  const zr = zoneRules.json as { maxSpeedKmh: number | null; stopAlertMin: number | null };
  check('PATCH /places/zones/:id clears zone rules', zr.maxSpeedKmh === null && zr.stopAlertMin === null);
  const delSite = await send('DELETE', '/places/sites/s-giza');
  const afterDel = await get('/places/fences');
  const ad = afterDel.json as { sites: { id: string }[]; zones: { id: string }[] };
  check('DELETE /places/sites/:id drops it from the feed', delSite.status === 200 && !ad.sites.some((s) => s.id === 's-giza'));
  const delZone = await send('DELETE', `/places/zones/${(zoneCreate.json as { id: string }).id}`);
  const afterZoneDel = await get('/places/fences');
  check('DELETE /places/zones/:id drops it', (afterZoneDel.json as { zones: { id: string }[] }).zones.every((z) => z.id !== (zoneCreate.json as { id: string }).id) && delZone.status === 200);
  const missingDel = await send('DELETE', '/places/zones/nope');
  check('DELETE unknown zone → 404', missingDel.status === 404);

  // alerts
  const alerts = await get('/alerts', { status: 'OPEN' });
  const aj = alerts.json as { alerts: { id: string; status: string }[] };
  check('GET /alerts?status=OPEN', aj.alerts.length > 0 && aj.alerts.every((a) => a.status === 'OPEN'));
  const firstId = aj.alerts[0].id;
  const ack = await send('POST', `/alerts/${firstId}/ack`);
  check('POST /alerts/:id/ack', (ack.json as { status: string }).status === 'ACK');
  const resolve = await send('POST', `/alerts/${firstId}/resolve`, { note: 'تم' });
  check('POST /alerts/:id/resolve', (resolve.json as { status: string }).status === 'RESOLVED');
  const callLog = await send('POST', `/alerts/${firstId}/call-log`, { called: true, note: 'رد' });
  check('POST /alerts/:id/call-log', Boolean((callLog.json as { meta: Record<string, unknown> }).meta.callLog));

  // what the map asks for: one driver's abnormal events inside one UTC day
  const dayWin = await get('/alerts', { userId: 'u-mostafa', from: '2026-10-22T00:00:00.000Z', to: '2026-10-22T23:59:59.999Z', pageSize: '200' });
  const dw = dayWin.json as { alerts: { userId: string; createdAt: string; meta: { lat?: number } }[] };
  check('GET /alerts?userId+day window filters to that driver', dw.alerts.length > 0 && dw.alerts.every((a) => a.userId === 'u-mostafa' && a.createdAt.startsWith('2026-10-22')), `${dw.alerts.length}`);
  check('day alerts carry meta.lat for map pins', dw.alerts.some((a) => typeof a.meta?.lat === 'number'));

  // attendance
  const att = await get('/attendance', { from: '2026-10-22', to: '2026-10-22' });
  const attj = att.json as { records: unknown[]; stats: { present: number } };
  check('GET /attendance grid+stats', attj.records.length >= 10 && attj.stats.present >= 1);
  const attCsv = await get('/attendance', { from: '2026-10-22', to: '2026-10-22', format: 'csv' });
  check('GET /attendance?format=csv', typeof (attCsv.json as { csv: string }).csv === 'string' && (attCsv.json as { csv: string }).csv.includes(','));

  // employees
  const drivers = await get('/employees', { role: 'DRIVER' });
  check('GET /employees?role=DRIVER → 14', (drivers.json as { employees: unknown[] }).employees.length === 14);
  const one = await get('/employees/u-ahmed');
  check('GET /employees/:id enriched with live', Boolean((one.json as { live?: unknown }).live));
  const rules = await send('PATCH', '/employees/u-ahmed/rules', { maxSpeedKmh: 75, stopAlertMin: 20 });
  check('PATCH /employees/:id/rules', (rules.json as { maxSpeedKmh: number }).maxSpeedKmh === 75);
  const dev = await get('/employees/u-ahmed/devices');
  check('GET /employees/:id/devices', (dev.json as { devices: unknown[] }).devices.length > 0);

  // sync
  const srcs = await get('/sync/sources');
  check('GET /sync/sources', (srcs.json as { sources: unknown[] }).sources.length >= 3);
  const run = await send('POST', '/sync/runs', { sourceId: 'src-1' });
  check('POST /sync/runs starts RUNNING', (run.json as { status: string }).status === 'RUNNING');
  const issues = await get('/sync/issues');
  const codes = (issues.json as { issues: { code: string }[] }).issues.map((i) => i.code);
  check('GET /sync/issues has MISSING_PHONE+UNKNOWN_SITE+IDENTIFIER_COLLISION', codes.includes('MISSING_PHONE') && codes.includes('UNKNOWN_SITE') && codes.includes('IDENTIFIER_COLLISION'));
  const matrix = await get('/sync/matrix');
  check('GET /sync/matrix freshness rows', (matrix.json as { rows: unknown[] }).rows.length > 0);

  // reports
  const daily = await get('/reports/daily', { date: '2026-10-22' });
  check('GET /reports/daily kpis', (daily.json as { kpis: { present: number } }).kpis.present > 0);
  const mile = await get('/reports/mileage', { groupBy: 'zone' });
  check('GET /reports/mileage?groupBy=zone', (mile.json as { rows: unknown[] }).rows.length > 0);
  const exc = await get('/reports/exceptions');
  check('GET /reports/exceptions', (exc.json as { total: number }).total > 0);
  const ts = await get('/reports/timesheet', { from: '2026-10-20', to: '2026-10-22' });
  check('GET /reports/timesheet', (ts.json as { rows: unknown[] }).rows.length > 0);

  // settings
  const st = await get('/settings');
  check('GET /settings rules+timezone+log', Boolean((st.json as { rules?: unknown; timezone?: string; notifications?: unknown }).rules) && (st.json as { timezone: string }).timezone === 'Africa/Cairo');
  const pref = await send('PATCH', '/me/preferences', { whatsapp: false });
  check('PATCH /me/preferences', (pref.json as { whatsapp: boolean }).whatsapp === false);
  const nlog = await get('/notifications/log');
  const failed = (nlog.json as { log: { status: string }[] }).log.filter((n) => n.status === 'FAILED' || n.status === 'NO_PROVIDER');
  check('GET /notifications/log surfaces failures', failed.length > 0);

  // unknown route → ApiError-shaped 404
  const nf = await get('/definitely-not-here');
  check('unknown path → 404 code', nf.status === 404 && !!(nf.json as { code?: string }).code);

  // live alert feed must include the scripted scenarios
  await new Promise((r) => setTimeout(r, 3500)); // let sim ticks fire
  const feed = await get('/alerts', { status: 'OPEN' });
  const types = new Set((feed.json as { alerts: { type: string }[] }).alerts.map((a) => a.type));
  check('sim raised SPEEDING/GEOFENCE/STOP/APP_OFFLINE family', types.has('SPEEDING') || types.has('GEOFENCE_EXIT') || types.has('STOP_EXCEEDED') || types.has('APP_OFFLINE'), [...types].join(','));

  stopSim();
  console.log(`\n=== ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(2);
});
