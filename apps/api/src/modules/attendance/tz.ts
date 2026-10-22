/** Offset (minutes) of `tz` wall clock vs UTC at a given UTC instant. */
export function tzOffsetMinutesAt(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour % 24, map.minute, map.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * Convert a wall-clock time in `tz` (calendar date YYYY-MM-DD + minutes from that
 * midnight) to a UTC instant. Used to find shift-end for auto-closing records.
 */
export function zonedLocalToUtc(workDate: string, minutesFromMidnight: number, tz: string): Date {
  const [y, m, d] = workDate.split('-').map(Number);
  const baseUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0);
  // first guess using the offset at nominal midnight, then refine once for DST edges.
  const off1 = tzOffsetMinutesAt(baseUtc, tz);
  let ts = baseUtc + minutesFromMidnight * 60000 - off1 * 60000;
  const off2 = tzOffsetMinutesAt(ts, tz);
  ts = baseUtc + minutesFromMidnight * 60000 - off2 * 60000;
  return new Date(ts);
}
