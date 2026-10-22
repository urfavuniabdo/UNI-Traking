export const json = (v: unknown): string => {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v ?? null);
  } catch {
    return 'null';
  }
};

export const parseJson = <T>(v: string | null | undefined, fallback: T): T => {
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** مفتاح cooldown/dedupe للتنبيهات */
export const cooldownKey = (employeeId: string, type: string, bucket = ''): string =>
  `${employeeId}:${type}${bucket ? `:${bucket}` : ''}`;

/** YYYY-MM-DD في منطقة عرض التقارير (افتراضي Africa/Cairo) */
export const workDateOf = (d: Date, timeZone = process.env.DASHBOARD_TIMEZONE || 'Africa/Cairo'): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
    .slice(0, 10);

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const round = (v: number | null | undefined, digits = 2): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

export const isValidLat = (v: number) => Number.isFinite(v) && v >= -90 && v <= 90;
export const isValidLng = (v: number) => Number.isFinite(v) && v >= -180 && v <= 180;

/** تطبيع رقم الموبايل إلى E.164 بسيط (مصر افتراضيًا) بدون مكتبات خارجية */
export const normalizePhone = (raw: string | null | undefined, defaultCountry = '20'): string | null => {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.length >= 10 ? digits : null;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+${defaultCountry}${digits.slice(1)}`;
  if (digits.length >= 9) return `+${defaultCountry}${digits}`;
  return null;
};
