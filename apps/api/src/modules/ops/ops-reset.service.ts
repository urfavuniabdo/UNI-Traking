import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { PositionsService } from '../tracking/positions.service';

/** What POST /ops/reset-data must say, so a mistyped call cannot delete anything. */
export const RESET_CONFIRM = 'RESET-OPS-DATA';

/**
 * Operational history, children before parents: Position and StopEvent point at Trip, CallLog and
 * NotificationLog point at Alert, so deleting a parent first would break the foreign key.
 */
const OPS_TABLES = [
  'CallLog',
  'NotificationLog',
  'Alert',
  'GeoEvent',
  'RouteLine',
  'StopEvent',
  'Position',
  'Trip',
  'AttendanceRecord',
  'LeaveRequest',
  'SyncIssue',
  'SyncRun',
] as const;

export type OpsTable = (typeof OPS_TABLES)[number];

/** Everything the board is built from — wipe these and the test would need re-registration and re-drawn zones. */
const KEPT_TABLES = [
  'OrgUnit',
  'Site',
  'Zone',
  'Employee',
  'User',
  'Device',
  'RuleOverride',
  'Setting',
  'SyncSource',
  'ShiftSchedule',
  'ShiftAssignment',
  'UserPreference',
] as const;

type OpsClient = Pick<
  Prisma.TransactionClient,
  | 'callLog'
  | 'notificationLog'
  | 'alert'
  | 'geoEvent'
  | 'routeLine'
  | 'stopEvent'
  | 'position'
  | 'trip'
  | 'attendanceRecord'
  | 'leaveRequest'
  | 'syncIssue'
  | 'syncRun'
  | 'orgUnit'
  | 'site'
  | 'zone'
  | 'employee'
  | 'user'
  | 'device'
  | 'ruleOverride'
  | 'setting'
  | 'syncSource'
  | 'shiftSchedule'
  | 'shiftAssignment'
  | 'userPreference'
>;

type Writer = { count(): Promise<number>; deleteMany(): Promise<{ count: number }> };

export interface ResetPlan {
  apply: false;
  wouldDelete: Record<OpsTable, number>;
  total: number;
  /** Only when the caller asked for `includeFences` — the drawn fences the apply will remove. */
  fences?: { Zone: number; Site: number };
}

export interface ResetResult {
  apply: true;
  deleted: Record<OpsTable, number>;
  total: number;
  remaining: number;
  kept: Record<(typeof KEPT_TABLES)[number], number>;
  fencesDeleted?: { Zone: number; Site: number };
}

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * Clears the operational history from inside the running service. Render's free plan has neither Shell
 * nor one-off jobs, so this is the only place a wipe can run with the app's own DATABASE_URL.
 */
@Injectable()
export class OpsResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly positions: PositionsService,
  ) {}

  private ops(client: OpsClient): Record<OpsTable, Writer> {
    return {
      CallLog: client.callLog,
      NotificationLog: client.notificationLog,
      Alert: client.alert,
      GeoEvent: client.geoEvent,
      RouteLine: client.routeLine,
      StopEvent: client.stopEvent,
      Position: client.position,
      Trip: client.trip,
      AttendanceRecord: client.attendanceRecord,
      LeaveRequest: client.leaveRequest,
      SyncIssue: client.syncIssue,
      SyncRun: client.syncRun,
    };
  }

  private kept(client: OpsClient): Record<(typeof KEPT_TABLES)[number], Writer> {
    return {
      OrgUnit: client.orgUnit,
      Site: client.site,
      Zone: client.zone,
      Employee: client.employee,
      User: client.user,
      Device: client.device,
      RuleOverride: client.ruleOverride,
      Setting: client.setting,
      SyncSource: client.syncSource,
      ShiftSchedule: client.shiftSchedule,
      ShiftAssignment: client.shiftAssignment,
      UserPreference: client.userPreference,
    };
  }

  private async counts(client: OpsClient): Promise<Record<OpsTable, number>> {
    const w = this.ops(client);
    const out = {} as Record<OpsTable, number>;
    for (const t of OPS_TABLES) out[t] = await w[t].count();
    return out;
  }

  /** The numbers `apply: true` will report, without touching a row. */
  async plan(): Promise<ResetPlan> {
    const wouldDelete = await this.counts(this.prisma);
    return { apply: false, wouldDelete, total: sum(wouldDelete) };
  }

  /**
   * One transaction, deletes in FK order, then drops the in-memory track/live state so the live board
   * empties instead of replaying wiped positions out of RAM.
   */
  async reset(input: { apply?: unknown; confirm?: unknown; includeFences?: unknown }): Promise<ResetPlan | ResetResult> {
    const wantFences = input?.includeFences === true;
    if (input?.apply !== true) {
      const plan = await this.plan();
      return wantFences
        ? { ...plan, fences: { Zone: await this.prisma.zone.count(), Site: await this.prisma.site.count() } }
        : plan;
    }
    if (input.confirm !== RESET_CONFIRM) {
      throw new BadRequestException(`CONFIRM_REQUIRED: send { "confirm": "${RESET_CONFIRM}" }`);
    }

    const before = await this.counts(this.prisma);
    const deleted = {} as Record<OpsTable, number>;
    await this.prisma.$transaction(async (tx) => {
      const w = this.ops(tx);
      for (const t of OPS_TABLES) deleted[t] = (await w[t].deleteMany()).count;
    });

    let fencesDeleted: ResetResult['fencesDeleted'];
    if (wantFences) {
      fencesDeleted = await this.prisma.$transaction(async (tx) => {
        // Each employee holds a foreign key on his zone and his site, so the links go before the rows.
        await tx.employee.updateMany({ where: { zoneId: { not: null } }, data: { zoneId: null } });
        await tx.employee.updateMany({ where: { siteId: { not: null } }, data: { siteId: null } });
        return { Zone: (await tx.zone.deleteMany()).count, Site: (await tx.site.deleteMany()).count };
      });
    }

    for (const { id } of await this.prisma.employee.findMany({ select: { id: true } })) {
      this.positions.clearTrack(id);
    }

    const remaining = await this.counts(this.prisma);
    const keptClient = this.kept(this.prisma);
    const kept = {} as ResetResult['kept'];
    for (const t of KEPT_TABLES) kept[t] = await keptClient[t].count();

    return { apply: true, deleted, total: sum(before), remaining: sum(remaining), kept, ...(fencesDeleted ? { fencesDeleted } : {}) };
  }
}
