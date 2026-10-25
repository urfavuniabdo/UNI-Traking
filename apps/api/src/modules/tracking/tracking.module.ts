import { Module } from '@nestjs/common';
import { PositionsService } from './positions.service';
import { MotionClassifierService } from './motion-classifier.service';
import { PositionsController } from './positions.controller';
import { TRIP_CLOSER } from '../../common/contracts';

// Tracking: position ingest, motion classifier, trips/stops/route geometry, live + presence.
// PrismaService, GeoService, RulesService, ALERT_DISPATCHER and REALTIME_PUBLISHER are all
// provided by @Global() modules (Prisma/Geo/Rules/Notify) so they need not be imported here.
// TRIP_CLOSER is the same PositionsService behind an interface, so devices can end a journey
// without importing tracking's class (and its module graph) directly.
@Module({
  controllers: [PositionsController],
  providers: [PositionsService, MotionClassifierService, { provide: TRIP_CLOSER, useExisting: PositionsService }],
  exports: [PositionsService, MotionClassifierService, TRIP_CLOSER],
})
export class TrackingModule {}
