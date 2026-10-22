import { fencesSnapshot, sites, zones } from '../db';
import { err, ok } from '../util';
import type { MockRoute } from './auth';
import type { Site, Zone } from '@/api/types';

export const placesRoutes: MockRoute[] = [
  { method: 'GET', pattern: /^\/places\/fences$/, handler: () => ok(fencesSnapshot()) },
  {
    method: 'POST',
    pattern: /^\/places\/sites$/,
    handler: ({ body }) => {
      const s: Site = {
        id: `s-${Date.now().toString(36)}`,
        name: String(body.name ?? 'موقع جديد'),
        code: String(body.code ?? `S-${Date.now() % 1000}`),
        city: String(body.city ?? 'القاهرة'),
        lat: Number(body.lat ?? 30.0444),
        lng: Number(body.lng ?? 31.2357),
        radiusM: Number(body.radiusM ?? 150),
        strictReject: Boolean(body.strictReject),
        attendance: { expected: 0, present: 0, outOfFence: 0 },
      };
      sites.push(s);
      return ok(s);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/places\/sites\/([^/]+)$/,
    handler: ({ params, body }) => {
      const s = sites.find((x) => x.id === params[0]);
      if (!s) return err(404, 'NOT_FOUND', 'موقع غير موجود');
      Object.assign(s, {
        name: body.name !== undefined ? String(body.name) : s.name,
        strictReject: body.strictReject !== undefined ? Boolean(body.strictReject) : s.strictReject,
        lat: body.lat !== undefined ? Number(body.lat) : s.lat,
        lng: body.lng !== undefined ? Number(body.lng) : s.lng,
        radiusM: body.radiusM !== undefined ? Number(body.radiusM) : s.radiusM,
      });
      return ok(s);
    },
  },
  {
    method: 'POST',
    pattern: /^\/places\/zones$/,
    handler: ({ body }) => {
      const z: Zone = {
        id: `z-${Date.now().toString(36)}`,
        name: String(body.name ?? 'نطاق جديد'),
        code: String(body.code ?? `Z-${Date.now() % 1000}`),
        city: String(body.city ?? 'القاهرة'),
        shape: body.shape === 'POLYGON' ? 'POLYGON' : 'CIRCLE',
        lat: Number(body.lat ?? 30.0444),
        lng: Number(body.lng ?? 31.2357),
        radiusM: body.radiusM !== undefined ? Number(body.radiusM) : 2000,
        polygon: (body.polygon as [number, number][] | undefined) ?? null,
        strictReject: Boolean(body.strictReject),
        maxSpeedKmh: body.maxSpeedKmh !== undefined ? Number(body.maxSpeedKmh) : null,
        stopAlertMin: body.stopAlertMin !== undefined ? Number(body.stopAlertMin) : null,
        driverCount: 0,
        activeDriverIds: [],
      };
      zones.push(z);
      return ok(z);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/places\/zones\/([^/]+)$/,
    handler: ({ params, body }) => {
      const z = zones.find((x) => x.id === params[0]);
      if (!z) return err(404, 'NOT_FOUND', 'نطاق غير موجود');
      Object.assign(z, {
        name: body.name !== undefined ? String(body.name) : z.name,
        strictReject: body.strictReject !== undefined ? Boolean(body.strictReject) : z.strictReject,
        lat: body.lat !== undefined ? Number(body.lat) : z.lat,
        lng: body.lng !== undefined ? Number(body.lng) : z.lng,
        radiusM: body.radiusM !== undefined ? Number(body.radiusM) : z.radiusM,
        polygon: body.polygon !== undefined ? (body.polygon as [number, number][]) : z.polygon,
        shape: body.shape !== undefined ? (body.shape === 'POLYGON' ? 'POLYGON' : 'CIRCLE') : z.shape,
        maxSpeedKmh: body.maxSpeedKmh !== undefined ? Number(body.maxSpeedKmh) : z.maxSpeedKmh,
        stopAlertMin: body.stopAlertMin !== undefined ? Number(body.stopAlertMin) : z.stopAlertMin,
      });
      return ok(z);
    },
  },
];
