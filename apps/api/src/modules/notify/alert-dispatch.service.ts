import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ALERT_DISPATCHER,
  REALTIME_PUBLISHER,
  type AlertDispatcher,
  type RaiseAlertInput,
  type RaisedAlert,
  type RealtimePublisher,
} from '../../common/contracts';
import { PrismaService } from '../../common/prisma.service';
import { cooldownKey, json, parseJson } from '../../common/utils';
import {
  AR_ALERT_TEXT,
  DRIVER_VISIBLE_ALERTS,
  ROLES,
  RULE_DEFAULTS,
  SEVERITY,
  type AlertType,
  type Role,
  type Severity,
} from '../../shared/constants';
import { RulesService, type EffectiveThresholds } from '../rules/rules.service';
import { PushService } from './push.service';

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };

export interface AlertPayload {
  id: string;
  type: string;
  severity: string;
  userId: string | null;
  employeeId: string;
  userName: string;
  phone: string | null;
  orgUnitId: string | null;
  zoneId: string | null;
  siteId: string | null;
  title: string;
  body: string;
  createdAt: string;
  status: string;
  ackBy?: string | null;
  ackAt?: string | null;
  replayed: boolean;
  meta: Record<string, unknown>;
  channel: { push: boolean; socket: boolean };
}

interface Audience {
  subjectUserId: string | null;
  admins: { id: string }[];
  supervisors: { id: string }[];
}

/**
 * The single delivery funnel every rule/attendance/device module must go through so
 * "no event goes unnoticed": cooldown/dedupe → Alert row → Socket `alert:new` → push → logs.
 * Provided under ALERT_DISPATCHER from the @Global() NotifyModule.
 */
@Injectable()
export class AlertDispatchService implements AlertDispatcher {
  private readonly logger = new Logger(AlertDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: RulesService,
    private readonly push: PushService,
    @Optional() @Inject(REALTIME_PUBLISHER) private readonly publisher?: RealtimePublisher,
  ) {}

  async raise(input: RaiseAlertInput): Promise<RaisedAlert | undefined> {
    try {
      const ctx = await this.rules.context(input.employeeId);
      const thresholds: EffectiveThresholds =
        ctx?.thresholds ?? ({ ...RULE_DEFAULTS, disabledTypes: [] } as unknown as EffectiveThresholds);

      // Disabled for this driver (RuleOverride.disabledTypes)?
      if (ctx && this.rules.isDisabled(thresholds, input.type)) {
        return { id: '', type: input.type, severity: input.severity, suppressed: true };
      }

      const key = cooldownKey(input.employeeId, input.type);
      const now = new Date();
      const cooldownMs = (thresholds.cooldownS ?? RULE_DEFAULTS.cooldownS) * 1000;

      // Cooldown / dedupe: suppress the same (employee,type) within the window unless severity escalates or force.
      if (!input.force) {
        const last = await this.prisma.alert.findFirst({
          where: { cooldownKey: key },
          orderBy: { createdAt: 'desc' },
          select: { id: true, severity: true, createdAt: true },
        });
        if (last) {
          const within = now.getTime() - last.createdAt.getTime() < cooldownMs;
          const escalated = SEVERITY_RANK[input.severity] > SEVERITY_RANK[(last.severity as Severity) ?? SEVERITY.INFO];
          if (within && !escalated) {
            return { id: last.id, type: input.type, severity: input.severity, suppressed: true };
          }
        }
      }

      const text = AR_ALERT_TEXT[input.type as AlertType] ?? { title: input.type, body: '' };
      const subjectUserId = input.targetUserId ?? ctx?.userId ?? null;

      const alert = await this.prisma.alert.create({
        data: {
          type: input.type,
          severity: input.severity,
          employeeId: input.employeeId,
          userId: subjectUserId,
          zoneId: input.zoneId ?? ctx?.zoneId ?? null,
          siteId: input.siteId ?? ctx?.siteId ?? null,
          title: input.title ?? text.title,
          body: input.body ?? text.body,
          meta: json(input.meta ?? {}),
          status: 'OPEN',
          replayed: input.replayed ?? false,
          cooldownKey: key,
          createdAt: now,
        },
      });

      const audience = await this.computeAudience(subjectUserId, ctx?.orgUnitId ?? null);
      const payload: AlertPayload = await this.toPayload(alert, ctx?.employeeName ?? '', ctx?.employeePhone ?? null, ctx?.orgUnitId ?? null);

      // 1) realtime (fire-and-forget — publisher must never throw into business code)
      try {
        this.publisher?.alert(payload, {
          userIds: subjectUserId ? [subjectUserId] : [],
          roles: [ROLES.ADMIN as Role, ROLES.SUPERVISOR as Role],
        });
      } catch (err) {
        this.logger.warn(`socket emit failed: ${(err as Error)?.message}`);
      }
      await this.logSocketDelivery(alert.id, subjectUserId, audience, payload);

      // 2) push — to every audience device; to the subject only if driver-visible.
      const driverVisible = (DRIVER_VISIBLE_ALERTS as readonly string[]).includes(input.type);
      const pushUserIds = [
        ...audience.admins.map((a) => a.id),
        ...audience.supervisors.map((s) => s.id),
        ...(subjectUserId && driverVisible ? [subjectUserId] : []),
      ];
      const tokens = await this.push.targetsFor(pushUserIds);
      let pushLogged = false;
      if (tokens.length) {
        const data = {
          title: payload.title,
          body: payload.body,
          alertId: alert.id,
          alertType: alert.type,
          severity: alert.severity,
        };
        for (const t of tokens) {
          await this.prisma.notificationLog.create({
            data: {
              alertId: alert.id,
              userId: t.userId,
              channel: 'PUSH',
              target: t.token,
              status: 'PENDING',
              payload: json(data),
            },
          });
        }
        pushLogged = true;
        // fire-and-forget the actual send; the retry sweep heals failures.
        void this.push.deliver(alert.id, data).catch((e) => this.logger.warn(`push deliver: ${(e as Error)?.message}`));
      }

      void pushLogged;
      return { id: alert.id, type: input.type, severity: input.severity, suppressed: false };
    } catch (err) {
      // Never let alerting crash the ingest path.
      this.logger.error(`alert dispatch failed (${input.type}): ${(err as Error)?.message}`);
      return undefined;
    }
  }

