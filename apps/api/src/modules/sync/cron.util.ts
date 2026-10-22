// مطابِق cron خفيف (5 أو 6 حقول) بدون أي حزم إضافية — يكفينا:
// ثوانٍ/دقائق/ساعات/أيام الشهر/الشهور/أيام الأسبوع، مع النجمة و "star slash n" و القيم و المدى والتكرار والقوائم الفاصلية.

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // seconds (6-field only)
  { min: 0, max: 59 }, // minutes
  { min: 0, max: 23 }, // hours
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // day of week (0=Sunday)
];

const matchToken = (token: string, spec: FieldSpec): number[] | null => {
  const t = token.trim();
  if (!t) return null;
  let body = t;
  let step = 1;
  const slash = t.indexOf('/');
  if (slash >= 0) {
    body = t.slice(0, slash);
    step = Number(t.slice(slash + 1));
    if (!Number.isInteger(step) || step <= 0) return null;
  }
  let from = spec.min;
  let to = spec.max;
  if (body !== '*') {
    const range = body.split('-');
    from = Number(range[0]);
    to = range.length > 1 ? Number(range[1]) : slash >= 0 ? spec.max : from;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < spec.min || to > spec.max || from > to) return null;
  }
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
};

const fieldAllowed = (expr: string, spec: FieldSpec): Set<number> | null => {
  const values = new Set<number>();
  for (const token of expr.split(',')) {
    const m = matchToken(token, spec);
    if (!m) return null;
    for (const v of m) values.add(v);
  }
  return values;
};

/** هل اللحظة d تطابق التعبير؟ (تعبير من 5 حقول = دقة دقيقة، نتجاهل الثواني) */
export const matchesCron = (expr: string, d: Date): boolean => {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  const hasSeconds = parts.length === 6;
  const fields = hasSeconds ? parts : ['0', ...parts];
  const now = [
    d.getSeconds(),
    d.getMinutes(),
    d.getHours(),
    d.getDate(),
    d.getMonth() + 1,
    d.getDay(),
  ];
  return fields.every((f, i) => {
    const allowed = fieldAllowed(f, FIELDS[i]);
    if (!allowed) return false;
    if (i === 5 && f !== '*') {
      // day-of-week: 7 == 0
      return allowed.has(now[i]) || (now[i] === 0 && allowed.has(7));
    }
    if (i === 3 || i === 4) {
      // dom/dow: standard cron OR semantics when both restricted — keep it simple AND,
      // our sources use time-only crons; document the limitation in README if needed.
    }
    return allowed.has(now[i]);
  });
};

/**
 * هل fired التعبير في أي ثانية داخل النافذة (now-windowMs, now]؟
 * يستخدمها المجدول الذي يعمل كل 60 ثانية — أبسط وأسهل اختبارًا من تسجيل cron jobs ديناميكية.
 */
export const cronDueWithin = (expr: string, now: Date, windowMs = 60_000): boolean => {
  const from = new Date(now.getTime() - windowMs);
  for (let t = new Date(from.getTime() + 1000); t.getTime() <= now.getTime(); t = new Date(t.getTime() + 1000)) {
    if (matchesCron(expr, t)) return true;
  }
  return false;
};
