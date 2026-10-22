import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { round, workDateOf } from '../../common/utils';
import { RULE_DEFAULTS } from '../../shared/constants';
import { tabular, toCsv, type Column, type CsvValue } from './csv';

type Cell = CsvValue;

export interface ReportTabular {
  headers: string[];
  rows: Cell[][];
  data: Record<string, Cell>[];
  [k: string]: unknown;
}

const dayRange = (date: string): { gte: Date; lte: Date } => ({
  gte: new Date(`${date}T00:00:00.000Z`),
  lte: new Date(`${date}T23:59:59.999Z`),
});

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async employeeIdForUser(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { employeeId: true } });
    if (user?.employeeId) return user.employeeId;
    const emp = await this.prisma.employee.findUnique({ where: { id: userId }, select: { id: true } });
    return emp?.id ?? null;
  }

  /** GET /reports/daily?date — per-driver rollup, replayed data split out. */
  async daily(dateInput?: string): Promise<ReportTabular> {
    const date = dateInput && /^\d{4}-\d{2}-\d{2}$/.test(dateInput) ? dateInput : workDateOf(new Date());
    const range = dayRange(date);

    const positions = await this.prisma.position.findMany({
      where: { clientTs: range },
      orderBy: { clientTs: 'asc' },
      include: { employee: { select: { id: true, name: true, phone: true } } },
    });
    const attendance = await this.prisma.attendanceRecord.findMany({ where: { workDate: date }, include: { employee: { select: { name: true } } } });
    const trips = await this.prisma.trip.findMany({ where: { startedAt: range } });
    const stops = await this.prisma.stopEvent.findMany({ where: { startedAt: range } });
    const alerts = await this.prisma.alert.findMany({ where: { createdAt: range }, select: { employeeId: true, type: true } });

    const byEmp = new Map<string, typeof positions>();
    for (const p of positions) {
      if (!byEmp.has(p.employeeId)) byEmp.set(p.employeeId, []);
      byEmp.get(p.employeeId)!.push(p);
    }

    const attByEmp = new Map(attendance.map((a) => [a.employeeId, a]));
    const tripsByEmp = new Map<string, typeof trips>();
    for (const t of trips) (tripsByEmp.get(t.employeeId) ?? tripsByEmp.set(t.employeeId, []).get(t.employeeId)!).push(t);
    const stopsByEmp = new Map<string, typeof stops>();
    for (const s of stops) (stopsByEmp.get(s.employeeId) ?? stopsByEmp.set(s.employeeId, []).get(s.employeeId)!).push(s);
    const alertsByEmp = new Map<string, Record<string, number>>();
    for (const a of alerts) {
      const m = alertsByEmp.get(a.employeeId) ?? {};
      m[a.type] = (m[a.type] ?? 0) + 1;
      alertsByEmp.set(a.employeeId, m);
    }

    interface Row {
      employeeId: string; name: string; phone: Cell; checkIn: Cell; checkOut: Cell;
      distanceKm: number; maxSpeedKmh: Cell; stopsOver5: number; alertsTotal: number; alertsByType: Record<string, number>;
      offlineMinutes: number; replayedMinutes: number; walkedMin: number; ridingMin: number; stoppedMin: number;
    }
    const rows: Row[] = [];
    for (const [employeeId, pts] of byEmp) {
      let walkedS = 0;
      let ridingS = 0;
      let stoppedS = 0;
      let offlineS = 0;
      let replayedS = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const cur = pts[i];
        const next = pts[i + 1];
        const dt = (next.clientTs.getTime() - cur.clientTs.getTime()) / 1000;
        if (!(dt > 0)) continue;
        const replayedRun = cur.buffered || cur.stale || next.buffered || next.stale;
        if (dt > RULE_DEFAULTS.gapMinMin * 60) offlineS += dt;
        else if (replayedRun) replayedS += dt;
        switch (cur.motionState) {
          case 'WALKING': walkedS += dt; break;
          case 'RIDING': ridingS += dt; break;
          case 'STOPPED': stoppedS += dt; break;
          default: break;
        }
      }
      const empName = pts[0].employee?.name ?? employeeId;
      const phone = pts[0].employee?.phone ?? null;
      const empTrips = tripsByEmp.get(employeeId) ?? [];
      const distanceKm = round(empTrips.reduce((s, t) => s + (t.distanceKm ?? 0), 0), 2) ?? 0;
      const maxSpeedKmh = round(
        empTrips.reduce((m, t) => Math.max(m, t.maxSpeedKmh ?? 0), 0) ||
          pts.reduce((m, p) => Math.max(m, p.speedKmh ?? 0), 0),
        1,
      );
      const stopsOver5 = (stopsByEmp.get(employeeId) ?? []).filter((s) => s.durationS > 300).length;
      const byType = alertsByEmp.get(employeeId) ?? {};
      const att = attByEmp.get(employeeId);
      rows.push({
        employeeId,
        name: empName,
        phone,
        checkIn: att?.checkInAt ? att.checkInAt.toISOString() : '',
        checkOut: att?.checkOutAt ? att.checkOutAt.toISOString() : '',
        distanceKm,
        maxSpeedKmh,
        stopsOver5,
        alertsTotal: Object.values(byType).reduce((s, n) => s + n, 0),
        alertsByType: byType,
        offlineMinutes: round(offlineS / 60, 1) ?? 0,
        replayedMinutes: round(replayedS / 60, 1) ?? 0,
        walkedMin: round(walkedS / 60, 1) ?? 0,
        ridingMin: round(ridingS / 60, 1) ?? 0,
        stoppedMin: round(stoppedS / 60, 1) ?? 0,
      });
    }
    rows.sort((a, b) => b.distanceKm - a.distanceKm);

    const cols: Column<Row>[] = [
      { label: 'driver', get: (r) => r.name },
      { label: 'phone', get: (r) => r.phone },
      { label: 'checkIn', get: (r) => r.checkIn },
      { label: 'checkOut', get: (r) => r.checkOut },
      { label: 'distanceKm', get: (r) => r.distanceKm },
      { label: 'maxSpeedKmh', get: (r) => r.maxSpeedKmh },
      { label: 'stopsOver5', get: (r) => r.stopsOver5 },
      { label: 'alerts', get: (r) => r.alertsTotal },
      { label: 'offlineMin', get: (r) => r.offlineMinutes },
      { label: 'replayedMin', get: (r) => r.replayedMinutes },
      { label: 'walkedMin', get: (r) => r.walkedMin },
      { label: 'ridingMin', get: (r) => r.ridingMin },
      { label: 'stoppedMin', get: (r) => r.stoppedMin },
    ];
    const t = tabular(cols, rows);
    return { ...t, date, meta: { drivers: rows.length, alertsByType: Object.fromEntries(rows.reduce((m, r) => { for (const [k, v] of Object.entries(r.alertsByType)) m.set(k, (m.get(k) ?? 0) + v); return m; }, new Map<string, number>())) } };
  }

  /** GET /reports/route?userId&date — tabular stop list + geometry meta. */
  async route(userId: string, date: string): Promise<ReportTabular> {
    const employeeId = await this.employeeIdForUser(userId);
    const range = dayRange(date);
    const positions = employeeId
      ? await this.prisma.position.findMany({ where: { employeeId, clientTs: range }, orderBy: { clientTs: 'asc' }, select: { lat: true, lng: true, speedKmh: true, buffered: true, stale: true, motionState: true, clientTs: true } })
      : [];
    const stops = employeeId ? await this.prisma.stopEvent.findMany({ where: { employeeId, startedAt: range }, orderBy: { startedAt: 'asc' } }) : [];
    let distanceM = 0;
    for (let i = 0; i < positions.length - 1; i++) {
      const a = positions[i];
      const b = positions[i + 1];
      distanceM += this.haversine(a.lat, a.lng, b.lat, b.lng);
    }
    interface StopRow { startedAt: string; endedAt: Cell; durationS: number; kind: string; lat: number; lng: number }
    const stopRows: StopRow[] = stops.map((s) => ({ startedAt: s.startedAt.toISOString(), endedAt: s.endedAt ? s.endedAt.toISOString() : '', durationS: s.durationS, kind: s.kind, lat: s.lat, lng: s.lng }));
    const cols: Column<StopRow>[] = [
      { label: 'startedAt', get: (r) => r.startedAt },
      { label: 'endedAt', get: (r) => r.endedAt },
      { label: 'durationS', get: (r) => r.durationS },
      { label: 'kind', get: (r) => r.kind },
      { label: 'lat', get: (r) => r.lat },
      { label: 'lng', get: (r) => r.lng },
    ];
    const t = tabular(cols, stopRows);
    return { ...t, userId, employeeId, date, meta: { distanceKm: round(distanceM / 1000, 2), pointCount: positions.length, replayed: positions.some((p) => p.buffered || p.stale) } };
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371008.8;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** GET /reports/timesheet?from&to&userId — attendance rows + exceptions. */
  async timesheet(from?: string, to?: string, userId?: string): Promise<ReportTabular> {
    const employeeId = userId ? await this.employeeIdForUser(userId) : null;
    const where: Record<string, unknown> = {};
    if (employeeId) where.employeeId = employeeId;
    const fromD = from ? String(from).slice(0, 10) : null;
    const toD = to ? String(to).slice(0, 10) : null;
    if (fromD || toD) {
      const wd: Record<string, string> = {};
      if (fromD) wd.gte = fromD;
      if (toD) wd.lte = toD;
      where.workDate = wd;
    }
    const rows = await this.prisma.attendanceRecord.findMany({ where, include: { employee: { select: { name: true } } }, orderBy: { workDate: 'desc' }, take: 2000 });
    interface R { name: Cell; workDate: string; checkIn: Cell; checkOut: Cell; status: string; distanceToSiteM: Cell; exception: boolean }
    const data: R[] = rows.map((a) => ({
      name: a.employee?.name ?? '',
      workDate: a.workDate,
      checkIn: a.checkInAt ? a.checkInAt.toISOString() : '',
      checkOut: a.checkOutAt ? a.checkOutAt.toISOString() : '',
      status: a.status,
      distanceToSiteM: a.distanceToSiteM ?? '',
      exception: a.status !== 'VALID',
    }));
    const cols: Column<R>[] = [
      { label: 'name', get: (r) => r.name },
      { label: 'date', get: (r) => r.workDate },
      { label: 'checkIn', get: (r) => r.checkIn },
      { label: 'checkOut', get: (r) => r.checkOut },
      { label: 'status', get: (r) => r.status },
      { label: 'distanceToSiteM', get: (r) => r.distanceToSiteM },
      { label: 'exception', get: (r) => (r.exception ? 'YES' : 'NO') },
    ];
    const t = tabular(cols, data);
    return { ...t, exceptions: data.filter((d) => d.exception), meta: { rows: data.length, exceptions: data.filter((d) => d.exception).length } };
  }

  /** GET /reports/exceptions?from&to — open/ack alerts grouped with age. */
  async exceptions(from?: string, to?: string): Promise<ReportTabular> {
    const range: Record<string, Date> = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    const where: Record<string, unknown> = { status: { in: ['OPEN', 'ACK'] } };
    if (Object.keys(range).length) where.createdAt = range;
    const rows = await this.prisma.alert.findMany({ where, include: { employee: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const now = Date.now();
    interface R { type: string; severity: string; status: string; driver: Cell; ageMin: number; createdAt: string; replayed: boolean }
    const data: R[] = rows.map((a) => ({
      type: a.type,
      severity: a.severity,
      status: a.status,
      driver: a.employee?.name ?? '',
      ageMin: Math.round((now - a.createdAt.getTime()) / 60000),
      createdAt: a.createdAt.toISOString(),
      replayed: a.replayed,
    }));
    const cols: Column<R>[] = [
      { label: 'type', get: (r) => r.type },
      { label: 'severity', get: (r) => r.severity },
      { label: 'status', get: (r) => r.status },
      { label: 'driver', get: (r) => r.driver },
      { label: 'ageMin', get: (r) => r.ageMin },
      { label: 'createdAt', get: (r) => r.createdAt },
      { label: 'replayed', get: (r) => (r.replayed ? 'YES' : 'NO') },
    ];
    const t = tabular(cols, data);
    const grouped: Record<string, number> = {};
    for (const d of data) grouped[d.type] = (grouped[d.type] ?? 0) + 1;
    return { ...t, grouped, meta: { open: data.length } };
  }

  /** GET /reports/mileage?from&to&groupBy=driver|zone */
  async mileage(from?: string, to?: string, groupBy: 'driver' | 'zone' = 'driver'): Promise<ReportTabular> {
    const range: Record<string, Date> = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    const where: Record<string, unknown> = {};
    if (Object.keys(range).length) where.startedAt = range;
    const trips = await this.prisma.trip.findMany({ where, include: { employee: { select: { name: true } }, zone: { select: { name: true } } }, take: 5000 });
    interface R { key: string; name: Cell; distanceKm: number; trips: number }
    const map = new Map<string, R>();
    for (const t of trips) {
      const key = groupBy === 'zone' ? (t.zoneId ?? 'none') : t.employeeId;
      const name = groupBy === 'zone' ? (t.zone?.name ?? '—') : (t.employee?.name ?? t.employeeId);
      const cur = map.get(key) ?? { key, name, distanceKm: 0, trips: 0 };
      cur.distanceKm += t.distanceKm ?? 0;
      cur.trips += 1;
      map.set(key, cur);
    }
    const data = [...map.values()].map((r) => ({ ...r, distanceKm: round(r.distanceKm, 2) ?? 0 })).sort((a, b) => b.distanceKm - a.distanceKm);
    const cols: Column<R>[] = [
      { label: groupBy, get: (r) => r.name },
      { label: 'distanceKm', get: (r) => r.distanceKm },
      { label: 'trips', get: (r) => r.trips },
    ];
    const t = tabular(cols, data);
    return { ...t, groupBy, meta: { total: round(data.reduce((s, r) => s + r.distanceKm, 0), 2) } };
  }

  /** GET /reports/live-kpis — dashboard header cards. */
  async liveKpis(): Promise<{ activeDrivers: number; openAlerts: number; criticalAlerts: number; offlineDrivers: number; avgSpeedToday: number; generatedAt: string }> {
    const today = workDateOf(new Date());
    const range = dayRange(today);
    const recent = new Date(Date.now() - 15 * 60_000);

    const [activePositions, openAlerts, criticalAlerts, offlineDevices, avgRow] = await this.prisma.$transaction([
      this.prisma.position.findMany({ where: { clientTs: { gte: recent } }, select: { employeeId: true }, distinct: ['employeeId'] }),
      this.prisma.alert.count({ where: { status: 'OPEN' } }),
      this.prisma.alert.count({ where: { status: 'OPEN', severity: 'CRITICAL' } }),
      this.prisma.device.count({ where: { tracking: true, lastSeenAt: { lt: new Date(Date.now() - RULE_DEFAULTS.heartbeatIntervalS * RULE_DEFAULTS.heartbeatMissedCycles * 1000) } } }),
      this.prisma.position.aggregate({ where: { clientTs: range, speedKmh: { gt: 0 } }, _avg: { speedKmh: true } }),
    ]);

    return {
      activeDrivers: activePositions.length,
      openAlerts,
      criticalAlerts,
      offlineDrivers: offlineDevices,
      avgSpeedToday: round(avgRow._avg.speedKmh ?? 0, 1) ?? 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /** CSV string for a report method result. */
  static csvOf(result: { headers: string[]; rows: Cell[][] }): string {
    return toCsv(result.headers, result.rows);
  }
}
