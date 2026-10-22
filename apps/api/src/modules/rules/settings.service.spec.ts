import { BadRequestException } from '@nestjs/common';
import { RULE_DEFAULTS, ALERT_TYPES } from '../../shared/constants';
import { RulesService } from './rules.service';
import { SettingsService, NUMERIC_RULE_KEYS } from './settings.service';

// Deterministic in-memory stand-in for the frozen Prisma models used by /settings.
function build() {
  const settingStore = new Map<string, string>();
  const prefRows: Array<{ userId: string; key: string; value: string }> = [];
  const logs: Array<{
    id: string; alertId: string | null; userId: string | null; channel: string; target: string;
    status: string; attempts: number; error: string | null; payload: string | null;
    createdAt: Date; alert: { type: string } | null;
  }> = [];
  const users: Array<{ id: string; name: string }> = [{ id: 'u1', name: 'مصطفى السيد' }];

  const prisma = {
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        settingStore.has(where.key) ? { key: where.key, value: settingStore.get(where.key)! } : null,
      upsert: async ({ where, create, update }: {
        where: { key: string }; create: { key: string; value: string }; update: { value: string };
      }) => {
        const value = settingStore.has(where.key) ? update.value : create.value;
        settingStore.set(where.key, value);
        return { key: where.key, value };
      },
    },
    userPreference: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        prefRows.filter((r) => r.userId === where.userId),
      upsert: async ({ where, create, update }: {
        where: { userId_key: { userId: string; key: string } };
        create: { userId: string; key: string; value: string };
        update: { value: string };
      }) => {
        const { userId, key } = where.userId_key;
        const idx = prefRows.findIndex((r) => r.userId === userId && r.key === key);
        if (idx >= 0) {
          prefRows[idx] = { ...prefRows[idx], value: update.value };
          return prefRows[idx];
        }
        prefRows.push({ ...create });
        return create;
      },
    },
    notificationLog: {
      findMany: async (opts: { take?: number }) =>
        [...logs]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, opts?.take ?? logs.length),
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        users.filter((u) => where.id.in.includes(u.id)),
    },
  };

  return {
    prisma: prisma as never,
    settingStore,
    prefRows,
    logs,
    users,
  };
}

describe('GET /settings envelope', () => {
  it('returns { rules, timezone, notifications, preferences } with every editable rule key', async () => {
    const { prisma } = build();
    const rules = new RulesService(prisma);
    const svc = new SettingsService(prisma, rules);

    const env = await svc.getSettingsEnvelope({ id: 'u1' });
    expect(Object.keys(env).sort()).toEqual(['notifications', 'preferences', 'rules', 'timezone']);
    expect(env.timezone).toBe('Africa/Cairo');

    // every numeric field the page edits is present, defaulting from RULE_DEFAULTS
    for (const key of NUMERIC_RULE_KEYS) {
      expect(typeof env.rules[key]).toBe('number');
    }
    expect(env.rules.maxSpeedKmh).toBe(RULE_DEFAULTS.maxSpeedKmh);
    expect(env.rules.harshBrakingMs2).toBe(RULE_DEFAULTS.harshBrakingMs2);
    expect(env.rules.attendanceStrictReject).toBe(false);

    // flat prefs (defaults) for the caller
    expect(env.preferences).toEqual({
      push: true,
      whatsapp: true,
      email: true,
      sound: true,
      types: [...ALERT_TYPES],
    });
  });

  it('maps the notification log to the dashboard shape and never leaks the raw push token', async () => {
    const { prisma, logs } = build();
    const token = 'FIREBASE_SECRET_TOKEN_xyz9';
    logs.push({
      id: 'n1', alertId: 'a1', userId: 'u1', channel: 'PUSH', target: token,
      status: 'FAILED', attempts: 3, error: 'FCM 406', payload: JSON.stringify({ type: 'SPEEDING' }),
      createdAt: new Date('2026-01-01T00:00:00.000Z'), alert: { type: 'SPEEDING' },
    });
    const rules = new RulesService(prisma);
    const svc = new SettingsService(prisma, rules);

    const [entry] = await svc.getNotificationLog();
    expect(entry).toMatchObject({
      id: 'n1', alertId: 'a1', alertType: 'SPEEDING', channel: 'push',
      userId: 'u1', userName: 'مصطفى السيد', status: 'FAILED', attempts: 3,
      at: '2026-01-01T00:00:00.000Z', error: 'FCM 406',
    });
    expect(entry.masked.endsWith(token.slice(-4))).toBe(true); // keeps last 4
    expect(entry.masked.slice(-4)).toBe(token.slice(-4));
    expect(entry.masked).toContain('*'); // rest masked
    expect(JSON.stringify(entry)).not.toContain(token);
  });
});

describe('PATCH /settings → rules.global + cache invalidation', () => {
  it('round-trips attendanceStrictReject and invalidates the RulesService 30s cache', async () => {
    const { prisma } = build();
    const rules = new RulesService(prisma);
    const svc = new SettingsService(prisma, rules);

    // prime the RulesService cache
    await rules.globalOverrides();

    const updated = await svc.patchRules({ rules: { attendanceStrictReject: true, cooldownS: 300 } });
    expect(updated.attendanceStrictReject).toBe(true);
    expect(updated.cooldownS).toBe(300);

    // because patchRules called invalidate(), the very next read reflects the new values
    const g = await rules.globalOverrides();
    expect(g.attendanceStrictReject).toBe(true);
    expect(g.cooldownS).toBe(300);
  });

  it('the 30s cache hides a direct write until invalidate() is called', async () => {
    const { prisma, settingStore } = build();
    const rules = new RulesService(prisma);
    await rules.globalOverrides(); // prime (empty)

    settingStore.set('rules.global', JSON.stringify({ cooldownS: 777 })); // bypass settings/invalidate
    const stale = await rules.globalOverrides();
    expect(stale.cooldownS).toBeUndefined(); // still cached

    rules.invalidate();
    const fresh = await rules.globalOverrides();
    expect(fresh.cooldownS).toBe(777);
  });

  it('rejects non-numeric rule values with BAD_RULE_VALUE and clamps negatives to 0', async () => {
    const { prisma } = build();
    const rules = new RulesService(prisma);
    const svc = new SettingsService(prisma, rules);

    await expect(svc.patchRules({ maxSpeedKmh: 'fast' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.patchRules({ maxSpeedKmh: 'fast' })).rejects.toThrow('BAD_RULE_VALUE');
    await expect(svc.patchRules({ attendanceStrictReject: 'yes' })).rejects.toThrow('BAD_RULE_VALUE');

    const r = await svc.patchRules({ stopAlertMin: -10 });
    expect(r.stopAlertMin).toBe(0);
  });
});
