import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { parseJson } from '../../common/utils';
import { SYNC_KINDS, SyncKind } from './sync.types';

const SECRET_KEYS = ['token', 'secret', 'password', 'apiKey', 'accessKey'];

/** يُخفي كلمة المرور المدمجة في connectionString (postgres://user:PASS@host/db). */
const maskConnection = (cs: string): string =>
  String(cs).replace(/(\/\/[^:/@\s]+:)[^@\s]+(@)/, '$1****$2');

@Injectable()
export class SyncSourcesService {
  constructor(private readonly prisma: PrismaService) {}

  /** كل قراءات config تُخرج نسخة مُخفّية — الأسرار الحية لا تغادر الـ API أبدًا. */
  maskConfig(rawConfig: string): string {
    const cfg = parseJson<Record<string, unknown>>(rawConfig, {});
    const masked: Record<string, unknown> = { ...cfg };
    for (const key of SECRET_KEYS) {
      if (masked[key] !== undefined && masked[key] !== null && masked[key] !== '') masked[key] = '****';
    }
    if (typeof masked.connectionString === 'string') masked.connectionString = maskConnection(masked.connectionString);
    return JSON.stringify(masked);
  }

  /**
   * Safe read shape: masked config (as today) + the dashboard's flat fields.
   * The webhook secret is NEVER returned in clear text — `webhookSecret` is a masked
   * placeholder present only when a secret exists, plus `hasSecret` for the UI.
   */
  private toSafe<T extends { id: string; config: string; lastRunAt?: Date | null }>(s: T): T & {
    config: string;
    lastRunAt: string | null;
    hasSecret: boolean;
    webhookSecret: string | null;
  } {
    const cfg = parseJson<Record<string, unknown>>(s.config, {});
    const hasSecret = Boolean(cfg.secret ?? cfg.webhookSecret);
    return {
      ...s,
      config: this.maskConfig(s.config),
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
      hasSecret,
      webhookSecret: hasSecret ? '••••••••' : null,
    };
  }

  async list(): Promise<unknown[]> {
    const sources = await this.prisma.syncSource.findMany({ orderBy: { code: 'asc' } });
    return sources.map((s) => this.toSafe(s));
  }

  async get(id: string): Promise<unknown> {
    const s = await this.prisma.syncSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException(`SYNC_SOURCE_NOT_FOUND: ${id}`);
    return this.toSafe(s);
  }

  async create(dto: {
    code: string;
    name: string;
    kind: SyncKind;
    config?: Record<string, unknown>;
    scheduleCron?: string | null;
    enabled?: boolean;
  }): Promise<unknown> {
    if (!SYNC_KINDS.includes(dto.kind)) throw new ConflictException(`BAD_KIND: ${dto.kind} not in sql|rest|csv`);
    const exists = await this.prisma.syncSource.findUnique({ where: { code: dto.code } });
    if (exists) throw new ConflictException(`SOURCE_CODE_TAKEN: ${dto.code}`);
    const s = await this.prisma.syncSource.create({
      data: {
        code: dto.code,
        name: dto.name,
        kind: dto.kind,
        config: JSON.stringify(dto.config ?? {}),
        scheduleCron: dto.scheduleCron ?? null,
        enabled: dto.enabled ?? true,
      },
    });
    return this.toSafe(s);
  }

  /**
   * تحديث: إذا أرسل العميل config مُخفّية (بها ****) نحافظ على الأسرار الحية القديمة.
   */
  async update(
    id: string,
    dto: Partial<{ code: string; name: string; kind: SyncKind; config: Record<string, unknown>; scheduleCron: string | null; enabled: boolean }>,
  ): Promise<unknown> {
    const current = await this.prisma.syncSource.findUnique({ where: { id } });
    if (!current) throw new NotFoundException(`SYNC_SOURCE_NOT_FOUND: ${id}`);
    let configJson = current.config;
    if (dto.config !== undefined) {
      const incoming = dto.config;
      const live = parseJson<Record<string, unknown>>(current.config, {});
      for (const key of SECRET_KEYS) {
        if (incoming[key] === '****' && live[key] !== undefined) incoming[key] = live[key];
      }
      if (typeof incoming.connectionString === 'string' && incoming.connectionString.includes('****')) {
        incoming.connectionString = (live.connectionString as string) ?? incoming.connectionString;
      }
      configJson = JSON.stringify(incoming);
    }
    const code = dto.code && dto.code !== current.code ? await this.assertFreeCode(dto.code) : dto.code ?? current.code;
    const s = await this.prisma.syncSource.update({
      where: { id },
      data: {
        code,
        name: dto.name ?? current.name,
        kind: dto.kind ?? current.kind,
        config: configJson,
        scheduleCron: dto.scheduleCron === undefined ? current.scheduleCron : dto.scheduleCron,
        enabled: dto.enabled ?? current.enabled,
      },
    });
    return this.toSafe(s);
  }

  async toggle(id: string, enabled: boolean): Promise<unknown> {
    const s = await this.prisma.syncSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException(`SYNC_SOURCE_NOT_FOUND: ${id}`);
    return this.toSafe(await this.prisma.syncSource.update({ where: { id }, data: { enabled } }));
  }

  private async assertFreeCode(code: string): Promise<string> {
    const exists = await this.prisma.syncSource.findUnique({ where: { code } });
    if (exists) throw new ConflictException(`SOURCE_CODE_TAKEN: ${code}`);
    return code;
  }
}
