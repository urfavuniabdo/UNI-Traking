import { HttpException } from '@nestjs/common';
import { GeoService } from '../../common/geo/geo.service';
import { workDateOf } from '../../common/utils';
import { LeaveService } from '../leave/leave.service';
import { AttendanceService } from './attendance.service';

const SITE = {
  id: 'site1',
  name: 'Cairo HQ',
  lat: 30.0444,
  lng: 31.2357,
  radiusM: 250,
  polygon: null,
  strictReject: false,
  active: true,
};
const SITE_STRICT = { ...SITE, id: 'siteS', name: 'Vault', strictReject: true };
const ZONE_POLY = {
  id: 'zone1',
  name: 'Nasr City',
  lat: 30.06,
  lng: 31.33,
  radiusM: 8000,
  active: true,
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
    e1: { id: 'e1', externalId: 'EMP1', name: 'Ahmed', kind: 'EMPLOYEE', phone: '+201000000001', orgUnitId: 'org1', siteId: SITE.id, zoneId: null, site: SITE, zone: null },
    eS: { id: 'eS', externalId: 'EMPS', name: 'Sara', kind: 'EMPLOYEE', phone: '+201000000002', orgUnitId: 'org1', siteId: SITE_STRICT.id, zoneId: null, site: SITE_STRICT, zone: null },
    e2: { id: 'e2', externalId: 'DRV1', name: 'Mostafa', kind: 'DRIVER', phone: '+201000000009', orgUnitId: 'org1', siteId: null, zoneId: ZONE_POLY.id, site: null, zone: ZONE_POLY },
  };
  const users: Record<string, any> = {
    u1: { id: 'u1', employeeId: 'e1', employee: employees.e1 },
    uS: { id: 'uS', employeeId: 'eS', employee: employees.eS },
    u2: { id: 'u2', employeeId: 'e2', employee: employees.e2 },
  };
  // supervisor/admin directory consulted by the 422 supervisorPhone resolution
  const directory: any[] = [];
  const records: any[] = [];
  const leaves: any[] = [];
  const positions: any[] = [];
  const settings: Record<string, string> = {};
  let seq = 1;
  const leaveMatches = (l: any, where: any) =>
    (!where?.employeeId || l.employeeId === where.employeeId) &&
    (!where?.status || l.status === where.status) &&
    (!where?.dateFrom?.lte || l.dateFrom <= where.dateFrom.lte) &&
    (!where?.dateTo?.gte || l.dateTo >= where.dateTo.gte);
  const prisma = {
    user: {
      findUnique: async ({ where }: any) => users[where.id] ?? null,
      findFirst: async ({ where }: any) =>
        directory.find((u) => {
          if (where.role && u.role !== where.role) return false;
          if (where.disabled === false && u.disabled) return false;
          if (where.employee?.orgUnitId && u.employee?.orgUnitId !== where.employee.orgUnitId) return false;
          if (where.employee?.isNot === null && !u.employee) return false;
          return true;
        }) ?? null,
    },
    setting: {
      findUnique: async ({ where }: any) =>
        settings[where.key] ? { key: where.key, value: settings[where.key] } : null,
    },
    site: { findMany: async () => [SITE, SITE_STRICT] },
    zone: {
      findMany: async ({ where }: any) =>
        where?.id?.in ? [ZONE_POLY].filter((z) => (where.id.in as string[]).includes(z.id)) : [ZONE_POLY],
    },
    employee: { findMany: async () => Object.values(employees).map((e: any) => ({ siteId: e.siteId })) },
    position: {
      findMany: async ({ where }: any) =>
        positions.filter((p) => {
          if (where?.employeeId?.in && !where.employeeId.in.includes(p.employeeId)) return false;
          if (where?.clientTs?.gte && p.clientTs < where.clientTs.gte) return false;
          if (where?.clientTs?.lte && p.clientTs > where.clientTs.lte) return false;
          if (Array.isArray(where?.OR) && !where.OR.some((c: any) => !!p[Object.keys(c)[0]])) return false;
          return true;
        }),
    },
    leaveRequest: {
      findFirst: async ({ where }: any) => leaves.find((l) => leaveMatches(l, where)) ?? null,
      findMany: async ({ where }: any) =>
        leaves
          .filter((l) => leaveMatches(l, where))
          .map((l) => ({ ...l, employee: employees[l.employeeId] })),
    },
    attendanceRecord: {
      findFirst: async ({ where }: any) => records.find((r) => match(r, where)) ?? null,
      findMany: async ({ where }: any) =>
        records
          .filter((r) => match(r, where))
          .map((r) => ({
            ...r,
            employee: { ...employees[r.employeeId], shifts: employees[r.employeeId].shifts ?? [], user: { id: `u_${r.employeeId}` } },
            site: employees[r.employeeId]?.site ?? null,
          })),
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
  return { prisma: prisma as never, employees, users, records, leaves, positions, settings, directory };
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
  const svc = new AttendanceService(fx.prisma, geo, new LeaveService(fx.prisma as never), dispatcher as never);
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
    const err = await svc.checkIn('uS', { lat: 30.2, lng: 31.5 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect((err.getResponse() as any).code).toBe('FENCE_VIOLATION');
    expect(fx.records).toHaveLength(0);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('422 FENCE_VIOLATION body: message/fenceName/distanceToCenterM/allowedFences/supervisorPhone/statusCode', async () => {
    const fx = makeFixtures();
    fx.directory.push(
      { id: 'u-admin', role: 'ADMIN', disabled: false, employee: { orgUnitId: 'orgX', phone: '+201099999999' } },
      { id: 'u-sup', role: 'SUPERVISOR', disabled: false, employee: { orgUnitId: 'org1', phone: '+201012345678' } },
    );
    const { svc } = build(fx);
    const err = await svc.checkIn('uS', { lat: 30.2, lng: 31.5 }).catch((e) => e);
    const body = err.getResponse() as any;
    expect(err.getStatus()).toBe(422);
    expect(body.code).toBe('FENCE_VIOLATION');
    expect(typeof body.message).toBe('string');
    expect(body.fenceName).toBe('Vault');
    expect(typeof body.distanceToCenterM).toBe('number');
    expect(Array.isArray(body.allowedFences)).toBe(true);
    expect(body.allowedFences[0]).toMatchObject({ id: 'siteS', name: 'Vault' });
    expect(body.supervisorPhone).toBe('+201012345678'); // SUPERVISOR of the SAME org unit wins over ADMIN
    expect(body.statusCode).toBe(422);
    expect(fx.records).toHaveLength(0);
  });

  it('422 supervisorPhone falls back to any ADMIN when no supervisor in the org unit', async () => {
    const fx = makeFixtures();
    fx.directory.push({ id: 'u-admin', role: 'ADMIN', disabled: false, employee: { orgUnitId: 'orgX', phone: '+201099999999' } });
    const { svc } = build(fx);
    const err = await svc.checkIn('uS', { lat: 30.2, lng: 31.5 }).catch((e) => e);
    expect((err.getResponse() as any).supervisorPhone).toBe('+201099999999');
  });

  it('global rules.global Setting attendanceStrictReject makes non-strict sites reject too', async () => {
    const fx = makeFixtures();
    fx.settings['rules.global'] = JSON.stringify({ attendanceStrictReject: true });
    const { svc, dispatcher } = build(fx);
    const err = await svc.checkIn('u1', { lat: 30.1, lng: 31.4 }).catch((e) => e); // e1 sits at a NON-strict site
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
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

describe('AttendanceService — GET /attendance list envelope (dashboard contract)', () => {
  function seedListFx() {
    const fx = makeFixtures();
    fx.records.push(
      {
        id: 'a1', employeeId: 'e1', workDate: '2026-01-05', status: 'VALID',
        checkInAt: new Date('2026-01-05T06:00:00Z'), checkOutAt: new Date('2026-01-05T14:00:00Z'),
        siteId: SITE.id, zoneId: null, distanceToSiteM: 40, note: null,
      },
      {
        id: 'a2', employeeId: 'e2', workDate: '2026-01-05', status: 'OUT_OF_FENCE',
        checkInAt: new Date('2026-01-05T07:00:00Z'), checkOutAt: null,
        siteId: null, zoneId: ZONE_POLY.id, distanceToSiteM: 910, note: null,
      },
      {
        id: 'a3', employeeId: 'eS', workDate: '2026-01-04', status: 'MISSING_CHECKOUT',
        checkInAt: new Date('2026-01-04T05:30:00Z'), checkOutAt: null,
        siteId: SITE_STRICT.id, zoneId: null, distanceToSiteM: 12, note: null,
      },
    );
    // e2's 2026-01-05 day includes a buffered (replayed) position batch.
    fx.positions.push({ employeeId: 'e2', clientTs: new Date('2026-01-05T07:30:00Z'), buffered: true, stale: false });
    return fx;
  }

  it('returns { records, total, page, pageSize, stats } with the dashboard record key names', async () => {
    const { svc } = build(seedListFx());
    const res = await svc.list({ from: '2026-01-04', to: '2026-01-05', page: 1, pageSize: 50 });

    expect(Object.keys(res).sort()).toEqual(['page', 'pageSize', 'records', 'stats', 'total']);
    expect(res.total).toBe(3);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(50);

    const rec = res.records[0]; // 2026-01-05 rows first (workDate desc)
    expect(Object.keys(rec).sort()).toEqual([
      'checkInStatus', 'checkInTs', 'checkOutStatus', 'checkOutTs', 'date', 'distanceToCenterM',
      'exception', 'fenceName', 'id', 'replayed', 'siteId', 'siteName', 'userId', 'userName', 'zoneId', 'zoneName',
    ]);
    expect(rec.userId).toBe('e1'); // employee id, per CONTRACT
    expect(rec.userName).toBe('Ahmed');
    expect(rec.date).toBe('2026-01-05');
    expect(rec.checkInTs).toBe('2026-01-05T06:00:00.000Z');
    expect(rec.checkOutTs).toBe('2026-01-05T14:00:00.000Z');
    expect(rec.checkInStatus).toBe('VALID');
    expect(rec.checkOutStatus).toBe('VALID');
    expect(rec.siteName).toBe('Cairo HQ');
    expect(rec.distanceToCenterM).toBe(40);
    expect(rec.exception).toBe(false);
    expect(rec.replayed).toBe(false);

    const drv = res.records.find((r) => r.userId === 'e2')!;
    expect(drv.checkInStatus).toBe('OUT_OF_FENCE');
    expect(drv.checkOutStatus).toBeNull();
    expect(drv.zoneName).toBe('Nasr City');
    expect(drv.fenceName).toBe('Nasr City');
    expect(drv.exception).toBe(true);
    expect(drv.replayed).toBe(true); // buffered position that day
  });

  it('stats carries present/missingCheckout/outOfFence + sites[]/zones[] for the filter dropdowns', async () => {
    const { svc } = build(seedListFx());
    const { stats } = await svc.list({ from: '2026-01-04', to: '2026-01-05' });
    expect(stats.present).toBe(3);
    expect(stats.missingCheckout).toBe(2);
    expect(stats.outOfFence).toBe(1);
    expect(stats.sites.map((s) => s.id).sort()).toEqual(['site1', 'siteS']);
    expect(stats.sites.find((s) => s.id === SITE.id)).toMatchObject({ name: 'Cairo HQ', count: 1, present: 1 });
    expect(stats.zones).toHaveLength(1);
    expect(stats.zones[0]).toMatchObject({ id: 'zone1', name: 'Nasr City', count: 1, present: 1 });
  });

  it('honors siteId/zoneId filters and page/pageSize paging', async () => {
    const { svc } = build(seedListFx());
    const byZone = await svc.list({ zoneId: ZONE_POLY.id });
    expect(byZone.total).toBe(1);
    expect(byZone.records[0].userId).toBe('e2');
    const bySite = await svc.list({ siteId: SITE.id });
    expect(bySite.records.map((r) => r.id)).toEqual(['a1']);
    const paged = await svc.list({ page: 2, pageSize: 2 });
    expect(paged.records).toHaveLength(1);
    expect(paged.total).toBe(3); // total stays the FULL filtered count
  });
});

describe('AttendanceService — approved leave owns the day', () => {
  const today = workDateOf(new Date());

  function withLeave(over: Record<string, unknown> = {}) {
    const fx = makeFixtures();
    fx.leaves.push({ id: 'lv1', employeeId: 'e1', dateFrom: today, dateTo: today, status: 'APPROVED', ...over });
    return fx;
  }

  it('409 ON_APPROVED_LEAVE instead of starting an approved-leave day', async () => {
    const fx = withLeave();
    const { svc, dispatcher } = build(fx);
    const err = await svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'ON_APPROVED_LEAVE', leave: { id: 'lv1', dateFrom: today, dateTo: today } });
    expect(fx.records).toHaveLength(0);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('a still-pending request leaves the day startable', async () => {
    const { svc } = build(withLeave({ status: 'PENDING' }));
    expect((await svc.checkIn('u1', { lat: 30.0444, lng: 31.2357 })).status).toBe('VALID');
  });

  it('meToday says ON_LEAVE and carries the window, so the app can disable the button', async () => {
    const { svc } = build(withLeave({ dateFrom: '2026-01-01', dateTo: today }));
    const res = await svc.meToday('u1');
    expect(res.currentStatus).toBe('ON_LEAVE');
    expect(res.leave).toMatchObject({ id: 'lv1', dateFrom: '2026-01-01', dateTo: today });
  });

  it('meToday keeps an already checked-in day as CHECKED_IN', async () => {
    const fx = withLeave();
    fx.records.push({ id: 'a0', employeeId: 'e1', workDate: today, status: 'VALID', checkInAt: new Date(), checkOutAt: null, siteId: SITE.id, zoneId: null, distanceToSiteM: 10, note: null });
    const { svc } = build(fx);
    const res = await svc.meToday('u1');
    expect(res.currentStatus).toBe('CHECKED_IN');
  });

  it('list() synthesizes a LEAVE record and counts it in stats.onLeave', async () => {
    const fx = makeFixtures();
    fx.leaves.push({ id: 'lv9', employeeId: 'e1', dateFrom: '2026-01-04', dateTo: '2026-01-05', status: 'APPROVED' });
    const { svc } = build(fx);
    const res = await svc.list({ from: '2026-01-04', to: '2026-01-05' });
    expect(res.total).toBe(2);
    expect(res.stats.onLeave).toBe(2);
    expect(res.records.map((r) => r.id)).toEqual(['leave:lv9:2026-01-05', 'leave:lv9:2026-01-04']);
    expect(res.records[0]).toMatchObject({ userId: 'e1', userName: 'Ahmed', checkInStatus: 'LEAVE', checkOutStatus: null, exception: false, siteName: 'Cairo HQ' });
  });

  it('a day with a check-in is attendance, not leave', async () => {
    const fx = makeFixtures();
    fx.records.push({ id: 'a1', employeeId: 'e1', workDate: '2026-01-05', status: 'VALID', checkInAt: new Date('2026-01-05T06:00:00Z'), checkOutAt: null, siteId: SITE.id, zoneId: null, distanceToSiteM: 5, note: null });
    fx.leaves.push({ id: 'lv1', employeeId: 'e1', dateFrom: '2026-01-05', dateTo: '2026-01-06', status: 'APPROVED' });
    const { svc } = build(fx);
    const res = await svc.list({ from: '2026-01-04', to: '2026-01-07' });
    expect(res.records.map((r) => r.id)).toEqual(['leave:lv1:2026-01-06', 'a1']); // newest day first
    expect(res.stats.onLeave).toBe(1);
  });

  it('?status=LEAVE shows only the leave rows', async () => {
    const fx = makeFixtures();
    fx.records.push({ id: 'a1', employeeId: 'e1', workDate: '2026-01-05', status: 'VALID', checkInAt: new Date('2026-01-05T06:00:00Z'), checkOutAt: null, siteId: SITE.id, zoneId: null, distanceToSiteM: 5, note: null });
    fx.leaves.push({ id: 'lv1', employeeId: 'eS', dateFrom: '2026-01-05', dateTo: '2026-01-05', status: 'APPROVED' });
    const { svc } = build(fx);
    const res = await svc.list({ from: '2026-01-04', to: '2026-01-06', status: 'LEAVE' as never });
    expect(res.records.map((r) => r.id)).toEqual(['leave:lv1:2026-01-05']);
  });

  it('the CSV export carries the leave days with their own status', async () => {
    const fx = makeFixtures();
    fx.leaves.push({ id: 'lv1', employeeId: 'e1', dateFrom: '2026-01-05', dateTo: '2026-01-05', status: 'APPROVED' });
    const { svc } = build(fx);
    const csv = await svc.exportCsv({ from: '2026-01-04', to: '2026-01-06' });
    expect(csv.split('\n')[1]).toBe('2026-01-05,EMP1,Ahmed,EMPLOYEE,Cairo HQ,LEAVE,,,,');
  });
});
