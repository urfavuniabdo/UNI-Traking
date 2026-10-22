import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Only the dashboard-side accounts are manageable through /users (CONTRACT §1). */
export const MANAGEABLE_ROLES = ['ADMIN', 'SUPERVISOR', 'HR'] as const;
export type ManageableRole = (typeof MANAGEABLE_ROLES)[number];

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  identifier!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsEnum(MANAGEABLE_ROLES)
  role!: ManageableRole;

  @IsOptional()
  @IsString()
  scopeOrgUnitId?: string | null;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsEnum(MANAGEABLE_ROLES)
  role?: ManageableRole;

  @IsOptional()
  @IsString()
  scopeOrgUnitId?: string | null;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class ListUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  pageSize?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(MANAGEABLE_ROLES)
  role?: ManageableRole;
}
