import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { GEO_EVENT_KINDS } from '../../shared/constants';

const PLATFORMS = ['android', 'ios'] as const;

export class RegisterDeviceDto {
  @IsString() @IsNotEmpty() deviceId!: string;
  @IsIn(PLATFORMS) platform!: (typeof PLATFORMS)[number];
  @IsOptional() @IsString() token?: string; // push token
  @IsOptional() @IsString() appVersion?: string;
}

export class HeartbeatDto {
  @IsString() @IsNotEmpty() deviceId!: string;
  @IsBoolean() tracking!: boolean;
  @IsBoolean() gpsEnabled!: boolean;
  @IsBoolean() online!: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(100) battery?: number;
}

export class ToggleEventDto {
  @IsString() @IsNotEmpty() deviceId!: string;
  @IsIn(GEO_EVENT_KINDS) kind!: (typeof GEO_EVENT_KINDS)[number];
  @IsOptional() @IsNumber() count?: number; // buffered point count for BUFFER_FLUSH
}

export class ListDevicesQueryDto {
  @IsOptional() page?: number;
  @IsOptional() pageSize?: number;
  @IsOptional() @IsString() userId?: string;
}
