import { Global, Module } from '@nestjs/common';
import { GeoService } from './geo.service';
import { TraceService } from './trace.service';

@Global()
@Module({ providers: [GeoService, TraceService], exports: [GeoService, TraceService] })
export class GeoModule {}
