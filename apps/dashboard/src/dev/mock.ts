import type { RawResponse } from './util';
import { err } from './util';
import type { MockRoute } from './handlers/auth';
import { authRoutes } from './handlers/auth';
import { liveRoutes } from './handlers/live';
import { positionsRoutes } from './handlers/positions';
import { alertRoutes } from './handlers/alerts';
import { attendanceRoutes } from './handlers/attendance';
import { placesRoutes } from './handlers/places';
import { employeeRoutes } from './handlers/employees';
import { syncRoutes } from './handlers/sync';
import { reportRoutes, attendanceEventRoutes } from './handlers/reports';
import { settingsRoutes } from './handlers/settings';
import { startSim } from './sim';

export function isMockMode(): boolean {
  return import.meta.env.VITE_USE_MOCK === '1';
}

// Boot the position simulation as soon as the mock layer is loaded, so a page
// refresh (with a persisted session) keeps streaming live data.
if (isMockMode()) startSim();

const routes: MockRoute[] = [
  ...authRoutes,
  ...liveRoutes,
  ...positionsRoutes,
  ...alertRoutes,
  ...attendanceRoutes,
  ...placesRoutes,
  ...employeeRoutes,
  ...syncRoutes,
  ...reportRoutes,
  ...attendanceEventRoutes,
  ...settingsRoutes,
];

const LATENCY = 90;

/**
 * In-memory mock server: intercepts every API call when VITE_USE_MOCK=1.
 * Mirrors docs/CONTRACT.md paths exactly, so removing the env flag
 * switches the dashboard to the real backend without any code change.
 */
export async function mockFetch(
  method: string,
  path: string,
  query: Record<string, string>,
  body: unknown,
): Promise<RawResponse> {
  await new Promise((r) => setTimeout(r, LATENCY + Math.random() * 90));
  const clean = path.split('?')[0];
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const m = route.pattern.exec(clean);
    if (!m) continue;
    try {
      return route.handler({ query, body: (body ?? {}) as Record<string, unknown>, params: m.slice(1) });
    } catch (e) {
      return err(500, 'MOCK_INTERNAL', e instanceof Error ? e.message : 'mock error');
    }
  }
  return err(404, 'NOT_FOUND', `مسار غير معرّف في الـ mock: ${method} ${clean}`);
}
