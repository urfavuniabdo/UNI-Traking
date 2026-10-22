import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import * as express from 'express';
import { AppModule } from './app.module';

/** Paths the SPA fallback must never swallow: the API itself and engine.io's polling transport. */
const NON_SPA = /^\/(api\/|socket\.io|rt\b)/;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: origins.length ? origins : true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // One process, one origin: the built dashboard is served beside the API so the
  // browser talks to /api/v1 and /rt on the same host and no CORS is involved.
  const distDir = process.env.STATIC_DIR?.trim() || join(__dirname, '..', '..', 'dashboard', 'dist');
  const indexHtml = join(distDir, 'index.html');
  if (existsSync(indexHtml)) {
    const http = app.getHttpAdapter().getInstance() as Express;
    http.use(express.static(distDir, { index: false, maxAge: '1h' }));
    http.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || NON_SPA.test(req.path)) return next();
      res.sendFile(indexHtml);
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`uni-tracking-api ready on :${port} (db=${process.env.DATABASE_URL?.startsWith('postgres') ? 'postgresql' : 'sqlite'}, ui=${existsSync(indexHtml) ? 'served' : 'absent'})`);
}

void bootstrap();
