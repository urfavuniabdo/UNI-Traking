import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { LeaveModule } from '../leave/leave.module';

// Reports (CONTRACT §9): daily / route / timesheet / exceptions / mileage (+ ?format=csv) and live-kpis.
@Module({
  imports: [LeaveModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
