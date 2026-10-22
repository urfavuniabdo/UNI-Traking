import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma.module';
import { HTTP_FETCHER } from './sync.types';
import { NodeHttpFetcher } from './adapters/http.fetcher';
import { RestSyncAdapter } from './adapters/rest.adapter';
import { SqlSyncAdapter } from './adapters/sql.adapter';
import { CsvSyncAdapter } from './adapters/csv.adapter';
import { AdapterRegistry } from './adapters/adapter.registry';
import { SyncService } from './sync.service';
import { SyncSourcesService } from './sync-sources.service';
import { SyncScheduler } from './sync.scheduler';
import { SyncController } from './sync.controller';

/**
 * HR sync module — docs/CONTRACT.md §8.
 * PrismaService متاح عالميًا (PrismaModule @Global)؛ ALERT_DISPATCHER تُحقن @Optional
 * لأن NotifyModule قيد الإنشاء并行 — غيابها لا يُسقط الموديول.
 */
@Module({
  imports: [PrismaModule],
  controllers: [SyncController],
  providers: [
    SyncService,
    SyncSourcesService,
    SyncScheduler,
    AdapterRegistry,
    RestSyncAdapter,
    SqlSyncAdapter,
    CsvSyncAdapter,
    { provide: HTTP_FETCHER, useClass: NodeHttpFetcher },
  ],
  exports: [SyncService],
})
export class SyncModule {}
