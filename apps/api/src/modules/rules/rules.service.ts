import { Injectable } from '@nestjs/common';
import type { AlertType } from '../../shared/constants';
import { RULE_DEFAULTS } from '../../shared/constants';
import { PrismaService } from '../../common/prisma.service';
import { parseJson } from '../../common/utils';
import type { FenceShape } from '../../common/geo/geo.service';

/** Fully-resolved numeric thresholds for one employee (RuleOverride → Zone → Setting → RULE_DEFAULTS). */
export interface EffectiveThresholds {
  maxSpeedKmh: number;
  stopAlertMin: number;
  geofenceGraceS: number;
  speedSamples: number;
  speedingCriticalS: number;
  cooldownS: number;
  harshBrakingMs2: number;
  harshAccelMs2: number;
  gapMinMin: number;
  heartbeatIntervalS: number;
  heartbeatMissedCycles: number;
  replayMaxAgeHours: number;
  accuracyDriftM: number;
  /** An alert condition is a value held for a duration, not a single sample (§6). */
  speedingHoldS: number;
  disabledTypes: AlertType[];
}

export interface EmployeeContext {
  employeeId: string;
  employeeName: string;
  employeePhone: string | null;
  kind: string;
  userId: string | null;
  orgUnitId: string | null;
  zoneId: string | null;
  siteId: string | null;
  /** Zone as a geofence (null when the driver has no zone). */
  zoneFence: FenceShape | null;
  /** Site fences used to classify StopEvent kind = PLANNED. */
  siteFences: FenceShape[];
  thresholds: EffectiveThresholds;
}

export interface GlobalOverrides {
  maxSpeedKmh?: number;
  stopAlertMin?: number;
  geofenceGraceS?: number;
  speedingCriticalS?: number;
  cooldownS?: number;
  heartbeatIntervalS?: number;
  replayMaxAgeHours?: number;
  gapMinMin?: number;
  shiftGraceMin?: number;
  harshBrakingMs2?: number;
  harshAccelMs2?: number;
  speedSamples?: number;
  accuracyDriftM?: number;
  [key: string]: number | boolean | undefined;
}

const asNum = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * A braking threshold is a deceleration, so it has to be negative. The Settings page used to clamp
 * every numeric key at 0, and 0 would flag every brake on the road as harsh — so a non-negative
 * stored value falls back to the default instead of being honoured.
 */
const brakingThreshold = (v: unknown): number => {
  const n = asNum(v);
  return n !== undefined && n < 0 ? n : RULE_DEFAULTS.harshBrakingMs2;
};

/**
 * Resolves the "single source of truth" numeric rule thresholds used by the tracking
 * rules engine and the notify alert dispatcher. Kept dependency-light (Prisma only)
 * so it can be shared by NotifyModule and TrackingModule without a cycle.
 */
