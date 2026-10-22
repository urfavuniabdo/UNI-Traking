import { Global, Module } from '@nestjs/common';
import { RulesService } from './rules.service';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

// Rules engine threshold resolution (RuleOverride → Zone → Setting → RULE_DEFAULTS).
// Global so both TrackingModule (evaluator) and NotifyModule (cooldown) share one source.
// Also hosts the Settings HTTP surface (GET/PATCH /settings, /notifications/log) because it
// exposes the very `rules.global` Setting store RulesService reads.
@Global()
@Module({
  controllers: [SettingsController],
  providers: [RulesService, SettingsService],
  exports: [RulesService, SettingsService],
})
export class RulesModule {}
