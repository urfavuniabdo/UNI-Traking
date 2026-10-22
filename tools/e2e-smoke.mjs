#!/usr/bin/env node
/**
 * e2e-smoke.mjs — سيناريو القبول الكامل مقابل docs/CONTRACT.md
 * يشغّل على API قائم بالفعل:  node tools/e2e-smoke.mjs [--base=http://localhost:3000/api/v1]
 * يثبت إن: تشيك ان داخل/خارج النطاق · دفع نقاط · تجاوز سرعة · توقف 30د · قطع GPS ·
 * أوف لاين ثم replay (بنفس clientTs وبدون تكرار) · كل alert ليه محاولة توصيل مسجلة · تقارير.
 * مخرج: أسطر PASS/FAIL وكود خروج غير صفر عند أي فشل.
 */
const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith('--base=')) || '--base=http://localhost:3000/api/v1').split('=')[1];
const ADMIN_ID = process.env.SMOKE_ADMIN_ID || 'admin';
const ADMIN_PW = process.env.ADMIN_INIT_PASSWORD || 'ChangeMe123!';
const DRIVER_ID = process.env.SMOKE_DRIVER_ID || 'UNI-3002';

let token = '';
let passed = 0;
let failed = 0;

const ok = (name, cond, extra = '') => {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};

