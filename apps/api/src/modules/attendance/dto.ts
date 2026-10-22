import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** POST /attendance/check-in | /check-out (CONTRACT §3). */
export class CheckDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsNumber()
  accuracy?: number;

  @IsOptional()
  @IsString()
  deviceId?: string;
}

/** GET /attendance (ADMIN/SUPERVISOR filters). */
export class AttendanceQueryDto {
  @IsOptional() @IsString() from?: string; // YYYY-MM-DD
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() siteId?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() status?: string;
  /** 'csv' → GET /attendance returns raw CSV text (dashboard downloadCsv reads res.text()). */
  @IsOptional() @IsString() format?: string;
  @IsOptional() @Type(() => Number) page?: number;
  @IsOptional() @Type(() => Number) pageSize?: number;
}
