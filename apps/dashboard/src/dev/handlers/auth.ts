import type { RawResponse } from '../util';
import { err, ok } from '../util';
import { adminPermissions, mockAdmin } from '../db';
import { startSim } from '../sim';

export interface Ctx {
  query: Record<string, string | undefined>;
  body: Record<string, unknown>;
  params: string[];
}

export type Handler = (ctx: Ctx) => RawResponse;
export interface MockRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  pattern: RegExp;
  handler: Handler;
}

export const authRoutes: MockRoute[] = [
  {
    method: 'POST',
    pattern: /^\/auth\/login$/,
    handler: ({ body }) => {
      startSim();
      const identifier = String(body.identifier ?? '').trim();
      const password = String(body.password ?? '');
      if (!identifier || !password) return err(400, 'INVALID_CREDENTIALS', 'المعرّف وكلمة المرور مطلوبان');
      return ok({
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        user: { ...mockAdmin, identifier },
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/auth\/refresh$/,
    handler: ({ body }) => {
      if (!body.refreshToken) return err(401, 'UNAUTHORIZED', 'لا توجد جلسة');
      return ok({ accessToken: 'mock-access-token', refreshToken: 'mock-refresh-token', user: mockAdmin });
    },
  },
  {
    method: 'GET',
    pattern: /^\/auth\/me$/,
    handler: () => ok({ user: mockAdmin, permissions: adminPermissions }),
  },
  { method: 'POST', pattern: /^\/auth\/logout$/, handler: () => ok({ ok: true }) },
];
