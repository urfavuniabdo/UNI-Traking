import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateOrgUnitDto {
  @IsString() @IsNotEmpty() @MaxLength(60) code!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsString() parentId?: string | null;
}

export class UpdateOrgUnitDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() parentId?: string | null;
}

/** Shared geofence geometry: circle (lat/lng/radiusM) and/or polygon override [[lat,lng],...]. */
export class FenceGeometryDto {
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
  @IsOptional() @IsInt() @Min(1) radiusM?: number;
  @IsOptional() @IsString() polygon?: string | null; // JSON array of [lat,lng]
}

export class CreateSiteDto extends FenceGeometryDto {
  @IsString() @IsNotEmpty() @MaxLength(60) code!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsNotEmpty() orgUnitId!: string;
  @IsOptional() @IsBoolean() strictReject?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateSiteDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsInt() @Min(1) radiusM?: number;
  @IsOptional() @IsString() polygon?: string | null;
  @IsOptional() @IsBoolean() strictReject?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateZoneDto extends FenceGeometryDto {
  @IsString() @IsNotEmpty() @MaxLength(60) code!: string;
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsNotEmpty() orgUnitId!: string;
  @IsOptional() @IsNumber() maxSpeedKmh?: number | null;
  @IsOptional() @IsInt() stopAlertMin?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateZoneDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsInt() @Min(1) radiusM?: number;
  @IsOptional() @IsString() polygon?: string | null;
  @IsOptional() @IsNumber() maxSpeedKmh?: number | null;
  @IsOptional() @IsInt() stopAlertMin?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