  /** Full AlertPayload used by the socket emit and the REST API. */
  async toPayload(
    alert: {
      id: string; type: string; severity: string; employeeId: string; userId: string | null;
      zoneId: string | null; siteId: string | null; title: string; body: string; meta: string;
      status: string; ackById: string | null; ackAt: Date | null; replayed: boolean; createdAt: Date;
    },
    employeeName = '',
    phone: string | null = null,
    orgUnitId: string | null = null,
  ): Promise<AlertPayload> {
    if (!employeeName) {
      const emp = await this.prisma.employee.findUnique({ where: { id: alert.employeeId }, select: { name: true, phone: true, orgUnitId: true } });
      employeeName = emp?.name ?? '';
      phone = emp?.phone ?? null;
      orgUnitId = emp?.orgUnitId ?? null;
    }
    const pushCount = await this.prisma.notificationLog
      .count({ where: { alertId: alert.id, channel: 'PUSH', status: 'SENT' } })
      .catch(() => 0);
    return {
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      userId: alert.userId,
      employeeId: alert.employeeId,
      userName: employeeName,
      phone,
      orgUnitId,
      zoneId: alert.zoneId,
      siteId: alert.siteId,
      title: alert.title,
      body: alert.body,
      createdAt: alert.createdAt.toISOString(),
      status: alert.status,
      ackBy: alert.ackById,
      ackAt: alert.ackAt ? alert.ackAt.toISOString() : null,
      replayed: alert.replayed,
      meta: parseJson<Record<string, unknown>>(alert.meta, {}),
      channel: { push: pushCount > 0, socket: true },
    };
  }

  private async computeAudience(subjectUserId: string | null, orgUnitId: string | null): Promise<Audience> {
    const admins = await this.prisma.user
      .findMany({ where: { role: ROLES.ADMIN, disabled: false }, select: { id: true } })
      .catch(() => [] as { id: string }[]);

    const sups = await this.prisma.user
      .findMany({ where: { role: ROLES.SUPERVISOR, disabled: false }, select: { id: true, scopeOrgUnitId: true } })
      .catch(() => [] as { id: string; scopeOrgUnitId: string | null }[]);

    let ancestors: Set<string> | null = null;
    if (orgUnitId) ancestors = await this.ancestorSet(orgUnitId);

    const supervisors = sups
      .filter((s) => {
        // no scope → sees everything; scope must be an ancestor-or-self of the employee's org unit
        if (!s.scopeOrgUnitId) return true;
        if (!ancestors) return true;
        return ancestors.has(s.scopeOrgUnitId);
      })
      .map((s) => ({ id: s.id }));

    return { subjectUserId, admins, supervisors };
  }

  /** Walk OrgUnit.parentId upward collecting the chain (self → root). */
  private async ancestorSet(orgUnitId: string): Promise<Set<string>> {
    const set = new Set<string>();
    let cursor: string | null = orgUnitId;
    let guard = 0;
    while (cursor && guard++ < 32) {
      set.add(cursor);
      const node = await this.prisma.orgUnit.findUnique({ where: { id: cursor }, select: { parentId: true } }).catch(() => null);
      cursor = node?.parentId ?? null;
    }
    return set;
  }

  private async logSocketDelivery(alertId: string, subjectUserId: string | null, audience: Audience, payload: AlertPayload): Promise<void> {
    const userIds = new Set<string>();
    if (subjectUserId) userIds.add(subjectUserId);
    for (const a of audience.admins) userIds.add(a.id);
    for (const s of audience.supervisors) userIds.add(s.id);
    for (const uid of userIds) {
      await this.prisma.notificationLog
        .create({
          data: {
            alertId,
            userId: uid,
            channel: 'SOCKET',
            target: uid,
            status: this.publisher ? 'SENT' : 'NO_PROVIDER',
            payload: json({ type: payload.type, severity: payload.severity }),
          },
        })
        .catch(() => undefined);
    }
  }
}

export { SEVERITY_RANK };
