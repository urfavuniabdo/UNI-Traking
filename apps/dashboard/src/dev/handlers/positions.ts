import { buildRoute } from '../sim';
import { err, ok, qstr } from '../util';
import type { MockRoute } from './auth';
import { drivers } from '../db';

export const positionsRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/positions\/trails$/,
    handler: ({ query }) => {
      const windowMin = Number(qstr(query, 'minutes') ?? 180) || 180;
      const date = new Date().toISOString().slice(0, 10);
      const trails = drivers
        .filter((d) => d.online)
        .map((d) => {
          const r = buildRoute(d.userId, date);
          if (!r) return null;
          // the mock emits one fix every 2 minutes
          const recent = r.points.slice(-Math.ceil(windowMin / 2));
          const gaps: { from: [number, number]; to: [number, number]; minutes: number }[] = [];
          for (let i = 1; i < recent.length; i++) {
            const minutes = Math.round((Date.parse(recent[i].clientTs) - Date.parse(recent[i - 1].clientTs)) / 60000);
            if (minutes > 10) gaps.push({ from: [recent[i - 1].lat, recent[i - 1].lng], to: [recent[i].lat, recent[i].lng], minutes });
          }
          return {
            userId: d.userId,
            employeeId: d.userId,
            name: d.name,
            motionState: d.motionState,
            lastTs: recent[recent.length - 1]?.clientTs ?? d.lastSeen,
            distanceKm: r.distanceKm,
            line: recent.map((p) => [p.lat, p.lng] as [number, number]),
            pointCount: recent.length,
            stops: r.stops.map((s, i) => ({ id: `ms-${d.userId}-${i}`, kind: 'UNPLANNED', lat: s.lat, lng: s.lng, startTs: s.startTs, endTs: s.endTs, durationMin: s.durationMin })),
            gaps,
          };
        })
        .filter((t): t is NonNullable<typeof t> => t !== null);
      return ok({ windowMin, serverTs: new Date().toISOString(), trails });
    },
  },
  {
    method: 'GET',
    pattern: /^\/positions\/route$/,
    handler: ({ query }) => {
      const userId = qstr(query, 'userId');
      const date = qstr(query, 'date') ?? new Date().toISOString().slice(0, 10);
      if (!userId) return err(400, 'BAD_REQUEST', 'userId مطلوب');
      const r = buildRoute(userId, date);
      if (!r) return err(404, 'NOT_FOUND', 'مستخدم غير موجود');
      return ok(r);
    },
  },
  {
    method: 'GET',
    pattern: /^\/positions\/drivers$/,
    handler: () =>
      ok({
        drivers: drivers.map((d) => ({
          id: d.userId,
          name: d.name,
          phone: d.phone,
          identifier: d.identifier,
          zoneId: d.zoneId,
          city: d.city,
        })),
      }),
  },
];
