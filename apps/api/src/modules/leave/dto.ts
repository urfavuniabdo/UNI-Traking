import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { LEAVE_STATUS } from '../../shared/constants';

/** Leave days are plain work-day keys (`YYYY-MM-DD`), same shape as `AttendanceRecord.workDate`. */
const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** POST /leave — one request per range; a single day sends `dateFrom` only. */
export class CreateLeaveDto {
  @Matches(WORK_DATE, { message: 'LEAVE_BAD_RANGE' })
  dateFrom!: string;

  @IsOptional()
  @Matches(WORK_DATE, { message: 'LEAVE_BAD_RANGE' })
  dateTo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** GET /leave (HR queue) and GET /leave/mine. */
export class ListLeaveQueryDto {
  @IsOptional() @IsIn(Object.values(LEAVE_STATUS)) status?: string;
  /** Overlap filter: requests whose range touches [from, to]. */
  @IsOptional() @Matches(WORK_DATE, { message: 'LEAVE_BAD_RANGE' }) from?: string;
  @IsOptional() @Matches(WORK_DATE, { message: 'LEAVE_BAD_RANGE' }) to?: string;
  @IsOptional() @Type(() => Number) page?: number;
  @IsOptional() @Type(() => Number) pageSize?: number;
}

/** POST /leave/:id/approve | /reject. */
export class LeaveDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
