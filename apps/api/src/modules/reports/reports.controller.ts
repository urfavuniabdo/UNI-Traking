import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, Roles, RolesGuard } from '../../common/auth/guards';
import { ReportsService, type ReportTabular } from './reports.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @Roles('ADMIN', 'SUPERVISOR')
  daily(@Query('date') date: string, @Query('format') format: string, @Res() res: Response): Promise<void> {
    return this.deliver(() => this.reports.daily(date), format, res, `daily${date ? `-${date}` : ''}`);
  }

  @Get('route')
  @Roles('ADMIN', 'SUPERVISOR')
  route(@Query('userId') userId: string, @Query('date') date: string, @Query('format') format: string, @Res() res: Response): Promise<void> {
    return this.deliver(() => this.reports.route(userId, date), format, res, `route-${userId}-${date}`);
  }

  @Get('timesheet')
  @Roles('ADMIN', 'SUPERVISOR')
  timesheet(@Query('from') from: string, @Query('to') to: string, @Query('userId') userId: string, @Query('format') format: string, @Res() res: Response): Promise<void> {
    return this.deliver(() => this.reports.timesheet(from, to, userId), format, res, `timesheet`);
  }

  @Get('exceptions')
  @Roles('ADMIN', 'SUPERVISOR')
  exceptions(@Query('from') from: string, @Query('to') to: string, @Query('format') format: string, @Res() res: Response): Promise<void> {
    return this.deliver(() => this.reports.exceptions(from, to), format, res, 'exceptions');
  }

  @Get('mileage')
  @Roles('ADMIN', 'SUPERVISOR')
  mileage(@Query('from') from: string, @Query('to') to: string, @Query('groupBy') groupBy: 'driver' | 'zone', @Query('format') format: string, @Res() res: Response): Promise<void> {
    return this.deliver(() => this.reports.mileage(from, to, groupBy === 'zone' ? 'zone' : 'driver'), format, res, `mileage-${groupBy ?? 'driver'}`);
  }

  @Get('live-kpis')
  @Roles('ADMIN', 'SUPERVISOR')
  liveKpis(): Promise<unknown> {
    return this.reports.liveKpis();
  }

  private async deliver(load: () => Promise<ReportTabular>, format: string, res: Response, filename: string): Promise<void> {
    const result = await load();
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(ReportsService.csvOf(result));
      return;
    }
    // JSON: strip the CSV-only fields and return the report body.
    const { headers: _h, rows: _r, ...body } = result;
    void _h;
    void _r;
    res.status(200).json(body);
  }
}
