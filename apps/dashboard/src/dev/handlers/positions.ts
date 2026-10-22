import { buildRoute } from '../sim';
import { err, ok, qstr } from '../util';
import type { MockRoute } from './auth';
import { drivers } from '../db';

export const positionsRoutes: MockRoute[] = [
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
