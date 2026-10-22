import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PlacesService } from './places.service';
import {
  CreateOrgUnitDto,
  CreateSiteDto,
  CreateZoneDto,
  UpdateOrgUnitDto,
  UpdateSiteDto,
  UpdateZoneDto,
} from './dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { ROLES } from '../../shared/constants';

@Controller('places')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  // ---- reads: ADMIN + SUPERVISOR ----
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('org-tree')
  orgTree() {
    return this.places.orgTree();
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('fences')
  fences() {
    return this.places.fences();
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('sites')
  sites(@Query('active') active?: string) {
    return this.places.listSites(active === 'true');
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('sites/:id')
  site(@Param('id') id: string) {
    return this.places.getSite(id);
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('zones')
  zones(@Query('active') active?: string) {
    return this.places.listZones(active === 'true');
  }

  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  @Get('zones/:id')
  zone(@Param('id') id: string) {
    return this.places.getZone(id);
  }

  // ---- debug endpoint (ADMIN) ----
  @Roles(ROLES.ADMIN)
  @Get('geofence-check')
  geofenceCheck(@Query('lat') lat: string, @Query('lng') lng: string, @Query('forUserId') forUserId?: string) {
    return this.places.geofenceCheck(Number(lat), Number(lng), forUserId);
  }

  // ---- writes: ADMIN only (CONTRACT §1) ----
  @Roles(ROLES.ADMIN)
  @Post('org-units')
  createOrg(@Body() dto: CreateOrgUnitDto) {
    return this.places.createOrgUnit(dto);
  }

  @Roles(ROLES.ADMIN)
  @Patch('org-units/:id')
  updateOrg(@Param('id') id: string, @Body() dto: UpdateOrgUnitDto) {
    return this.places.updateOrgUnit(id, dto);
  }

  @Roles(ROLES.ADMIN)
  @Delete('org-units/:id')
  deleteOrg(@Param('id') id: string) {
    return this.places.deleteOrgUnit(id);
  }

  @Roles(ROLES.ADMIN)
  @Post('sites')
  createSite(@Body() dto: CreateSiteDto, @CurrentUser() user: AuthUser) {
    return this.places.createSite(dto, { scopeOrgUnitId: user?.scopeOrgUnitId ?? null });
  }

  @Roles(ROLES.ADMIN)
  @Patch('sites/:id')
  updateSite(@Param('id') id: string, @Body() dto: UpdateSiteDto) {
    return this.places.updateSite(id, dto);
  }

  @Roles(ROLES.ADMIN)
  @Delete('sites/:id')
  deleteSite(@Param('id') id: string) {
    return this.places.deleteSite(id);
  }

  @Roles(ROLES.ADMIN)
  @Post('zones')
  createZone(@Body() dto: CreateZoneDto, @CurrentUser() user: AuthUser) {
    return this.places.createZone(dto, { scopeOrgUnitId: user?.scopeOrgUnitId ?? null });
  }

  @Roles(ROLES.ADMIN)
  @Patch('zones/:id')
  updateZone(@Param('id') id: string, @Body() dto: UpdateZoneDto) {
    return this.places.updateZone(id, dto);
  }

  @Roles(ROLES.ADMIN)
  @Delete('zones/:id')
  deleteZone(@Param('id') id: string) {
    return this.places.deleteZone(id);
  }
}
