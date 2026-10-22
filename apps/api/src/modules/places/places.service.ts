import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { GeoService, type FenceShape } from '../../common/geo/geo.service';
import { isValidLat, isValidLng, workDateOf } from '../../common/utils';
import type { RulesService } from '../rules/rules.service';

type GeometryInput = { lat: number; lng: number; radiusM?: number | null; polygon?: string | number[][] | null };
type PolygonInput = string | number[][] | null | undefined;

/** Who is calling — used for the optional orgUnitId fallback (scope → root). */
export interface CallerScope {
  scopeOrgUnitId?: string | null;
}

/**
 * Zone has no strictReject column and the schema is frozen — the value lives in the
 * generic Setting key/value table (String column convention), one key per zone.
 */
const ZONE_STRICT_PREFIX = 'places.zone.strictReject.';
const zoneStrictKey = (id: string) => `${ZONE_STRICT_PREFIX}${id}`;

@Injectable()
export class PlacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    /** RulesModule is @Global; optional so unit specs run without it. Used for the online window. */
    @Optional() private readonly rules?: RulesService,
  ) {}

  // ---------- OrgUnit tree ----------
  async orgTree() {
    const units = await this.prisma.orgUnit.findMany({ orderBy: { code: 'asc' } });
    const byId = new Map<string, Record<string, unknown>>(
      units.map((u) => [{ ...u, children: [] as unknown[] } as never] as never),
    );
    // rebuild cleanly to keep TS happy
    const nodes = new Map<string, { id: string; code: string; name: string; parentId: string | null; children: unknown[] }>();
    for (const u of units) nodes.set(u.id, { id: u.id, code: u.code, name: u.name, parentId: u.parentId, children: [] });
    const roots: unknown[] = [];
    for (const n of nodes.values()) {
      if (n.parentId && nodes.has(n.parentId)) (nodes.get(n.parentId)!.children as unknown[]).push(n);
      else roots.push(n);
    }
    return roots;
  }

  async createOrgUnit(dto: { code: string; name: string; parentId?: string | null }) {
    const exists = await this.prisma.orgUnit.findFirst({ where: { code: dto.code } });
    if (exists) throw new BadRequestException('ORGUNIT_CODE_TAKEN');
    if (dto.parentId) await this.mustFindOrg(dto.parentId, 'PARENT_ORGUNIT_NOT_FOUND');
    return this.prisma.orgUnit.create({ data: { code: dto.code, name: dto.name, parentId: dto.parentId ?? null } });
  }

  async updateOrgUnit(id: string, dto: { name?: string; parentId?: string | null }) {
    await this.mustFindOrg(id, 'ORGUNIT_NOT_FOUND');
    if (dto.parentId) {
      if (dto.parentId === id) throw new BadRequestException('CANNOT_PARENT_SELF');
      await this.mustFindOrg(dto.parentId, 'PARENT_ORGUNIT_NOT_FOUND');
    }
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.parentId !== undefined) data.parentId = dto.parentId;
    return this.prisma.orgUnit.update({ where: { id }, data });
  }

  async deleteOrgUnit(id: string) {
    await this.mustFindOrg(id, 'ORGUNIT_NOT_FOUND');
    const kids = await this.prisma.orgUnit.count({ where: { parentId: id } });
    const emps = await this.prisma.employee.count({ where: { orgUnitId: id } });
    const sites = await this.prisma.site.count({ where: { orgUnitId: id } });
    const zones = await this.prisma.zone.count({ where: { orgUnitId: id } });
    if (kids + emps + sites + zones > 0) throw new BadRequestException('ORGUNIT_IN_USE');
    return this.prisma.orgUnit.delete({ where: { id } });
  }

  // ---------- geometry validation ----------
  private validateGeometry(g: GeometryInput, requireRadius: boolean): void {
    if (!isValidLat(g.lat)) throw new BadRequestException('BAD_LAT');
    if (!isValidLng(g.lng)) throw new BadRequestException('BAD_LNG');
    if (g.polygon) {
      const ring = this.geo.ringOf({ id: 'v', name: 'v', lat: g.lat, lng: g.lng, radiusM: g.radiusM ?? 0, polygon: this.normalizePolygon(g.polygon) });
      if (!ring) throw new BadRequestException('POLYGON_INVALID'); // <3 points or non-finite coords (CONTRACT §places)
    } else if (requireRadius && (g.radiusM === undefined || g.radiusM === null)) {
      throw new BadRequestException('RADIUS_OR_POLYGON_REQUIRED');
    }
  }

  /** Accepts the dashboard's array form [[lat,lng],…] or a JSON string; stores the canonical String column. */
  private normalizePolygon(p: string | number[][] | null | undefined): string | null {
    if (p === null || p === undefined) return null;
    if (typeof p === 'string') {
      try {
        const parsed: unknown = JSON.parse(p);
        if (!Array.isArray(parsed)) throw new Error('not an array');
      } catch {
        throw new BadRequestException('POLYGON_INVALID');
      }
      return p;
    }
    if (!Array.isArray(p) || !p.every((v) => Array.isArray(v) && v.length >= 2)) {
      throw new BadRequestException('POLYGON_INVALID');
    }
    return JSON.stringify(p);
  }

  /** Auto-generate a unique fence code: `<prefix>-<slug of name>` (dashboard POSTs omit code). */
  private async generateCode(prefix: 'Z' | 'S', name: string, existing: (code: string) => Promise<unknown>): Promise<string> {
    const slug = String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || Date.now().toString(36);
    let code = `${prefix}-${slug}`.slice(0, 60);
    let n = 1;
    while (await existing(code)) {
      code = `${prefix}-${slug}-${++n}`.slice(0, 60);
    }
    return code;
  }

  /** orgUnitId is optional on create: caller's scope first, then the root OrgUnit. */
  private async resolveOrgUnitId(provided: string | undefined | null, caller?: CallerScope): Promise<string> {
    if (provided) {
      await this.mustFindOrg(provided, 'ORGUNIT_NOT_FOUND');
      return provided;
    }
    const scope = caller?.scopeOrgUnitId ?? null;
    if (scope) {
      const inScope = await this.prisma.orgUnit.findUnique({ where: { id: scope } });
      if (inScope) return inScope.id;
    }
    const root = await this.prisma.orgUnit.findFirst({ where: { parentId: null }, orderBy: { code: 'asc' } });
    if (!root) throw new BadRequestException('NO_ORGUNIT_AVAILABLE');
    return root.id;
  }

  private async zoneStrictRejectMap(): Promise<Map<string, boolean>> {
    const rows = await this.prisma.setting
      .findMany({ where: { key: { startsWith: ZONE_STRICT_PREFIX } } })
      .catch(() => [] as Array<{ key: string; value: string }>);
    return new Map(rows.map((r) => [r.key.slice(ZONE_STRICT_PREFIX.length), r.value === 'true'] as [string, boolean]));
  }

  private async setZoneStrict(id: string, value: boolean | undefined): Promise<void> {
    if (value === undefined) return;
    await this.prisma.setting.upsert({
      where: { key: zoneStrictKey(id) },
      update: { value: String(value) },
      create: { key: zoneStrictKey(id), value: String(value) },
    });
  }

  // ---------- Sites ----------
  async createSite(dto: {
    code?: string; name: string; orgUnitId?: string | null; lat: number; lng: number;
    radiusM?: number; polygon?: string | number[][] | null; strictReject?: boolean; active?: boolean;
  }, caller?: CallerScope) {
    const polygon = this.normalizePolygon(dto.polygon);
    this.validateGeometry({ ...dto, polygon }, true);
    const orgUnitId = await this.resolveOrgUnitId(dto.orgUnitId, caller);
    const code = dto.code?.trim()
      || (await this.generateCode('S', dto.name, (c) => this.prisma.site.findFirst({ where: { code: c } })));
    if (await this.prisma.site.findFirst({ where: { code } })) throw new BadRequestException('SITE_CODE_TAKEN');
    return this.prisma.site.create({
      data: {
        code,
        name: dto.name,
        orgUnitId,
        lat: dto.lat,
        lng: dto.lng,
        radiusM: dto.radiusM ?? 250,
        polygon: polygon ?? null,
        strictReject: dto.strictReject ?? false,
        active: dto.active ?? true,
      },
    });
  }

  async updateSite(id: string, dto: Partial<CreateSiteShapeInput> & { code?: string; orgUnitId?: string }) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) throw new NotFoundException('SITE_NOT_FOUND');
    const polygon = dto.polygon !== undefined ? this.normalizePolygon(dto.polygon) : site.polygon;
    const merged = {
      lat: dto.lat ?? site.lat,
      lng: dto.lng ?? site.lng,
      radiusM: dto.radiusM ?? site.radiusM,
      polygon,
    };
    if (dto.lat !== undefined || dto.lng !== undefined || dto.polygon !== undefined || dto.radiusM !== undefined) {
      this.validateGeometry(merged, false);
    }
    const { polygon: _p, ...rest } = stripUndefined(dto);
    return this.prisma.site.update({ where: { id }, data: { ...rest, ...(dto.polygon !== undefined ? { polygon: polygon ?? null } : {}) } });
  }

  async listSites(activeOnly = false) {
    return this.prisma.site.findMany({
      where: activeOnly ? { active: true } : {},
      orderBy: { name: 'asc' },
      include: { orgUnit: { select: { id: true, code: true, name: true } } },
    });
  }

  async getSite(id: string) {
    const s = await this.prisma.site.findUnique({ where: { id }, include: { orgUnit: true } });
    if (!s) throw new NotFoundException('SITE_NOT_FOUND');
    return s;
  }

  async deleteSite(id: string) {
    const s = await this.prisma.site.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('SITE_NOT_FOUND');
    const [emps, att] = await this.prisma.$transaction([
      this.prisma.employee.count({ where: { siteId: id } }),
      this.prisma.attendanceRecord.count({ where: { siteId: id } }),
    ]);
    if (emps + att > 0) throw new BadRequestException(`FENCE_IN_USE:${emps}:${att}`);
    return this.prisma.site.delete({ where: { id } });
  }

  // ---------- Zones ----------
  async createZone(dto: {
    code?: string; name: string; orgUnitId?: string | null; lat: number; lng: number;
    radiusM?: number; polygon?: string | number[][] | null; maxSpeedKmh?: number | null; stopAlertMin?: number | null;
    active?: boolean; shape?: 'CIRCLE' | 'POLYGON'; strictReject?: boolean;
  }, caller?: CallerScope) {
    const polygon = this.normalizePolygon(dto.polygon);
    this.validateGeometry({ ...dto, polygon }, true);
    const orgUnitId = await this.resolveOrgUnitId(dto.orgUnitId, caller);
    const code = dto.code?.trim()
      || (await this.generateCode('Z', dto.name, (c) => this.prisma.zone.findFirst({ where: { code: c } })));
    if (await this.prisma.zone.findFirst({ where: { code } })) throw new BadRequestException('ZONE_CODE_TAKEN');
    const zone = await this.prisma.zone.create({
      data: {
        code,
        name: dto.name,
        orgUnitId,
        lat: dto.lat,
        lng: dto.lng,
        radiusM: dto.radiusM ?? 8000,
        polygon: polygon ?? null,
        maxSpeedKmh: dto.maxSpeedKmh ?? null,
        stopAlertMin: dto.stopAlertMin ?? null,
        active: dto.active ?? true,
      },
    });
    await this.setZoneStrict(zone.id, dto.strictReject);
    return { ...zone, strictReject: dto.strictReject ?? false };
  }

  async updateZone(id: string, dto: Partial<ZoneShapeInput> & { code?: string; orgUnitId?: string; shape?: string; strictReject?: boolean }) {
    const zone = await this.prisma.zone.findUnique({ where: { id } });
    if (!zone) throw new NotFoundException('ZONE_NOT_FOUND');
    const polygon = dto.polygon !== undefined ? this.normalizePolygon(dto.polygon) : zone.polygon;
    const merged = {
      lat: dto.lat ?? zone.lat,
      lng: dto.lng ?? zone.lng,
      radiusM: dto.radiusM ?? zone.radiusM,
      polygon,
    };
    if (dto.lat !== undefined || dto.lng !== undefined || dto.polygon !== undefined || dto.radiusM !== undefined) {
      this.validateGeometry(merged, false);
    }
    // `shape` is derived (polygon presence) and `strictReject` has no Zone column — both live outside the row.
    const { polygon: _p, shape: _s, strictReject, ...rest } = stripUndefined(dto);
    const updated = await this.prisma.zone.update({
      where: { id },
      data: { ...rest, ...(dto.polygon !== undefined ? { polygon: polygon ?? null } : {}) },
    });
    await this.setZoneStrict(id, strictReject);
    return { ...updated, strictReject: strictReject ?? (await this.zoneStrictRejectMap()).get(id) ?? false };
  }

  async listZones(activeOnly = false) {
    return this.prisma.zone.findMany({
      where: activeOnly ? { active: true } : {},
      orderBy: { name: 'asc' },
      include: { orgUnit: { select: { id: true, code: true, name: true } } },
    });
  }

  async getZone(id: string) {
    const z = await this.prisma.zone.findUnique({ where: { id }, include: { orgUnit: true } });
    if (!z) throw new NotFoundException('ZONE_NOT_FOUND');
    const strict = await this.zoneStrictRejectMap();
    return { ...z, strictReject: strict.get(z.id) ?? false };
  }

  async deleteZone(id: string) {
    const z = await this.prisma.zone.findUnique({ where: { id } });
    if (!z) throw new NotFoundException('ZONE_NOT_FOUND');
    const [emps, trips, stops] = await this.prisma.$transaction([
      this.prisma.employee.count({ where: { zoneId: id } }),
      this.prisma.trip.count({ where: { zoneId: id } }),
      this.prisma.stopEvent.count({ where: { zoneId: id } }),
    ]);
    if (emps + trips + stops > 0) throw new BadRequestException(`FENCE_IN_USE:${emps}:${trips}:${stops}`);
    return this.prisma.zone.delete({ where: { id } });
  }

  // ---------- fences for the dashboard map ----------
  /**
   * GET /places/fences → { sites, zones, outside } (CONTRACT §places).
   * - zone.polygon is the canonical [[lat,lng],…] array the Fences page draws (orientation
   *   normalized by GeoService.ringOf — never reordered blindly).
   * - zone.driverCount = active DRIVER employees assigned to the zone.
   * - zone.activeDriverIds = those drivers whose best Device is online within the same
   *   window the tracking presence logic uses: heartbeatIntervalS × 3 (default 300 × 3 s).
   * - outside = assigned drivers whose last position in the past 24h fails its zone fence.
   * - site.attendance: expected = active non-driver employees assigned; present = today's
   *   records with a check-in (VALID/AUTO_CLOSED); outOfFence = today's OUT_OF_FENCE records.
   * - `city` has no Site/Zone column (schema frozen) ⇒ always null.
   */
  async fences() {
    const now = new Date();
    const today = workDateOf(now);
    const [sites, zones, employees, attendance] = await this.prisma.$transaction([
      this.prisma.site.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      this.prisma.zone.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      this.prisma.employee.findMany({
        where: { active: true },
        select: {
          id: true,
          kind: true,
          siteId: true,
          zoneId: true,
          devices: { select: { online: true, lastSeenAt: true } },
        },
      }),
      this.prisma.attendanceRecord.findMany({
        where: { workDate: today },
        select: { siteId: true, checkInAt: true, status: true },
      }),
    ]);
    const strictMap = await this.zoneStrictRejectMap();
    const hb = (await this.rules?.globalOverrides().catch(() => undefined))?.heartbeatIntervalS;
    const offlineAfter = (hb ?? 300) * 3;

    const driverIdsByZone = new Map<string, string[]>();
    const activeIdsByZone = new Map<string, string[]>();
    const expectedBySite = new Map<string, number>();
    for (const e of employees) {
      if (e.kind === 'DRIVER') {
        if (!e.zoneId) continue;
        const all = driverIdsByZone.get(e.zoneId) ?? [];
        all.push(e.id);
        driverIdsByZone.set(e.zoneId, all);
        const best = e.devices.reduce<{ online: boolean; lastSeenAt: Date | null } | null>(
          (acc, d) => (!acc || (d.lastSeenAt?.getTime() ?? 0) > (acc.lastSeenAt?.getTime() ?? 0) ? d : acc),
          null,
        );
        const ageS = best?.lastSeenAt ? Math.round((now.getTime() - best.lastSeenAt.getTime()) / 1000) : null;
        if (best && best.online && (ageS === null || ageS <= offlineAfter)) {
          const act = activeIdsByZone.get(e.zoneId) ?? [];
          act.push(e.id);
          activeIdsByZone.set(e.zoneId, act);
        }
      } else if (e.siteId) {
        expectedBySite.set(e.siteId, (expectedBySite.get(e.siteId) ?? 0) + 1);
      }
    }

    const presentBySite = new Map<string, number>();
    const outBySite = new Map<string, number>();
    for (const a of attendance) {
      if (!a.siteId) continue;
      if (a.checkInAt && (a.status === 'VALID' || a.status === 'AUTO_CLOSED')) {
        presentBySite.set(a.siteId, (presentBySite.get(a.siteId) ?? 0) + 1);
      }
      if (a.status === 'OUT_OF_FENCE') {
        outBySite.set(a.siteId, (outBySite.get(a.siteId) ?? 0) + 1);
      }
    }

    // outside: last position (24h) per zone-assigned driver, tested against its zone fence.
    const driverZone = new Map<string, string>();
    for (const e of employees) if (e.kind === 'DRIVER' && e.zoneId) driverZone.set(e.id, e.zoneId);
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    const outside: string[] = [];
    if (driverZone.size) {
      const positions = await this.prisma.position.findMany({
        where: { employeeId: { in: [...driverZone.keys()] }, clientTs: { gte: new Date(now.getTime() - 24 * 3600_000) } },
        orderBy: { clientTs: 'desc' },
        select: { employeeId: true, lat: true, lng: true },
      });
      const seen = new Set<string>();
      for (const p of positions) {
        if (seen.has(p.employeeId)) continue;
        seen.add(p.employeeId);
        const z = zoneById.get(driverZone.get(p.employeeId)!);
        if (!z) continue;
        if (!this.geo.test(toShape(z), { lat: p.lat, lng: p.lng }).inside) outside.push(p.employeeId);
      }
    }

    return {
      sites: sites.map((s) => ({
        id: s.id,
        kind: 'SITE' as const,
        code: s.code,
        name: s.name,
        orgUnitId: s.orgUnitId,
        lat: s.lat,
        lng: s.lng,
        radiusM: s.radiusM,
        polygon: this.geo.ringOf(toShape(s)) as [number, number][] | null,
        city: null, // no Site.city column (schema frozen)
        strictReject: s.strictReject,
        attendance: {
          expected: expectedBySite.get(s.id) ?? 0,
          present: presentBySite.get(s.id) ?? 0,
          outOfFence: outBySite.get(s.id) ?? 0,
        },
      })),
      zones: zones.map((z) => ({
        id: z.id,
        kind: 'ZONE' as const,
        shape: z.polygon ? ('POLYGON' as const) : ('CIRCLE' as const),
        code: z.code,
        name: z.name,
        orgUnitId: z.orgUnitId,
        lat: z.lat,
        lng: z.lng,
        radiusM: z.radiusM,
        polygon: this.geo.ringOf(toShape(z)) as [number, number][] | null,
        city: null, // no Zone.city column (schema frozen)
        strictReject: strictMap.get(z.id) ?? false,
        maxSpeedKmh: z.maxSpeedKmh,
        stopAlertMin: z.stopAlertMin,
        driverCount: (driverIdsByZone.get(z.id) ?? []).length,
        activeDriverIds: activeIdsByZone.get(z.id) ?? [],
      })),
      outside,
    };
  }

  private async activeShapes(): Promise<FenceShape[]> {
    const [sites, zones] = await this.prisma.$transaction([
      this.prisma.site.findMany({ where: { active: true } }),
      this.prisma.zone.findMany({ where: { active: true } }),
    ]);
    return [...sites.map(toShape), ...zones.map(toShape)];
  }

  /** Debug helper: is a point inside the caller's assigned fence, or any active fence. */
  async geofenceCheck(lat: number, lng: number, forUserId?: string) {
    if (!isValidLat(lat) || !isValidLng(lng)) throw new BadRequestException('BAD_COORDS');
    const p = { lat, lng };

    if (forUserId) {
      const user = await this.prisma.user.findUnique({
        where: { id: forUserId },
        include: { employee: { include: { site: true, zone: true } } },
      });
      const emp = user?.employee;
      if (!emp) throw new NotFoundException('EMPLOYEE_NOT_FOUND');
      const fence = emp.kind === 'DRIVER' ? emp.zone : emp.site;
      if (!fence) return { scope: 'assigned', inside: false, reason: 'NO_FENCE_ASSIGNED', userId: forUserId };
      const hit = this.geo.test(toShape(fence), p);
      return {
        scope: 'assigned',
        userId: forUserId,
        employeeKind: emp.kind,
        fenceType: emp.kind === 'DRIVER' ? 'ZONE' : 'SITE',
        ...hit,
        geometry: JSON.parse(this.geo.fenceToGeoJSON(toShape(fence))),
      };
    }

    const shapes = await this.activeShapes();
    const { hit, hits } = this.geo.firstHit(shapes, p);
    return {
      scope: 'all',
      checked: hits.length,
      inside: !!hit,
      matched: hit ? { fenceId: hit.fenceId, fenceName: hit.fenceName, kind: hit.kind } : null,
      nearestDistanceM: hits.length ? Math.min(...hits.map((h) => h.distanceToCenterM)) : null,
    };
  }

  private async mustFindOrg(id: string, err: string) {
    const found = await this.prisma.orgUnit.findUnique({ where: { id } });
    if (!found) throw new NotFoundException(err);
    return found;
  }
}

/** Documents the Site/Zone row shape stored in Prisma (String columns; polygon is a JSON [[lat,lng]] string). */
interface FenceRow {
  id: string;
  code: string;
  name: string;
  orgUnitId: string;
  lat: number;
  lng: number;
  radiusM: number;
  polygon: string | null;
  strictReject?: boolean;
  maxSpeedKmh?: number | null;
  stopAlertMin?: number | null;
}
export type { FenceRow };
type CreateSiteShapeInput = { name: string; lat: number; lng: number; radiusM: number; polygon: PolygonInput; strictReject: boolean; active: boolean };
type ZoneShapeInput = { name: string; lat: number; lng: number; radiusM: number; polygon: PolygonInput; maxSpeedKmh: number | null; stopAlertMin: number | null; active: boolean };

function toShape(f: { id: string; name: string; lat: number; lng: number; radiusM: number; polygon: string | null }): FenceShape {
  return { id: f.id, name: f.name, lat: f.lat, lng: f.lng, radiusM: f.radiusM, polygon: f.polygon };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
