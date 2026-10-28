import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import {
  ALERT_DISPATCHER,
  TRIP_CLOSER,
  type AlertDispatcher,
  type RaiseAlertInput,
  type TripCloser,
} from '../../common/contracts';
import { RULE_DEFAULTS, SEVERITY, AR_ALERT_TEXT, type AlertType } from '../../shared/constants';
import { json, workDateOf } from '../../common/utils';
import type { RegisterDeviceDto, HeartbeatDto, ToggleEventDto } from './dto';

const HEARTBEAT_INTERVAL_S = Number(process.env.HEARTBEAT_INTERVAL_S ?? 300);
/** Same arithmetic as the offline alert (2 missed beats): a device the board still calls «متصل»
 *  must not be one the alert funnel already declared silent. */
const PRESENCE_WINDOW_S = HEARTBEAT_INTERVAL_S * 2;

export interface DevicePresenceInput {
  online: boolean;
  lastSeenAt: Date | null;
}

/** Reusable across modules: a device is "present" if it is online and beat within 3 intervals. */
export function presenceOf(device: DevicePresenceInput, now: Date = new Date()): boolean {
  if (!device.online) return false;
  if (!device.lastSeenAt) return false;
  const ageS = (now.getTime() - new Date(device.lastSeenAt).getTime()) / 1000;
  return ageS <= PRESENCE_WINDOW_S;
}

