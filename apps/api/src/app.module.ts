import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { PrismaModule } from './common/prisma.module';
import { GeoModule } from './common/geo/geo.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { PlacesModule } from './modules/places/places.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { LeaveModule } from './modules/leave/leave.module';
import { DevicesModule } from './modules/devices/devices.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { RulesModule } from './modules/rules/rules.module';
import { NotifyModule } from './modules/notify/notify.module';
import { SyncModule } from './modules/sync/sync.module';
import { ReportsModule } from './modules/reports/reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env', '../../../.env'],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    GeoModule,
    AuthModule,
    UsersModule,
    EmployeesModule,
    PlacesModule,
    AttendanceModule,
    LeaveModule,
    DevicesModule,
    TrackingModule,
    RulesModule,
    NotifyModule,
    SyncModule,
    ReportsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
