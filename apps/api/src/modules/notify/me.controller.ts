import { Body, Controller, Get, Inject, Optional, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { PrismaService } from '../../common/prisma.service';
import { REALTIME_PUBLISHER, type RealtimePublisher } from '../../common/contracts';
import { flatPatchToRows, prefsFromRows, type FlatPrefs } from '../rules/preferences.mapper';

// Keys we recognise (unknown keys are still stored so other modules can extend prefs).
const KNOWN_KEYS = ['push.enabled', 'push.mutedTypes', 'push.quietFrom', 'push.quietTo'];

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(REALTIME_PUBLISHER) private readonly publisher?: RealtimePublisher,
  ) {}

  /** Flat shape the Settings page reads: { push, whatsapp, email, sound, types }. */
  @Get('preferences')
  async getPreferences(@CurrentUser() user: AuthUser): Promise<FlatPrefs> {
    const rows = await this.prisma.userPreference.findMany({ where: { userId: user.id } });
    return prefsFromRows(rows);
  }

  /** Accept a partial flat body, persist into the existing string-keyed columns, ping notify:me. */
  @Patch('preferences')
  async patchPreferences(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ): Promise<FlatPrefs> {
    const input = (body ?? {}) as Record<string, unknown>;
    const rowsToWrite = flatPatchToRows(input);
    for (const [key, value] of Object.entries(rowsToWrite)) {
      await this.prisma.userPreference.upsert({
        where: { userId_key: { userId: user.id, key } },
        create: { userId: user.id, key, value },
        update: { value },
      });
    }
    const rows = await this.prisma.userPreference.findMany({ where: { userId: user.id } });
    // Save confirmation the dashboard listens for (mirrors the mock's busEmit('notify:me', …)).
    this.publisherNotifyMe(user.id);
    return prefsFromRows(rows);
  }

  /** Expose the recognised preference keys (kept for parity with the previous response). */
  @Get('preferences/keys')
  preferenceKeys(): { knownKeys: string[] } {
    return { knownKeys: KNOWN_KEYS };
  }

  private publisherNotifyMe(userId: string): void {
    const pub = this.publisher as unknown as
      | { publish?: (event: string, payload: unknown, rooms: string[]) => void }
      | undefined;
    pub?.publish?.('notify:me', { title: 'تم تحديث التفضيلات', body: '', alertType: 'INFO' }, [`user:${userId}`]);
  }
}
