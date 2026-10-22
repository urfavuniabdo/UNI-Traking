import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

interface FakeUser {
  id: string;
  identifier: string;
  name: string;
  role: string;
  employeeId: string | null;
  passwordHash: string;
  disabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: Date | null;
  scopeOrgUnitId?: string | null;
  employee?: { phone: string; siteId: string | null; zoneId: string | null; kind: string; id: string } | null;
}

function makeFakePrisma(seed: FakeUser[]) {
  const users = new Map(seed.map((u) => [u.id, { ...u }]));
  const sessions = new Map<string, {
    id: string;
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  }>();
  const prisma = {
    user: {
      findFirst: async ({ where }: { where: { OR: Array<{ identifier?: string; employee?: { email?: string } }> } }) => {
        const id = where.OR.map((c) => c.identifier).find(Boolean);
        for (const u of users.values()) if (u.identifier === id) return u;
        return null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.get(where.id)!;
        Object.assign(u, data);
        return u;
      },
    },
    session: {
      create: async ({ data }: { data: { id: string; userId: string; refreshTokenHash: string; expiresAt: Date } }) => {
        sessions.set(data.id, { ...data, revokedAt: null });
        return data;
      },
      findUnique: async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sessions.get(where.id);
        if (s) Object.assign(s, data);
        return s;
      },
      updateMany: async ({ where, data }: { where: { userId?: string; revokedAt?: null }; data: Record<string, unknown> }) => {
        let n = 0;
        for (const s of sessions.values()) {
          if ((where.userId === undefined || s.userId === where.userId) && s.revokedAt === null) {
            Object.assign(s, data);
            n++;
          }
        }
        return { count: n };
      },
    },
  };
  return { prisma: prisma as never, sessions, users };
}

describe('AuthService', () => {
  const baseUser: FakeUser = {
    id: 'u1',
    identifier: 'EMP001',
    name: 'Ahmed Ali',
    role: 'EMPLOYEE',
    employeeId: 'e1',
    passwordHash: bcrypt.hashSync('pw123456', 4),
    disabled: false,
    mustChangePassword: false,
    employee: { id: 'e1', phone: '+201000000001', siteId: 's1', zoneId: null, kind: 'EMPLOYEE' },
  };

  function build() {
    const { prisma, sessions } = makeFakePrisma([{ ...baseUser }]);
    const jwt = new JwtService({});
    const svc = new AuthService(prisma, jwt);
    return { svc, prisma, sessions };
  }

  it('logs in and persists a hashed refresh session', async () => {
    const { svc, sessions } = build();
    const res = await svc.login('EMP001', 'pw123456');
    expect(res.accessToken).toEqual(expect.any(String));
    expect(res.refreshToken).toEqual(expect.any(String));
    expect(res.user.employeeId).toBe('e1');
    expect(sessions.size).toBe(1);
    const stored = [...sessions.values()][0];
    expect(stored.refreshTokenHash).not.toBe(res.refreshToken); // stored hashed, not raw
  });

  it('rejects wrong credentials', async () => {
    const { svc } = build();
    await expect(svc.login('EMP001', 'nope')).rejects.toThrow('INVALID_CREDENTIALS');
  });

  it('rotates the refresh token (in place) keeping a single session', async () => {
    const { svc, sessions } = build();
    const first = await svc.login('EMP001', 'pw123456');
    const second = await svc.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(sessions.size).toBe(1);
    // the surviving session is still active (not revoked)
    expect([...sessions.values()][0].revokedAt).toBeNull();
  });

  it('detects refresh token reuse and revokes the session', async () => {
    const { svc, sessions } = build();
    const first = await svc.login('EMP001', 'pw123456');
    await svc.refresh(first.refreshToken);
    await expect(svc.refresh(first.refreshToken)).rejects.toThrow('REFRESH_REUSED');
    // reuse marks the chain revoked
    expect([...sessions.values()][0].revokedAt).not.toBeNull();
  });

  it('logout revokes the presented session', async () => {
    const { svc, sessions } = build();
    const { refreshToken } = await svc.login('EMP001', 'pw123456');
    await svc.logout(refreshToken, 'u1');
    expect([...sessions.values()].every((s) => s.revokedAt)).toBe(true);
  });

  it('me() returns profile + effective permissions', async () => {
    const { svc } = build();
    const me = await svc.me('u1');
    expect(me.profile?.id).toBe('e1');
    expect(me.permissions).toContain('attendance:self');
    expect(me.permissions).not.toContain('users:write');
  });
});
