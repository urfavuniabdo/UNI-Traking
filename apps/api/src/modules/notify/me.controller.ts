import { BadRequestException, Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { PrismaService } from '../../common/prisma.service';

// Keys we recognise (unknown keys are still stored so other modules can extend prefs).
const KNOWN_KEYS = ['push.enabled', 'push.mutedTypes', 'push.quietFrom', 'push.quietTo'];

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('preferences')
  async getPreferences(@CurrentUser() user: AuthUser): Promise<{ preferences: Record<string, string> }> {
    const rows = await this.prisma.userPreference.findMany({ where: { userId: user.id } });
    return { preferences: Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  }

  @Patch('preferences')
  async patchPreferences(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ): Promise<{ preferences: Record<string, string>; knownKeys: string[] }> {
    const input = (body?.preferences && typeof body.preferences === 'object' ? body.preferences : body) as Record<string, unknown>;
    if (!input || typeof input !== 'object') throw new BadRequestException('BAD_BODY');
    const entries = Object.entries(input).filter(([, v]) => v !== undefined);
    for (const [key, value] of entries) {
      const strValue = typeof value === 'string' ? value : JSON.stringify(value);
      await this.prisma.userPreference.upsert({
        where: { userId_key: { userId: user.id, key } },
        create: { userId: user.id, key, value: strValue },
        update: { value: strValue },
      });
    }
    const rows = await this.prisma.userPreference.findMany({ where: { userId: user.id } });
    return { preferences: Object.fromEntries(rows.map((r) => [r.key, r.value])), knownKeys: KNOWN_KEYS };
  }
}
