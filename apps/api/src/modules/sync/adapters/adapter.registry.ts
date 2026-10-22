import { Injectable } from '@nestjs/common';
import { SourceAdapter, SyncKind } from '../sync.types';
import { CsvSyncAdapter } from './csv.adapter';
import { RestSyncAdapter } from './rest.adapter';
import { SqlSyncAdapter } from './sql.adapter';

@Injectable()
export class AdapterRegistry {
  constructor(
    private readonly rest: RestSyncAdapter,
    private readonly sql: SqlSyncAdapter,
    private readonly csv: CsvSyncAdapter,
  ) {}

  get(kind: string): SourceAdapter {
    switch (kind as SyncKind) {
      case 'rest':
        return this.rest;
      case 'sql':
        return this.sql;
      case 'csv':
        return this.csv;
      default:
        throw new Error(`UNKNOWN_SOURCE_KIND: ${kind}`);
    }
  }
}
