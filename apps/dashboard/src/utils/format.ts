const TZ = 'Africa/Cairo';

const dtf = new Intl.DateTimeFormat('ar-EG', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dtFull = new Intl.DateTimeFormat('ar-EG', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dtDateTime = new Intl.DateTimeFormat('ar-EG', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Time "HH:MM" (Africa/Cairo) — always rendered LTR/tabular via <Num>. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dtf.format(new Date(iso));
}

export function fmtDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return dtFull.format(typeof iso === 'string' ? new Date(iso) : iso);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dtDateTime.format(new Date(iso));
}

export function todayISODate(): string {
  const now = new Date();
  const y = now.toLocaleString('en-US', { timeZone: TZ, year: 'numeric' });
  const m = now.toLocaleString('en-US', { timeZone: TZ, month: '2-digit' });
  const d = now.toLocaleString('en-US', { timeZone: TZ, day: '2-digit' });
  return `${y}-${m}-${d}`;
}

/** "منذ ٣ د" style relative age (English digits + <Num>). */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} ث`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} د`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} س`;
  return `${Math.floor(h / 24)} يوم`;
}

export function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

/** Alert age for SLA coloring: minutes since creation. */
export function ageMin(iso: string, now = Date.now()): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return '—';
  if (m < 1000) return `${fmtNum(m)} م`;
  return `${fmtNum(m / 1000, 2)} كم`;
}

export function waLink(phone: string): string {
  const p = phone.replace(/[^\d]/g, '');
  return `https://wa.me/${p}`;
}

export function telLink(phone: string): string {
  return `tel:${phone.replace(/\s+/g, '')}`;
}

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** point-in-polygon (lat/lng pairs, simple ray casting on planar approximation) */
export function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
