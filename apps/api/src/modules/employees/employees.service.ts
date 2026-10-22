import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { normalizePhone, workDateOf } from '../../common/utils';
import { EMPLOYEE_KIND, ROLES } from '../../shared/constants';
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
  constructor(private readonly prisma: PrismaService) {}

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
    const where: Record<string, unknown> = {};
    if (query.kind) where.kind = query.kind;
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
    return { items, total, page, pageSize };
  }

  async one(id: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        site: { select: { id: true, name: true, code: true } },
        zone: { select: { id: true, name: true, code: true } },
        user: { select: { id: true, identifier: true, role: true, disabled: true, lastLoginAt: true } },
      },
    });
    if (!emp) throw new NotFoundException('EMPLOYEE_NOT_FOUND');
    return emp;
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
    return this.prisma.ruleOverride.upsert({
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
  }

  async getRules(id: string) {
    await this.one(id);
    return this.prisma.ruleOverride.findUnique({ where: { employeeId: id } });
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

function deriveStatus(a?: { checkInAt: Date | null; checkOutAt: Date | null; status: string } | null): string {
  if (!a) return 'ABSENT';
  if (a.status === 'MISSING_CHECKOUT') return 'MISSING_CHECKOUT';
  if (a.checkInAt && !a.checkOutAt) return 'CHECKED_IN';
  if (a.checkInAt && a.checkOutAt) return 'CHECKED_OUT';
  return a.status;
}
