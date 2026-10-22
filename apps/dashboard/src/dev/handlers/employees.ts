import { alerts, devices, employees, sites, zones } from '../db';
import { err, maybeCsv, ok, qstr } from '../util';
import type { MockRoute } from './auth';
import type { LivePosition } from '@/api/types';
import { useLive } from '@/stores/ui';
import { drivers } from '../db';

function liveFor(userId: string): LivePosition | undefined {
  const fromStore = useLive.getState().positions[userId];
  if (fromStore) return fromStore;
  const d = drivers.find((x) => x.userId === userId);
  if (!d) return undefined;
  return {
    userId: d.userId, lat: d.lat, lng: d.lng, speedKmh: d.speed, motionState: d.motionState,
    ts: d.lastSeen, online: d.online, tracking: d.tracking, gpsEnabled: d.gpsEnabled,
    dataEnabled: d.dataEnabled, lastSeen: d.lastSeen, battery: d.battery,
  };
}

export const employeeRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/employees$/,
    handler: ({ query }) => {
      const role = qstr(query, 'role');
      let list = employees;
      if (role) list = list.filter((e) => e.role === role);
      const enriched = list.map((e) => ({
        ...e,
        openAlerts: alerts.filter((a) => a.userId === e.id && a.status === 'OPEN').length,
        live: liveFor(e.id),
      }));
      return maybeCsv(query, enriched as unknown as Record<string, unknown>[], { employees: enriched, total: enriched.length });
    },
  },
  {
    method: 'GET',
    pattern: /^\/employees\/([^/]+)$/,
    handler: ({ params }) => {
      const e = employees.find((x) => x.id === params[0]);
      if (!e) return err(404, 'NOT_FOUND', 'موظف غير موجود');
      return ok({
        ...e,
        live: liveFor(e.id),
        zoneName: zones.find((z) => z.id === e.zoneId)?.name ?? null,
        siteName: sites.find((s) => s.id === e.siteId)?.name ?? null,
      });
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/employees\/([^/]+)\/rules$/,
    handler: ({ params, body }) => {
      const e = employees.find((x) => x.id === params[0]);
      if (!e) return err(404, 'NOT_FOUND', 'موظف غير موجود');
      if (body.zoneId !== undefined) {
        e.zoneId = body.zoneId === null || body.zoneId === '' ? null : String(body.zoneId);
        e.zoneName = zones.find((z) => z.id === e.zoneId)?.name ?? null;
      }
      if (body.maxSpeedKmh !== undefined) e.maxSpeedKmh = body.maxSpeedKmh === null ? null : Number(body.maxSpeedKmh);
      if (body.stopAlertMin !== undefined) e.stopAlertMin = body.stopAlertMin === null ? null : Number(body.stopAlertMin);
      return ok(e);
    },
  },
  {
    method: 'GET',
    pattern: /^\/employees\/([^/]+)\/devices$/,
    handler: ({ params }) => ok({ devices: devices.filter((d) => d.deviceId.startsWith(`AND-${params[0]}`) || true).slice(0, 2).map((d, i) => ({ ...d, id: `dev-${params[0]}-${i}` })) }),
  },
  {
    method: 'GET',
    pattern: /^\/employees\/([^/]+)\/summary$/,
    handler: ({ params }) => {
      const e = employees.find((x) => x.id === params[0]);
      if (!e) return err(404, 'NOT_FOUND', 'موظف غير موجود');
      return ok({
        motionMinutes: e.motionMinutes ?? { stopped: 42, walking: 18, riding: 214 },
        openAlerts: alerts.filter((a) => a.userId === e.id && a.status === 'OPEN').length,
        totalAlerts: alerts.filter((a) => a.userId === e.id).length,
      });
    },
  },
];
