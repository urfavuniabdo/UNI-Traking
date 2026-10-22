import * as bcrypt from 'bcryptjs';
import { UsersService } from './users.service';

interface Row {
  id: string;
  identifier: string;
  name: string;
  role: string;
  disabled: boolean;
  mustChangePassword: boolean;
  passwordHash: string;
  scopeOrgUnitId: string | null;
  employeeId: string | null;
}

function fakeDb(rows: Row[]) {
  const users = new Map(rows.map((r) => [r.id, { ...r }]));
  const sessions: Array<{ userId: string; revokedAt: Date | null }> = [];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      findFirst: async ({ where }: { where: { identifier?: string } }) =>
        [...users.values()].find((u) => u.identifier === where.identifier) ?? null,
      findMany: async () => [...users.values()],
      count: async ({ where }: { where?: { role?: string; disabled?: boolean } }) =>
        [...users.values()].filter(
          (u) => (!where?.role || u.role === where.role) && (where?.disabled === undefined || u.disabled === where.disabled),
        ).length,
      create: async ({ data }: { data: Row }) => {
        users.set(data.id, { ...data });
        return data;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const u = users.get(where.id)!;
        Object.assign(u, data);
        return u;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        users.delete(where.id);
        return { id: where.id };
      },
    },
    session: {
      updateMany: async () => ({ count: 0 }),
    },
    orgUnit: {
      findUnique: async () => ({ id: 'o1' }),
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { prisma: prisma as never, users, sessions };
}

const admin = (id: string, extra: Partial<Row> = {}): Row => ({
  id,
  identifier: id,
  name: `Admin ${id}`,
  role: 'ADMIN',
  disabled: false,
  mustChangePassword: false,
  passwordHash: bcrypt.hashSync('pw123456', 4),
  scopeOrgUnitId: null,
  employeeId: null,
  ...extra,
});

describe('UsersService', () => {
  it('blocks deleting the last active ADMIN', async () => {
    const { prisma } = fakeDb([admin('a1')]);
    const svc = new UsersService(prisma);
    await expect(svc.remove('a1')).rejects.toThrow('CANNOT_DELETE_LAST_ADMIN');
  });

  it('blocks disabling the last active ADMIN but allows when 2 admins exist', async () => {
    const { prisma } = fakeDb([admin('a1'), admin('a2')]);
    const svc = new UsersService(prisma);
    await expect(svc.setDisabled('a1', true)).resolves.toMatchObject({ id: 'a1', disabled: true });
  });

  it('resetPassword sets mustChangePassword and hashes the new password', async () => {
    const { prisma, users } = fakeDb([admin('a1'), admin('a2')]);
    const svc = new UsersService(prisma);
    await svc.resetPassword('a1', 'NewSecret1');
    const u = users.get('a1')!;
    expect(u.mustChangePassword).toBe(true);
    expect(bcrypt.compareSync('NewSecret1', u.passwordHash)).toBe(true);
  });

  it('rejects a duplicate identifier on create', async () => {
    const { prisma } = fakeDb([admin('a1'), admin('a2')]);
    const svc = new UsersService(prisma);
    await expect(
      svc.create({ identifier: 'a1', name: 'Dup', password: 'secret123', role: 'ADMIN' }),
    ).rejects.toThrow('IDENTIFIER_TAKEN');
  });
});
