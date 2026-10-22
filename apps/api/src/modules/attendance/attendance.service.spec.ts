import { GeoService } from '../../common/geo/geo.service';
import { workDateOf } from '../../common/utils';
import { AttendanceService } from './attendance.service';

const SITE = {
  id: 'site1',
  name: 'Cairo HQ',
  lat: 30.0444,
  lng: 31.2357,
  radiusM: 250,
  polygon: null,
  strictReject: false,
};
const SITE_STRICT = { ...SITE, id: 'siteS', name: 'Vault', strictReject: true };
const ZONE_POLY = {
  id: 'zone1',
  name: 'Nasr City',
  lat: 30.06,
  lng: 31.33,
  radiusM: 8000,
  // ring in [lng,lat] order — the shared GeoService feeds it straight to turf/GeoJSON (both [lng,lat]).
  polygon: JSON.stringify([
    [31.32, 30.05],
    [31.32, 30.07],
    [31.34, 30.06],
  ]),
};

function match(rec: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if ('not' in o) return o.not === null ? rec[k] !== null && rec[k] !== undefined : rec[k] !== o.not;
      if ('gte' in o) return String(rec[k]) >= String(o.gte);
      if ('lte' in o) return String(rec[k]) <= String(o.lte);
    }
    return rec[k] === v;
  });
}

function makeFixtures() {
  const employees: Record<string, any> = {
    e1: { id: 'e1', externalId: 'EMP1', name: 'Ahmed', kind: 'EMPLOYEE', phone: '+201000000001', siteId: SITE.id, zoneId: null, site: SITE, zone: null },
    eS: { id: 'eS', externalId: 'EMPS', name: 'Sara', kind: 'EMPLOYEE', phone: '+201000000002', siteId: SITE_STRICT.id, zoneId: null, site: SITE_STRICT, zone: null },
    e2: { id: 'e2', externalId: 'DRV1', name: 'Mostafa', kind: 'DRIVER', phone: '+201000000009', siteId: null, zoneId: ZONE_POLY.id, site: null, zone: ZONE_POLY },
  };
  const users: Record<string, any> = {
    u1: { id: 'u1', employeeId: 'e1', employee: employees.e1 },
    uS: { id: 'uS', employeeId: 'eS', employee: employees.eS },
    u2: { id: 'u2', employeeId: 'e2', employee: employees.e2 },
  };
  const records: any[] = [];
  let seq = 1;
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => users[where.id] ?? null,
    },
    attendanceRecord: {
      findFirst: async ({ where }: any) => records.find((r) => match(r, where)) ?? null,
      findMany: async ({ where }: any) =>
        records
          .filter((r) => match(r, where))
          .map((r) => ({ ...r, employee: { ...employees[r.employeeId], shifts: employees[r.employeeId].shifts ?? [], user: { id: `u_${r.employeeId}` } } })),
      create: async ({ data }: any) => {
        const row = { id: `r${seq++}`, note: null, checkOutAt: null, ...data };
        records.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = records.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { prisma: prisma as never, employees, users, records };
}

function makeDispatcher() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    raise: async (input: Record<string, unknown>) => {
      calls.push(input);
      return { id: `al${calls.length}`, type: input.type as never, severity: input.severity as never, suppressed: false };
    },
  };
}

function build(fx = makeFixtures()) {
  const geo = new GeoService();
  const dispatcher = makeDispatcher();
  const svc = new AttendanceService(fx.prisma, geo, dispatcher as never);
  return { svc, fx, dispatcher };
}

