import { GeoService } from '../../common/geo/geo.service';
import { PlacesService } from './places.service';

function fakePrisma(opts: { employeesUsingSite?: number; attendanceUsingSite?: number } = {}) {
  const sites: any[] = [
    { id: 'site1', code: 'CAIRO', name: 'Cairo HQ', orgUnitId: 'o1', lat: 30.0444, lng: 31.2357, radiusM: 250, polygon: null, strictReject: false, active: true },
  ];
  const zones: any[] = [];
  const prisma = {
    orgUnit: {
      findUnique: async ({ where }: any) => (where.id === 'o1' ? { id: 'o1', code: 'HQ', name: 'HQ', parentId: null } : null),
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
      findFirst: async () => null,
      findUnique: async ({ where }: any) => zones.find((z) => z.id === where.id) ?? null,
      findMany: async () => zones,
      count: async () => 0,
      create: async ({ data }: any) => data,
      update: async () => null,
      delete: async ({ where }: any) => where,
    },
    employee: { count: async () => opts.employeesUsingSite ?? 0 },
    attendanceRecord: { count: async () => opts.attendanceUsingSite ?? 0 },
    trip: { count: async () => 0 },
    stopEvent: { count: async () => 0 },
    user: { findUnique: async () => null },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { prisma: prisma as never, sites };
}

describe('PlacesService — geometry validation', () => {
  it('rejects a polygon with fewer than 3 points', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    await expect(
      svc.createSite({ code: 'X', name: 'X', orgUnitId: 'o1', lat: 30, lng: 31, radiusM: 200, polygon: JSON.stringify([[30, 31], [30.1, 31.1]]) } as never),
    ).rejects.toThrow('BAD_POLYGON');
  });

  it('rejects a polygon with non-finite coordinates', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    await expect(
      svc.createSite({ code: 'X', name: 'X', orgUnitId: 'o1', lat: 30, lng: 31, radiusM: 200, polygon: JSON.stringify([[30, 'a'], [31, 'b'], [32, 'c']]) } as never),
    ).rejects.toThrow('BAD_POLYGON');
  });

  it('rejects out-of-range latitude', async () => {
    const { prisma } = fakePrisma();
    const svc = new PlacesService(prisma, new GeoService());
    await expect(
      svc.createSite({ code: 'X', name: 'X', orgUnitId: 'o1', lat: 120, lng: 31, radiusM: 200 } as never),
    ).rejects.toThrow('BAD_LAT');
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
