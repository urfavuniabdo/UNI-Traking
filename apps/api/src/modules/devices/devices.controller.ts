import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { HeartbeatDto, ListDevicesQueryDto, RegisterDeviceDto, ToggleEventDto } from './dto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { ROLES } from '../../shared/constants';

@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  // ---- self device lifecycle (any authenticated employee/driver) ----
  @HttpCode(200)
  @Post('register')
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(user.id, dto);
  }

  @HttpCode(200)
  @Post('heartbeat')
  heartbeat(@Body() dto: HeartbeatDto) {
    return this.devices.heartbeat(dto);
  }

  @HttpCode(200)
  @Post('toggle-event')
  toggle(@Body() dto: ToggleEventDto) {
    return this.devices.toggleEvent(dto);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.devices.mine(user.id);
  }

  /**
   * «طلب مساعدة طارئة» — held for three seconds on the driver's home screen. Driver-only by
   * contract: an office employee has no field emergency to raise from this app.
   */
  @Roles(ROLES.DRIVER)
  @HttpCode(200)
  @Post('help')
  help(@CurrentUser() user: AuthUser) {
    return this.devices.requestHelp(user.id);
  }

  // ---- admin list ----
  @Roles(ROLES.ADMIN)
  @Get()
  list(@Query() q: ListDevicesQueryDto) {
    return this.devices.list(q);
  }
}
