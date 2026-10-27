import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ROLES, RULE_DEFAULTS, type AlertType } from '../../shared/constants';
import { PrismaService } from '../../common/prisma.service';
import { parseJson } from '../../common/utils';
import { RulesService, type GlobalOverrides } from './rules.service';
import { prefsFromRows, type FlatPrefs } from './preferences.mapper';

const RULES_KEY = 'rules.global';
const LOG_LIMIT = 200;

/** Numeric rule keys the Settings page edits — canonical RULE_DEFAULTS names. */
export const NUMERIC_RULE_KEYS = [
  'maxSpeedKmh',
  'stopAlertMin',
  'stopRepeatMin',
  'geofenceGraceS',
  'speedingCriticalS',
  'cooldownS',
  'gapMinMin',
  'shiftGraceMin',
  'replayMaxAgeHours',
  'harshBrakingMs2',
  'harshAccelMs2',
  'speedSamples',
  'accuracyDriftM',
] as const;

export type NumericRuleKey = (typeof NUMERIC_RULE_KEYS)[number];

/** Harsh braking is a deceleration, so its threshold is negative — clamping it to 0 would make
 *  every brake read as harsh once the page is saved. */
const NEGATIVE_ALLOWED: readonly NumericRuleKey[] = ['harshBrakingMs2'];

/** What an HR admin may change in `rules.global` — attendance policy only, never tracking thresholds. */
export const HR_RULE_KEYS = ['shiftGraceMin', 'attendanceStrictReject'] as const;

/** The `rules` object served by GET/PATCH /settings. */
export type RulesPayload = Record<NumericRuleKey, number> & { attendanceStrictReject: boolean };

export type NotifChannel = 'push' | 'whatsapp' | 'socket' | 'sms' | 'email';
export type NotifStatus = 'SENT' | 'FAILED' | 'PENDING' | 'NO_PROVIDER';

/** Mapped row matching `apps/dashboard/src/api/types.ts::NotificationLogEntry`. */
export interface NotificationLogEntryDto {
  id: string;
  alertId: string | null;
  alertType: AlertType;
  channel: NotifChannel;
  userId: string;
  userName: string;
  status: NotifStatus;
  attempts: number;
  at: string;
  error: string | null;
  /** Masked push target (last 4 only) — the raw token is never returned. */
  masked: string;
}

export interface SettingsEnvelope {
  rules: RulesPayload;
  timezone: string;
  notifications: NotificationLogEntryDto[];
  preferences: FlatPrefs;
}

/** A caller-shaped user (`role` decides the HR key allowlist; matches AuthUser). */
export interface SettingsUser {
  id: string;
  role?: string;
}

const asFiniteNumber = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Never leak a raw push token — keep the last 4, mask the rest. */
export const maskToken = (token: string | null | undefined): string => {
  const s = token ?? '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
};

const normalizeChannel = (c: string): NotifChannel => {
  switch (c.toLowerCase()) {
    case 'push':
      return 'push';
    case 'whatsapp':
      return 'whatsapp';
    case 'email':
      return 'email';
    case 'sms':
      return 'sms';
    default:
      return 'socket';
  }
};

