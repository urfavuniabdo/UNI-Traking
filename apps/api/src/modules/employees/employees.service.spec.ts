import { EmployeesService } from './employees.service';

function fakePrisma() {
  const state = {
    employees: [] as Array<Record<string, unknown>>,
    users: [] as Array<Record<string, unknown>>,
    seq: 1,
  };
  const prisma = {
    employee: {
      findFirst: async ({ where }: { where: { externalId?: string } }) =>
        state.employees.find((e) => e.externalId === where.externalId) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.employees.find((e) => e.id === where.id) ?? null,
      findMany: async (arg?: { where?: { kind?: string }; select?: unknown }) => {
        const kind = arg?.where?.kind;
        return state.employees.filter((e) => !kind || e.kind === kind);
      },
      count: async (arg?: { where?: { kind?: string } }) =>
        state.employees.filter((e) => !arg?.where?.kind || e.kind === arg.where.kind).length,
      create: async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const id = `emp${state.seq++}`;
        const row = { id, ...data };
        state.employees.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const emp = state.employees.find((e) => e.id === where.id)!;
        Object.assign(emp, data);
        return emp;
      },
    },
    user: {
      findFirst: async ({ where }: { where: { identifier?: string } }) =>
        state.users.find((u) => u.identifier === where.identifier) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `usr${state.seq++}`, ...data };
        state.users.push(row);
        return row;
      },
    },
    // ---- reads for list/one/devices/summary ----
    position: { findMany: async () => [] as Record<string, unknown>[] },
    device: { findMany: async () => [] as Record<string, unknown>[] },
    ruleOverride: {
      rows: {} as Record<string, Record<string, unknown>>,
      findUnique: async function (this: { rows: Record<string, Record<string, unknown>> }, { where }: { where: { employeeId: string } }) {
        return this.rows[where.employeeId] ?? null;
      },
      upsert: async function (this: { rows: Record<string, Record<string, unknown>> }, { where, create, update }: { where: { employeeId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
        this.rows[where.employeeId] = { ...(this.rows[where.employeeId] ?? {}), ...update, ...create };
        return this.rows[where.employeeId];
      },
    },
    alert: { count: async () => 0 },
    zone: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: `zone-${where.id}` }) },
    site: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { prisma: prisma as never, state };
}

function seededPrisma() {
  const { prisma, state } = fakePrisma();
  state.employees.push(
    { id: 'd1', externalId: 'DRV1', name: 'Mostafa', phone: '+201000000001', kind: 'DRIVER', active: true, siteId: null, zoneId: 'z1' },
    { id: 'e1', externalId: 'EMP1', name: 'Mona', phone: '+201000000002', kind: 'EMPLOYEE', active: true, siteId: 's1', zoneId: null },
  );
  return { prisma, state };
}

describe('EmployeesService.create', () => {
  it('rejects a manual employee with no valid phone', async () => {
    const { prisma } = fakePrisma();
    const svc = new EmployeesService(prisma);
    await expect(
      svc.create({ externalId: 'E1', name: 'No Phone', phone: 'not-a-phone' } as never),
    ).rejects.toThrow('PHONE_REQUIRED');
  });

  it('normalizes the phone and auto-creates a login that must change its password', async () => {
    const { prisma, state } = fakePrisma();
    const svc = new EmployeesService(prisma);
    const res = await svc.create({
      externalId: 'DRV9',
      name: 'Mostafa Amin',
      phone: '01000000009',
      kind: 'DRIVER',
    } as never);

    expect(res.phone).toBe('+201000000009');
    expect(res.source).toBe('MANUAL');
    expect(res.createdUser).not.toBeNull();
    expect(state.users[0]).toMatchObject({
      identifier: 'DRV9',
      role: 'DRIVER',
      mustChangePassword: true,
    });
  });
});

