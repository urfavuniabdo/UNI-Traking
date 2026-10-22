import { GeoService } from '../../common/geo/geo.service';
import { PlacesService } from './places.service';

function fakePrisma(opts: { employeesUsingSite?: number; attendanceUsingSite?: number } = {}) {
  const sites: any[] = [
    { id: 'site1', code: 'CAIRO', name: 'Cairo HQ', orgUnitId: 'o1', lat: 30.0444, lng: 31.2357, radiusM: 250, polygon: null, strictReject: false, active: true },
  ];
  const zones: any[] = [];
  const settings: any[] = [];
  const employees: any[] = [
    // one online driver + one offline driver in zone1, one office employee at site1
    { id: 'drv1', kind: 'DRIVER', active: true, siteId: null, zoneId: 'zone1', devices: [{ online: true, lastSeenAt: new Date() }] },
    { id: 'drv2', kind: 'DRIVER', active: true, siteId: null, zoneId: 'zone1', devices: [{ online: false, lastSeenAt: new Date(Date.now() - 8 * 3600_000) }] },
    { id: 'off1', kind: 'EMPLOYEE', active: true, siteId: 'site1', zoneId: null, devices: [] },
  ];
  const prisma = {
    orgUnit: {
      findUnique: async ({ where }: any) => (where.id === 'o1' ? { id: 'o1', code: 'HQ', name: 'HQ', parentId: null } : null),
      findFirst: async ({ where }: any) => (where?.parentId === null ? { id: 'o1', code: 'HQ', name: 'HQ', parentId: null } : null),
      findMany: async () => [{ id: 'o1', code: 'HQ', name: 'HQ', parentId: null }],
      count: async () => 0,
      create: async ({ data }: any) => data,
      update: async ({ data }: any) => data,
      delete: async ({ where }: any) => where,
    },
    site: {
      findFirst: async ({ where }: any) => sites.find((s) => s.code === where.code) ?? null,
      findUnique: async ({ where }: any) => sites.find((s) => s.id === where.id) ?? null,
      findMany: async ({ where }: any) => sites.filter((s) => where?.active === undefined || s.active === where.active),
      count: async () => (opts.employeesUsingSite ?? 0) + (opts.attendanceUsingSite ?? 0),
      create: async ({ data }: any) => {
        const row = { id: `s${sites.length + 1}`, ...data };
        sites.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const s = sites.find((x) => x.id === where.id);
        Object.assign(s, data);
        return s;
      },
      delete: async ({ where }: any) => where,
    },
    zone: {
      findFirst: async ({ where }: any) => zones.find((z) => z.code === where?.code) ?? null,
      findUnique: async ({ where }: any) => zones.find((z) => z.id === where.id) ?? null,
      findMany: async ({ where }: any) => zones.filter((z) => where?.active === undefined || z.active === where.active),
      count: async () => 0,
      create: async ({ data }: any) => {
        const row = { id: `z${zones.length + 1}`, ...data };
        zones.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const z = zones.find((x) => x.id === where.id);
        Object.assign(z, data);
        return z;
      },
      delete: async ({ where }: any) => where,
    },
    employee: {
      count: async () => opts.employeesUsingSite ?? 0,
      findMany: async ({ where }: any = {}) => employees.filter((e) => where?.active === undefined || e.active === where.active),
    },
    attendanceRecord: {
      count: async () => opts.attendanceUsingSite ?? 0,
      findMany: async () => [{ siteId: 'site1', checkInAt: new Date(), status: 'VALID' }],
    },
    position: {
      findMany: async () => [],
    },
    setting: {
      findMany: async ({ where }: any = {}) => settings.filter((s) => !where?.key?.startsWith || s.key.startsWith(where.key.startsWith)),
      upsert: async ({ where, create, update }: any) => {
        const row = settings.find((s) => s.key === where.key);
        if (row) Object.assign(row, update);
        else settings.push({ key: where.key, ...create });
        return row ?? create;
      },
    },
    trip: { count: async () => 0 },
    stopEvent: { count: async () => 0 },
    user: { findUnique: async () => null },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { prisma: prisma as never, sites, zones, settings, employees };
}

describe('PlacesService — geometry validation', () => {
  it('rejects a polygon with fewer than 3 points with POLYGON_INVALID', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    await expect(
      svc.createSite({ code: 'X', name: 'X', orgUnitId: 'o1', lat: 30, lng: 31, radiusM: 200, polygon: JSON.stringify([[30, 31], [30.1, 31.1]]) } as never),
    ).rejects.toThrow('POLYGON_INVALID');
  });

  it('rejects a polygon with non-finite coordinates with POLYGON_INVALID', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    await expect(
      svc.createSite({ code: 'X', name: 'X', orgUnitId: 'o1', lat: 30, lng: 31, radiusM: 200, polygon: JSON.stringify([[30, 'a'], [31, 'b'], [32, 'c']]) } as never),
    ).rejects.toThrow('POLYGON_INVALID');
  });

  it('rejects out-of-range latitude', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    await expect(
      svc.createSite({ code: 'X', name: 'X', orgUnitId: 'o1', lat: 120, lng: 31, radiusM: 200 } as never),
    ).rejects.toThrow('BAD_LAT');
  });

  it('accepts a polygon sent as an ARRAY (the dashboard form [[lat,lng],…])', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const z = await svc.createZone({
      name: 'Nasr City', lat: 30.05, lng: 31.36,
      polygon: [[30.04, 31.35], [30.06, 31.35], [30.06, 31.38], [30.04, 31.38]],
    } as never);
    expect(JSON.parse((z as { polygon: string }).polygon)).toHaveLength(4);
  });

  it('auto-generates Z-<slug> codes and falls back to the root OrgUnit when orgUnitId is absent', async () => {
    const { prisma, zones } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const z = await svc.createZone({ name: 'Nasr City East', lat: 30.05, lng: 31.36, radiusM: 2000 } as never);
    expect(z.code).toBe('Z-nasr-city-east');
    expect(z.orgUnitId).toBe('o1');
    expect(zones).toHaveLength(1);
  });
});

