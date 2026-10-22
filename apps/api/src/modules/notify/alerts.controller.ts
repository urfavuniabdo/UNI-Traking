import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
} from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { PrismaService } from '../../common/prisma.service';
import { parseJson } from '../../common/utils';
import { REALTIME_PUBLISHER, type RealtimePublisher } from '../../common/contracts';
import { ALERT_TYPES, ROLES } from '../../shared/constants';
import { AlertDispatchService, type AlertPayload } from './alert-dispatch.service';

type AlertWithEmp = {
  id: string; type: string; severity: string; employeeId: string; userId: string | null;
  zoneId: string | null; siteId: string | null; title: string; body: string; meta: string;
  status: string; ackById: string | null; ackAt: Date | null; resolvedAt: Date | null; resolveNote: string | null;
  replayed: boolean; createdAt: Date; cooldownKey: string;
  employee: { name: string; phone: string; orgUnitId: string | null } | null;
};

@Controller('alerts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AlertsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: AlertDispatchService,
    @Optional() @Inject(REALTIME_PUBLISHER) private readonly publisher?: RealtimePublisher,
  ) {}

  @Get()
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  async list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('userId') userId?: string,
    @Query('zoneId') zoneId?: string,
    @Query('zone') zone?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ): Promise<{ data: AlertPayload[]; meta: { total: number; page: number; pageSize: number } }> {
    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(200, Math.max(1, Number(pageSize) || 50));

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (type && (ALERT_TYPES as readonly string[]).includes(type)) where.type = type;
    const zid = zoneId ?? zone;
    if (zid) where.zoneId = zid;
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from);
      if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to);
    }
    if (userId) {
      where.OR = [{ userId }, { employee: { user: { id: userId } } }];
    }

    // Supervisor scope: restrict to employees under the supervisor's org subtree.
    // (AuthUser.scopeOrgUnitId is not populated by the shared JWT strategy → resolve from DB.)
    if (user.role === ROLES.SUPERVISOR) {
      const scope = await this.prisma.user.findUnique({ where: { id: user.id }, select: { scopeOrgUnitId: true } }).catch(() => null);
      if (scope?.scopeOrgUnitId) {
        const scopeIds = await this.descendantOrgUnits(scope.scopeOrgUnitId);
        where.employee = { ...(where.employee as object), orgUnitId: { in: scopeIds } };
      }
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.alert.count({ where }),
      this.prisma.alert.findMany({
        where,
        include: { employee: { select: { name: true, phone: true, orgUnitId: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (pg - 1) * ps,
        take: ps,
      }),
    ]);

    const payloads = await Promise.all(
      (rows as unknown as AlertWithEmp[]).map((r) =>
        this.dispatch.toPayload(r, r.employee?.name ?? '', r.employee?.phone ?? null, r.employee?.orgUnitId ?? null),
      ),
    );
    return { data: payloads, meta: { total, page: pg, pageSize: ps } };
  }

  @Get('stream/summary')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  async summary(): Promise<{
    total: number;
    open: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    const total = await this.prisma.alert.count();
    const open = await this.prisma.alert.count({ where: { status: 'OPEN' } });
    const byType = await this.prisma.alert.groupBy({ by: ['type'], _count: { _all: true } });
    const bySeverity = await this.prisma.alert.groupBy({ by: ['severity'], _count: { _all: true } });
    const byStatus = await this.prisma.alert.groupBy({ by: ['status'], _count: { _all: true } });
    const toMap = (arr: { _count: { type?: number; severity?: number; status?: number } & Record<string, number>; type?: string; severity?: string; status?: string }[], key: 'type' | 'severity' | 'status'): Record<string, number> =>
      arr.reduce<Record<string, number>>((acc, r) => {
        if (r[key]) acc[r[key] as string] = r._count._all;
        return acc;
      }, {});
    return {
      total,
      open,
      byType: toMap(byType as never, 'type'),
      bySeverity: toMap(bySeverity as never, 'severity'),
      byStatus: toMap(byStatus as never, 'status'),
    };
  }

  @Get(':id')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  async one(@Param('id') id: string): Promise<AlertPayload & { callLogs: unknown[] }> {
    const alert = (await this.prisma.alert.findUnique({
      where: { id },
      include: {
        employee: { select: { name: true, phone: true, orgUnitId: true } },
        callLogs: { orderBy: { at: 'desc' } },
      },
    })) as unknown as (AlertWithEmp & { callLogs: unknown[] }) | null;
    if (!alert) throw new NotFoundException('ALERT_NOT_FOUND');
    const payload = await this.dispatch.toPayload(alert, alert.employee?.name ?? '', alert.employee?.phone ?? null, alert.employee?.orgUnitId ?? null);
    return { ...payload, callLogs: alert.callLogs };
  }

  @Post(':id/ack')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  async ack(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<{ ok: boolean; id: string; status: string }> {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('ALERT_NOT_FOUND');
    const updated = await this.prisma.alert.update({
      where: { id },
      data: { status: 'ACK', ackById: user.id, ackAt: new Date() },
    });
    this.publishUpdate(updated);
    return { ok: true, id, status: 'ACK' };
  }

  @Post(':id/resolve')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  async resolve(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() body: { note?: string }): Promise<{ ok: boolean; id: string; status: string }> {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('ALERT_NOT_FOUND');
    const updated = await this.prisma.alert.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolveNote: body?.note ?? null, ackById: alert.ackById ?? user.id, ackAt: alert.ackAt ?? new Date() },
    });
    this.publishUpdate(updated);
    return { ok: true, id, status: 'RESOLVED' };
  }

  @Post(':id/call-log')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  async callLog(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { called?: boolean; note?: string },
  ): Promise<{ ok: boolean; alertId: string; at: string }> {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('ALERT_NOT_FOUND');
    if (typeof body?.called !== 'boolean') throw new BadRequestException('CALLED_REQUIRED');
    const log = await this.prisma.callLog.create({
      data: { alertId: id, userId: user.id, called: body.called, note: body.note ?? null },
    });
    return { ok: true, alertId: id, at: log.at.toISOString() };
  }

  private publishUpdate(alert: { id: string; status: string; ackById: string | null; ackAt: Date | null }): void {
    const pub = this.publisher as unknown as { publish?: (e: string, p: unknown, rooms: string[]) => void } | undefined;
    pub?.publish?.('alert:updated', { id: alert.id, status: alert.status, ackBy: alert.ackById, ackAt: alert.ackAt?.toISOString() ?? null }, ['watch:admins', 'role:ADMIN', 'role:SUPERVISOR']);
  }

  private async descendantOrgUnits(rootId: string): Promise<string[]> {
    const ids: string[] = [];
    const queue = [rootId];
    let guard = 0;
    while (queue.length && guard++ < 5000) {
      const id = queue.shift()!;
      ids.push(id);
      const kids = await this.prisma.orgUnit.findMany({ where: { parentId: id }, select: { id: true } }).catch(() => []);
      for (const k of kids) queue.push(k.id);
    }
    return ids;
  }
}
