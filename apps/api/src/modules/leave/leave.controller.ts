import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { LEAVE_STATUS, ROLES } from '../../shared/constants';
import { CreateLeaveDto, LeaveDecisionDto, ListLeaveQueryDto } from './dto';
import { LeaveService } from './leave.service';

/**
 * Leave requests.
 *  POST   /leave                 any employee/driver — ask for a range
 *  GET    /leave/mine            own requests (+ pendingCount)
 *  PATCH  /leave/:id/cancel      own, only while PENDING
 *  GET    /leave                 HR + IT admin queue
 *  POST   /leave/:id/approve     HR + IT admin
 *  POST   /leave/:id/reject      HR + IT admin
 */
@Controller('leave')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @HttpCode(201)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeaveDto) {
    return this.leave.create(user, dto);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query() q: ListLeaveQueryDto) {
    return this.leave.mine(user, q);
  }

  @Roles(ROLES.HR, ROLES.ADMIN)
  @Get()
  list(@Query() q: ListLeaveQueryDto) {
    return this.leave.list(q);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.leave.cancel(id, user);
  }

  @Roles(ROLES.HR, ROLES.ADMIN)
  @HttpCode(200)
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: LeaveDecisionDto) {
    return this.leave.decide(id, LEAVE_STATUS.APPROVED, user, dto?.note);
  }

  @Roles(ROLES.HR, ROLES.ADMIN)
  @HttpCode(200)
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser() user: AuthUser, @Body() dto: LeaveDecisionDto) {
    return this.leave.decide(id, LEAVE_STATUS.REJECTED, user, dto?.note);
  }
}
