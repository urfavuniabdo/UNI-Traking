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
  TRIP_CLOSER,
  type AlertDispatcher,
  type RealtimePublisher,
  type TripCloser,
} from '../../common/contracts';
import { parseJson, workDateOf } from '../../common/utils';
import { AR_ALERT_TEXT, ATTENDANCE_STATUS, ROLES, SEVERITY } from '../../shared/constants';
import { LeaveService, type LeaveDay } from '../leave/leave.service';
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
  orgUnitId: string | null;
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

/** One row of the GET /attendance envelope — a checked day, or a synthesized approved-leave day. */
type RecordDto = {
  id: string;
  userId: string;
  userName: string | null;
  siteId: string | null;
  siteName: string | null;
  zoneId: string | null;
  zoneName: string | null;
  date: string;
  checkInTs: string | null;
  checkOutTs: string | null;
  checkInStatus: string;
  checkOutStatus: string | null;
  distanceToCenterM: number | null;
  fenceName: string | null;
  exception: boolean;
  replayed: boolean;
};

/** Attendance row + joins needed to map the dashboard `/attendance` record shape. */
type AttRow = {
  id: string;
  employeeId: string;
  workDate: string;
  siteId: string | null;
  zoneId: string | null;
  status: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  distanceToSiteM: number | null;
  employee: { id: string; externalId: string; name: string; kind: string; phone: string } | null;
  site: { id: string; name: string } | null;
};

@Injectable()
export class AttendanceService {
  /** Cached `rules.global` Setting row (same ~30s pattern as RulesService.globalOverrides). */
  private settingsCache: { at: number; value: { attendanceStrictReject?: boolean } } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly leave: LeaveService,
    @Inject(ALERT_DISPATCHER) @Optional() private readonly dispatcher?: AlertDispatcher,
    @Inject(REALTIME_PUBLISHER) @Optional() private readonly rt?: RealtimePublisher,
    @Inject(TRIP_CLOSER) @Optional() private readonly trips?: TripCloser,
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

  /**
   * Strict reject = `site.strictReject` (employees) OR the global
   * `rules.global` Setting `attendanceStrictReject` (applies to every fence,
   * zones included — the Zone table has no strictReject column).
   */
  private async isStrict(emp: EmpWithPlaces): Promise<boolean> {
    if (emp.kind !== 'DRIVER' && emp.site?.strictReject) return true;
    return this.globalStrictReject();
  }

