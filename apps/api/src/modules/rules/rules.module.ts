import { Global, Module } from '@nestjs/common';
import { RulesService } from './rules.service';

// Rules engine threshold resolution (RuleOverride → Zone → Setting → RULE_DEFAULTS).
// Global so both TrackingModule (evaluator) and NotifyModule (cooldown) share one source.
@Global()
@Module({
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
