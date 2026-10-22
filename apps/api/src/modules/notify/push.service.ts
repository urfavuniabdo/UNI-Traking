import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma.service';
import { parseJson } from '../../common/utils';

// Imported lazily as types only so the app boots even without firebase credentials.
import type { Messaging, Message } from 'firebase-admin/messaging';

const PUSH_RETRY_MAX = Number(process.env.PUSH_RETRY_MAX ?? 3);
const BACKOFF_BASE_S = 15; // exponential: 15s, 30s, 60s ...

export interface PushDataPayload {
  title: string;
  body: string;
  alertId: string;
  alertType: string;
  severity: string;
  click_action?: string;
  channel_id?: string;
}

/**
 * FCM push delivery. Firebase is initialised ONLY when FCM_CREDENTIALS_JSON is a non-empty,
 * valid service-account JSON. Any failure degrades to NO_PROVIDER and never crashes the app.
 * Failed/PENDING sends are retried by the retry sweep with exponential backoff.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private messaging: Messaging | null = null;
  private initialised = false;

  constructor(private readonly prisma: PrismaService) {}

  private ensureFirebase(): Messaging | null {
    if (this.initialised) return this.messaging;
    this.initialised = true;
    const raw = (process.env.FCM_CREDENTIALS_JSON ?? '').trim();
    if (!raw) {
      this.logger.log('FCM disabled (no FCM_CREDENTIALS_JSON) → pushes recorded as NO_PROVIDER');
      return (this.messaging = null);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const admin = require('firebase-admin');
      const credential = JSON.parse(raw);
      const app = admin.apps?.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(credential) });
      this.messaging = app.messaging();
      this.logger.log('FCM initialised');
    } catch (err) {
      this.logger.warn(`FCM init failed (invalid credentials?) → NO_PROVIDER: ${(err as Error)?.message}`);
      this.messaging = null;
    }
    return this.messaging;
  }

  get available(): boolean {
    return this.ensureFirebase() !== null;
  }

  /** Collect every push token that should receive an alert for the given audience. */
  async targetsFor(userIds: string[]): Promise<{ userId: string; token: string }[]> {
    if (!userIds.length) return [];
    const devices = await this.prisma.device.findMany({
      where: { userId: { in: userIds }, pushToken: { not: null } },
      select: { userId: true, pushToken: true },
    });
    return devices
      .filter((d) => d.userId && d.pushToken)
      .map((d) => ({ userId: d.userId as string, token: d.pushToken as string }));
  }

  /** Respect UserPreference: push.enabled, push.mutedTypes, and quiet hours (Africa/Cairo). */
  async isPushAllowed(userId: string, alertType: string): Promise<boolean> {
    const prefs = await this.prisma.userPreference
      .findMany({ where: { userId } })
      .catch(() => []);
    const map = new Map<string, string>(prefs.map((p) => [p.key, p.value] as [string, string]));
    if ((map.get('push.enabled') ?? 'true') === 'false') return false;
    const muted = parseJson<string[]>(map.get('push.mutedTypes') ?? '[]', []);
    if (Array.isArray(muted) && muted.includes(alertType)) return false;
    const qFrom = map.get('push.quietFrom');
    const qTo = map.get('push.quietTo');
    if (qFrom && qTo) {
      const nowMin = this.minutesOfDayCairo();
      const from = this.hhmmToMin(qFrom);
      const to = this.hhmmToMin(qTo);
      if (from != null && to != null) {
        const inQuiet = from <= to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to;
        if (inQuiet && alertType !== 'GEOFENCE_EXIT' && alertType !== 'STOP_EXCEEDED') return false;
      }
    }
    return true;
  }

  private minutesOfDayCairo(): number {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: process.env.DASHBOARD_TIMEZONE || 'Africa/Cairo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date());
      const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
      return h * 60 + m;
    } catch {
      return new Date().getUTCHours() * 60;
    }
  }

  private hhmmToMin(v: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /** Attempt delivery for one set of already-logged PENDING push rows attached to an alert. */
  async deliver(alertId: string, data: PushDataPayload): Promise<void> {
    const rows = await this.prisma.notificationLog.findMany({
      where: { alertId, channel: 'PUSH', status: 'PENDING' },
    });
    if (!rows.length) return;

    if (!this.ensureFirebase()) {
      await this.markBatch(rows.map((r) => r.id), 'NO_PROVIDER', null, 'FCM not configured');
      return;
    }

    // Group by userId to apply per-user preferences/muting.
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) {
      const uid = r.userId ?? '';
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push(r);
    }

    const messaging = this.messaging!;
    for (const [uid, group] of byUser) {
      const allowed = uid ? await this.isPushAllowed(uid, data.alertType) : true;
      const sendable = allowed ? group : [];
      if (!allowed) {
        await this.markBatch(group.map((r) => r.id), 'NO_PROVIDER', null, 'Push suppressed by user preference');
        continue;
      }
      const messages: Message[] = sendable.map((r) => ({
        token: r.target,
        notification: { title: data.title, body: data.body },
        data: {
          ...data,
          click_action: data.click_action ?? 'FLUTTER_NOTIFICATION_CLICK',
          channel_id: 'traccer_alerts',
        } as Record<string, string>,
      }));
      if (!messages.length) continue;
      try {
        const res = await messaging.sendEach(messages);
        for (let i = 0; i < sendable.length; i++) {
          const ok = res.responses[i]?.success;
          const failure = res.responses[i]?.error;
          if (ok) await this.markOne(sendable[i].id, 'SENT', undefined, true);
          else await this.markOne(sendable[i].id, 'FAILED', failure?.message ?? 'FCM_UNAVAILABLE', false);
        }
      } catch (err) {
        await this.markBatch(sendable.map((r) => r.id), 'FAILED', null, (err as Error).message);
      }
    }
  }

  /** Retry sweep: resend FAILED/PENDING push rows with exponential backoff, up to PUSH_RETRY_MAX. */
  @Interval(60_000)
  async retrySweep(): Promise<void> {
    if (!this.ensureFirebase()) return;
    const candidates = await this.prisma.notificationLog.findMany({
      where: { channel: 'PUSH', status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: PUSH_RETRY_MAX } },
      orderBy: { updatedAt: 'asc' },
      take: 100,
    }).catch(() => []);
    const now = Date.now();
    const due = candidates.filter((c) => {
      const wait = BACKOFF_BASE_S * 2 ** c.attempts * 1000;
      return now - c.updatedAt.getTime() >= wait;
    });
    for (const row of due) {
      if (row.attempts + 1 >= PUSH_RETRY_MAX) {
        await this.markOne(row.id, 'FAILED', 'EXHAUSTED_RETRIES', false, true);
        continue;
      }
      try {
        const payload = parseJson<PushDataPayload>(row.payload, { title: '', body: '', alertId: row.alertId ?? '', alertType: '', severity: 'INFO' });
        const res = await this.messaging!.send({
          token: row.target,
          notification: { title: payload.title, body: payload.body },
          data: { ...payload, click_action: 'FLUTTER_NOTIFICATION_CLICK', channel_id: 'traccer_alerts' } as Record<string, string>,
        });
        await this.markOne(row.id, 'SENT', undefined, true);
        void res;
      } catch (err) {
        await this.markOne(row.id, 'FAILED', (err as Error).message, false, true);
      }
    }
  }

  private async markOne(id: string, status: string, error: string | null | undefined, bumpAttempt: boolean, forceBump = false): Promise<void> {
    const row = await this.prisma.notificationLog.findUnique({ where: { id }, select: { attempts: true } });
    const attempts = (row?.attempts ?? 0) + (bumpAttempt || forceBump ? 1 : 0);
    await this.prisma.notificationLog.update({
      where: { id },
      data: { status, error: error ?? null, attempts: bumpAttempt || forceBump ? attempts : undefined },
    });
  }

  private async markBatch(ids: string[], status: string, attemptsTo: number | null, error: string | null): Promise<void> {
    if (!ids.length) return;
    await this.prisma.notificationLog.updateMany({
      where: { id: { in: ids } },
      data: { status, error, ...(attemptsTo != null ? { attempts: attemptsTo } : {}) },
    });
  }
}
