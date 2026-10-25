import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '../../common/auth/guards';
import { ROLES } from '../../shared/constants';
import { OpsResetService, type ResetPlan, type ResetResult } from './ops-reset.service';

@Controller('ops')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OpsResetController {
  constructor(private readonly ops: OpsResetService) {}

  /**
   * ADMIN + SUPERVISOR because Render's free plan gives the service neither a Shell nor a one-off job,
   * so there is no way to run a script against the database at all — the wipe has to be reachable over
   * HTTP. `apply: true` additionally needs the literal confirm phrase, and a call without it only previews.
   */
  @Post('reset-data')
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @HttpCode(200)
  reset(@Body() body: { apply?: unknown; confirm?: unknown }): Promise<ResetPlan | ResetResult> {
    return this.ops.reset(body ?? {});
  }
}
