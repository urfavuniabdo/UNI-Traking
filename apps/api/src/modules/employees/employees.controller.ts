import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { EmployeesService } from './employees.service';
import {
  AssignSiteDto,
  AssignZoneDto,
  CreateEmployeeDto,
  ListEmployeesQueryDto,
  RuleOverrideDto,
  UpdateEmployeeDto,
} from './dto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { ROLES } from '../../shared/constants';

@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  // ---- reads: ADMIN + SUPERVISOR ----
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('live')
  live(
    @Query('kind') kind?: string,
    @Query('siteId') siteId?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    return this.employees.live({ kind, siteId, zoneId });
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get()
  list(@Query() q: ListEmployeesQueryDto) {
    return this.employees.list(q);
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get(':id')
  one(@Param('id') id: string) {
    return this.employees.one(id);
  }

  // Supervisor needs these too: the Drivers/Live/DriverDetail pages are a supervising role's job.
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get(':id/devices')
  devices(@Param('id') id: string) {
    return this.employees.devicesOf(id);
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get(':id/summary')
  summary(@Param('id') id: string) {
    return this.employees.summaryOf(id);
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get(':id/rules')
  getRules(@Param('id') id: string) {
    return this.employees.getRules(id);
  }

  // ---- writes: ADMIN only ----
  @Roles(ROLES.ADMIN)
  @Post()
  create(@Body() dto: CreateEmployeeDto) {
    return this.employees.create(dto);
  }

  @Roles(ROLES.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(id, dto);
  }

  @Roles(ROLES.ADMIN)
  @Post(':id/assign-site')
  @HttpCode(200)
  assignSite(@Param('id') id: string, @Body() dto: AssignSiteDto) {
    return this.employees.assignSite(id, dto.siteId ?? null);
  }

  @Roles(ROLES.ADMIN)
  @Post(':id/assign-zone')
  @HttpCode(200)
  assignZone(@Param('id') id: string, @Body() dto: AssignZoneDto) {
    return this.employees.assignZone(id, dto.zoneId ?? null);
  }

  @Roles(ROLES.ADMIN)
  @Patch(':id/rules')
  upsertRules(@Param('id') id: string, @Body() dto: RuleOverrideDto) {
    return this.employees.upsertRules(id, dto);
  }

  @Roles(ROLES.ADMIN)
  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string) {
    return this.employees.setDisabled(id, false);
  }

  @Roles(ROLES.ADMIN)
  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string) {
    return this.employees.setDisabled(id, true);
  }
}