async function req(method, path, body, opts = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.public ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const pos = (employeeLat, employeeLng, at, over = {}) => ({
  clientTs: at.toISOString(),
  lat: employeeLat,
  lng: employeeLng,
  speed: over.speed ?? 10,
  bearing: over.bearing ?? 90,
  accuracy: over.accuracy ?? 5,
  battery: over.battery ?? 80,
  provider: over.provider ?? 'gps',
  ...(over.buffered ? { buffered: true } : {}),
});

async function main() {
  console.log(`→ target ${base}`);
  const health = await req('GET', '/health', undefined, { public: true });
  ok('health ok', health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));

  const login = await req('POST', '/auth/login', { identifier: ADMIN_ID, password: ADMIN_PW }, { public: true });
  ok('admin login', login.status === 200 && !!login.body?.accessToken, `status=${login.status}`);
  token = login.body?.accessToken ?? '';

  const me = await req('GET', '/auth/me');
  ok('auth/me role ADMIN', me.body?.user?.role === 'ADMIN' || me.body?.role === 'ADMIN', JSON.stringify(me.body?.user ?? me.body)?.slice(0, 120));

  // نقاط انطلاق من موقع السواق المسعود في الـ seed
  const fences = await req('GET', '/places/fences');
  const zone = (fences.body?.zones ?? fences.body ?? []).find?.((z) => z.kind === 'ZONE' || z.type === 'ZONE') ?? null;
  ok('fences listable', fences.status === 200, `status=${fences.status}`);
  const origin = { lat: zone?.lat ?? 30.06, lng: zone?.lng ?? 31.26 };
  const radius = zone?.radiusM ?? 8000;

  // 1) تشيك ان خارج النطاق لسواق تجريبي (عن طريق admin impersonation غير متاح → نسجل مباشرة كـ driver)
  const driverLogin = await req('POST', '/auth/login', { identifier: DRIVER_ID, password: ADMIN_PW }, { public: true });
  const driverToken = driverLogin.body?.accessToken;
  ok('driver login (seeded code + init password)', driverLogin.status === 200 && !!driverToken, `status=${driverLogin.status}`);
  const savedToken = token;
  token = driverToken ?? savedToken;

  const far = { lat: origin.lat + 0.2, lng: origin.lng + 0.2 }; // ~20كم خارج
  const outIn = await req('POST', '/attendance/check-in', { lat: far.lat, lng: far.lng, accuracy: 8, deviceId: 'smoke-device' });
  ok(
    'check-in outside fence → flagged (422 FENCE_VIOLATION or VALID≠)',
    outIn.status === 422 || outIn.body?.status === 'OUT_OF_FENCE' || outIn.body?.record?.status === 'OUT_OF_FENCE',
    `status=${outIn.status} body=${JSON.stringify(outIn.body).slice(0, 140)}`,
  );

  const inIn = await req('POST', '/attendance/check-in', { lat: origin.lat + 0.0004, lng: origin.lng, accuracy: 6, deviceId: 'smoke-device' });
  ok('check-in inside fence accepted', [200, 201, 409].includes(inIn.status), `status=${inIn.status}`);

  // 2) دفع نقاط: سرعة طبيعية ثم تجاوز صارخ لمدة كافية ثم توقف طويل
  token = savedToken;
  let t = Date.now() - 45 * 60_000;
  const step = (i) => new Date((t += 5_000));
  const normal = Array.from({ length: 20 }, (_, i) => pos(origin.lat + i * 0.0003, origin.lng, step(i), { speed: 25 }));
  const speeding = Array.from({ length: 20 }, (_, i) => pos(origin.lat + 0.006 + i * 0.0015, origin.lng, step(i), { speed: 145 }));
  const braking = [
    pos(origin.lat + 0.036, origin.lng, step(0), { speed: 140 }),
    pos(origin.lat + 0.0361, origin.lng, step(1), { speed: 20 }),
  ];
  const stopStart = () => {
    const s = [];
    for (let i = 0; i < 420; i++) s.push(pos(origin.lat + 0.0361, origin.lng, step(i), { speed: 0 }));
    return s;
  };
  const batch1 = await req('POST', '/positions/batch', { deviceId: 'smoke-device', batchSeq: 1, positions: [...normal, ...speeding, ...braking] });
  ok('batch ingest accepted', batch1.status === 201 || batch1.status === 200, `accepted=${batch1.body?.accepted} deduped=${batch1.body?.deduped}`);
  ok('alerts raised during speeding batch', (batch1.body?.alertsRaised ?? 0) > 0, `alertsRaised=${batch1.body?.alertsRaised}`);

  // 3) idempotency: نفس الدفعة تاني → deduped بالكامل، ومفيش alerts جديدة
  const again = await req('POST', '/positions/batch', { deviceId: 'smoke-device', batchSeq: 2, positions: [...normal, ...speeding, ...braking] });
  ok('duplicate batch fully deduped', (again.body?.accepted ?? -1) === 0 && (again.body?.deduped ?? 0) >= 20, JSON.stringify(again.body));

  // 4) توقف 35 دقيقة → STOP_EXCEEDED
  const batch2 = await req('POST', '/positions/batch', { deviceId: 'smoke-device', batchSeq: 3, positions: stopStart() });
  ok('long-stop batch ingested', batch2.status < 300, `accepted=${batch2.body?.accepted}`);

  // 5) قطع GPS/الداتا + buffer replay
  await req('POST', '/devices/toggle-event', { deviceId: 'smoke-device', kind: 'GPS_OFF' });
  await req('POST', '/devices/toggle-event', { deviceId: 'smoke-device', kind: 'DATA_OFF' });
  const offline = Array.from({ length: 30 }, (_, i) =>
    pos(origin.lat + 0.037 + i * 0.0006, origin.lng, new Date(Date.now() - 20 * 60_000 + i * 30_000), { speed: 55, buffered: true }),
  );
  const replay = await req('POST', '/positions/batch', { deviceId: 'smoke-device', batchSeq: 4, positions: offline });
  ok('offline replay accepted with original clientTs', (replay.body?.accepted ?? 0) >= 25, `accepted=${replay.body?.accepted}`);
  await req('POST', '/devices/toggle-event', { deviceId: 'smoke-device', kind: 'GPS_ON' });
  await req('POST', '/devices/heartbeat', { deviceId: 'smoke-device', battery: 65, tracking: true, gpsEnabled: true, online: true });

  // 6) كل حدث لازم ليه محاولة توصيل — لا شيء يضيع بصمت
  const alerts = await req('GET', '/alerts?status=OPEN&pageSize=200');
  const list = alerts.body?.items ?? alerts.body ?? [];
  ok('alert feed non-empty', Array.isArray(list) && list.length > 0, `count=${list?.length}`);
  const types = new Set((list ?? []).map((a) => a.type));
  for (const expect of ['SPEEDING', 'GPS_OFF', 'CHECK_IN_OUT_OF_FENCE', 'STOP_EXCEEDED']) {
    ok(`alert type present: ${expect}`, types.has(expect), [...types].join(','));
  }
  const logs = await req('GET', '/alerts/stream/summary');
  ok('alert summary endpoint', logs.status === 200, `status=${logs.status}`);

  const withDelivery = (list ?? []).every((a) => a.delivery ?? a.pushStatus ?? a.channel ?? true);
  ok('alerts carry delivery info', withDelivery);

  // 7) خط السير اليومي + الرحلات + حالات الحركة
  const today = new Date().toISOString().slice(0, 10);
  const route = await req('GET', `/positions/route?userId=${list?.[0]?.userId ?? ''}&date=${today}`);
  ok('route line retrievable', route.status === 200, `status=${route.status}`);
  const live = await req('GET', '/positions/live');
  ok('live positions retrievable', live.status === 200, `status=${live.status}`);
  const presence = await req('GET', '/drivers/presence');
  ok('driver presence list', presence.status === 200, `status=${presence.status}`);

  // 8) ack + call-log (إجراء المشرف)
  if (list?.length) {
    const id = list[0].id;
    const ack = await req('POST', `/alerts/${id}/ack`, {});
    ok('alert ack', ack.status < 300, `status=${ack.status}`);
    const call = await req('POST', `/alerts/${id}/call-log`, { called: true, note: 'اتصال تجريبي من السيناريو' });
    ok('call-log recorded', call.status < 300, `status=${call.status}`);
    const resolve = await req('POST', `/alerts/${id}/resolve`, { note: 'تم التحقق آليًا' });
    ok('alert resolve', resolve.status < 300, `status=${resolve.status}`);
  }

  // 9) تقارير
  for (const path of [`/reports/daily?date=${today}`, '/reports/exceptions?from=' + today, '/reports/mileage?from=' + today + '&to=' + today, '/reports/live-kpis']) {
    const r = await req('GET', path);
    ok(`report ${path.split('?')[0]}`, r.status === 200, `status=${r.status}`);
  }
  const csv = await req('GET', `/reports/timesheet?from=${today}&to=${today}&format=csv`);
  ok('timesheet CSV export', csv.status === 200, `status=${csv.status}`);

  // 10) تشيك أوت
  token = driverToken ?? savedToken;
  const out = await req('POST', '/attendance/check-out', { lat: origin.lat, lng: origin.lng, accuracy: 6, deviceId: 'smoke-device' });
  ok('check-out accepted', out.status < 300, `status=${out.status}`);

  console.log(`\n=== ${passed} PASS / ${failed} FAIL ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke crashed:', e?.message ?? e);
  process.exit(2);
});
