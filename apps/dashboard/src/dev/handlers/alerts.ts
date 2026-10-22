import { alerts } from '../db';
import { busEmit } from '../bus';
import { err, ok, qstr } from '../util';
import type { MockRoute } from './auth';
import type { AlertPayload } from '@/api/types';

function match(a: AlertPayload, q: Record<string, string | undefined>): boolean {
  const status = qstr(q, 'status');
  const type = qstr(q, 'type');
  const severity = qstr(q, 'severity');
  const userId = qstr(q, 'userId');
  const from = qstr(q, 'from');
  const to = qstr(q, 'to');
  if (status && a.status !== status) return false;
  if (type && a.type !== type) return false;
  if (severity && a.severity !== severity) return false;
  if (userId && a.userId !== userId) return false;
  if (from && new Date(a.createdAt) < new Date(from)) return false;
  if (to && new Date(a.createdAt) > new Date(`${to}T23:59:59`)) return false;
  return true;
}

export const alertRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/alerts$/,
    handler: ({ query }) => {
      const list = alerts.filter((a) => match(a, query)).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      return ok({ alerts: list, total: list.length });
    },
  },
  {
    method: 'POST',
    pattern: /^\/alerts\/([^/]+)\/ack$/,
    handler: ({ params }) => {
      const a = alerts.find((x) => x.id === params[0]);
      if (!a) return err(404, 'NOT_FOUND', 'تنبيه غير موجود');
      a.status = 'ACK';
      a.ackBy = 'u-admin';
      a.ackAt = new Date().toISOString();
      busEmit('alert:updated', { id: a.id, status: a.status, ackBy: a.ackBy, ackAt: a.ackAt });
      return ok(a);
    },
  },
  {
    method: 'POST',
    pattern: /^\/alerts\/([^/]+)\/resolve$/,
    handler: ({ params, body }) => {
      const a = alerts.find((x) => x.id === params[0]);
      if (!a) return err(404, 'NOT_FOUND', 'تنبيه غير موجود');
      a.status = 'RESOLVED';
      a.ackBy = a.ackBy ?? 'u-admin';
      a.ackAt = a.ackAt ?? new Date().toISOString();
      (a.meta as Record<string, unknown>).resolveNote = body.note ?? '';
      busEmit('alert:updated', { id: a.id, status: a.status, ackBy: a.ackBy, ackAt: a.ackAt });
      return ok(a);
    },
  },
  {
    method: 'POST',
    pattern: /^\/alerts\/([^/]+)\/call-log$/,
    handler: ({ params, body }) => {
      const a = alerts.find((x) => x.id === params[0]);
      if (!a) return err(404, 'NOT_FOUND', 'تنبيه غير موجود');
      (a.meta as Record<string, unknown>).callLog = {
        called: Boolean(body.called),
        note: String(body.note ?? ''),
        by: 'u-admin',
        at: new Date().toISOString(),
      };
      busEmit('alert:updated', { id: a.id, status: a.status, ackBy: a.ackBy, ackAt: a.ackAt });
      return ok(a);
    },
  },
];