@Injectable()
export class RulesService {
  private settingsCache: { at: number; value: GlobalOverrides } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** Global overrides stored in the Setting table (key = "rules.global", JSON string). */
  async globalOverrides(): Promise<GlobalOverrides> {
    const now = Date.now();
    // 30s cache so a rules change is picked up without hammering the DB.
    if (this.settingsCache && now - this.settingsCache.at < 30_000) return this.settingsCache.value;
    let value: GlobalOverrides = {};
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: 'rules.global' } });
      value = parseJson<GlobalOverrides>(row?.value, {});
    } catch {
      value = {};
    }
    this.settingsCache = { at: now, value };
    return value;
  }

  /**
   * Drop the in-memory 30s Setting cache so the next ingest/dispatch re-reads
   * `rules.global` from the DB. Call after any write to that Setting (PATCH /settings).
   */
  invalidate(): void {
    this.settingsCache = null;
  }

  /** Resolve numeric thresholds for an employee, honoring per-driver and per-zone overrides. */
  async thresholdsFor(
    employeeId: string,
    cached?: { override?: { maxSpeedKmh?: number | null; stopAlertMin?: number | null; geofenceGraceS?: number | null; speedSamples?: number | null; disabledTypes?: string | null } | null; zoneMaxSpeedKmh?: number | null; zoneStopAlertMin?: number | null },
  ): Promise<EffectiveThresholds> {
    const g = await this.globalOverrides();
    const override =
      cached?.override ??
      (await this.prisma.ruleOverride.findUnique({ where: { employeeId } }).catch(() => null));
    const zone =
      cached?.zoneMaxSpeedKmh !== undefined
        ? { maxSpeedKmh: cached.zoneMaxSpeedKmh, stopAlertMin: cached.zoneStopAlertMin }
        : await this.zoneFor(employeeId);

    const disabledTypes = (override?.disabledTypes ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as AlertType[];

    return {
      maxSpeedKmh:
        asNum(override?.maxSpeedKmh) ??
        asNum(zone?.maxSpeedKmh) ??
        asNum(g.maxSpeedKmh) ??
        RULE_DEFAULTS.maxSpeedKmh,
      stopAlertMin:
        asNum(override?.stopAlertMin) ??
        asNum(zone?.stopAlertMin) ??
        asNum(g.stopAlertMin) ??
        RULE_DEFAULTS.stopAlertMin,
      geofenceGraceS:
        asNum(override?.geofenceGraceS) ?? asNum(g.geofenceGraceS) ?? RULE_DEFAULTS.geofenceGraceS,
      speedSamples:
        asNum(override?.speedSamples) ?? asNum(g.speedSamples) ?? RULE_DEFAULTS.speedSamples,
      speedingCriticalS: asNum(g.speedingCriticalS) ?? RULE_DEFAULTS.speedingCriticalS,
      cooldownS: asNum(g.cooldownS) ?? RULE_DEFAULTS.cooldownS,
      harshBrakingMs2: brakingThreshold(g.harshBrakingMs2),
      harshAccelMs2: asNum(g.harshAccelMs2) ?? RULE_DEFAULTS.harshAccelMs2,
      gapMinMin: asNum(g.gapMinMin) ?? RULE_DEFAULTS.gapMinMin,
      heartbeatIntervalS: asNum(g.heartbeatIntervalS) ?? RULE_DEFAULTS.heartbeatIntervalS,
      heartbeatMissedCycles: RULE_DEFAULTS.heartbeatMissedCycles,
      replayMaxAgeHours: asNum(g.replayMaxAgeHours) ?? RULE_DEFAULTS.replayMaxAgeHours,
      accuracyDriftM: RULE_DEFAULTS.accuracyDriftM,
      speedingHoldS: asNum(g.speedingHoldS) ?? RULE_DEFAULTS.speedingHoldS,
      disabledTypes,
    };
  }

  private async zoneFor(employeeId: string): Promise<{ maxSpeedKmh: number | null; stopAlertMin: number | null; id: string | null; orgUnitId: string | null } | null> {
    const emp = await this.prisma.employee
      .findUnique({ where: { id: employeeId }, include: { zone: true } })
      .catch(() => null);
    if (!emp?.zone) return emp ? { maxSpeedKmh: null, stopAlertMin: null, id: emp.zoneId, orgUnitId: emp.orgUnitId } : null;
    return {
      maxSpeedKmh: emp.zone.maxSpeedKmh,
      stopAlertMin: emp.zone.stopAlertMin,
      id: emp.zone.id,
      orgUnitId: emp.zone.orgUnitId,
    };
  }

  /** Full per-employee context used by ingest + alert dispatch (single round of queries). */
  async context(employeeId: string): Promise<EmployeeContext | null> {
    const emp = await this.prisma.employee
      .findUnique({
        where: { id: employeeId },
        include: { user: true, zone: true, site: true, rule: true },
      })
      .catch(() => null);
    if (!emp) return null;

    const zoneFence: FenceShape | null = emp.zone
      ? {
          id: emp.zone.id,
          name: emp.zone.name,
          lat: emp.zone.lat,
          lng: emp.zone.lng,
          radiusM: emp.zone.radiusM,
          polygon: emp.zone.polygon,
        }
      : null;

    // PLANNED stops are those inside the employee's own site (if any) — else any active site fence.
    const siteFences: FenceShape[] = emp.site
      ? [
          {
            id: emp.site.id,
            name: emp.site.name,
            lat: emp.site.lat,
            lng: emp.site.lng,
            radiusM: emp.site.radiusM,
            polygon: emp.site.polygon,
          },
        ]
      : [];

    const thresholds = await this.thresholdsFor(employeeId, {
      override: emp.rule
        ? {
            maxSpeedKmh: emp.rule.maxSpeedKmh,
            stopAlertMin: emp.rule.stopAlertMin,
            geofenceGraceS: emp.rule.geofenceGraceS,
            speedSamples: emp.rule.speedSamples,
            disabledTypes: emp.rule.disabledTypes,
          }
        : null,
      zoneMaxSpeedKmh: emp.zone?.maxSpeedKmh ?? null,
      zoneStopAlertMin: emp.zone?.stopAlertMin ?? null,
    });

    return {
      employeeId: emp.id,
      employeeName: emp.name,
      employeePhone: emp.phone,
      kind: emp.kind,
      userId: emp.user?.id ?? null,
      orgUnitId: emp.orgUnitId ?? emp.zone?.orgUnitId ?? emp.site?.orgUnitId ?? null,
      zoneId: emp.zoneId ?? null,
      siteId: emp.siteId ?? null,
      zoneFence,
      siteFences,
      thresholds,
    };
  }

  /** true when the alert type is disabled for this employee (RuleOverride.disabledTypes). */
  isDisabled(thresholds: EffectiveThresholds, type: AlertType): boolean {
    return thresholds.disabledTypes.includes(type);
  }
}