describe('AttendanceService — fence validation', () => {
  it('VALID when check-in is inside the site circle', async () => {
    const { svc, dispatcher } = build();
    const res = await svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 });
    expect(res.status).toBe('VALID');
    expect(res.fenceName).toBe('Cairo HQ');
    expect(res.allowedFences).toHaveLength(1);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('OUT_OF_FENCE (saved, alert raised) when outside and not strict', async () => {
    const { svc, dispatcher, fx } = build();
    const res = await svc.checkIn('u1', { lat: 30.1, lng: 31.4 });
    expect(res.status).toBe('OUT_OF_FENCE');
    expect(res.distanceToCenterM).toBeGreaterThan(250);
    expect(fx.records).toHaveLength(1); // NOT rejected — recorded
    expect(dispatcher.calls[0]).toMatchObject({ type: 'CHECK_IN_OUT_OF_FENCE', severity: 'WARNING' });
    expect((dispatcher.calls[0].meta as any).allowedFences).toHaveLength(1);
  });

  it('422 FENCE_VIOLATION when outside a strict site (nothing saved, no alert)', async () => {
    const { svc, dispatcher, fx } = build();
    await expect(svc.checkIn('uS', { lat: 30.2, lng: 31.5 })).rejects.toThrow('FENCE_VIOLATION');
    expect(fx.records).toHaveLength(0);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('polygon fence: driver inside polygon → VALID', async () => {
    const { svc } = build();
    const res = await svc.checkIn('u2', { lat: 30.06, lng: 31.325 });
    expect(res.status).toBe('VALID');
    expect(res.fenceName).toBe('Nasr City');
  });

  it('polygon fence: driver outside polygon → OUT_OF_FENCE', async () => {
    const { svc } = build();
    const res = await svc.checkIn('u2', { lat: 30.5, lng: 31.9 });
    expect(res.status).toBe('OUT_OF_FENCE');
  });
});

describe('AttendanceService — duplicate / missing checkout', () => {
  it('rejects a second check-in with ALREADY_CHECKED_IN', async () => {
    const { svc } = build();
    await svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 });
    await expect(svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 })).rejects.toThrow('ALREADY_CHECKED_IN');
  });

  it('rejects check-out with no open record (NO_OPEN_RECORD)', async () => {
    const { svc } = build();
    await expect(svc.checkOut('u1', { lat: 30.0444, lng: 31.2357 })).rejects.toThrow('NO_OPEN_RECORD');
  });

  it('records a normal check-out after check-in', async () => {
    const { svc, fx } = build();
    await svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 });
    const out = await svc.checkOut('u1', { lat: 30.0444, lng: 31.2357 });
    expect(out.status).toBe('VALID');
    expect(fx.records[0].checkOutAt).not.toBeNull();
  });
});

describe('AttendanceService — auto-close (closeExpired)', () => {
  function seedOpen(workDate: string, endMinDay: number) {
    const fx = makeFixtures();
    fx.employees.e1.shifts = [{ weekday: null, schedule: { endMinDay, crossMidnight: false, graceMin: 30 } }];
    fx.records.push({
      id: 'open1',
      employeeId: 'e1',
      workDate,
      status: 'VALID',
      checkInAt: new Date(workDate + 'T08:00:00Z'),
      checkOutAt: null,
      siteId: SITE.id,
      zoneId: null,
    });
    return fx;
  }

  it('flags records open past shift-end + grace as MISSING_CHECKOUT and alerts', async () => {
    const fx = seedOpen('2026-01-01', 1080); // ends 18:00 Cairo (~16:00Z)
    const { svc, dispatcher } = build(fx);
    const res = await svc.closeExpired(new Date('2026-01-01T18:00:00Z'));
    expect(res.closed).toBe(1);
    expect(fx.records[0].status).toBe('MISSING_CHECKOUT');
    expect(dispatcher.calls[0]).toMatchObject({ type: 'CHECKOUT_MISSING', severity: 'CRITICAL' });
  });

  it('leaves recent open records untouched', async () => {
    const fx = seedOpen('2026-01-01', 1200); // ends 20:00 Cairo (~18:00Z) + 30m grace = 18:30Z
    const { svc, dispatcher } = build(fx);
    const res = await svc.closeExpired(new Date('2026-01-01T18:00:00Z'));
    expect(res.closed).toBe(0);
    expect(fx.records[0].status).toBe('VALID');
    expect(dispatcher.calls).toHaveLength(0);
  });
});

describe('AttendanceService — meToday', () => {
  it('reports CHECKED_IN while open', async () => {
    const { svc } = build();
    await svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 });
    const today = workDateOf(new Date());
    const me = await svc.meToday('u1');
    expect(me.workDate).toBe(today);
    expect(me.currentStatus).toBe('CHECKED_IN');
  });
});
