import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SYNC_KINDS } from './sync.types';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class RunSyncDto {
  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsIn(SYNC_KINDS as unknown as string[])
  kind?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  filePath?: string;
}

export class CreateSyncSourceDto {
  @IsString()
  @IsNotEmpty()
  @Matches(CODE_RE, { message: 'BAD_CODE: use letters/digits/dash/underscore' })
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(SYNC_KINDS as unknown as string[])
  kind!: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  scheduleCron?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateSyncSourceDto {
  @IsOptional()
  @Matches(CODE_RE, { message: 'BAD_CODE: use letters/digits/dash/underscore' })
  code?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(SYNC_KINDS as unknown as string[])
  kind?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  scheduleCron?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ToggleSourceDto {
  @IsBoolean()
  enabled!: boolean;
}

export class ListRunsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class ListIssuesDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  resolved?: boolean;
}

export class MatrixDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
