import { attendance, sites, zones } from '../db';
import { maybeCsv, ok, qstr } from '../util';
import type { MockRoute } from './auth';

export const attendanceRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/attendance$/,
    handler: ({ query }) => {
      const siteId = qstr(query, 'siteId');
      const zoneId = qstr(query, 'zoneId');
      const status = qstr(query, 'status');
      const from = qstr(query, 'from');
      const to = qstr(query, 'to');
      const userId = qstr(query, 'userId');
      let list = attendance.filter((r) => {
        if (siteId && r.siteId !== siteId) return false;
        if (zoneId && r.zoneId !== zoneId) return false;
        if (userId && r.userId !== userId) return false;
        if (from && r.date < from) return false;
        if (to && r.date > to) return false;
        if (status) {
          if (status === 'MISSING_CHECKOUT') return r.checkInTs && !r.checkOutTs;
          if (status === 'OUT_OF_FENCE') return r.checkInStatus === 'OUT_OF_FENCE' || r.checkOutStatus === 'OUT_OF_FENCE';
          if (status === 'VALID') return r.checkInStatus === 'VALID';
        }
        return true;
      });
      list = [...list].sort((a, b) => (b.checkInTs ?? '').localeCompare(a.checkInTs ?? ''));
      const page = Number(qstr(query, 'page') ?? 1);
      const size = 50;
      return maybeCsv(
        query,
        list.map((r) => ({ ...r, siteName: r.siteName ?? '', zoneName: r.zoneName ?? '' })),
        {
          records: list.slice((page - 1) * size, page * size),
          total: list.length,
          page,
          stats: {
            present: list.filter((r) => r.checkInTs).length,
            missingCheckout: list.filter((r) => r.checkInTs && !r.checkOutTs).length,
            outOfFence: list.filter((r) => r.checkInStatus === 'OUT_OF_FENCE').length,
            sites: sites.map((s) => ({ id: s.id, name: s.name, present: list.filter((r) => r.siteId === s.id).length, expected: s.attendance.expected })),
            zones: zones.map((z) => ({ id: z.id, name: z.name, present: list.filter((r) => r.zoneId === z.id).length })),
          },
        },
      );
    },
  },
];