describe('PlacesService — geofence-check (all fences)', () => {
  it('reports inside=true for a point within the active site circle', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const res = await svc.geofenceCheck(30.0444, 31.2357);
    expect(res.inside).toBe(true);
    expect(res.matched?.fenceName).toBe('Cairo HQ');
  });

  it('reports inside=false with a nearest distance for a far point', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const res = await svc.geofenceCheck(30.5, 31.9);
    expect(res.inside).toBe(false);
    expect(res.nearestDistanceM).toBeGreaterThan(250);
  });
});

describe('PlacesService — delete guard', () => {
  it('blocks deleting a Site that is in use', async () => {
    const { prisma } = fakePrisma({ employeesUsingSite: 2 });
    const svc = new PlacesService(prisma, new GeoService());
    await expect(svc.deleteSite('site1')).rejects.toThrow(/FENCE_IN_USE/);
  });

  it('deletes an unused Site', async () => {
    const { prisma } = fakePrisma({ employeesUsingSite: 0, attendanceUsingSite: 0 });
    const svc = new PlacesService(prisma, new GeoService());
    await expect(svc.deleteSite('site1')).resolves.toBeTruthy();
  });
});

describe('PlacesService.fences — dashboard envelope', () => {
  it('returns { sites, zones, outside } with flat names, driver counts and array polygons', async () => {
    const { prisma, employees } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const circle = await svc.createZone({
      code: 'Z-CL', name: 'Circle Zone', orgUnitId: 'o1', lat: 30.0444, lng: 31.2357, radiusM: 5000,
    } as never);
    await svc.createZone({
      code: 'Z-PG', name: 'Polygon Zone', orgUnitId: 'o1', lat: 30.05, lng: 31.36,
      polygon: [[30.04, 31.35], [30.06, 31.35], [30.06, 31.38], [30.04, 31.38]],
      strictReject: true,
    } as never);
    // point the fake drivers at the created circle zone so driverCount/activeDriverIds are exercised
    employees[0].zoneId = (circle as { id: string }).id;
    employees[1].zoneId = (circle as { id: string }).id;

    const res = await svc.fences();
    expect(Object.keys(res).sort()).toEqual(['outside', 'sites', 'zones']);
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0]).toMatchObject({
      id: 'site1', kind: 'SITE', code: 'CAIRO', name: 'Cairo HQ', orgUnitId: 'o1',
      lat: 30.0444, lng: 31.2357, radiusM: 250, strictReject: false,
      attendance: { expected: 1, present: 1, outOfFence: 0 },
    });
    const z1 = res.zones.find((z) => z.code === 'Z-CL')!;
    expect(z1.shape).toBe('CIRCLE');
    expect(z1.driverCount).toBe(2);
    expect(z1.activeDriverIds).toEqual(['drv1']); // drv2 is offline beyond the presence window
    const z2 = res.zones.find((z) => z.code === 'Z-PG')!;
    expect(z2.shape).toBe('POLYGON');
    expect(Array.isArray(z2.polygon)).toBe(true);
    expect(z2.polygon![0]).toHaveLength(2); // [[lat,lng],…] canonical orientation
    expect(z2.strictReject).toBe(true); // stored via Setting (no Zone column — schema frozen)
    expect(res.outside).toEqual([]); // no positions in the fake ⇒ nobody tested outside
    expect(z2.city).toBeNull(); // no Zone.city column — reported, not invented
  });

  it('marks a driver outside his zone fence in `outside`', async () => {
    const { prisma, employees } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const far = await svc.createZone({ code: 'Z-FAR', name: 'Far Zone', orgUnitId: 'o1', lat: 30.0, lng: 31.0, radiusM: 300 } as never);
    employees[0].zoneId = (far as { id: string }).id;
    (prisma as never as { position: { findMany: () => Promise<unknown[]> } }).position.findMany = async () => [
      { employeeId: 'drv1', lat: 31.5, lng: 32.5 }, // far outside the 300 m circle
    ];
    const res = await svc.fences();
    const zone = res.zones.find((z) => z.code === 'Z-FAR')!;
    expect(zone.activeDriverIds).toContain('drv1');
    expect(res.outside).toContain('drv1');
  });

  it('zone PATCH persists strictReject through the Setting table and reads it back', async () => {
    const { prisma, settings } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    const z = await svc.createZone({ code: 'Z-UP', name: 'Update Me', orgUnitId: 'o1', lat: 30, lng: 31, radiusM: 1000 } as never);
    const id = (z as { id: string }).id;
    const updated = await svc.updateZone(id, { strictReject: true } as never);
    expect((updated as { strictReject: boolean }).strictReject).toBe(true);
    expect(settings.some((s: { key: string; value: string }) => s.key === `places.zone.strictReject.${id}` && s.value === 'true')).toBe(true);
  });
});
