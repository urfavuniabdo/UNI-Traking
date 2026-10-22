import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { EMPLOYEE_KIND } from '../../shared/constants';

export class CreateEmployeeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  externalId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @IsNotEmpty()
  phone!: string; // normalized to E.164 in the service; required

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  jobTitle?: string | null;

  @IsOptional()
  @IsEnum(EMPLOYEE_KIND)
  kind?: keyof typeof EMPLOYEE_KIND;

  @IsOptional()
  @IsString()
  orgUnitId?: string | null;

  @IsOptional()
  @IsString()
  siteId?: string | null;

  @IsOptional()
  @IsString()
  zoneId?: string | null;
}

export class UpdateEmployeeDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string | null;
  @IsOptional() @IsString() jobTitle?: string | null;
  @IsOptional() @IsEnum(EMPLOYEE_KIND) kind?: keyof typeof EMPLOYEE_KIND;
  @IsOptional() @IsString() orgUnitId?: string | null;
  @IsOptional() @IsString() siteId?: string | null;
  @IsOptional() @IsString() zoneId?: string | null;
  @IsOptional() @IsString() externalId?: string;
}

export class AssignSiteDto {
  @IsOptional()
  @IsString()
  siteId?: string | null;
}

export class AssignZoneDto {
  @IsOptional()
  @IsString()
  zoneId?: string | null;
}

export class RuleOverrideDto {
  @IsOptional() @IsNumber() maxSpeedKmh?: number | null;
  @IsOptional() @IsNumber() stopAlertMin?: number | null;
  @IsOptional() @IsNumber() geofenceGraceS?: number | null;
  @IsOptional() @IsNumber() speedSamples?: number | null;
  @IsOptional() @IsString() disabledTypes?: string | null;
  /** Reassign the employee's zone in the same call (DriverDetail page edits it alongside the rules). */
  @IsOptional() @IsString() zoneId?: string | null;
}

export class ListEmployeesQueryDto {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(EMPLOYEE_KIND) kind?: keyof typeof EMPLOYEE_KIND;
  /** Dashboard alias for `kind` — Drivers/Live pages send `role=DRIVER`. */
  @IsOptional() @IsIn(Object.values(EMPLOYEE_KIND)) role?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() active?: boolean;
}
