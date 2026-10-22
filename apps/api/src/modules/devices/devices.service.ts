import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ALERT_DISPATCHER, type AlertDispatcher, type RaiseAlertInput } from '../../common/contracts';
import { RULE_DEFAULTS, SEVERITY, AR_ALERT_TEXT, type AlertType } from '../../shared/constants';
import { json } from '../../common/utils';
import type { RegisterDeviceDto, HeartbeatDto, ToggleEventDto } from './dto';

const HEARTBEAT_INTERVAL_S = Number(process.env.HEARTBEAT_INTERVAL_S ?? 300);
const PRESENCE_WINDOW_S = HEARTBEAT_INTERVAL_S * 3;

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

    // Detect transitions / offline gaps before overwriting the row.
    const wasOnline = device.online;
    const wasGps = device.gpsEnabled;
    const prevSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null;
    const gapS = prevSeen ? (now.getTime() - prevSeen) / 1000 : null;

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

    if (wasGps && !dto.gpsEnabled) this.maybeAlert(device, 'GPS_OFF');
    if (wasOnline && !dto.online) this.maybeAlert(device, 'DATA_OFF');
    if (gapS !== null && gapS > PRESENCE_WINDOW_S) this.maybeAlert(device, 'APP_OFFLINE');

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

    if (dto.kind === 'GPS_OFF') this.maybeAlert(device, 'GPS_OFF');
    if (dto.kind === 'DATA_OFF') this.maybeAlert(device, 'DATA_OFF');
    if (dto.kind === 'APP_KILLED') this.maybeAlert(device, 'APP_OFFLINE');

    return { ok: true };
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

  private maybeAlert(
    device: { id: string; employeeId: string | null; userId: string | null; deviceId: string; platform: string },
    type: Extract<AlertType, 'GPS_OFF' | 'DATA_OFF' | 'APP_OFFLINE'>,
  ) {
    if (!this.dispatcher || !device.employeeId) return;
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
