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

  it('refreshes the access token without rotating the session secret', async () => {
    const { svc, sessions } = build();
    const first = await svc.login('EMP001', 'pw123456');
    const second = await svc.refresh(first.refreshToken);
    expect(second.accessToken).toEqual(expect.any(String));
    expect(second.refreshToken).toBe(first.refreshToken);
    expect(sessions.size).toBe(1);
    expect([...sessions.values()][0].revokedAt).toBeNull();
  });

  it('tolerates a second refresh from another isolate with the same token', async () => {
    const { svc, sessions } = build();
    const first = await svc.login('EMP001', 'pw123456');
    await svc.refresh(first.refreshToken);
    const again = await svc.refresh(first.refreshToken);
    expect(again.user.identifier).toBe('EMP001');
    expect([...sessions.values()][0].revokedAt).toBeNull();
  });

  it('a revoked session refuses to refresh', async () => {
    const { svc } = build();
    const { refreshToken } = await svc.login('EMP001', 'pw123456');
    await svc.logout(refreshToken);
    await expect(svc.refresh(refreshToken)).rejects.toThrow('REFRESH_EXPIRED');
  });

  it('logout revokes the presented session', async () => {
    const { svc, sessions } = build();
    const { refreshToken } = await svc.login('EMP001', 'pw123456');
    await svc.logout(refreshToken);
    expect([...sessions.values()].every((s) => s.revokedAt)).toBe(true);
  });

  it('logout by bearer revokes every live session of that user', async () => {
    const { svc, sessions } = build();
    const a = await svc.login('EMP001', 'pw123456');
    const b = await svc.login('EMP001', 'pw123456');
    await svc.logoutByBearer(`Bearer ${a.accessToken}`);
    expect([...sessions.values()].every((s) => s.revokedAt)).toBe(true);
    await expect(svc.refresh(b.refreshToken)).rejects.toThrow('REFRESH_EXPIRED');
  });

  it('logout by bearer refuses a token it cannot verify', async () => {
    const { svc } = build();
    await expect(svc.logoutByBearer(undefined)).rejects.toThrow('INVALID_REFRESH_TOKEN');
    await expect(svc.logoutByBearer('Bearer not.a.jwt')).rejects.toThrow('UNAUTHENTICATED');
  });

  it('me() returns profile + effective permissions', async () => {
    const { svc } = build();
    const me = await svc.me('u1');
    expect(me.profile?.id).toBe('e1');
    expect(me.permissions).toContain('attendance:self');
    expect(me.permissions).not.toContain('users:write');
  });
});
