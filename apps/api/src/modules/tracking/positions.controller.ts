import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '../../common/auth/guards';
import { PositionsService } from './positions.service';
import type { PositionBatchDto } from './dto';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  /** POST /positions/batch — CONTRACT §4. The only position entry point (driver JWT). */
  @Post('positions/batch')
  async batch(@Body() body: PositionBatchDto): Promise<unknown> {
    if (!body?.deviceId) throw new BadRequestException('DEVICE_ID_REQUIRED');
    return this.positions.ingestBatch(body);
  }

  @Get('positions/route')
  route(@Query('userId') userId: string, @Query('date') date: string): Promise<unknown> {
    if (!userId || !date) throw new BadRequestException('USERID_AND_DATE_REQUIRED');
    return this.positions.route(userId, date);
  }

  @Get('positions/live')
  @Roles('ADMIN', 'SUPERVISOR')
  live(@Query('since') since?: string): Promise<unknown> {
    return this.positions.liveSnapshot(since);
  }

  @Get('trips')
  trips(@Query('userId') userId: string, @Query('from') from?: string, @Query('to') to?: string): Promise<unknown> {
    if (!userId) throw new BadRequestException('USERID_REQUIRED');
    return this.positions.trips(userId, from, to);
  }

  @Get('drivers/presence')
  @Roles('ADMIN', 'SUPERVISOR')
  presence(): Promise<unknown> {
    return this.positions.presence();
  }
}
