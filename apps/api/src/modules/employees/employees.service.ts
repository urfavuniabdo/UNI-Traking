import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { normalizePhone, workDateOf } from '../../common/utils';
import { EMPLOYEE_KIND, ROLES, RULE_DEFAULTS } from '../../shared/constants';
import type { RulesService } from '../rules/rules.service';
import type { CreateEmployeeDto, ListEmployeesQueryDto, RuleOverrideDto, UpdateEmployeeDto } from './dto';

const EMP_SELECT = {
  id: true,
  externalId: true,
  name: true,
  phone: true,
  email: true,
  jobTitle: true,
  kind: true,
  active: true,
  source: true,
  orgUnitId: true,
  siteId: true,
  zoneId: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    /** RulesModule is @Global; optional so unit specs can run without it (inline fallback below). */
    @Optional() private readonly rules?: RulesService,
  ) {}

  private normalizePhoneOrThrow(raw: string | null | undefined): string {
    const phone = normalizePhone(raw);
    if (!phone) throw new BadRequestException('PHONE_REQUIRED');
    return phone;
  }

  async create(dto: CreateEmployeeDto) {
    const externalId = dto.externalId.trim();
    const phone = this.normalizePhoneOrThrow(dto.phone);
    const kind = dto.kind ?? EMPLOYEE_KIND.EMPLOYEE;

    const dupEmp = await this.prisma.employee.findFirst({ where: { externalId } });
    if (dupEmp) throw new ConflictException('EXTERNAL_ID_TAKEN');

    const employee = await this.prisma.employee.create({
      data: {
        externalId,
        name: dto.name,
        phone,
        email: dto.email ?? null,
        jobTitle: dto.jobTitle ?? null,
        kind,
        source: 'MANUAL',
        orgUnitId: dto.orgUnitId ?? null,
        siteId: dto.siteId ?? null,
        zoneId: dto.zoneId ?? null,
      },
      select: EMP_SELECT,
    });

    // Auto-provision a login for the new employee (CONTRACT §8: temp password + change on first login).
    let createdUser: { id: string; identifier: string; role: string } | null = null;
    const existingUser = await this.prisma.user.findFirst({ where: { identifier: externalId } });
    if (!existingUser) {
      const tempPassword = process.env.ADMIN_INIT_PASSWORD || 'ChangeMe123!';
      createdUser = await this.prisma.user.create({
        data: {
          identifier: externalId,
          name: dto.name,
          role: kind === EMPLOYEE_KIND.DRIVER ? ROLES.DRIVER : ROLES.EMPLOYEE,
          passwordHash: await bcrypt.hash(tempPassword, 10),
          mustChangePassword: true,
          employeeId: employee.id,
        },
        select: { id: true, identifier: true, role: true },
      });
    }

    return { ...employee, createdUser };
  }

  async list(query: ListEmployeesQueryDto) {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 50)));
    const kind = query.kind ?? (query.role as keyof typeof EMPLOYEE_KIND | undefined);
    const where: Record<string, unknown> = {};
    if (kind) where.kind = kind;
    if (query.siteId) where.siteId = query.siteId;
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.active !== undefined) where.active = query.active;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { externalId: { contains: query.search } },
        { phone: { contains: query.search } },
      ];
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        select: { ...EMP_SELECT, site: { select: { id: true, name: true } }, zone: { select: { id: true, name: true } } },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.employee.count({ where }),
    ]);
    const lives = await this.liveMap(items.map((e) => e.id));
    const employees = items.map((e) => ({
      ...e,
      identifier: e.externalId,
      role: e.kind,
      driver: e.kind === EMPLOYEE_KIND.DRIVER,
      zoneName: e.zone?.name ?? null,
      siteName: e.site?.name ?? null,
      live: lives.get(e.id) ?? null,
    }));
    return { employees, total, page, pageSize };
  }

  /**
   * Last known LivePosition per employee — the same source `GET /employees/live` uses
   * (latest Position within 24h + Device presence flags), read via Prisma only.
   */
  private async liveMap(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (!ids.length) return out;
    const now = new Date();
    const [positions, devices] = await this.prisma.$transaction([
      this.prisma.position.findMany({
        where: { employeeId: { in: ids }, clientTs: { gte: new Date(now.getTime() - 24 * 3600_000) } },
        orderBy: { clientTs: 'desc' },
      }),
      this.prisma.device.findMany({
        where: { employeeId: { in: ids } },
        select: { employeeId: true, online: true, tracking: true, gpsEnabled: true, lastSeenAt: true, batteryPct: true },
      }),
    ]);
    const posMap = new Map<string, (typeof positions)[number]>();
    for (const p of positions) if (!posMap.has(p.employeeId)) posMap.set(p.employeeId, p);
    const devMap = new Map<string, (typeof devices)[number]>();
    for (const d of devices) {
      if (!d.employeeId) continue;
      const prev = devMap.get(d.employeeId);
      if (!prev || (d.lastSeenAt?.getTime() ?? 0) > (prev.lastSeenAt?.getTime() ?? 0)) devMap.set(d.employeeId, d);
    }
    for (const id of ids) {
      const pos = posMap.get(id);
      if (!pos) continue; // no last known position ⇒ no `live`
      const dev = devMap.get(id);
      out.set(id, {
        userId: id,
        employeeId: id,
        lat: pos.lat,
        lng: pos.lng,
        speedKmh: pos.speedKmh ?? 0,
        motionState: pos.motionState ?? 'UNKNOWN',
        ts: pos.clientTs.toISOString(),
        battery: pos.batteryPct ?? dev?.batteryPct ?? null,
        accuracy: pos.accuracyM ?? null,
        online: dev?.online ?? false,
        tracking: dev?.tracking ?? false,
        gpsEnabled: dev?.gpsEnabled ?? true,
        // No dataEnabled column in Device/Position — presence of a live path implies the link worked.
        dataEnabled: dev?.online ?? false,
        lastSeen: (dev?.lastSeenAt ?? pos.clientTs).toISOString(),
      });
    }
    return out;
  }

  /** Effective maxSpeedKmh / stopAlertMin: RuleOverride → Zone → global Setting → RULE_DEFAULTS. */
  private async effectiveNumbers(
    id: string,
    row: { zone?: { maxSpeedKmh?: number | null; stopAlertMin?: number | null } | null },
  ): Promise<{ maxSpeedKmh: number; stopAlertMin: number }> {
    if (this.rules) {
      const t = await this.rules.thresholdsFor(id);
      return { maxSpeedKmh: t.maxSpeedKmh, stopAlertMin: t.stopAlertMin };
    }
    const override = await this.prisma.ruleOverride
      .findUnique({ where: { employeeId: id } })
      .catch(() => null);
    const num = (v: unknown): number | undefined => {
      if (v === null || v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      maxSpeedKmh:
        num(override?.maxSpeedKmh) ?? num(row.zone?.maxSpeedKmh) ?? RULE_DEFAULTS.maxSpeedKmh,
      stopAlertMin:
        num(override?.stopAlertMin) ?? num(row.zone?.stopAlertMin) ?? RULE_DEFAULTS.stopAlertMin,
    };
  }

  async one(id: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, code: true } },
        zone: { select: { id: true, name: true, code: true, maxSpeedKmh: true, stopAlertMin: true } },
        user: { select: { id: true, identifier: true, role: true, disabled: true, lastLoginAt: true } },
      },
    });
    if (!emp) throw new NotFoundException('EMPLOYEE_NOT_FOUND');
    const lives = await this.liveMap([id]);
    const effective = await this.effectiveNumbers(id, emp);
    return {
      ...emp,
      identifier: emp.externalId,
      role: emp.kind,
      driver: emp.kind === EMPLOYEE_KIND.DRIVER,
      zoneName: emp.zone?.name ?? null,
      siteName: emp.site?.name ?? null,
      maxSpeedKmh: effective.maxSpeedKmh,
      stopAlertMin: effective.stopAlertMin,
      live: lives.get(id) ?? null,
    };
  }

  async update(id: string, dto: UpdateEmployeeDto) {
    await this.one(id);
    const data: Record<string, unknown> = {};
    if (dto.externalId !== undefined) {
      const dup = await this.prisma.employee.findFirst({ where: { externalId: dto.externalId, NOT: { id } } });
      if (dup) throw new ConflictException('EXTERNAL_ID_TAKEN');
      data.externalId = dto.externalId.trim();
    }
    if (dto.phone !== undefined) data.phone = this.normalizePhoneOrThrow(dto.phone);
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.jobTitle !== undefined) data.jobTitle = dto.jobTitle;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.orgUnitId !== undefined) data.orgUnitId = dto.orgUnitId;
    if (dto.siteId !== undefined) data.siteId = dto.siteId;
    if (dto.zoneId !== undefined) data.zoneId = dto.zoneId;
    return this.prisma.employee.update({ where: { id }, data, select: EMP_SELECT });
  }

  async assignSite(id: string, siteId: string | null) {
    await this.one(id);
    if (siteId) {
      const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
      if (!site) throw new BadRequestException('SITE_NOT_FOUND');
    }
    return this.prisma.employee.update({ where: { id }, data: { siteId: siteId ?? null }, select: EMP_SELECT });
  }

  async assignZone(id: string, zoneId: string | null) {
    await this.one(id);
    if (zoneId) {
      const zone = await this.prisma.zone.findUnique({ where: { id: zoneId }, select: { id: true } });
      if (!zone) throw new BadRequestException('ZONE_NOT_FOUND');
    }
    return this.prisma.employee.update({ where: { id }, data: { zoneId: zoneId ?? null }, select: EMP_SELECT });
  }

  async setDisabled(id: string, active: boolean) {
    await this.one(id);
    return this.prisma.employee.update({ where: { id }, data: { active }, select: EMP_SELECT });
  }

  async upsertRules(id: string, dto: RuleOverrideDto) {
    await this.one(id);
    if (dto.zoneId !== undefined) {
      await this.assignZone(id, dto.zoneId ?? null);
    }
    await this.prisma.ruleOverride.upsert({
      where: { employeeId: id },
      update: {
        maxSpeedKmh: dto.maxSpeedKmh ?? null,
        stopAlertMin: dto.stopAlertMin ?? null,
        geofenceGraceS: dto.geofenceGraceS ?? null,
        speedSamples: dto.speedSamples ?? null,
        disabledTypes: dto.disabledTypes ?? null,
      },
      create: {
        employeeId: id,
        maxSpeedKmh: dto.maxSpeedKmh ?? null,
        stopAlertMin: dto.stopAlertMin ?? null,
        geofenceGraceS: dto.geofenceGraceS ?? null,
        speedSamples: dto.speedSamples ?? null,
        disabledTypes: dto.disabledTypes ?? null,
      },
    });
    const emp = await this.prisma.employee.findUnique({
      where: { id },
      select: { zoneId: true, zone: { select: { maxSpeedKmh: true, stopAlertMin: true } } },
    });
    const effective = await this.effectiveNumbers(id, { zone: emp?.zone ?? null });
    // Updated effective values, merged from zone/override (what the detail page displays next).
    return {
      employeeId: id,
      zoneId: emp?.zoneId ?? null,
      maxSpeedKmh: effective.maxSpeedKmh,
      stopAlertMin: effective.stopAlertMin,
    };
  }

  async getRules(id: string) {
    await this.one(id);
    return this.prisma.ruleOverride.findUnique({ where: { employeeId: id } });
  }

  /** GET /employees/:id/devices — Device rows for the driver-detail page; push token masked. */
  async devicesOf(id: string) {
    await this.one(id);
    const devices = await this.prisma.device.findMany({
      where: { employeeId: id },
      orderBy: { lastSeenAt: 'desc' },
    });
    return {
      devices: devices.map((d) => ({
        id: d.id,
        deviceId: d.deviceId,
        platform: d.platform,
        appVersion: d.appVersion ?? '',
        token: maskToken(d.pushToken),
        lastSeen: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
        battery: d.batteryPct ?? null,
        tracking: d.tracking,
        gpsEnabled: d.gpsEnabled,
        online: d.online,
      })),
    };
  }

  /** GET /employees/:id/summary — today's motion minutes per state + alert counts. */
  async summaryOf(id: string) {
    await this.one(id);
    const now = new Date();
    const workDate = workDateOf(now);
    const dayStart = new Date(`${workDate}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const [positions, openAlerts, totalAlerts] = await this.prisma.$transaction([
      this.prisma.position.findMany({
        where: { employeeId: id, clientTs: { gte: dayStart, lt: dayEnd } },
        orderBy: { clientTs: 'asc' },
        select: { clientTs: true, motionState: true },
      }),
      this.prisma.alert.count({ where: { employeeId: id, status: 'OPEN' } }),
      this.prisma.alert.count({ where: { employeeId: id } }),
    ]);
    // Attribute each gap between consecutive points (capped at 5 min) to the state of its first point.
    const minutes = { stopped: 0, walking: 0, riding: 0 } as Record<string, number>;
    const CAP_MS = 5 * 60_000;
    for (let i = 1; i < positions.length; i++) {
      const state = String(positions[i - 1].motionState ?? '').toLowerCase();
      if (!(state in minutes)) continue; // UNKNOWN
      const dt = Math.min(Math.max(0, positions[i].clientTs.getTime() - positions[i - 1].clientTs.getTime()), CAP_MS);
      minutes[state] += dt / 60_000;
    }
    return {
      motionMinutes: {
        stopped: Math.round(minutes.stopped),
        walking: Math.round(minutes.walking),
        riding: Math.round(minutes.riding),
      },
      openAlerts,
      totalAlerts,
    };
  }

  /** Live attendance/tracking state right now for every active employee (EMPLOYEE + DRIVER). */
  async live(query: { kind?: string; siteId?: string; zoneId?: string } = {}) {
    const now = new Date();
    const today = workDateOf(now);
    const where: Record<string, unknown> = { active: true };
    if (query.kind) where.kind = query.kind;
    if (query.siteId) where.siteId = query.siteId;
    if (query.zoneId) where.zoneId = query.zoneId;

    const employees = await this.prisma.employee.findMany({
      where,
      select: {
        id: true,
        externalId: true,
        name: true,
        kind: true,
        phone: true,
        siteId: true,
        zoneId: true,
        site: { select: { id: true, name: true } },
        zone: { select: { id: true, name: true } },
        devices: { select: { deviceId: true, online: true, tracking: true, gpsEnabled: true, lastSeenAt: true } },
      },
    });
    const ids = employees.map((e) => e.id);
    if (!ids.length) return [];

    const [att, positions] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({ where: { employeeId: { in: ids }, workDate: today } }),
      this.prisma.position.findMany({
        where: { employeeId: { in: ids }, clientTs: { gte: new Date(now.getTime() - 24 * 3600_000) } },
        orderBy: { clientTs: 'desc' },
      }),
    ]);
    const attMap = new Map(att.map((a) => [a.employeeId, a]));
    const posMap = new Map<string, (typeof positions)[number]>();
    for (const p of positions) if (!posMap.has(p.employeeId)) posMap.set(p.employeeId, p);

    return employees.map((e) => {
      const a = attMap.get(e.id);
      const open = !!a?.checkInAt && !a?.checkOutAt;
      const pos = posMap.get(e.id);
      const dev = pickDevice(e.devices);
      return {
        employeeId: e.id,
        externalId: e.externalId,
        name: e.name,
        kind: e.kind,
        phone: e.phone,
        siteId: e.siteId,
        zoneId: e.zoneId,
        siteName: e.site?.name ?? null,
        zoneName: e.zone?.name ?? null,
        checkedInSince: open && a?.checkInAt ? a.checkInAt.toISOString() : null,
        currentStatus: deriveStatus(a),
        attendanceId: a?.id ?? null,
        lastPosition: pos
          ? {
              lat: pos.lat,
              lng: pos.lng,
              speedKmh: pos.speedKmh ?? null,
              motionState: pos.motionState,
              at: pos.clientTs.toISOString(),
              ageS: Math.max(0, Math.round((now.getTime() - pos.clientTs.getTime()) / 1000)),
            }
          : null,
        online: dev?.online ?? false,
        tracking: dev?.tracking ?? false,
        gpsEnabled: dev?.gpsEnabled ?? false,
        lastSeen: dev?.lastSeenAt ? dev.lastSeenAt.toISOString() : null,
      };
    });
  }
}

function pickDevice(
  devices: Array<{ online: boolean; tracking: boolean; gpsEnabled: boolean; lastSeenAt: Date | null }>,
) {
  if (!devices.length) return null;
  return [...devices].sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))[0];
}

/** Push tokens never leave the API in clear text — keep the field present but masked. */
function maskToken(token: string | null): string {
  if (!token) return '';
  return `${token.slice(0, 6)}••••••`;
}

function deriveStatus(a?: { checkInAt: Date | null; checkOutAt: Date | null; status: string } | null): string {
  if (!a) return 'ABSENT';
  if (a.status === 'MISSING_CHECKOUT') return 'MISSING_CHECKOUT';
  if (a.checkInAt && !a.checkOutAt) return 'CHECKED_IN';
  if (a.checkInAt && a.checkOutAt) return 'CHECKED_OUT';
  return a.status;
}
