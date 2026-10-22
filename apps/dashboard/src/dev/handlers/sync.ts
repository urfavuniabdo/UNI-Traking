import { syncIssues, syncMatrix, syncRuns, syncSources } from '../db';
import type { SyncRun } from '@/api/types';
import { err, ok, qstr } from '../util';
import type { MockRoute } from './auth';

export const syncRoutes: MockRoute[] = [
  { method: 'GET', pattern: /^\/sync\/sources$/, handler: () => ok({ sources: syncSources }) },
  {
    method: 'POST',
    pattern: /^\/sync\/sources$/,
    handler: ({ body }) => {
      const src = {
        id: `src-${Date.now().toString(36)}`,
        name: String(body.name ?? 'مصدر جديد'),
        kind: (body.kind === 'rest' || body.kind === 'csv' ? body.kind : 'sql') as 'sql' | 'rest' | 'csv',
        enabled: true,
        scheduleCron: String(body.scheduleCron ?? '*/15 * * * *'),
        lastRunAt: null,
        webhookSecret: `whsec_${Math.random().toString(36).slice(2, 12)}`,
      };
      syncSources.push(src);
      return ok(src);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/sync\/sources\/([^/]+)$/,
    handler: ({ params, body }) => {
      const src = syncSources.find((s) => s.id === params[0]);
      if (!src) return err(404, 'NOT_FOUND', 'مصدر غير موجود');
      Object.assign(src, {
        name: body.name !== undefined ? String(body.name) : src.name,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : src.enabled,
        scheduleCron: body.scheduleCron !== undefined ? String(body.scheduleCron) : src.scheduleCron,
      });
      return ok(src);
    },
  },
  {
    method: 'POST',
    pattern: /^\/sync\/runs$/,
    handler: ({ body }) => {
      const sourceId = qstr(body as Record<string, string>, 'sourceId') ?? syncSources[0].id;
      const src = syncSources.find((s) => s.id === sourceId) ?? syncSources[0];
      const run: SyncRun = {
        id: `run-${Date.now().toString(36)}`,
        sourceId: src.id,
        sourceName: src.name,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        status: 'RUNNING',
        created: 0,
        updated: 0,
        unchanged: 0,
        deactivated: 0,
        triggeredBy: 'MANUAL',
      };
      syncRuns.unshift(run);
      // finish it like a real worker would
      setTimeout(() => {
        run.finishedAt = new Date().toISOString();
        run.status = Math.random() > 0.9 ? 'FAILED' : 'SUCCESS';
        run.created = Math.floor(Math.random() * 3);
        run.updated = Math.floor(Math.random() * 6);
        run.unchanged = 140 + Math.floor(Math.random() * 20);
        run.deactivated = Math.random() > 0.7 ? 1 : 0;
        src.lastRunAt = run.finishedAt;
      }, 1500);
      return ok(run);
    },
  },
  {
    method: 'GET',
    pattern: /^\/sync\/runs\/([^/]+)$/,
    handler: ({ params }) => {
      const r = syncRuns.find((x) => x.id === params[0]);
      return r ? ok(r) : err(404, 'NOT_FOUND', 'تشغيل غير موجود');
    },
  },
  {
    method: 'GET',
    pattern: /^\/sync\/runs$/,
    handler: () => ok({ runs: syncRuns }),
  },
  {
    method: 'GET',
    pattern: /^\/sync\/issues$/,
    handler: () => ok({ issues: syncIssues }),
  },
  {
    method: 'POST',
    pattern: /^\/sync\/issues\/([^/]+)\/resolve$/,
    handler: ({ params }) => {
      const i = syncIssues.find((x) => x.id === params[0]);
      if (!i) return err(404, 'NOT_FOUND', 'مشكلة غير موجودة');
      i.resolved = true;
      return ok(i);
    },
  },
  { method: 'GET', pattern: /^\/sync\/matrix$/, handler: () => ok({ rows: syncMatrix }) },
];
