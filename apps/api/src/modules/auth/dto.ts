import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/** POST /auth/login — identifier = employee externalId OR email. */
export class LoginDto {
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

/**
 * POST /auth/refresh — token required (the service rejects a missing one).
 * POST /auth/logout  — optional: the dashboard logs out with an empty `{}` body,
 * and AuthService.logout() already tolerates `undefined` (revokes by userId instead).
 */
export class RefreshDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

/** POST /auth/change-password */
export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}
