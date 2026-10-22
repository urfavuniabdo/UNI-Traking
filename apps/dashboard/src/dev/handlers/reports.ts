import { buildDailyReport, exceptions, mileageByDriver, mileageByZone, timesheet, drivers } from '../db';
import { buildRoute } from '../sim';
import { busEmit } from '../bus';
import { err, maybeCsv, ok, qstr } from '../util';
import type { MockRoute } from './auth';

const todayISO = () => new Date().toISOString().slice(0, 10);

export const reportRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/reports\/daily$/,
    handler: ({ query }) => ok(buildDailyReport(qstr(query, 'date') ?? todayISO())),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/route$/,
    handler: ({ query }) => {
      const r = buildRoute(qstr(query, 'userId') ?? drivers[0].userId, qstr(query, 'date') ?? todayISO());
      return r ? ok(r) : err(404, 'NOT_FOUND', 'لا مسار');
    },
  },
  {
    method: 'GET',
    pattern: /^\/reports\/mileage$/,
    handler: ({ query }) => {
      const groupBy = qstr(query, 'groupBy') === 'zone' ? 'zone' : 'driver';
      const rows = groupBy === 'zone' ? mileageByZone : mileageByDriver;
      const from = qstr(query, 'from');
      const to = qstr(query, 'to');
      return maybeCsv(
        query,
        rows as unknown as Record<string, unknown>[],
        { groupBy, from: from ?? null, to: to ?? null, rows, totalKm: +rows.reduce((s, r) => s + r.km, 0).toFixed(1) },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/reports\/exceptions$/,
    handler: ({ query }) =>
      maybeCsv(query, exceptions as unknown as Record<string, unknown>[], {
        rows: exceptions,
        total: exceptions.reduce((s, r) => s + r.count, 0),
        unresolved: exceptions.reduce((s, r) => s + r.unresolved, 0),
      }),
  },
  {
    method: 'GET',
    pattern: /^\/reports\/timesheet$/,
    handler: ({ query }) => {
      const userId = qstr(query, 'userId');
      const from = qstr(query, 'from');
      const to = qstr(query, 'to');
      let rows = timesheet;
      if (userId) rows = rows.filter((r) => r.userId === userId);
      if (from) rows = rows.filter((r) => r.date >= from);
      if (to) rows = rows.filter((r) => r.date <= to);
      return maybeCsv(query, rows as unknown as Record<string, unknown>[], { rows });
    },
  },
];

export const attendanceEventRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/attendance\/me\/today$/,
    handler: () => {
      const now = new Date().toISOString();
      busEmit('attendance:changed', { userId: 'u-admin', kind: 'CHECK_IN', status: 'VALID', ts: now });
      return ok({ id: 'att-me', userId: 'u-admin', userName: 'أ. مدير النظام', date: todayISO(), checkInTs: now, checkOutTs: null, checkInStatus: 'VALID' });
    },
  },
];
