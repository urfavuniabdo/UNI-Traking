import { ALERT_TYPES } from '../../shared/constants';
import { MeController } from './me.controller';
import type { AuthUser } from '../../common/auth/jwt.strategy';

function build() {
  const rows: Array<{ userId: string; key: string; value: string }> = [];
  const prisma = {
    userPreference: {
      findMany: async ({ where }: { where: { userId: string } }) => rows.filter((r) => r.userId === where.userId),
      upsert: async ({ where, create, update }: {
        where: { userId_key: { userId: string; key: string } };
        create: { userId: string; key: string; value: string };
        update: { value: string };
      }) => {
        const { userId, key } = where.userId_key;
        const idx = rows.findIndex((r) => r.userId === userId && r.key === key);
        if (idx >= 0) rows[idx] = { ...rows[idx], value: update.value };
        else rows.push({ ...create });
        return idx >= 0 ? rows[idx] : create;
      },
    },
  };
  const publisher = { publish: jest.fn() };
  const user: AuthUser = { id: 'u1', role: 'EMPLOYEE' };
  const ctrl = new MeController(prisma as never, publisher as never);
  return { ctrl, rows, publisher, user };
}

describe('/me/preferences — flat shape', () => {
  it('defaults every channel to true and returns all alert types when nothing is stored', async () => {
    const { ctrl, user } = build();
    const prefs = await ctrl.getPreferences(user);
    expect(prefs).toEqual({ push: true, whatsapp: true, email: true, sound: true, types: [...ALERT_TYPES] });
  });

  it('GET → PATCH (partial) → GET reflects the flat values', async () => {
    const { ctrl, user, rows, publisher } = build();

    const before = await ctrl.getPreferences(user);
    expect(before.push).toBe(true);

    await ctrl.patchPreferences(user, { push: false, whatsapp: false });
    // persisted into the existing string-keyed columns, not new flat keys
    expect(rows.find((r) => r.key === 'push.enabled')?.value).toBe('false');
    expect(rows.find((r) => r.key === 'notify.whatsapp')?.value).toBe('false');
    expect(rows.find((r) => r.key === 'push')).toBeUndefined();

    const after = await ctrl.getPreferences(user);
    expect(after.push).toBe(false);
    expect(after.whatsapp).toBe(false);
    expect(after.email).toBe(true); // untouched by the partial body
    expect(after.sound).toBe(true);

    // the save-confirmation socket ping the dashboard listens for
    expect(publisher.publish).toHaveBeenCalledWith(
      'notify:me',
      expect.objectContaining({ title: 'تم تحديث التفضيلات' }),
      ['user:u1'],
    );
  });

  it('PATCH { types } stores the complement as push.mutedTypes and round-trips', async () => {
    const { ctrl, user } = build();
    const wanted = ['SPEEDING', 'GEOFENCE_EXIT'];
    const returned = await ctrl.patchPreferences(user, { types: wanted });
    expect(returned.types.slice().sort()).toEqual([...wanted].sort());
    const after = await ctrl.getPreferences(user);
    expect(after.types.slice().sort()).toEqual([...wanted].sort());
    expect(after.types).not.toContain('GPS_OFF');
  });
});
