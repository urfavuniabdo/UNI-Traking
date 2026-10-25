import { Body, Controller, Get, HttpCode, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto, RefreshDto } from './dto';
import { Public, JwtAuthGuard } from '../../common/auth/guards';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthUser } from '../../common/auth/jwt.strategy';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(LoginRateLimitGuard)
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.identifier, dto.password);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    if (!dto.refreshToken) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    return this.auth.refresh(dto.refreshToken);
  }

  // Public because the app signs out locally before the request goes out: its access token may
  // already be gone or expired. The refresh token is the proof of ownership — AuthService
  // verifies its signature and revokes exactly that session row.
  @Public()
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser() user: AuthUser | undefined, @Body() dto: RefreshDto) {
    if (dto?.refreshToken) return this.auth.logout(dto.refreshToken);
    if (user?.id) return this.auth.logout(undefined, user.id);
    throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }
}
