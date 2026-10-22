import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import type { ManageableRole } from './dto';

const SAFE_SELECT = {
  id: true,
  identifier: true,
  name: true,
  role: true,
  scopeOrgUnitId: true,
  disabled: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  employeeId: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: {
    identifier: string;
    name: string;
    password: string;
    role: ManageableRole;
    scopeOrgUnitId?: string | null;
  }) {
    const identifier = dto.identifier.trim();
    if (!identifier) throw new BadRequestException('IDENTIFIER_REQUIRED');
    const exists = await this.prisma.user.findFirst({ where: { identifier } });
    if (exists) throw new BadRequestException('IDENTIFIER_TAKEN');
    if (dto.scopeOrgUnitId) await this.assertOrgUnit(dto.scopeOrgUnitId);

    const user = await this.prisma.user.create({
      data: {
        identifier,
        name: dto.name,
        role: dto.role,
        passwordHash: await bcrypt.hash(dto.password, 10),
        scopeOrgUnitId: dto.scopeOrgUnitId ?? null,
        mustChangePassword: true,
      },
      select: SAFE_SELECT,
    });
    return user;
  }

  async list(query: { page?: number; pageSize?: number; search?: string; role?: ManageableRole }) {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));
    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search } },
              { identifier: { contains: query.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async one(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException('USER_NOT_FOUND');
    return user;
  }

  async update(
    id: string,
    dto: { name?: string; role?: ManageableRole; scopeOrgUnitId?: string | null; disabled?: boolean },
  ) {
    await this.one(id);
    if (dto.scopeOrgUnitId) await this.assertOrgUnit(dto.scopeOrgUnitId);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.scopeOrgUnitId !== undefined) data.scopeOrgUnitId = dto.scopeOrgUnitId;
    if (dto.disabled !== undefined) {
      if (dto.disabled === true) await this.guardLastAdmin(id, { disable: true });
      data.disabled = dto.disabled;
    }
    return this.prisma.user.update({ where: { id }, data, select: SAFE_SELECT });
  }

  async setDisabled(id: string, disabled: boolean) {
    await this.one(id);
    if (disabled) await this.guardLastAdmin(id, { disable: true });
    return this.prisma.user.update({ where: { id }, data: { disabled }, select: SAFE_SELECT });
  }

  async resetPassword(id: string, newPassword: string) {
    await this.one(id);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: true },
    });
    // reset invalidates existing sessions
    await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  async remove(id: string) {
    const user = await this.one(id);
    if (user.role === 'ADMIN' && !user.disabled) {
      await this.guardLastAdmin(id, { delete: true });
    }
    await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.user.delete({ where: { id } });
    return { ok: true };
  }

  /** Never allow removing/disabling the last active ADMIN. */
  private async guardLastAdmin(id: string, op: { disable?: boolean; delete?: boolean }) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.role !== 'ADMIN') return;
    const activeAdmins = await this.prisma.user.count({ where: { role: 'ADMIN', disabled: false } });
    if (activeAdmins <= 1) {
      throw new BadRequestException(op.delete ? 'CANNOT_DELETE_LAST_ADMIN' : 'CANNOT_DISABLE_LAST_ADMIN');
    }
  }

  private async assertOrgUnit(id: string) {
    const found = await this.prisma.orgUnit.findUnique({ where: { id }, select: { id: true } });
    if (!found) throw new BadRequestException('ORGUNIT_NOT_FOUND');
  }
}