/**
 * HTTP face for the dashboard Settings page: exposes the `rules.global` Setting store
 * (read by RulesService), the notification delivery log, and the caller's flat prefs.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: RulesService,
  ) {}

  private async readStored(): Promise<GlobalOverrides> {
    const row = await this.prisma.setting.findUnique({ where: { key: RULES_KEY } }).catch(() => null);
    return parseJson<GlobalOverrides>(row?.value, {});
  }

  /** RULE_DEFAULTS merged with the stored `rules.global` overrides + the strict-reject boolean. */
  private mergeRules(stored: GlobalOverrides): RulesPayload {
    const defaults = RULE_DEFAULTS as unknown as Record<string, number>;
    const nums = {} as Record<NumericRuleKey, number>;
    for (const key of NUMERIC_RULE_KEYS) {
      nums[key] = asFiniteNumber(stored[key]) ?? defaults[key];
    }
    return { ...nums, attendanceStrictReject: stored.attendanceStrictReject === true };
  }

  async getRules(): Promise<RulesPayload> {
    return this.mergeRules(await this.readStored());
  }

  /**
   * Merge an incoming PATCH into `rules.global`, validate numeric keys, clamp negatives,
   * persist, and drop the RulesService cache so the next ingest sees the new values.
   *
   * HR is limited to the attendance keys (CONTRACT §1); every other key is a 403, so a
   * stolen HR session cannot retune speed or geofence thresholds.
   */
  async patchRules(input: Record<string, unknown> | null | undefined, user: SettingsUser): Promise<RulesPayload> {
    const body = input ?? {};
    const source = (
      body.rules && typeof body.rules === 'object' ? body.rules : body
    ) as Record<string, unknown>;

    if (user.role === ROLES.HR) {
      const forbidden = Object.keys(source).filter((k) => !(HR_RULE_KEYS as readonly string[]).includes(k));
      if (forbidden.length) throw new ForbiddenException('FORBIDDEN_SETTING_KEY');
    }

    const storedBefore = await this.readStored();
    const merged = this.mergeRules(storedBefore);

    for (const key of NUMERIC_RULE_KEYS) {
      if (!(key in source)) continue;
      const n = asFiniteNumber(source[key]);
      if (n === undefined) throw new BadRequestException('BAD_RULE_VALUE');
      merged[key] = NEGATIVE_ALLOWED.includes(key) ? n : Math.max(0, n);
    }
    if ('attendanceStrictReject' in source) {
      const v = source.attendanceStrictReject;
      if (typeof v !== 'boolean') throw new BadRequestException('BAD_RULE_VALUE');
      merged.attendanceStrictReject = v;
    }

    const toStore: GlobalOverrides = { ...storedBefore };
    for (const key of NUMERIC_RULE_KEYS) toStore[key] = merged[key];
    toStore.attendanceStrictReject = merged.attendanceStrictReject;

    const value = JSON.stringify(toStore);
    await this.prisma.setting.upsert({
      where: { key: RULES_KEY },
      create: { key: RULES_KEY, value },
      update: { value },
    });
    this.rules.invalidate();
    return merged;
  }

  /** Recent NotificationLog rows → dashboard shape (newest first, capped). */
  async getNotificationLog(): Promise<NotificationLogEntryDto[]> {
    const rows = await this.prisma.notificationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: LOG_LIMIT,
      include: { alert: { select: { type: true } } },
    });

    const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return rows.map((r) => {
      const payload = parseJson<{ type?: string }>(r.payload, {});
      const alertType = (r.alert?.type ?? payload.type ?? 'APP_OFFLINE') as AlertType;
      return {
        id: r.id,
        alertId: r.alertId ?? null,
        alertType,
        channel: normalizeChannel(r.channel),
        userId: r.userId ?? '',
        userName: (r.userId ? nameById.get(r.userId) : undefined) ?? r.userId ?? '',
        status: r.status as NotifStatus,
        attempts: r.attempts ?? 0,
        at: r.createdAt.toISOString(),
        error: r.error ?? null,
        masked: maskToken(r.target),
      };
    });
  }

  /** The full envelope GET /settings returns. The delivery log is tracking traffic, so HR gets an empty list. */
  async getSettingsEnvelope(user: SettingsUser): Promise<SettingsEnvelope> {
    const hr = user.role === ROLES.HR;
    const [rules, prefRows, notifications] = await Promise.all([
      this.getRules(),
      this.prisma.userPreference.findMany({ where: { userId: user.id } }),
      hr ? Promise.resolve([] as NotificationLogEntryDto[]) : this.getNotificationLog(),
    ]);
    return {
      rules,
      timezone: process.env.DASHBOARD_TIMEZONE || 'Africa/Cairo',
      notifications,
      preferences: prefsFromRows(prefRows),
    };
  }
}
