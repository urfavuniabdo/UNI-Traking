import { DevicesService, presenceOf } from './devices.service';

function fakePrisma(openShift = true) {
  const devices: any[] = [];
  const events: any[] = [];
  let seq = 1;
  const state = { openShift };
  const prisma = {
    user: { findUnique: async () => ({ employeeId: 'e1' }) },
    attendanceRecord: { findFirst: async () => (state.openShift ? { id: 'ar-1' } : null) },
    device: {
      findUnique: async ({ where }: any) =>
        devices.find((d) => (where.deviceId ? d.deviceId === where.deviceId : d.id === where.id)) ?? null,
      findMany: async () => devices,
      count: async () => devices.length,
      create: async ({ data }: any) => {
        const row = { id: `d${seq++}`, online: true, tracking: false, gpsEnabled: true, lastSeenAt: null, batteryPct: null, pushToken: null, appVersion: null, employeeId: null, userId: null, ...data };
        devices.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const d = devices.find((x) => x.id === where.id);
        Object.assign(d, data);
        return d;
      },
    },
    geoEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  };
  return { prisma: prisma as never, devices, events, state };
}

function fakeDispatcher() {
  const calls: any[] = [];
  return { calls, raise: async (i: any) => { calls.push(i); return { id: 'a', type: i.type, severity: i.severity, suppressed: false }; } };
}

describe('presenceOf', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  it('online + fresh beat → present', () => {
    expect(presenceOf({ online: true, lastSeenAt: new Date(now.getTime() - 60_000) }, now)).toBe(true);
  });
  it('online but stale beat → absent', () => {
    // HEARTBEAT_INTERVAL_S default 300 → window 900s
    expect(presenceOf({ online: true, lastSeenAt: new Date(now.getTime() - 2_000_000) }, now)).toBe(false);
  });
  it('offline → absent', () => {
    expect(presenceOf({ online: false, lastSeenAt: now }, now)).toBe(false);
  });
});

describe('DevicesService', () => {
  it('register is idempotent by deviceId', async () => {
    const { prisma, devices } = fakePrisma();
    const svc = new DevicesService(prisma);
    const a = await svc.register('u1', { deviceId: 'dev-1', platform: 'android', token: 'tokA' } as never);
    const b = await svc.register('u1', { deviceId: 'dev-1', platform: 'android', appVersion: '1.2' } as never);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(devices).toHaveLength(1);
    expect(b.device).toMatchObject({ pushToken: 'tokA', appVersion: '1.2', employeeId: 'e1' });
  });

  it('heartbeat returns serverTs and raises GPS_OFF once (cooldown blocks the second)', async () => {
    const { prisma } = fakePrisma();
    const dispatcher = fakeDispatcher();
    const svc = new DevicesService(prisma, dispatcher as never);
    await svc.register('u1', { deviceId: 'dev-1', platform: 'android' } as never);

    // gpsEnabled true→false transition fires an alert
    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: false, online: true } as never);
    expect(dispatcher.calls.filter((c) => c.type === 'GPS_OFF')).toHaveLength(1);

    // fire again while still off — but device.gpsEnabled is now false, so no further transition;
    // force a fresh transition to verify cooldown suppresses repeats.
    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: true, online: true } as never);
    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: false, online: true } as never);
    expect(dispatcher.calls.filter((c) => c.type === 'GPS_OFF')).toHaveLength(1); // still one (cooldown)
  });

  it('toggle-event writes a GeoEvent row with count for BUFFER_FLUSH', async () => {
    const { prisma, events } = fakePrisma();
    const svc = new DevicesService(prisma);
    await svc.register('u1', { deviceId: 'dev-1', platform: 'ios' } as never);
    await svc.toggleEvent({ deviceId: 'dev-1', kind: 'BUFFER_FLUSH', count: 42 } as never);
    expect(events[0]).toMatchObject({ kind: 'BUFFER_FLUSH', count: 42, employeeId: 'e1' });
  });

  it('tracking on→off ends the driver’s run; any other beat does not', async () => {
    const { prisma } = fakePrisma();
    const closed: Array<[string, number]> = [];
    const trips = { closeOpenTrips: async (employeeId: string, at?: number) => { closed.push([employeeId, at ?? 0]); return 1; } };
    const svc = new DevicesService(prisma, undefined, trips as never);
    await svc.register('u1', { deviceId: 'dev-1', platform: 'android' } as never);

    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: true, online: true } as never);
    expect(closed).toHaveLength(0); // still running
    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: true, online: true } as never);
    expect(closed).toHaveLength(0);

    await svc.heartbeat({ deviceId: 'dev-1', tracking: false, gpsEnabled: true, online: true } as never);
    expect(closed).toEqual([['e1', expect.any(Number)]]);

    await svc.heartbeat({ deviceId: 'dev-1', tracking: false, gpsEnabled: true, online: true } as never);
    expect(closed).toHaveLength(1); // off stays off — one close, not a close per beat
  });

  // The bug he reported: pressing "بدء اليوم" raised «التطبيق غير متصل» 1.5 seconds later, because the
  // phone's first beat was compared with lastSeenAt left from yesterday's session.
  it('a beat returning after hours of silence announces the app as ALIVE, not offline', async () => {
    const { prisma, devices } = fakePrisma();
    const dispatcher = fakeDispatcher();
    const svc = new DevicesService(prisma, dispatcher as never);
    await svc.register('u1', { deviceId: 'dev-1', platform: 'android' } as never);
    devices[0].lastSeenAt = new Date(Date.now() - 6 * 60 * 60_000); // six hours ago, previous day

    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: true, online: true } as never);

    expect(dispatcher.calls).toHaveLength(0);
    expect(new Date(devices[0].lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a device whose driver never started the day raises nothing at all', async () => {
    const { prisma, events } = fakePrisma(false);
    const dispatcher = fakeDispatcher();
    const svc = new DevicesService(prisma, dispatcher as never);
    await svc.register('u1', { deviceId: 'dev-1', platform: 'android' } as never);

    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: false, online: false } as never);
    await svc.toggleEvent({ deviceId: 'dev-1', kind: 'APP_KILLED' } as never);

    expect(dispatcher.calls).toHaveLength(0);
    // the event itself is still recorded — only the alert is silenced
    expect(events.map((e: any) => e.kind)).toEqual(['APP_KILLED']);
  });

  it('the same toggles mid-shift still reach the supervisor', async () => {
    const { prisma } = fakePrisma(true);
    const dispatcher = fakeDispatcher();
    const svc = new DevicesService(prisma, dispatcher as never);
    await svc.register('u1', { deviceId: 'dev-1', platform: 'android' } as never);
    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: true, online: true } as never);

    await svc.heartbeat({ deviceId: 'dev-1', tracking: true, gpsEnabled: false, online: false } as never);
    await svc.toggleEvent({ deviceId: 'dev-1', kind: 'APP_KILLED' } as never);

    expect(dispatcher.calls.map((c) => c.type).sort()).toEqual(['APP_OFFLINE', 'DATA_OFF', 'GPS_OFF']);
  });
});
