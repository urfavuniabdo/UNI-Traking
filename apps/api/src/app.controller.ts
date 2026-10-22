import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/guards';
import { PrismaService } from './common/prisma.service';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('ping')
  ping() {
    // Render's health probe: answers as soon as the process is up, without touching the DB.
    return { ok: true };
  }

  @Public()
  @Get('health')
  async health() {
    let db = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = false;
    }
    return { ok: db, service: 'uni-tracking-api', version: process.env.npm_package_version ?? '0.1.0', time: new Date().toISOString() };
  }
}
