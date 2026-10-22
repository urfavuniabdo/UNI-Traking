import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
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

/** polygon arrives either as a JSON string or as the array the dashboard draws: [[lat,lng],…]. */
@ValidatorConstraint({ name: 'polygonShape', async: false })
class PolygonShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return true; // parsed + re-checked by GeoService in the service
    if (Array.isArray(value)) {
      return value.every(
        (p) => Array.isArray(p) && p.length >= 2 && p.every((c) => Number.isFinite(Number(c))),
      );
    }
    return false;
  }
  defaultMessage(): string {
    return 'POLYGON_INVALID';
  }
}

const PolygonField = () => Validate(PolygonShapeConstraint);

/** Shared geofence geometry: circle (lat/lng/radiusM) and/or polygon override [[lat,lng],...]. */
export class FenceGeometryDto {
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
  @IsOptional() @IsInt() @Min(1) radiusM?: number;
  @IsOptional() @PolygonField() polygon?: string | number[][] | null; // canonical orientation [[lat,lng]] (CONTRACT §places)
}

export class CreateSiteDto extends FenceGeometryDto {
  @IsOptional() @IsString() @MaxLength(60) code?: string; // auto-generated as `S-<slug>` when absent
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsString() orgUnitId?: string; // falls back to the caller's scope, then the root OrgUnit
  @IsOptional() @IsBoolean() strictReject?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateSiteDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsInt() @Min(1) radiusM?: number;
  @IsOptional() @PolygonField() polygon?: string | number[][] | null;
  @IsOptional() @IsBoolean() strictReject?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CreateZoneDto extends FenceGeometryDto {
  @IsOptional() @IsString() @MaxLength(60) code?: string; // auto-generated as `Z-<slug>` when absent
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsOptional() @IsString() orgUnitId?: string; // falls back to the caller's scope, then the root OrgUnit
  @IsOptional() @IsNumber() maxSpeedKmh?: number | null;
  @IsOptional() @IsInt() stopAlertMin?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(['CIRCLE', 'POLYGON']) shape?: 'CIRCLE' | 'POLYGON'; // informational — derived from polygon presence
  /** No Zone.strictReject column (schema frozen) — persisted via the Setting table in PlacesService. */
  @IsOptional() @IsBoolean() strictReject?: boolean;
}

export class UpdateZoneDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(60) code?: string;
  @IsOptional() @IsString() orgUnitId?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsInt() @Min(1) radiusM?: number;
  @IsOptional() @PolygonField() polygon?: string | number[][] | null;
  @IsOptional() @IsNumber() maxSpeedKmh?: number | null;
  @IsOptional() @IsInt() stopAlertMin?: number | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(['CIRCLE', 'POLYGON']) shape?: 'CIRCLE' | 'POLYGON';
  /** No Zone.strictReject column (schema frozen) — persisted via the Setting table in PlacesService. */
  @IsOptional() @IsBoolean() strictReject?: boolean;
}
