import { Body, Controller, Get, Header, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
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

  // ---- management reads ----
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="attendance.csv"')
  async export(@Query() q: AttendanceQueryDto) {
    return this.attendance.exportCsv(q);
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get()
  list(@Query() q: AttendanceQueryDto) {
    return this.attendance.list(q);
  }
}
