import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma.service';
import { cronDueWithin } from './cron.util';
import { SyncService } from './sync.service';

/**
 * جدول ديناميكي لكل مصدر: نبضة كل دقيقة تفحص «هل حان موعد أي مصدر؟»
 * (scheduleCron الخاص به أو SYNC_CRON افتراضيًا) — أبسط وأسهل اختبارًا من
 * تسجيل/إلغاء cron jobs وقت التشغيل. التداخل محكوم بمانع SKIPPED_OVERLAP في SyncService.
 */
@Injectable()
export class SyncScheduler {
  private readonly logger = new Logger(SyncScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: SyncService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(now = new Date()): Promise<void> {
    if (String(process.env.SYNC_SCHEDULER_DISABLED ?? '') === 'true') return;
    const sources = await this.prisma.syncSource.findMany({ where: { enabled: true } });
    const defaultCron = process.env.SYNC_CRON || '0 */15 * * * *';
    for (const source of sources) {
      const expr = source.scheduleCron?.trim() || defaultCron;
      if (!cronDueWithin(expr, now, 60_000)) continue;
      // لا نعيد تشغيل مصدر لم يكتمل تشغيله بعد — lastRunAt داخل نفس النافذة
      if (source.lastRunAt && now.getTime() - source.lastRunAt.getTime() < 60_000) continue;
      try {
        const res = await this.sync.startRun({ sourceId: source.id }, 'CRON');
        if (!res.skippedOverlap) this.logger.log(`cron started run ${res.runId} for source ${source.code}`);
      } catch (e) {
        this.logger.error(`cron start failed for ${source.code}: ${String((e as Error).message ?? e)}`);
      }
    }
  }
}
