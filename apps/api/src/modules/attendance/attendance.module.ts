import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { LeaveModule } from '../leave/leave.module';
import { TrackingModule } from '../tracking/tracking.module';

@Module({
  imports: [LeaveModule, TrackingModule],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
