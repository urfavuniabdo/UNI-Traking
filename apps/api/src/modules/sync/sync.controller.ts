import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard, Public, Roles, RolesGuard } from '../../common/auth/guards';
import { ROLES } from '../../shared/constants';
import { SyncService } from './sync.service';
import { SyncSourcesService } from './sync-sources.service';
import { CreateSyncSourceDto, ListIssuesDto, ListRunsDto, RunSyncDto, ToggleSourceDto, UpdateSyncSourceDto } from './sync.dto';
import { sanitizeUploadName, syncUploadsDir } from './upload.util';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

interface UploadFileLike {
  originalname?: string;
  mimetype?: string;
  buffer?: Buffer;
}

@Controller('sync')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    private readonly sources: SyncSourcesService,
  ) {}

  // ---------- runs ----------

  @Post('runs')
  @Roles(ROLES.ADMIN)
  @HttpCode(202)
  async run(@Body() dto: RunSyncDto): Promise<{ runId: string; status: string; skippedOverlap?: boolean }> {
    if (!dto.sourceId && !dto.kind) throw new BadRequestException('SYNC_NO_SOURCE: provide sourceId or kind+config');
    return this.sync.startRun(dto, 'MANUAL');
  }

  @Get('runs')
  @Roles(ROLES.ADMIN)
  listRuns(@Query() q: ListRunsDto): Promise<unknown[]> {
    return this.sync.listRuns(q.limit ?? 50);
  }

  @Get('runs/:id')
  @Roles(ROLES.ADMIN)
  getRun(@Param('id') id: string): Promise<unknown> {
    return this.sync.getRun(id);
  }

  // ---------- issues ----------

  @Get('issues')
  @Roles(ROLES.ADMIN)
  listIssues(@Query() q: ListIssuesDto): Promise<unknown[]> {
    return this.sync.listIssues(q.resolved);
  }

  @Post('issues/:id/resolve')
  @Roles(ROLES.ADMIN)
  @HttpCode(200)
  resolveIssue(@Param('id') id: string): Promise<unknown> {
    return this.sync.resolveIssue(id);
  }

  // ---------- sources (config secrets masked in every response) ----------

  @Get('sources')
  @Roles(ROLES.ADMIN)
  listSources(): Promise<unknown[]> {
    return this.sources.list();
  }

  @Get('sources/:id')
  @Roles(ROLES.ADMIN)
  getSource(@Param('id') id: string): Promise<unknown> {
    return this.sources.get(id);
  }

  @Post('sources')
  @Roles(ROLES.ADMIN)
  createSource(@Body() dto: CreateSyncSourceDto): Promise<unknown> {
    return this.sources.create(dto as never);
  }

  @Patch('sources/:id')
  @Roles(ROLES.ADMIN)
  updateSource(@Param('id') id: string, @Body() dto: UpdateSyncSourceDto): Promise<unknown> {
    return this.sources.update(id, dto as never);
  }

  @Post('sources/:id/toggle')
  @Roles(ROLES.ADMIN)
  @HttpCode(200)
  toggleSource(@Param('id') id: string, @Body() dto: ToggleSourceDto): Promise<unknown> {
    return this.sources.toggle(id, dto.enabled);
  }

  // ---------- csv upload preview ----------

  @Post('preview-upload')
  @Roles(ROLES.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  previewUpload(@UploadedFile() file?: UploadFileLike): unknown {
    if (!file || !file.buffer) throw new BadRequestException('NO_FILE: multipart field "file" with a csv is required');
    const name = sanitizeUploadName(file.originalname ?? 'upload.csv');
    const filePath = path.join(syncUploadsDir(), name);
    writeFileSync(filePath, file.buffer);
    try {
      return this.sync.previewCsv(filePath);
    } catch (e) {
      throw new BadRequestException(String((e as Error).message ?? e));
    }
  }

  // ---------- webhook — PUBLIC, guarded only by x-sync-secret ----------

  @Public()
  @Post('webhook')
  @HttpCode(202)
  async webhook(
    @Query('source') sourceId: string | undefined,
    @Headers('x-sync-secret') secret: string | undefined,
  ): Promise<{ runId: string; status: string; skippedOverlap?: boolean }> {
    let source;
    try {
      source = await this.sync.verifyWebhook(sourceId, secret);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('SYNC_WEBHOOK_UNAUTHORIZED')) throw new UnauthorizedException('SYNC_WEBHOOK_UNAUTHORIZED');
      throw new UnauthorizedException(msg.split(':')[0] || 'SYNC_WEBHOOK_UNAUTHORIZED');
    }
    return this.sync.startRun({ sourceId: source.id }, 'WEBHOOK');
  }

  // ---------- dashboard freshness panel ----------

  @Get('matrix')
  @Roles(ROLES.ADMIN)
  matrix(): Promise<unknown[]> {
    return this.sync.matrix();
  }
}
