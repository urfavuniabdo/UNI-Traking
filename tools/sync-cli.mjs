#!/usr/bin/env node
// CLI رفيع لتشغيل مزامنة الـ HR عبر الـ HTTP API — docs/CONTRACT.md §8
// الاستخدام:  node tools/sync-cli.mjs run --source=hr_csv
// البيئة:     UNI_API_BASE (افتراضي http://localhost:3000/api/v1) · UNI_ADMIN_TOKEN (رمب Admin Bearer)
const BASE = (process.env.UNI_API_BASE || 'http://localhost:3000/api/v1').replace(/\/+$/, '');
const TOKEN = process.env.UNI_ADMIN_TOKEN || '';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: TOKEN ? `Bearer ${TOKEN}` : '', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const code = json && json.message ? json.message : res.status;
    throw new Error(`API ${method} ${path} فشل (${res.status}): ${code}`);
  }
  return json;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runCmd = async () => {
  if (!TOKEN) throw new Error('لازم تضبط UNI_ADMIN_TOKEN (توكن ADMIN) في البيئة');
  const sourceRef = arg('source');
  if (!sourceRef) throw new Error('مطلوب --source=<code أو id> — مثل: run --source=hr_csv');

  let sourceId = sourceRef;
  const sources = await api('GET', '/sync/sources');
  const byCode = (sources || []).find((s) => s.code === sourceRef || s.id === sourceRef);
  if (byCode) sourceId = byCode.id;
  else if (!(sources || []).length) throw new Error('لا توجد مصادر مزامنة معرّفة بعد — أنشئ مصدرًا أولًا عبر POST /sync/sources');

  console.log(`بدء مزامنة المصدر: ${byCode ? byCode.code : sourceRef} ...`);
  const started = await api('POST', '/sync/runs', { sourceId });
  if (started.skippedOverlap) console.log('⚠ تشغيل سابق لم ينتهِ بعد — تم تخطي هذا الطلب (SKIPPED_OVERLAP)');

  let view = null;
  for (let i = 0; i < 120; i += 1) {
    view = await api('GET', `/sync/runs/${started.runId}`);
    if (view.run.status !== 'RUNNING') break;
    await sleep(1500);
  }
  if (!view || view.run.status === 'RUNNING') throw new Error('انتهت المهلة والتشغيل ما زال RUNNING');

  const c = view.counts;
  const label = { SUCCESS: 'نجحت', PARTIAL: 'نجحت جزئيًا (بها مشاكل)', FAILED: 'فشلت' }[view.run.status] || view.run.status;
  console.log('—'.repeat(46));
  console.log(`تشغيل: ${view.run.id}  |  مصدر: ${view.source.code}  |  مُشغِّل: ${view.run.trigger}`);
  console.log(`الحالة: ${label}${view.run.error ? '  |  خطأ: ' + view.run.error : ''}`);
  console.log(`المفحوصة: ${c.scanned}  |  الجديدة: ${c.created}  |  المحدّثة: ${c.updated}  |  بدون تغيير: ${c.unchanged}  |  المعطّلة: ${c.deactivated}`);
  console.log(`بدون هاتف قابل للوصل: ${c.noPhone}  |  المشاكل: ${c.issues}`);
  const problems = (view.issues || []).slice(0, 15);
  for (const p of problems) console.log(`  • ${p.reason} — ${p.externalId}${p.detail ? ' — ' + p.detail : ''}`);
  if ((view.issues || []).length > 15) console.log(`  … وغيرها ${view.issues.length - 15} مشكلة (GET /sync/issues?resolved=false)`);
};

const main = async () => {
  const cmd = process.argv[2];
  if (cmd === 'run') return runCmd();
  console.log('الاستخدام: node tools/sync-cli.mjs run --source=hr_csv');
  console.log('متغيرات: UNI_API_BASE · UNI_ADMIN_TOKEN');
  if (cmd) throw new Error(`أمر غير معروف: ${cmd}`);
};

main().catch((e) => {
  console.error(`فشل: ${e.message}`);
  process.exit(1);
});
