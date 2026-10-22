import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService, presenceOf } from './devices.service';

@Module({
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService, presenceOf],
})
export class DevicesModule {}
