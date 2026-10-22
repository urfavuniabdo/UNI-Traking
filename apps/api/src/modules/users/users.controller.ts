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
import { UsersService } from './users.service';
import { CreateUserDto, ListUsersQueryDto, ResetPasswordDto, UpdateUserDto } from './dto';
import { JwtAuthGuard, RolesGuard, Roles } from '../../common/auth/guards';
import { ROLES } from '../../shared/constants';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(ROLES.ADMIN)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get()
  list(@Query() q: ListUsersQueryDto) {
    return this.users.list(q);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.users.one(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string) {
    return this.users.setDisabled(id, true);
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string) {
    return this.users.setDisabled(id, false);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto) {
    return this.users.resetPassword(id, dto.newPassword);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}
