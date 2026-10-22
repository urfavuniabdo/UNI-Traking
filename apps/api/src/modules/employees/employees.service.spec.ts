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
      create: async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const id = `emp${state.seq++}`;
        const row = { id, ...data };
        state.employees.push(row);
        return row;
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
  };
  return { prisma: prisma as never, state };
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