@Injectable()
export class DevicesService {
  private readonly cooldown = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ALERT_DISPATCHER) @Optional() private readonly dispatcher?: AlertDispatcher,
    @Inject(TRIP_CLOSER) @Optional() private readonly trips?: TripCloser,
  ) {}

  /** Idempotent by deviceId: create-or-update the device and (re)link the caller's identities. */
  async register(userId: string, dto: RegisterDeviceDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } });
    const employeeId = user?.employeeId ?? null;
    const existing = await this.prisma.device.findUnique({ where: { deviceId: dto.deviceId } });
    const payload = {
      userId,
      employeeId,
      platform: dto.platform,
      pushToken: dto.token ?? existing?.pushToken ?? null,
      appVersion: dto.appVersion ?? existing?.appVersion ?? null,
    };
    if (existing) {
      const updated = await this.prisma.device.update({ where: { id: existing.id }, data: payload });
      return { device: updated, created: false };
    }
    const created = await this.prisma.device.create({ data: { deviceId: dto.deviceId, ...payload } });
    return { device: created, created: true };
  }

  async heartbeat(dto: HeartbeatDto) {
    const now = new Date();
    const device = await this.prisma.device.findUnique({ where: { deviceId: dto.deviceId } });
    if (!device) throw new NotFoundException('DEVICE_NOT_REGISTERED');

    // Detect transitions before overwriting the row.
    const wasOnline = device.online;
    const wasGps = device.gpsEnabled;
    const wasTracking = device.tracking;

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeenAt: now,
        tracking: dto.tracking,
        online: dto.online,
        batteryPct: dto.battery ?? device.batteryPct,
        gpsEnabled: dto.gpsEnabled,
      },
    });

    // No "offline" is raised here: a beat arriving is the proof the app is NOT offline, and its gap
    // is measured against the last beat of a previous day or session — so the driver's first beat
    // after "بدء اليوم" used to announce him as disconnected. Silence while the day is open belongs
    // to the heartbeat sweep (TrackingService.heartbeatSweep), which is day-gated.
    if (wasGps && !dto.gpsEnabled) await this.maybeAlert(device, 'GPS_OFF');
    if (wasOnline && !dto.online) await this.maybeAlert(device, 'DATA_OFF');
    // Tracking off is the end of the run — whoever forgot to say so.
    if (wasTracking && !dto.tracking && device.employeeId) {
      await this.trips?.closeOpenTrips(device.employeeId, now.getTime()).catch(() => undefined);
    }

    return { serverTs: now.toISOString() };
  }

  async toggleEvent(dto: ToggleEventDto) {
    const now = new Date();
    const device = await this.prisma.device.findUnique({ where: { deviceId: dto.deviceId } });
    if (!device) throw new NotFoundException('DEVICE_NOT_REGISTERED');

    await this.prisma.geoEvent.create({
      data: {
        deviceId: device.id,
        employeeId: device.employeeId,
        kind: dto.kind,
        at: now,
        count: dto.kind === 'BUFFER_FLUSH' ? dto.count ?? null : null,
        meta: json({ platform: device.platform, appVersion: device.appVersion }),
      },
    });

    if (dto.kind === 'GPS_OFF') await this.maybeAlert(device, 'GPS_OFF');
    if (dto.kind === 'DATA_OFF') await this.maybeAlert(device, 'DATA_OFF');
    if (dto.kind === 'APP_KILLED') await this.maybeAlert(device, 'APP_OFFLINE');

    return { ok: true };
  }

  /**
   * «طلب مساعدة طارئة» — the driver held the button for three seconds. This is not a rule firing
   * on a threshold, it is a person asking for help: it goes through the same delivery funnel
   * (Alert row → socket → push to ADMIN/SUPERVISOR) but with `force`, so a cooldown from his
   * previous request can never swallow a second one, and with no on-shift gate, since needing
   * help does not wait for the day to be open.
   */
  async requestHelp(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { employeeId: true },
    });
    if (!user?.employeeId) throw new NotFoundException('NO_EMPLOYEE_PROFILE');
    const device = await this.prisma.device.findFirst({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    if (!this.dispatcher) return { ok: false, alertId: null };

    const text = AR_ALERT_TEXT.HELP_REQUESTED;
    const raised = await this.dispatcher.raise({
      type: 'HELP_REQUESTED',
      severity: SEVERITY.CRITICAL,
      employeeId: user.employeeId,
      targetUserId: userId,
      title: text.title,
      body: text.body,
      meta: { deviceId: device?.deviceId ?? null, platform: device?.platform ?? null },
      at: new Date(),
      force: true,
    });
    return { ok: true, alertId: raised?.id ?? null };
  }

  /** ADMIN list with computed presence. */
  async list(query: { page?: number; pageSize?: number; userId?: string }) {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 50)));
    const where: Record<string, unknown> = {};
    if (query.userId) where.userId = query.userId;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.device.findMany({
        where,
        include: { employee: { select: { id: true, externalId: true, name: true, kind: true } } },
        orderBy: { lastSeenAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.device.count({ where }),
    ]);
    return {
      items: items.map((d) => ({ ...d, present: presenceOf(d) })),
      total,
      page,
      pageSize,
      presenceWindowS: PRESENCE_WINDOW_S,
    };
  }

  async mine(userId: string) {
    return this.prisma.device.findMany({
      where: { userId },
      select: { deviceId: true, platform: true, tracking: true, gpsEnabled: true, online: true, lastSeenAt: true, batteryPct: true },
    });
  }

  /**
   * An alert means "a driver who is on shift is in trouble". A device whose driver never started a
   * day — or already finished it — is off the clock, not in trouble: it stays quiet until the next
   * beat or the day-gated heartbeat sweep says otherwise.
   */
  private async onShift(employeeId: string): Promise<boolean> {
    const open = await this.prisma.attendanceRecord.findFirst({
      where: { employeeId, workDate: workDateOf(new Date()), checkOutAt: null },
      select: { id: true },
    });
    return !!open;
  }

  private async maybeAlert(
    device: { id: string; employeeId: string | null; userId: string | null; deviceId: string; platform: string },
    type: Extract<AlertType, 'GPS_OFF' | 'DATA_OFF' | 'APP_OFFLINE'>,
  ) {
    if (!this.dispatcher || !device.employeeId) return;
    if (!(await this.onShift(device.employeeId))) return;
    const key = `${device.deviceId}:${type}`;
    const last = this.cooldown.get(key) ?? 0;
    const now = Date.now();
    if (now - last < RULE_DEFAULTS.cooldownS * 1000) return; // don't spam a flapping device
    this.cooldown.set(key, now);

    const text = AR_ALERT_TEXT[type];
    const input: RaiseAlertInput = {
      type,
      severity: SEVERITY.CRITICAL,
      employeeId: device.employeeId,
      targetUserId: device.userId ?? undefined,
      title: text.title,
      body: text.body,
      meta: { deviceId: device.deviceId, platform: device.platform },
      at: new Date(),
    };
    void this.dispatcher.raise(input).catch(() => undefined);
  }
}
