import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { LEAVE_STATUS, type LeaveStatus } from '../../shared/constants';
import type { CreateLeaveDto, ListLeaveQueryDto } from './dto';

/** One approved-leave day, already joined to the employee labels the attendance/report rows need. */
export interface LeaveDay {
  leaveId: string;
  employeeId: string;
  name: string;
  externalId: string;
  kind: string;
  siteId: string | null;
  siteName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  date: string;
}

type LeaveRow = {
  id: string;
  employeeId: string;
  dateFrom: string;
  dateTo: string;
  reason: string | null;
  status: string;
  requestedAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  employee: { id: string; name: string; externalId: string; kind: string } | null;
  decidedBy: { id: string; name: string } | null;
};

/** Inclusive day count between two `YYYY-MM-DD` keys (UTC math — no DST drift). */
export function leaveDays(dateFrom: string, dateTo: string): number {
  const a = Date.parse(`${dateFrom}T00:00:00Z`);
  const b = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000) + 1;
}

/** Every `YYYY-MM-DD` key covered by a request, capped so a mistyped range can't explode a report. */
export function expandDays(dateFrom: string, dateTo: string, cap = 366): string[] {
  const total = leaveDays(dateFrom, dateTo);
  if (total < 1) return [];
  const days: string[] = [];
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  for (let i = 0; i < Math.min(total, cap); i++) {
    days.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Leave requests. Approving one never writes an attendance record — it turns the covered
 * days from "absent" into "on leave" in the reports and blocks the app's start-day button.
 */
@Injectable()
export class LeaveService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every leave surface is keyed on the caller's employee profile (HR/IT accounts have none). */
  private employeeIdOf(user: AuthUser): string {
    if (!user?.employeeId) throw new BadRequestException('NO_EMPLOYEE_PROFILE');
    return user.employeeId;
  }

  private rangeOf(dto: CreateLeaveDto): { dateFrom: string; dateTo: string } {
    const dateFrom = dto.dateFrom;
    const dateTo = dto.dateTo ?? dateFrom;
    if (Date.parse(`${dateTo}T00:00:00Z`) < Date.parse(`${dateFrom}T00:00:00Z`)) {
      throw new BadRequestException('LEAVE_BAD_RANGE');
    }
    return { dateFrom, dateTo };
  }

  async create(user: AuthUser, dto: CreateLeaveDto) {
    const employeeId = this.employeeIdOf(user);
    const { dateFrom, dateTo } = this.rangeOf(dto);

    const clash = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: [LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED] },
        dateFrom: { lte: dateTo },
        dateTo: { gte: dateFrom },
      },
      select: { id: true, dateFrom: true, dateTo: true, status: true },
    });
    if (clash) throw new ConflictException('LEAVE_OVERLAP');

    const created = await this.prisma.leaveRequest.create({
      data: { employeeId, dateFrom, dateTo, reason: dto.reason ?? null },
    });
    return this.one(created.id);
  }

  /** Own requests — never another employee's rows. */
  async mine(user: AuthUser, q: ListLeaveQueryDto) {
    const employeeId = this.employeeIdOf(user);
    return this.query({ ...q, employeeId });
  }

  /** HR / IT queue over the whole company. */
  async list(q: ListLeaveQueryDto) {
    return this.query(q);
  }

  private async query(q: ListLeaveQueryDto & { employeeId?: string }) {
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 50)));
    const where: Record<string, unknown> = {};
    if (q.employeeId) where.employeeId = q.employeeId;
    if (q.status) where.status = q.status;
    // Range filters are overlap filters: a request touching [from, to] at all matches.
    if (q.from && q.to) where.AND = [{ dateTo: { gte: q.from } }, { dateFrom: { lte: q.to } }];
    else if (q.from) where.dateTo = { gte: q.from };
    else if (q.to) where.dateFrom = { lte: q.to };

    const [rows, total, pendingCount] = await this.prisma.$transaction([
      this.prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { select: { id: true, name: true, externalId: true, kind: true } },
          decidedBy: { select: { id: true, name: true } },
        },
        orderBy: [{ requestedAt: 'desc' }, { dateFrom: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.leaveRequest.count({ where }),
      this.prisma.leaveRequest.count({
        where: q.employeeId ? { status: LEAVE_STATUS.PENDING, employeeId: q.employeeId } : { status: LEAVE_STATUS.PENDING },
      }),
    ]);
    return { items: rows.map((r) => this.toDto(r as unknown as LeaveRow)), total, page, pageSize, pendingCount };
  }

  async one(id: string) {
    const row = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, name: true, externalId: true, kind: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    });
    if (!row) throw new NotFoundException('LEAVE_NOT_FOUND');
    return this.toDto(row as unknown as LeaveRow);
  }

  /** Cancel while still pending — a decided request is HR's record, not the requester's. */
  async cancel(id: string, user: AuthUser) {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('LEAVE_NOT_FOUND');
    if (row.employeeId !== this.employeeIdOf(user)) throw new ForbiddenException('LEAVE_NOT_YOURS');
    if (row.status !== LEAVE_STATUS.PENDING) throw new ConflictException('LEAVE_NOT_PENDING');
    await this.prisma.leaveRequest.update({ where: { id }, data: { status: LEAVE_STATUS.CANCELLED } });
    return this.one(id);
  }

  /** Approve/reject. A decision is final — re-deciding is a new request, not an edit. */
  async decide(id: string, status: typeof LEAVE_STATUS.APPROVED | typeof LEAVE_STATUS.REJECTED, user: AuthUser, note?: string) {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('LEAVE_NOT_FOUND');
    if (row.status !== LEAVE_STATUS.PENDING) throw new ConflictException('LEAVE_ALREADY_DECIDED');
    await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, decidedById: user.id, decidedAt: new Date(), decisionNote: note ?? null },
    });
    return this.one(id);
  }

  /** Approved leave covering `workDate`, if any — the attendance flow asks this before check-in. */
  async approvedOn(employeeId: string, workDate: string): Promise<{ id: string; dateFrom: string; dateTo: string } | null> {
    const row = await this.prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: LEAVE_STATUS.APPROVED,
        dateFrom: { lte: workDate },
        dateTo: { gte: workDate },
      },
      select: { id: true, dateFrom: true, dateTo: true },
    });
    return row ?? null;
  }

  /** Approved leave for the days in [from, to], flattened to one row per employee-day. */
  async approvedDaysInRange(from: string, to: string): Promise<LeaveDay[]> {
    const rows = await this.prisma.leaveRequest.findMany({
      where: { status: LEAVE_STATUS.APPROVED, dateFrom: { lte: to }, dateTo: { gte: from } },
      include: { employee: { include: { site: { select: { name: true } }, zone: { select: { name: true } } } } },
      orderBy: { dateFrom: 'asc' },
    });
    const out: LeaveDay[] = [];
    for (const r of rows) {
      const e = r.employee as unknown as { id: string; name: string; externalId: string; kind: string; siteId: string | null; zoneId: string | null; site?: { name: string } | null; zone?: { name: string } | null } | null;
      for (const date of expandDays(r.dateFrom, r.dateTo)) {
        if (date < from || date > to) continue;
        out.push({
          leaveId: r.id,
          employeeId: r.employeeId,
          name: e?.name ?? r.employeeId,
          externalId: e?.externalId ?? '',
          kind: e?.kind ?? '',
          siteId: e?.siteId ?? null,
          siteName: e?.site?.name ?? null,
          zoneId: e?.zoneId ?? null,
          zoneName: e?.zone?.name ?? null,
          date,
        });
      }
    }
    return out;
  }

  private toDto(r: LeaveRow) {
    return {
      id: r.id,
      employeeId: r.employeeId,
      employeeName: r.employee?.name ?? null,
      employeeExternalId: r.employee?.externalId ?? null,
      kind: (r.employee?.kind ?? null) as string | null,
      dateFrom: r.dateFrom,
      dateTo: r.dateTo,
      days: leaveDays(r.dateFrom, r.dateTo),
      reason: r.reason,
      status: r.status as LeaveStatus,
      requestedAt: r.requestedAt.toISOString(),
      decidedById: r.decidedById,
      decidedByName: r.decidedBy?.name ?? null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionNote: r.decisionNote,
    };
  }
}
