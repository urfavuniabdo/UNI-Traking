import { ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { LEAVE_STATUS } from '../../shared/constants';
import { LeaveService, leaveDays } from './leave.service';

type Row = Record<string, unknown>;

/** In-memory stand-in for the LeaveRequest table: only the operators the service uses. */
class FakePrisma {
  rows: Row[] = [];
  seq = 0;

  mk(data: Row): Row {
    return {
      id: `lv-${++this.seq}`,
      reason: null,
      status: LEAVE_STATUS.PENDING,
      requestedAt: new Date('2026-10-01T08:00:00Z'),
      decidedById: null,
      decidedAt: null,
      decisionNote: null,
      ...data,
    };
  }

  leaveRequest = {
    create: async ({ data }: { data: Row }) => {
      const row = this.mk(data);
      this.rows.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => this.match(where)[0] ?? null,
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) => this.match(where),
    count: async ({ where }: { where: Record<string, unknown> }) => this.match(where).length,
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.rows.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
  };

  $transaction = async (ops: Array<Promise<unknown>>) => Promise.all(ops);

  private match(where: Record<string, unknown>): Row[] {
    const keys = Object.keys(where);
    return this.rows.filter((r) =>
      keys.every((k) => {
        const cond = where[k] as never;
        if (k === 'AND') return (cond as Array<Record<string, unknown>>).every((c) => this.ok(r, c));
        return this.ok(r, { [k]: cond });
      }),
    );
  }

  private ok(r: Row, cond: Record<string, unknown>): boolean {
    return Object.entries(cond).every(([field, raw]) => {
      const v = r[field];
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const c = raw as Record<string, unknown>;
        if ('in' in c) return (c.in as unknown[]).includes(v);
        if ('lte' in c) return String(v) <= String(c.lte);
        if ('gte' in c) return String(v) >= String(c.gte);
        return false;
      }
      return v === raw;
    });
  }
}

const empUser = { id: 'u-emp', role: 'EMPLOYEE', employeeId: 'emp-1' };
const hrUser = { id: 'u-hr', role: 'HR', employeeId: null };

const seed = (prisma: FakePrisma, data: Row): Row => {
  const row = prisma.mk(data);
  prisma.rows.push(row);
  return row;
};

describe('LeaveService', () => {
  let prisma: FakePrisma;
  let svc: LeaveService;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = new LeaveService(prisma as never);
  });

  it('defaults a single-day request to dateFrom and reports one day', async () => {
    const out = await svc.create(empUser as never, { dateFrom: '2026-11-03', reason: 'ظرف عائلي' });
    expect(out).toMatchObject({
      dateFrom: '2026-11-03',
      dateTo: '2026-11-03',
      days: 1,
      status: LEAVE_STATUS.PENDING,
      employeeId: 'emp-1',
    });
  });

  it('counts an inclusive range', () => {
    expect(leaveDays('2026-11-03', '2026-11-05')).toBe(3);
  });

  it('rejects an inverted range and a caller without an employee profile', async () => {
    await expect(svc.create(empUser as never, { dateFrom: '2026-11-05', dateTo: '2026-11-03' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.create(hrUser as never, { dateFrom: '2026-11-05' })).rejects.toThrow('NO_EMPLOYEE_PROFILE');
  });

  it('blocks a request that overlaps a pending or approved one', async () => {
    await svc.create(empUser as never, { dateFrom: '2026-11-03', dateTo: '2026-11-05' });
    await expect(svc.create(empUser as never, { dateFrom: '2026-11-05' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.rows).toHaveLength(1);
  });

  it('lets a rejected range be re-requested', async () => {
    seed(prisma, {
      employeeId: 'emp-1',
      dateFrom: '2026-11-03',
      dateTo: '2026-11-03',
      status: LEAVE_STATUS.REJECTED,
    });
    await expect(svc.create(empUser as never, { dateFrom: '2026-11-03' })).resolves.toBeTruthy();
  });

  it('approves only while pending and stamps the HR decider', async () => {
    const created = await svc.create(empUser as never, { dateFrom: '2026-11-10' });
    const approved = await svc.decide(created.id, LEAVE_STATUS.APPROVED, hrUser as never, 'تم');
    expect(approved).toMatchObject({
      status: LEAVE_STATUS.APPROVED,
      decidedById: 'u-hr',
      decisionNote: 'تم',
    });
    expect(approved.decidedAt).toBeTruthy();
    await expect(svc.decide(created.id, LEAVE_STATUS.REJECTED, hrUser as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('cancels only the requester’s own pending request', async () => {
    const created = await svc.create(empUser as never, { dateFrom: '2026-11-11' });
    const other = { id: 'u-other', role: 'EMPLOYEE', employeeId: 'emp-2' };
    await expect(svc.cancel(created.id, other as never)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.decide(created.id, LEAVE_STATUS.APPROVED, hrUser as never);
    await expect(svc.cancel(created.id, empUser as never)).rejects.toThrow('LEAVE_NOT_PENDING');
    const fresh = await svc.create(empUser as never, { dateFrom: '2026-11-20' });
    expect((await svc.cancel(fresh.id, empUser as never)).status).toBe(LEAVE_STATUS.CANCELLED);
  });

  it('treats another employee’s approved leave as not covering me', async () => {
    seed(prisma, { employeeId: 'emp-2', dateFrom: '2026-11-11', dateTo: '2026-11-12', status: LEAVE_STATUS.APPROVED });
    expect(await svc.approvedOn('emp-1', '2026-11-11')).toBeNull();
    const mine = seed(prisma, {
      employeeId: 'emp-1',
      dateFrom: '2026-11-11',
      dateTo: '2026-11-12',
      status: LEAVE_STATUS.APPROVED,
    });
    expect(await svc.approvedOn('emp-1', '2026-11-12')).toMatchObject({ id: mine.id });
    expect(await svc.approvedOn('emp-1', '2026-11-13')).toBeNull();
  });

  it('returns pendingCount with the HR queue and only own rows for /mine', async () => {
    await svc.create(empUser as never, { dateFrom: '2026-11-01' });
    seed(prisma, { employeeId: 'emp-9', dateFrom: '2026-11-02', dateTo: '2026-11-02' });
    const queue = await svc.list({});
    expect(queue).toMatchObject({ total: 2, pendingCount: 2, page: 1 });
    const own = await svc.mine(empUser as never, {});
    expect(own.total).toBe(1);
    expect(own.items[0].employeeId).toBe('emp-1');
  });
});
