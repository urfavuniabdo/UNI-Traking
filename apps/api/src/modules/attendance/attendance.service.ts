import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma.service';
import { GeoService, type FenceShape } from '../../common/geo/geo.service';
import {
  ALERT_DISPATCHER,
  REALTIME_PUBLISHER,
  type AlertDispatcher,
  type RealtimePublisher,
} from '../../common/contracts';
import { workDateOf } from '../../common/utils';
import { AR_ALERT_TEXT, ATTENDANCE_STATUS, SEVERITY } from '../../shared/constants';
import type { AttendanceQueryDto, CheckDto } from './dto';
import { zonedLocalToUtc } from './tz';

const TZ = () => process.env.DASHBOARD_TIMEZONE || 'Africa/Cairo';
const SHIFT_GRACE_MIN = Number(process.env.SHIFT_GRACE_MIN ?? 30);

type EmpWithPlaces = {
  id: string;
  externalId: string;
  name: string;
  kind: string;
  phone: string;
  siteId: string | null;
  zoneId: string | null;
  site: { id: string; name: string; lat: number; lng: number; radiusM: number; polygon: string | null; strictReject: boolean } | null;
  zone: { id: string; name: string; lat: number; lng: number; radiusM: number; polygon: string | null } | null;
};

interface EvalResult {
  inside: boolean;
  distanceToCenterM: number | null;
  fenceName: string | null;
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    @Inject(ALERT_DISPATCHER) @Optional() private readonly dispatcher?: AlertDispatcher,
    @Inject(REALTIME_PUBLISHER) @Optional() private readonly rt?: RealtimePublisher,
  ) {}

  // ---------- core ----------
  private async resolveEmployee(userId: string): Promise<EmpWithPlaces> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { include: { site: true, zone: true } } },
    });
    if (!user) throw new UnauthorizedException('UNAUTHENTICATED');
    if (!user.employee) throw new BadRequestException('NO_EMPLOYEE_PROFILE');
    return user.employee as unknown as EmpWithPlaces;
  }

  private fenceOf(emp: EmpWithPlaces) {
    return emp.kind === 'DRIVER' ? emp.zone : emp.site;
  }

  private allowedFences(emp: EmpWithPlaces): Array<{ id: string; name: string; kind: 'SITE' | 'ZONE' }> {
    if (emp.kind === 'DRIVER') return emp.zone ? [{ id: emp.zone.id, name: emp.zone.name, kind: 'ZONE' }] : [];
    return emp.site ? [{ id: emp.site.id, name: emp.site.name, kind: 'SITE' }] : [];
  }

  private evaluate(emp: EmpWithPlaces, lat: number, lng: number): EvalResult {
    const fence = this.fenceOf(emp);
    if (!fence) return { inside: false, distanceToCenterM: null, fenceName: null };
    const shape: FenceShape = { id: fence.id, name: fence.name, lat: fence.lat, lng: fence.lng, radiusM: fence.radiusM, polygon: fence.polygon };
    const hit = this.geo.test(shape, { lat, lng });
    return { inside: hit.inside, distanceToCenterM: hit.distanceToCenterM, fenceName: hit.fenceName };
  }

  private isStrict(emp: EmpWithPlaces): boolean {
    // Site.strictReject covers employees; Zone has no equivalent field yet (see report).
    return emp.kind !== 'DRIVER' && !!emp.site?.strictReject;
  }

  async checkIn(userId: string, dto: CheckDto) {
    const now = new Date();
    const emp = await this.resolveEmployee(userId);
    const workDate = workDateOf(now);

    const existing = await this.prisma.attendanceRecord.findFirst({ where: { employeeId: emp.id, workDate } });
    if (existing && existing.checkInAt) throw new ConflictException('ALREADY_CHECKED_IN');

    const evalRes = this.evaluate(emp, dto.lat, dto.lng);
    const allowed = this.allowedFences(emp);
    const status = evalRes.inside ? ATTENDANCE_STATUS.VALID : ATTENDANCE_STATUS.OUT_OF_FENCE;

    if (!evalRes.inside && this.isStrict(emp)) {
      throw new HttpException('FENCE_VIOLATION', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const data = {
      employeeId: emp.id,
      workDate,
      siteId: emp.siteId ?? null,
      zoneId: emp.zoneId ?? null,
      checkInAt: now,
      checkInLat: dto.lat,
      checkInLng: dto.lng,
      checkInAccuracy: dto.accuracy ?? null,
      checkOutAt: null,
      distanceToSiteM: evalRes.distanceToCenterM,
      status,
      deviceId: dto.deviceId ?? null,
    };
    const record = existing
      ? await this.prisma.attendanceRecord.update({ where: { id: existing.id }, data })
      : await this.prisma.attendanceRecord.create({ data });

    if (status === ATTENDANCE_STATUS.OUT_OF_FENCE) {
      await this.raiseOutOfFence(emp, userId, evalRes, allowed, dto, 'IN');
    }
    this.rt?.attendance({ userId, kind: 'IN', status, ts: now.toISOString() });

    return {
      status,
      fenceName: evalRes.fenceName,
      distanceToCenterM: evalRes.distanceToCenterM,
      allowedFences: allowed,
      record,
    };
  }

  async checkOut(userId: string, dto: CheckDto) {
    const now = new Date();
    const emp = await this.resolveEmployee(userId);
    const workDate = workDateOf(now);

    const rec = await this.prisma.attendanceRecord.findFirst({ where: { employeeId: emp.id, workDate } });
    if (!rec || !rec.checkInAt || rec.checkOutAt) throw new ConflictException('NO_OPEN_RECORD');

    const evalRes = this.evaluate(emp, dto.lat, dto.lng);
    const allowed = this.allowedFences(emp);
    const outOfFence = !evalRes.inside;

    if (outOfFence && this.isStrict(emp)) {
      throw new HttpException('FENCE_VIOLATION', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    const status = outOfFence
      ? ATTENDANCE_STATUS.OUT_OF_FENCE
      : rec.status === ATTENDANCE_STATUS.OUT_OF_FENCE
        ? ATTENDANCE_STATUS.OUT_OF_FENCE
        : ATTENDANCE_STATUS.VALID;

    const record = await this.prisma.attendanceRecord.update({
      where: { id: rec.id },
      data: {
        checkOutAt: now,
        checkOutLat: dto.lat,
        checkOutLng: dto.lng,
        distanceToSiteM: evalRes.distanceToCenterM ?? rec.distanceToSiteM,
        status,
        deviceId: dto.deviceId ?? rec.deviceId,
      },
    });

    if (outOfFence) await this.raiseOutOfFence(emp, userId, evalRes, allowed, dto, 'OUT');
    this.rt?.attendance({ userId, kind: 'OUT', status, ts: now.toISOString() });

    return {
      status,
      fenceName: evalRes.fenceName,
      distanceToCenterM: evalRes.distanceToCenterM,
      allowedFences: allowed,
      record,
    };
  }

  private async raiseOutOfFence(
    emp: EmpWithPlaces,
    userId: string,
    evalRes: EvalResult,
    allowed: Array<{ id: string; name: string; kind: string }>,
    dto: CheckDto,
    edge: 'IN' | 'OUT',
  ) {
    if (!this.dispatcher) return; // silently skip in stub state
    const text = AR_ALERT_TEXT.CHECK_IN_OUT_OF_FENCE;
    try {
      await this.dispatcher.raise({
        type: 'CHECK_IN_OUT_OF_FENCE',
        severity: SEVERITY.WARNING,
        employeeId: emp.id,
        targetUserId: userId,
        siteId: emp.siteId ?? undefined,
        zoneId: emp.zoneId ?? undefined,
        title: text.title,
        body: text.body,
        meta: {
          lat: dto.lat,
          lng: dto.lng,
          edge,
          fenceName: evalRes.fenceName,
          distanceToCenterM: evalRes.distanceToCenterM,
          allowedFences: allowed,
        },
        at: new Date(),
      });
    } catch {
      /* dispatcher must never break the attendance flow */
    }
  }

  // ---------- auto-close ----------
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cronCloseExpired(): Promise<void> {
    await this.closeExpired();
  }

  /** Public + unit-testable: close records still open past shift-end + grace. */
  async closeExpired(now: Date = new Date()) {
    const open = await this.prisma.attendanceRecord.findMany({
      where: { checkInAt: { not: null }, checkOutAt: null, status: { not: ATTENDANCE_STATUS.MISSING_CHECKOUT } },
      include: { employee: { include: { shifts: { include: { schedule: true } }, user: { select: { id: true } } } } },
    });
    let closed = 0;
    for (const rec of open) {
      const emp = rec.employee as unknown as (EmpWithPlaces & { shifts: Array<{ weekday: number | null; schedule: { endMinDay: number; crossMidnight: boolean; graceMin: number } | null }> }) & { user?: { id: string } | null };
      const dow = (() => {
        const [y, m, d] = rec.workDate.split('-').map(Number);
        return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
      })();
      const chosen = emp.shifts?.find((s) => s.weekday === dow) ?? emp.shifts?.find((s) => s.weekday === null) ?? emp.shifts?.[0];
      const sch = chosen?.schedule;

      let endMs: number;
      let graceMin: number;
      if (sch) {
        const endMinutes = sch.endMinDay + (sch.crossMidnight ? 1440 : 0);
        endMs = zonedLocalToUtc(rec.workDate, endMinutes, TZ()).getTime();
        graceMin = sch.graceMin ?? SHIFT_GRACE_MIN;
      } else {
        // No schedule: fall back to end of the calendar work-day.
        endMs = zonedLocalToUtc(rec.workDate, 1440, TZ()).getTime();
        graceMin = SHIFT_GRACE_MIN;
      }

      if (now.getTime() > endMs + graceMin * 60_000) {
        await this.prisma.attendanceRecord.update({
          where: { id: rec.id },
          data: { status: ATTENDANCE_STATUS.MISSING_CHECKOUT, note: 'auto-closed: shift ended without check-out' },
        });
        closed++;
        if (this.dispatcher) {
          const text = AR_ALERT_TEXT.CHECKOUT_MISSING;
          try {
            await this.dispatcher.raise({
              type: 'CHECKOUT_MISSING',
              severity: SEVERITY.CRITICAL,
              employeeId: rec.employeeId,
              targetUserId: emp.user?.id ?? undefined,
              siteId: rec.siteId ?? undefined,
              zoneId: rec.zoneId ?? undefined,
              title: text.title,
              body: text.body,
              meta: { workDate: rec.workDate, shiftEndIso: new Date(endMs).toISOString(), graceMin },
              at: now,
            });
          } catch {
            /* never crash the sweep */
          }
        }
      }
    }
    return { scanned: open.length, closed };
  }

  // ---------- reads ----------
  async meToday(userId: string) {
    const emp = await this.resolveEmployee(userId);
    const workDate = workDateOf(new Date());
    const rec = await this.prisma.attendanceRecord.findFirst({ where: { employeeId: emp.id, workDate } });
    const currentStatus = rec
      ? rec.checkOutAt
        ? rec.status === ATTENDANCE_STATUS.OUT_OF_FENCE
          ? 'CHECKED_OUT_OUT_OF_FENCE'
          : 'CHECKED_OUT'
        : rec.status === ATTENDANCE_STATUS.MISSING_CHECKOUT
          ? 'MISSING_CHECKOUT'
          : 'CHECKED_IN'
      : 'ABSENT';
    return {
      workDate,
      employee: { id: emp.id, externalId: emp.externalId, name: emp.name, kind: emp.kind },
      fenceName: this.fenceOf(emp)?.name ?? null,
      allowedFences: this.allowedFences(emp),
      currentStatus,
      record: rec ?? null,
    };
  }

  private async buildWhere(f: AttendanceQueryDto): Promise<Record<string, unknown>> {
    const where: Record<string, unknown> = {};
    const dateRange: Record<string, string> = {};
    if (f.from) dateRange.gte = f.from;
    if (f.to) dateRange.lte = f.to;
    if (Object.keys(dateRange).length) where.workDate = dateRange;
    if (f.status) where.status = f.status;
    if (f.siteId) where.siteId = f.siteId;
    if (f.userId) {
      const u = await this.prisma.user.findUnique({ where: { id: f.userId }, select: { employeeId: true } });
      where.employeeId = u?.employeeId ?? '__none__';
    }
    return where;
  }

  async list(f: AttendanceQueryDto) {
    const where = await this.buildWhere(f);
    const page = Math.max(1, Number(f.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(f.pageSize ?? 50)));
    const [items, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        include: {
          employee: { select: { id: true, externalId: true, name: true, kind: true, phone: true } },
          site: { select: { id: true, name: true } },
        },
        orderBy: [{ workDate: 'desc' }, { checkInAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async exportCsv(f: AttendanceQueryDto): Promise<string> {
    const where = await this.buildWhere(f);
    const rows = await this.prisma.attendanceRecord.findMany({
      where,
      include: { employee: { select: { externalId: true, name: true, kind: true } }, site: { select: { name: true } } },
      orderBy: [{ workDate: 'desc' }, { checkInAt: 'desc' }],
      take: 20000,
    });
    const header = ['workDate', 'externalId', 'name', 'kind', 'site', 'status', 'checkInAt', 'checkOutAt', 'distanceToSiteM', 'deviceId'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.workDate,
          r.employee?.externalId ?? '',
          r.employee?.name ?? '',
          r.employee?.kind ?? '',
          r.site?.name ?? '',
          r.status,
          r.checkInAt ? r.checkInAt.toISOString() : '',
          r.checkOutAt ? r.checkOutAt.toISOString() : '',
          r.distanceToSiteM ?? '',
          r.deviceId ?? '',
        ]
          .map(esc)
          .join(','),
      );
    }
    return lines.join('\n');
  }

  /** Re-exported so other surfaces (and tests) can reach the not-found path uniformly. */
  async recordById(id: string) {
    const rec = await this.prisma.attendanceRecord.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('ATTENDANCE_NOT_FOUND');
    return rec;
  }
}