describe('EmployeesService.list — dashboard envelope', () => {
  it('returns { employees, total, page, pageSize } with flat dashboard names', async () => {
    const { prisma } = seededPrisma();
    const svc = new EmployeesService(prisma);
    const res = await svc.list({});
    expect(res).toHaveProperty('employees');
    expect(Array.isArray(res.employees)).toBe(true);
    expect(res.total).toBe(2);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(50);
    const driver = res.employees.find((e) => (e as { id: string }).id === 'd1') as Record<string, unknown>;
    expect(driver.identifier).toBe('DRV1');
    expect(driver.role).toBe('DRIVER');
    expect(driver.driver).toBe(true);
    expect(driver).toHaveProperty('live');
    expect(driver).toHaveProperty('zoneName');
    expect(driver).toHaveProperty('siteName');
  });

  it('filters by ?role= as an alias of ?kind= (Drivers/Live pages send role=DRIVER)', async () => {
    const { prisma } = seededPrisma();
    const svc = new EmployeesService(prisma);
    const res = await svc.list({ role: 'DRIVER' } as never);
    expect(res.total).toBe(1);
    expect(res.employees).toHaveLength(1);
    expect((res.employees[0] as { externalId: string }).externalId).toBe('DRV1');
  });

  it('kind still wins over role when both are sent', async () => {
    const { prisma } = seededPrisma();
    const svc = new EmployeesService(prisma);
    const res = await svc.list({ kind: 'EMPLOYEE', role: 'DRIVER' } as never);
    expect((res.employees[0] as { externalId: string }).externalId).toBe('EMP1');
  });
});

describe('EmployeesService — detail reads for the DriverDetail page', () => {
  it('one() adds identifier/role/driver/live and effective rule numbers', async () => {
    const { prisma } = seededPrisma();
    const svc = new EmployeesService(prisma);
    const emp = (await svc.one('d1')) as Record<string, unknown>;
    expect(emp.identifier).toBe('DRV1');
    expect(emp.role).toBe('DRIVER');
    expect(emp.driver).toBe(true);
    expect(emp).toHaveProperty('live');
    // no override, no zone row values in the fake ⇒ RULE_DEFAULTS
    expect(emp.maxSpeedKmh).toBeGreaterThan(0);
    expect(emp.stopAlertMin).toBeGreaterThan(0);
  });

  it('devicesOf() returns { devices } with the token masked but present', async () => {
    const { prisma, state } = seededPrisma();
    (prisma as never as { device: { findMany: () => Promise<unknown[]> } }).device.findMany = async () => [
      {
        id: 'dev1', deviceId: 'AND-1', platform: 'android', appVersion: '1.2.3',
        pushToken: 'very-secret-push-token', lastSeenAt: new Date('2026-10-01T10:00:00Z'),
        batteryPct: 77, tracking: true, gpsEnabled: true, online: true, employeeId: 'd1',
      },
    ];
    void state;
    const svc = new EmployeesService(prisma);
    const res = await svc.devicesOf('d1');
    expect(res.devices).toHaveLength(1);
    const d = res.devices[0] as Record<string, unknown>;
    expect(d.token).toContain('••••');
    expect(d.token).not.toContain('secret-push-token');
    expect(d.online).toBe(true);
    expect(d.battery).toBe(77);
  });

  it('summaryOf() returns motionMinutes/openAlerts/totalAlerts from the day positions', async () => {
    const { prisma } = seededPrisma();
    const day = new Date();
    (prisma as never as { position: { findMany: () => Promise<unknown[]> } }).position.findMany = async () => [
      { clientTs: new Date(day.getTime()), motionState: 'RIDING' },
      { clientTs: new Date(day.getTime() + 4 * 60_000), motionState: 'STOPPED' },
      { clientTs: new Date(day.getTime() + 8 * 60_000), motionState: 'WALKING' },
    ];
    (prisma as never as { alert: { count: () => Promise<number> } }).alert.count = async () => 3;
    const svc = new EmployeesService(prisma);
    const res = await svc.summaryOf('d1');
    expect(res.motionMinutes).toEqual({ stopped: 4, walking: 0, riding: 4 });
    expect(res.openAlerts).toBe(3);
    expect(res.totalAlerts).toBe(3);
  });

  it('upsertRules() accepts zoneId, reassigns the zone, and returns the updated effective values', async () => {
    const { prisma, state } = seededPrisma();
    const svc = new EmployeesService(prisma);
    const res = (await svc.upsertRules('d1', { maxSpeedKmh: 70, stopAlertMin: 10, zoneId: 'z2' } as never)) as Record<string, unknown>;
    expect(state.employees.find((e) => e.id === 'd1')!.zoneId).toBe('z2');
    expect(res.zoneId).toBe('z2');
    expect(res.maxSpeedKmh).toBe(70); // override wins over defaults (no RulesService injected → inline merge)
    expect(res.stopAlertMin).toBe(10);
  });
});
