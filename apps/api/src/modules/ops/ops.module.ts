import { Module } from '@nestjs/common';
import { TrackingModule } from '../tracking/tracking.module';
import { OpsResetController } from './ops-reset.controller';
import { OpsResetService } from './ops-reset.service';

// Ops tooling that has to run inside the service because the free Render plan offers no Shell.
@Module({
  imports: [TrackingModule],
  controllers: [OpsResetController],
  providers: [OpsResetService],
})
export class OpsModule {}
