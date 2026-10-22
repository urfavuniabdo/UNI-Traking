import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { ROLES } from '../../shared/constants';
import {
  SettingsService,
  type NotificationLogEntryDto,
  type RulesPayload,
  type SettingsEnvelope,
} from './settings.service';

/**
 * HTTP surface for the dashboard Settings page.
 *  GET   /settings          ADMIN+SUPERVISOR → { rules, timezone, notifications, preferences }
 *  PATCH /settings          ADMIN only       → upsert rules.global, invalidate RulesService cache
 *  GET   /notifications/log ADMIN+SUPERVISOR → { log: NotificationLogEntry[] }
 */
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('settings')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  getSettings(@CurrentUser() user: AuthUser): Promise<SettingsEnvelope> {
    return this.settings.getSettingsEnvelope(user);
  }

  @Patch('settings')
  @Roles(ROLES.ADMIN)
  patchSettings(@Body() body: Record<string, unknown>): Promise<RulesPayload> {
    return this.settings.patchRules(body);
  }

  @Get('notifications/log')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  notificationsLog(): Promise<{ log: NotificationLogEntryDto[] }> {
    return this.settings.getNotificationLog().then((log) => ({ log }));
  }
}
