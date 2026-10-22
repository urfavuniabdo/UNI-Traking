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

/** POST /auth/refresh */
export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
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
