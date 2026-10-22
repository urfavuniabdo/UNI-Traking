import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { GeoService, type FenceShape } from '../../common/geo/geo.service';
import { isValidLat, isValidLng } from '../../common/utils';

type GeometryInput = { lat: number; lng: number; radiusM?: number | null; polygon?: string | null };

@Injectable()
export class PlacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
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
      const ring = this.geo.ringOf({ id: 'v', name: 'v', lat: g.lat, lng: g.lng, radiusM: g.radiusM ?? 0, polygon: g.polygon });
      if (!ring) throw new BadRequestException('BAD_POLYGON'); // <3 points or non-finite coords
    } else if (requireRadius && (g.radiusM === undefined || g.radiusM === null)) {
      throw new BadRequestException('RADIUS_OR_POLYGON_REQUIRED');
    }
  }

  // ---------- Sites ----------
  async createSite(dto: {
    code: string; name: string; orgUnitId: string; lat: number; lng: number;
    radiusM?: number; polygon?: string | null; strictReject?: boolean; active?: boolean;
  }) {
    this.validateGeometry(dto, true);
    await this.mustFindOrg(dto.orgUnitId, 'ORGUNIT_NOT_FOUND');
    if (await this.prisma.site.findFirst({ where: { code: dto.code } })) throw new BadRequestException('SITE_CODE_TAKEN');
    return this.prisma.site.create({
      data: {
        code: dto.code,
        name: dto.name,
        orgUnitId: dto.orgUnitId,
        lat: dto.lat,
        lng: dto.lng,
        radiusM: dto.radiusM ?? 250,
        polygon: dto.polygon ?? null,
        strictReject: dto.strictReject ?? false,
        active: dto.active ?? true,
      },
    });
  }

  async updateSite(id: string, dto: Partial<CreateSiteShapeInput>) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) throw new NotFoundException('SITE_NOT_FOUND');
    const merged = {
      lat: dto.lat ?? site.lat,
      lng: dto.lng ?? site.lng,
      radiusM: dto.radiusM ?? site.radiusM,
      polygon: dto.polygon !== undefined ? dto.polygon : site.polygon,
    };
    if (dto.lat !== undefined || dto.lng !== undefined || dto.polygon !== undefined || dto.radiusM !== undefined) {
      this.validateGeometry(merged, false);
    }
    return this.prisma.site.update({ where: { id }, data: stripUndefined(dto) });
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
    code: string; name: string; orgUnitId: string; lat: number; lng: number;
    radiusM?: number; polygon?: string | null; maxSpeedKmh?: number | null; stopAlertMin?: number | null; active?: boolean;
  }) {
    this.validateGeometry(dto, true);
    await this.mustFindOrg(dto.orgUnitId, 'ORGUNIT_NOT_FOUND');
    if (await this.prisma.zone.findFirst({ where: { code: dto.code } })) throw new BadRequestException('ZONE_CODE_TAKEN');
    return this.prisma.zone.create({
      data: {
        code: dto.code,
        name: dto.name,
        orgUnitId: dto.orgUnitId,
        lat: dto.lat,
        lng: dto.lng,
        radiusM: dto.radiusM ?? 8000,
        polygon: dto.polygon ?? null,
        maxSpeedKmh: dto.maxSpeedKmh ?? null,
        stopAlertMin: dto.stopAlertMin ?? null,
        active: dto.active ?? true,
      },
    });
  }

  async updateZone(id: string, dto: Partial<ZoneShapeInput>) {
    const zone = await this.prisma.zone.findUnique({ where: { id } });
    if (!zone) throw new NotFoundException('ZONE_NOT_FOUND');
    const merged = {
      lat: dto.lat ?? zone.lat,
      lng: dto.lng ?? zone.lng,
      radiusM: dto.radiusM ?? zone.radiusM,
      polygon: dto.polygon !== undefined ? dto.polygon : zone.polygon,
    };
    if (dto.lat !== undefined || dto.lng !== undefined || dto.polygon !== undefined || dto.radiusM !== undefined) {
      this.validateGeometry(merged, false);
    }
    return this.prisma.zone.update({ where: { id }, data: stripUndefined(dto) });
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
    return z;
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
  async fences() {
    const [sites, zones] = await this.prisma.$transaction([
      this.prisma.site.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      this.prisma.zone.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    ]);
    return [
      ...sites.map((s) => this.fenceOut(s, 'SITE')),
      ...zones.map((z) => this.fenceOut(z, 'ZONE')),
    ];
  }

  private fenceOut(f: FenceRow, kind: 'SITE' | 'ZONE') {
    return {
      id: f.id,
      kind,
      code: f.code,
      name: f.name,
      orgUnitId: f.orgUnitId,
      center: { lat: f.lat, lng: f.lng },
      radiusM: f.radiusM,
      hasPolygon: !!f.polygon,
      strictReject: kind === 'SITE' ? f.strictReject : undefined,
      maxSpeedKmh: kind === 'ZONE' ? f.maxSpeedKmh : undefined,
      stopAlertMin: kind === 'ZONE' ? f.stopAlertMin : undefined,
      geometry: JSON.parse(this.geo.fenceToGeoJSON(toShape(f))),
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
type CreateSiteShapeInput = { name: string; lat: number; lng: number; radiusM: number; polygon: string | null; strictReject: boolean; active: boolean };
type ZoneShapeInput = { name: string; lat: number; lng: number; radiusM: number; polygon: string | null; maxSpeedKmh: number | null; stopAlertMin: number | null; active: boolean };

function toShape(f: { id: string; name: string; lat: number; lng: number; radiusM: number; polygon: string | null }): FenceShape {
  return { id: f.id, name: f.name, lat: f.lat, lng: f.lng, radiusM: f.radiusM, polygon: f.polygon };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
