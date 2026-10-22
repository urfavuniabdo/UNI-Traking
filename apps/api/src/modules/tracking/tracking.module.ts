import { Module } from '@nestjs/common';
import { PositionsService } from './positions.service';
import { MotionClassifierService } from './motion-classifier.service';
import { PositionsController } from './positions.controller';

// Tracking: position ingest, motion classifier, trips/stops/route geometry, live + presence.
// PrismaService, GeoService, RulesService, ALERT_DISPATCHER and REALTIME_PUBLISHER are all
// provided by @Global() modules (Prisma/Geo/Rules/Notify) so they need not be imported here.
@Module({
  controllers: [PositionsController],
  providers: [PositionsService, MotionClassifierService],
  exports: [PositionsService, MotionClassifierService],
})
export class TrackingModule {}