  /** Global override stored in Setting(key='rules.global') as a JSON string — cached ~30s. */
  private async globalStrictReject(): Promise<boolean> {
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCache.at < 30_000) {
      return !!this.settingsCache.value.attendanceStrictReject;
    }
    let value: { attendanceStrictReject?: boolean } = {};
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: 'rules.global' } });
      value = parseJson<{ attendanceStrictReject?: boolean }>(row?.value, {});
    } catch {
      value = {};
    }
    this.settingsCache = { at: now, value };
    return !!value.attendanceStrictReject;
  }

  /** Phone of a SUPERVISOR user in the employee's org unit, falling back to any ADMIN. */
  private async supervisorPhone(emp: EmpWithPlaces): Promise<string | null> {
    try {
      if (emp.orgUnitId) {
        const sup = await this.prisma.user.findFirst({
          where: { role: ROLES.SUPERVISOR, disabled: false, employee: { orgUnitId: emp.orgUnitId } },
          select: { employee: { select: { phone: true } } },
          orderBy: { createdAt: 'asc' },
        });
        if (sup?.employee?.phone) return sup.employee.phone;
      }
      const admin = await this.prisma.user.findFirst({
        where: { role: ROLES.ADMIN, disabled: false, employee: { isNot: null } },
        select: { employee: { select: { phone: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return admin?.employee?.phone ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 422 with the rich JSON body the mobile client parses (api_error.dart
   * FenceViolationException.fromJson): message / fenceName / distanceToCenterM /
   * allowedFences[] / supervisorPhone|phone / statusCode (+ code for dashboard ApiError).
   */
  private async raiseFenceViolation(
    emp: EmpWithPlaces,
    evalRes: EvalResult,
    allowed: Array<{ id: string; name: string; kind: 'SITE' | 'ZONE' }>,
  ): Promise<never> {
    const body = {
      code: 'FENCE_VIOLATION',
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      message: AR_ALERT_TEXT.CHECK_IN_OUT_OF_FENCE.title,
      fenceName: evalRes.fenceName,
      distanceToCenterM: evalRes.distanceToCenterM,
      allowedFences: allowed,
      supervisorPhone: await this.supervisorPhone(emp),
    };
    throw new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  async checkIn(userId: string, dto: CheckDto) {
    const now = new Date();
    const emp = await this.resolveEmployee(userId);
    const workDate = workDateOf(now);

    // Approved leave wins: the day is already accounted for, so there is nothing to start.
    const onLeave = await this.leave.approvedOn(emp.id, workDate);
    if (onLeave) {
      throw new HttpException(
        { code: 'ON_APPROVED_LEAVE', statusCode: HttpStatus.CONFLICT, message: 'يومك معتمد كإجازة، لا حاجة لبدء اليوم', leave: onLeave },
        HttpStatus.CONFLICT,
      );
    }

    const existing = await this.prisma.attendanceRecord.findFirst({ where: { employeeId: emp.id, workDate } });
    if (existing && existing.checkInAt) throw new ConflictException('ALREADY_CHECKED_IN');

    const evalRes = this.evaluate(emp, dto.lat, dto.lng);
    const allowed = this.allowedFences(emp);
    const status = evalRes.inside ? ATTENDANCE_STATUS.VALID : ATTENDANCE_STATUS.OUT_OF_FENCE;

    if (!evalRes.inside && (await this.isStrict(emp))) {
      await this.raiseFenceViolation(emp, evalRes, allowed);
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

    if (outOfFence && (await this.isStrict(emp))) {
      await this.raiseFenceViolation(emp, evalRes, allowed);
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
    // the shift is over, so the vehicle is back at the yard: a run left OPEN shows a driver on the road
    await this.trips?.closeOpenTrips(emp.id, now.getTime()).catch(() => undefined);
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
    const [rec, leave] = await Promise.all([
      this.prisma.attendanceRecord.findFirst({ where: { employeeId: emp.id, workDate } }),
      this.leave.approvedOn(emp.id, workDate),
    ]);
    let currentStatus = rec
      ? rec.checkOutAt
        ? rec.status === ATTENDANCE_STATUS.OUT_OF_FENCE
          ? 'CHECKED_OUT_OUT_OF_FENCE'
          : 'CHECKED_OUT'
        : rec.status === ATTENDANCE_STATUS.MISSING_CHECKOUT
          ? 'MISSING_CHECKOUT'
          : 'CHECKED_IN'
      : 'ABSENT';
    // A checked-in day stays as it is; an untouched approved-leave day is not an absence.
    if (!rec && leave) currentStatus = 'ON_LEAVE';
    return {
      workDate,
      employee: { id: emp.id, externalId: emp.externalId, name: emp.name, kind: emp.kind },
      fenceName: this.fenceOf(emp)?.name ?? null,
      allowedFences: this.allowedFences(emp),
      currentStatus,
      leave: leave ?? null,
      record: rec ?? null,
    };
  }

  /** Own history for EMPLOYEE/DRIVER (never leaks another employee's rows). */
  async meHistory(userId: string, f: AttendanceQueryDto) {
    const emp = await this.resolveEmployee(userId);
    const page = Math.max(1, Number(f.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(f.pageSize ?? 50)));
    const where: Record<string, unknown> = { employeeId: emp.id };
    const dateRange: Record<string, string> = {};
    if (f.from) dateRange.gte = f.from.slice(0, 10);
    if (f.to) dateRange.lte = f.to.slice(0, 10);
    if (Object.keys(dateRange).length) where.workDate = dateRange;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        include: { site: { select: { id: true, name: true } } },
        orderBy: [{ workDate: 'desc' }, { checkInAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  private async buildWhere(f: AttendanceQueryDto): Promise<Record<string, unknown>> {
    const where: Record<string, unknown> = {};
    const dateRange: Record<string, string> = {};
    if (f.from) dateRange.gte = f.from;
    if (f.to) dateRange.lte = f.to;
    if (Object.keys(dateRange).length) where.workDate = dateRange;
    if (f.status) {
      if (f.status === ATTENDANCE_STATUS.OUT_OF_FENCE) {
        where.status = ATTENDANCE_STATUS.OUT_OF_FENCE;
      } else if (f.status === ATTENDANCE_STATUS.VALID) {
        where.status = { not: ATTENDANCE_STATUS.OUT_OF_FENCE };
      } else if (f.status === ATTENDANCE_STATUS.MISSING_CHECKOUT) {
        where.OR = [
          { status: { in: [ATTENDANCE_STATUS.MISSING_CHECKOUT, ATTENDANCE_STATUS.AUTO_CLOSED] } },
          { checkInAt: { not: null }, checkOutAt: null },
        ];
      } else {
        where.status = f.status;
      }
    }
    if (f.siteId) where.siteId = f.siteId;
    if (f.zoneId) where.zoneId = f.zoneId;
    if (f.userId) {
      const u = await this.prisma.user.findUnique({ where: { id: f.userId }, select: { employeeId: true } });
      where.employeeId = u?.employeeId ?? '__none__';
    }
    return where;
  }

  /**
   * GET /attendance (admin list) — envelope the dashboard Attendance page renders:
   * `{ records, total, page, pageSize, stats }`. `records[]` keys follow
   * apps/dashboard/src/api/types.ts AttendanceRecord exactly (userId = employee id).
   *
   * Approved leave has no AttendanceRecord row — it is synthesized here so the page shows
   * "إجازة" for those days instead of counting the person as absent.
   */
  async list(f: AttendanceQueryDto) {
    const where = await this.buildWhere(f);
    const page = Math.max(1, Number(f.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Number(f.pageSize ?? 50)));
    const rows = (await this.prisma.attendanceRecord.findMany({
      where,
      include: {
        employee: { select: { id: true, externalId: true, name: true, kind: true, phone: true } },
        site: { select: { id: true, name: true } },
      },
      orderBy: [{ workDate: 'desc' }, { checkInAt: 'desc' }],
      take: 20000,
    })) as unknown as AttRow[];

    const zoneIds = [...new Set(rows.map((r) => r.zoneId).filter((z): z is string => !!z))];
    const zoneNames = new Map<string, string>();
    if (zoneIds.length) {
      const zs = await this.prisma.zone.findMany({ where: { id: { in: zoneIds } }, select: { id: true, name: true } });
      for (const z of zs) zoneNames.set(z.id, z.name);
    }
    const replayedKeys = await this.replayedKeys(rows);
    const records: RecordDto[] = rows.map((r) => this.toRecordDto(r, zoneNames, replayedKeys));

    const leaveOnly = f.status === ATTENDANCE_STATUS.LEAVE;
    if (!f.status || leaveOnly) {
      const leaveDays = await this.leaveDaysFor(where, f, rows);
      if (leaveOnly) records.length = 0;
      records.push(...leaveDays.map((d) => this.toLeaveRecordDto(d)));
      // Stable sort on the day only: leave joins its own day, the DB's intra-day order survives.
      records.sort((a, b) => b.date.localeCompare(a.date));
    }
    const onLeave = records.filter((r) => r.checkInStatus === ATTENDANCE_STATUS.LEAVE).length;

    // stats: computed over the whole filtered set — the page uses sites[]/zones[] to fill filter dropdowns.
    const [sites, zones, staffed] = await Promise.all([
      this.prisma.site.findMany({ where: { active: true }, select: { id: true, name: true } }).catch(() => []),
      this.prisma.zone.findMany({ where: { active: true }, select: { id: true, name: true } }).catch(() => []),
      this.prisma.employee.findMany({ where: { active: true, siteId: { not: null } }, select: { siteId: true } }).catch(() => []),
    ]);
    const expectedBySite = new Map<string, number>();
    for (const e of staffed) if (e.siteId) expectedBySite.set(e.siteId, (expectedBySite.get(e.siteId) ?? 0) + 1);
    const stats = {
      present: rows.filter((r) => r.checkInAt).length,
      missingCheckout: rows.filter((r) => r.checkInAt && !r.checkOutAt).length,
      outOfFence: rows.filter((r) => r.status === ATTENDANCE_STATUS.OUT_OF_FENCE).length,
      onLeave,
      sites: sites.map((s) => {
        const c = rows.filter((r) => r.siteId === s.id).length;
        return { id: s.id, name: s.name, count: c, present: c, expected: expectedBySite.get(s.id) ?? 0 };
      }),
      zones: zones.map((z) => {
        const c = rows.filter((r) => r.zoneId === z.id).length;
        return { id: z.id, name: z.name, count: c, present: c };
      }),
    };
    return { records: records.slice((page - 1) * pageSize, page * pageSize), total: records.length, page, pageSize, stats };
  }

  /**
   * Approved leave days the attendance list should carry, in the `?userId`/site/zone scope
   * `buildWhere` already resolved — minus any day the employee actually checked in for.
   */
  private async leaveDaysFor(where: Record<string, unknown>, f: AttendanceQueryDto, rows: Array<{ employeeId: string; workDate: string; checkInAt: Date | null }>): Promise<LeaveDay[]> {
    const employeeId = typeof where.employeeId === 'string' ? where.employeeId : null;
    const taken = new Set(rows.filter((r) => r.checkInAt).map((r) => `${r.employeeId}|${r.workDate}`));
    const days = await this.leave.approvedDaysInRange(f.from?.slice(0, 10) ?? '1970-01-01', f.to?.slice(0, 10) ?? '9999-12-31');
    return days.filter(
      (d) =>
        !taken.has(`${d.employeeId}|${d.date}`) &&
        (!employeeId || d.employeeId === employeeId) &&
        (!f.siteId || d.siteId === f.siteId) &&
        (!f.zoneId || d.zoneId === f.zoneId),
    );
  }

  /** A leave day wearing the attendance-record shape — id is stable per request per day. */
  private toLeaveRecordDto(d: LeaveDay): RecordDto {
    return {
      id: `leave:${d.leaveId}:${d.date}`,
      userId: d.employeeId,
      userName: d.name,
      siteId: d.siteId,
      siteName: d.siteName,
      zoneId: d.zoneId,
      zoneName: d.zoneName,
      date: d.date,
      checkInTs: null,
      checkOutTs: null,
      checkInStatus: ATTENDANCE_STATUS.LEAVE,
      checkOutStatus: null,
      distanceToCenterM: null,
      fenceName: d.siteName ?? d.zoneName,
      exception: false,
      replayed: false,
    };
  }

  /** Attendance rows without a `replayed` column — derive from buffered/stale positions of the same work day. */
  private async replayedKeys(rows: Array<{ employeeId: string; workDate: string }>): Promise<Set<string>> {
    const out = new Set<string>();
    if (!rows.length) return out;
    const dates = rows.map((r) => r.workDate).sort();
    try {
      const hits = await this.prisma.position.findMany({
        where: {
          employeeId: { in: [...new Set(rows.map((r) => r.employeeId))] },
          clientTs: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`) },
          OR: [{ buffered: true }, { stale: true }],
        },
        select: { employeeId: true, clientTs: true },
      });
      for (const h of hits) out.add(`${h.employeeId}|${workDateOf(h.clientTs, TZ())}`);
    } catch {
      /* positions table unreachable in stub state — everything stays non-replayed */
    }
    return out;
  }

  private toRecordDto(
    r: AttRow,
    zoneNames: Map<string, string>,
    replayedKeys: Set<string>,
  ): RecordDto {
    const outOfFence = r.status === ATTENDANCE_STATUS.OUT_OF_FENCE;
    const zoneName = r.zoneId ? zoneNames.get(r.zoneId) ?? null : null;
    return {
      id: r.id,
      userId: r.employeeId,
      userName: r.employee?.name ?? null,
      siteId: r.siteId ?? null,
      siteName: r.site?.name ?? null,
      zoneId: r.zoneId ?? null,
      zoneName,
      date: r.workDate,
      checkInTs: r.checkInAt ? r.checkInAt.toISOString() : null,
      checkOutTs: r.checkOutAt ? r.checkOutAt.toISOString() : null,
      checkInStatus: outOfFence ? ATTENDANCE_STATUS.OUT_OF_FENCE : ATTENDANCE_STATUS.VALID,
      checkOutStatus: r.checkOutAt ? (outOfFence ? ATTENDANCE_STATUS.OUT_OF_FENCE : ATTENDANCE_STATUS.VALID) : null,
      distanceToCenterM: r.distanceToSiteM ?? null,
      fenceName: r.site?.name ?? zoneName,
      exception: r.status !== ATTENDANCE_STATUS.VALID,
      replayed: replayedKeys.has(`${r.employeeId}|${r.workDate}`),
    };
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
    // Leave days that were never checked in — same columns, LEAVE status, no times.
    for (const d of await this.leaveDaysFor(where, f, rows)) {
      lines.push(
        [d.date, d.externalId, d.name, d.kind, d.siteName ?? '', ATTENDANCE_STATUS.LEAVE, '', '', '', '']
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
