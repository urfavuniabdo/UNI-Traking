import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { ALERT_DISPATCHER } from '../../common/contracts';
import type { AlertDispatcher } from '../../common/contracts';
import { normalizePhone, parseJson } from '../../common/utils';
import { EMPLOYEE_KIND, ROLES } from '../../shared/constants';
import { AdapterRegistry } from './adapters/adapter.registry';
import {
  AdapterConfig,
  RunCounts,
  SourceConfigError,
  SyncRow,
  SyncTrigger,
} from './sync.types';
import { CsvSyncAdapter } from './adapters/csv.adapter';
import { resolveSyncFilePath } from './upload.util';

interface RunAccumulator {
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  noPhone: number;
  issues: number;
  seen: Set<string>;
}

const SEEN_KEY = (sourceId: string): string => `sync:seen:${sourceId}`;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdapterRegistry,
    @Inject(ALERT_DISPATCHER) @Optional() private readonly dispatcher?: AlertDispatcher,
  ) {
    void this.dispatcher; // متاحة للتوسعة (تنبيه المشرفين عند فشل مزامنة) — تُتحمّل بأمان عند الغياب
  }

  // ---------- triggers ----------

  /** يبدأ تشغيلًا غير متزامن ويُعيد runId فورًا. مانع التداخل: تشغيل RUNNING بنفس المصدر ⇒ SKIPPED_OVERLAP. */
  async startRun(
    input: { sourceId?: string; kind?: string; config?: AdapterConfig; filePath?: string },
    trigger: SyncTrigger,
  ): Promise<{ runId: string; status: string; skippedOverlap?: boolean }> {
    const source = await this.resolveSource(input);
    const running = await this.prisma.syncRun.findFirst({
      where: { sourceId: source.id, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
    });
    if (running) {
      await this.prisma.syncIssue.create({
        data: {
          runId: running.id,
          externalId: '-',
          reason: 'SKIPPED_OVERLAP',
          detail: `${trigger} trigger skipped because a run is already RUNNING for source ${source.code}`,
        },
      });
      return { runId: running.id, status: 'RUNNING', skippedOverlap: true };
    }
    const run = await this.prisma.syncRun.create({ data: { sourceId: source.id, trigger } });
    // async fire-and-forget — الحالة تُقفل في executeRun دائمًا
    void this.executeRun(run.id).catch((e) => this.logger.error(`sync run ${run.id} crashed: ${String(e)}`));
    return { runId: run.id, status: 'RUNNING' };
  }

  /** تشغيل متزامن (يُستخدم في الاختبارات وللمجدول بعد قرار الموعد). */
  async executeRun(runId: string): Promise<void> {
    const run = await this.prisma.syncRun.findUnique({ where: { id: runId }, include: { source: true } });
    if (!run) throw new NotFoundException(`SYNC_RUN_NOT_FOUND: ${runId}`);
    const source = run.source;
    const acc: RunAccumulator = {
      scanned: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      noPhone: 0,
      issues: 0,
      seen: new Set(),
    };
    let rows: SyncRow[];
    try {
      const config = parseJson<AdapterConfig>(source.config, {});
      rows = await this.adapters.get(source.kind).fetch(config);
    } catch (e) {
      const code = e instanceof SourceConfigError ? e.code : 'FETCH_FAILED';
      await this.prisma.syncRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: `${code}: ${(e as Error).message}`.slice(0, 900),
        },
      });
      return;
    }

    acc.scanned = rows.length;
    for (const row of rows) {
      try {
        await this.applyRow(runId, row, acc);
      } catch (e) {
        acc.issues += 1;
        await this.prisma.syncIssue.create({
          data: {
            runId,
            externalId: row.externalId || '-',
            reason: 'ROW_FAILED',
            detail: String((e as Error)?.message ?? e).slice(0, 500),
          },
        });
      }
    }
    await this.deactivateMissing(runId, source.id, acc);
    // عدد المشاكل النهائي من قاعدة البيانات — يشمل كل مسار (phone/site/collision/row-failed)
    acc.issues = await this.prisma.syncIssue.count({ where: { runId } });
    await this.prisma.setting.upsert({
      where: { key: SEEN_KEY(source.id) },
      update: { value: JSON.stringify([...acc.seen]) },
      create: { key: SEEN_KEY(source.id), value: JSON.stringify([...acc.seen]) },
    });

    const status = acc.issues > 0 ? 'PARTIAL' : 'SUCCESS';
    await this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        scanned: acc.scanned,
        created: acc.created,
        updated: acc.updated,
        unchanged: acc.unchanged,
        deactivated: acc.deactivated,
        error: acc.noPhone > 0 ? `noPhone=${acc.noPhone}` : null,
      },
    });
    await this.prisma.syncSource.update({ where: { id: source.id }, data: { lastRunAt: new Date() } });
  }

  // ---------- row application (CONTRACT §8 upsert) ----------

  private async addIssue(runId: string, externalId: string, reason: string, detail?: string): Promise<void> {
    await this.prisma.syncIssue.create({
      data: { runId, externalId: externalId || '-', reason, detail: detail?.slice(0, 500) },
    });
  }

  private async applyRow(runId: string, row: SyncRow, acc: RunAccumulator): Promise<void> {
    const externalId = String(row.externalId ?? '').trim();
    if (!externalId) {
      await this.addIssue(runId, '-', 'MISSING_EXTERNAL_ID', 'row has no externalId — skipped entirely');
      return;
    }
    if (acc.seen.has(externalId)) {
      await this.addIssue(runId, externalId, 'DUPLICATE', 'same externalId twice in one source batch — first wins');
      return;
    }
    acc.seen.add(externalId);

    const name = String(row.name ?? '').trim() || externalId;

    // Phone إلزامي للتنبيهات/واتساب — النقص يذهب لـ SyncIssue بدل الفشل الصامت
    const phone = normalizePhone(row.phoneE164);
    if (!phone) {
      acc.noPhone += 1;
      await this.addIssue(runId, externalId, 'MISSING_PHONE', `raw phone: "${row.phoneE164 ?? ''}"`);
    }

    let kind: string = EMPLOYEE_KIND.EMPLOYEE;
    const hint = String(row.roleHint ?? '').trim().toUpperCase();
    if (hint === EMPLOYEE_KIND.DRIVER) kind = EMPLOYEE_KIND.DRIVER;
    else if (hint && hint !== EMPLOYEE_KIND.EMPLOYEE) {
      await this.addIssue(runId, externalId, 'BAD_ROLE', `roleHint "${row.roleHint}" defaulted to EMPLOYEE`);
    }

    // OrgUnit: resolve/create — السجل الوحيد الذي يمكن إنشاؤه بأمان من الكود فقط
    let orgUnitId: string | null = null;
    const orgCode = String(row.orgUnit ?? '').trim();
    if (orgCode) {
      orgUnitId = await this.prisma.orgUnit
        .upsert({
          where: { code: orgCode },
          update: {},
          create: { code: orgCode, name: orgCode },
        })
        .then((u) => u.id);
    }

    // Site/Zone: أكواد مجهولة ⇒ SyncIssue والصف يُزامن بلا تعيين (لا إنشاء — إحداثيات مجهولة)
    let siteId: string | null = null;
    const siteCode = String(row.siteCode ?? '').trim();
    if (siteCode) {
      const site = await this.prisma.site.findUnique({ where: { code: siteCode } });
      if (site) siteId = site.id;
      else await this.addIssue(runId, externalId, 'UNKNOWN_SITE', `site code "${siteCode}" not found — synced without site`);
    }
    let zoneId: string | null = null;
    const zoneCode = String(row.zoneCode ?? '').trim();
    if (zoneCode) {
      const zone = await this.prisma.zone.findUnique({ where: { code: zoneCode } });
      if (zone) zoneId = zone.id;
      else await this.addIssue(runId, externalId, 'UNKNOWN_ZONE', `zone code "${zoneCode}" not found — synced without zone`);
    }

    const active = row.active ?? true;
    const now = new Date();
    const existing = await this.prisma.employee.findUnique({ where: { externalId } });

    if (!existing) {
      const emp = await this.prisma.employee.create({
        data: {
          externalId,
          name,
          phone: phone ?? '',
          kind,
          active,
          source: 'MASTER',
          orgUnitId,
          siteId,
          zoneId,
          syncedAt: now,
        },
      });
      acc.created += 1;
      // CONTRACT §8: لا يُنشأ حساب بدون هاتف صحيح (واتساب/طوارئ) — MISSING_PHONE سُجّل أعلاه
      if (phone) await this.ensureUser(runId, emp.id, externalId, name, kind);
      return;
    }

    // رقم غير صالح لا يُمسح به رقمٌ صالح موجود (hence phone===null ⇒ إبقاء القديم)
    const changed =
      (phone !== null && phone !== existing.phone) ||
      name !== existing.name ||
      kind !== existing.kind ||
      active !== existing.active ||
      orgUnitId !== (existing.orgUnitId ?? null) ||
      siteId !== (existing.siteId ?? null) ||
      zoneId !== (existing.zoneId ?? null);

    if (changed) {
      await this.prisma.employee.update({
        where: { id: existing.id },
        data: {
          name,
          // رقم موجود صالح لا يُمسح بسبب مصدر أرسل رقمًا مكسورًا
          phone: phone ?? existing.phone,
          kind,
          active,
          orgUnitId,
          siteId,
          zoneId,
          syncedAt: now,
          // ملاحظة: passwordHash الخاص بالمستخدم لا يُمس أبدًا هنا — التحديث للملف الوظيفي فقط
        },
      });
      acc.updated += 1;
    } else {
      await this.prisma.employee.update({ where: { id: existing.id }, data: { syncedAt: now } });
      acc.unchanged += 1;
    }
  }

  /** حساب لكل موظف جديد — بلا اختطاف تسجيل دخول موجود. */
  private async ensureUser(
    runId: string,
    employeeId: string,
    externalId: string,
    name: string,
    kind: string,
  ): Promise<void> {
    const initPassword = process.env.ADMIN_INIT_PASSWORD;
    if (!initPassword) {
      await this.addIssue(runId, externalId, 'NO_INIT_PASSWORD', 'ADMIN_INIT_PASSWORD not set — account skipped');
      return;
    }
    const byIdentifier = await this.prisma.user.findUnique({ where: { identifier: externalId } });
    if (byIdentifier) {
      if (byIdentifier.employeeId === employeeId) return; // مربوط صحيحًا
      await this.addIssue(
        runId,
        externalId,
        'IDENTIFIER_COLLISION',
        `User ${byIdentifier.id} already uses identifier "${externalId}" (employeeId=${byIdentifier.employeeId ?? 'none'}) — account NOT created, existing user untouched`,
      );
      return;
    }
    const byEmployee = await this.prisma.user.findFirst({ where: { employeeId } });
    if (byEmployee) return; // موجود مسبقًا لموظف أُعيد إنشاؤه بشكل غير متوقع — لا اللف ولا السرقة
    const role = kind === EMPLOYEE_KIND.DRIVER ? ROLES.DRIVER : ROLES.EMPLOYEE;
    await this.prisma.user.create({
      data: {
        identifier: externalId,
        passwordHash: await bcrypt.hash(initPassword, 10),
        role,
        name,
        employeeId,
        mustChangePassword: true,
      },
    });
  }

  /**
   * الاختفاء من المصدر = تعطيل لا حذف: attendance/positions/alerts تبقى سليمة.
   * النطاق: فقط صفوف MASTER التي رآها هذا المصدر نفسه آخر مرة (Setting seen-set) —
   * حتى لا يعطّل مصدرٌ صفوفَ مصدر آخر.
   */
  private async deactivateMissing(runId: string, sourceId: string, acc: RunAccumulator): Promise<void> {
    const setting = await this.prisma.setting.findUnique({ where: { key: SEEN_KEY(sourceId) } });
    if (!setting) return; // أول تشغيل للمصدر — لا شيء معروف مسبقًا
    let previous: string[] = [];
    try {
      previous = JSON.parse(setting.value) as string[];
    } catch {
      return;
    }
    for (const externalId of previous) {
      if (acc.seen.has(externalId)) continue;
      const emp = await this.prisma.employee.findUnique({ where: { externalId } });
      if (!emp || emp.source !== 'MASTER' || !emp.active) continue;
      await this.prisma.employee.update({ where: { id: emp.id }, data: { active: false } });
      acc.deactivated += 1;
      await this.addIssue(runId, externalId, 'DEACTIVATED', 'employee disappeared from source — set active:false, never deleted');
    }
  }

  /** مصدر من sourceId، أو ad-hoc من kind/config (يُخزَّن كمصدر معطّل حتى لا يلمسه المجدول). */
  private async resolveSource(input: {
    sourceId?: string;
    kind?: string;
    config?: AdapterConfig;
    filePath?: string;
  }): Promise<{ id: string; code: string }> {
    if (input.sourceId) {
      const found = await this.prisma.syncSource.findUnique({ where: { id: input.sourceId } });
      if (!found) throw new NotFoundException(`SYNC_SOURCE_NOT_FOUND: ${input.sourceId}`);
      return found;
    }
    const kind = String(input.kind ?? '').trim();
    if (!kind) throw new NotFoundException('SYNC_NO_SOURCE: provide sourceId or kind+config');
    const config: AdapterConfig = { ...(input.config ?? {}) };
    if (input.filePath && kind === 'csv') config.filePath = input.filePath;
    const code = `ADHOC-${Date.now()}`;
    const created = await this.prisma.syncSource.create({
      data: { code, name: `Ad-hoc ${kind} run`, kind, config: JSON.stringify(config), enabled: false },
    });
    return created;
  }

  // ---------- reads ----------

  async listRuns(limit = 50): Promise<unknown[]> {
    const runs = await this.prisma.syncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: { source: { select: { id: true, code: true, name: true, kind: true } } },
    });
    return runs;
  }

  /** GET /sync/runs/:id — التشغيل + ملفه + مشاكله + noPhone مشتق من المشاكل. */
  async getRun(id: string): Promise<{
    run: unknown;
    source: unknown;
    counts: RunCounts;
    issues: unknown[];
  }> {
    const run = await this.prisma.syncRun.findUnique({
      where: { id },
      include: { source: true, issues: { orderBy: { id: 'asc' } } },
    });
    if (!run) throw new NotFoundException(`SYNC_RUN_NOT_FOUND: ${id}`);
    const issues = run.issues;
    const counts: RunCounts = {
      scanned: run.scanned,
      created: run.created,
      updated: run.updated,
      unchanged: run.unchanged,
      deactivated: run.deactivated,
      noPhone: new Set(issues.filter((i) => i.reason === 'MISSING_PHONE').map((i) => i.externalId)).size,
      issues: issues.length,
    };
    const source = { ...run.source };
    delete (source as { config?: string }).config; // السر لا يسرّب في تفاصيل التشغيل
    return { run: { ...run, source: undefined, issues: undefined }, source, counts, issues };
  }

  listIssues(resolved?: boolean) {
    return this.prisma.syncIssue.findMany({
      where: resolved === undefined ? {} : { resolved },
      orderBy: { id: 'desc' },
      take: 500,
    });
  }

  async resolveIssue(id: string): Promise<unknown> {
    const issue = await this.prisma.syncIssue.findUnique({ where: { id } });
    if (!issue) throw new NotFoundException(`SYNC_ISSUE_NOT_FOUND: ${id}`);
    return this.prisma.syncIssue.update({ where: { id }, data: { resolved: true } });
  }

  /** لوحة المتابعة: مدى نضارة مزامنة كل موظف وإمكانية الوصول إليه. */
  async matrix(): Promise<unknown[]> {
    const employees = await this.prisma.employee.findMany({
      where: { source: 'MASTER' },
      include: {
        user: { select: { id: true, mustChangePassword: true } },
        site: { select: { code: true, name: true } },
        zone: { select: { code: true, name: true } },
        orgUnit: { select: { code: true } },
      },
      orderBy: [{ syncedAt: 'desc' }, { externalId: 'asc' }],
    });
    return employees.map((e) => ({
      externalId: e.externalId,
      employeeId: e.id,
      name: e.name,
      kind: e.kind,
      active: e.active,
      source: e.source,
      lastSyncedAt: e.syncedAt,
      hasPhone: !!e.phone,
      phone: e.phone || null,
      siteCode: e.site?.code ?? null,
      zoneCode: e.zone?.code ?? null,
      orgUnitCode: e.orgUnit?.code ?? null,
      hasAccount: !!e.user,
      mustChangePassword: e.user?.mustChangePassword ?? false,
    }));
  }

  // ---------- webhook ----------

  /** مقارنة timing-safe عبر sha256 حتى لا يُسرّب اختلاف الطول المعلومة. */
  static timingSafeCompare(a: string, b: string): boolean {
    const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
    const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
    return timingSafeEqual(ha, hb);
  }

  /**
   * عامّة webhook محمية فقط بـ x-sync-secret:
   * السر = config.secret للمصدر، وإلا SYNC_WEBHOOK_SECRET.
   */
  async verifyWebhook(sourceId: string | undefined, presentedSecret: string | undefined): Promise<{ id: string; code: string }> {
    if (!sourceId) throw new Error('SYNC_NO_SOURCE: ?source=<id> is required');
    const source = await this.prisma.syncSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new NotFoundException(`SYNC_SOURCE_NOT_FOUND: ${sourceId}`);
    const config = parseJson<AdapterConfig>(source.config, {});
    const expected = String(config.secret ?? process.env.SYNC_WEBHOOK_SECRET ?? '');
    if (!expected) throw new Error('SYNC_NO_SECRET: neither config.secret nor SYNC_WEBHOOK_SECRET is set');
    if (!presentedSecret || !SyncService.timingSafeCompare(presentedSecret, expected)) {
      throw new Error('SYNC_WEBHOOK_UNAUTHORIZED');
    }
    return source;
  }

  // ---------- csv preview (POST /sync/preview-upload) ----------

  /** يقرأ الملف المخزّن ويعيد معاينة مُطبَّعة + مشاكل محتملة — بدون أي كتابة على Employee. */
  previewCsv(filePath: string, limit = 20): {
    filePath: string;
    totalRows: number;
    preview: SyncRow[];
    rowIssues: { row: number; externalId: string; reason: string }[];
  } {
    const resolved = resolveSyncFilePath(filePath);
    const text = readFileSync(resolved, 'utf8');
    const csv = this.adapters.get('csv') as CsvSyncAdapter;
    const rows = csv.parseText(text, resolved);
    const rowIssues: { row: number; externalId: string; reason: string }[] = [];
    rows.forEach((r, i) => {
      if (!r.externalId) rowIssues.push({ row: i + 2, externalId: '-', reason: 'MISSING_EXTERNAL_ID' });
      else if (!normalizePhone(r.phoneE164)) rowIssues.push({ row: i + 2, externalId: r.externalId, reason: 'MISSING_PHONE' });
    });
    return { filePath: resolved, totalRows: rows.length, preview: rows.slice(0, Math.max(1, limit)), rowIssues };
  }
}
