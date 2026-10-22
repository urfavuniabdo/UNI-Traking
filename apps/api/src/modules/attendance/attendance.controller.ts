import { Body, Controller, Get, Header, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AttendanceService } from './attendance.service';
import { AttendanceQueryDto, CheckDto } from './dto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { ROLES } from '../../shared/constants';

@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  // ---- self actions (any authenticated employee/driver) ----
  @HttpCode(200)
  @Post('check-in')
  checkIn(@CurrentUser() user: AuthUser, @Body() dto: CheckDto) {
    return this.attendance.checkIn(user.id, dto);
  }

  @HttpCode(200)
  @Post('check-out')
  checkOut(@CurrentUser() user: AuthUser, @Body() dto: CheckDto) {
    return this.attendance.checkOut(user.id, dto);
  }

  @Get('me/today')
  meToday(@CurrentUser() user: AuthUser) {
    return this.attendance.meToday(user.id);
  }

  @Get('me/history')
  meHistory(@CurrentUser() user: AuthUser, @Query() q: AttendanceQueryDto) {
    return this.attendance.meHistory(user.id, q);
  }

  // ---- management reads (ADMIN + tracking admin + HR) ----
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HR)
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="attendance.csv"')
  async export(@Query() q: AttendanceQueryDto) {
    return this.attendance.exportCsv(q);
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HR)
  @Get()
  async list(@Query() q: AttendanceQueryDto, @Res({ passthrough: true }) res: Response) {
    // ?format=csv → raw CSV text (dashboard downloadCsv() reads res.text() in real mode);
    // same payload /attendance/export serves.
    if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendance${q.from ? `-${q.from}` : ''}.csv"`);
      return this.attendance.exportCsv(q);
    }
    return this.attendance.list(q);
  }
}
