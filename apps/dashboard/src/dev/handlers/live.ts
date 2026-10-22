import { ok } from '../util';
import type { MockRoute } from './auth';
import { drivers } from '../db';
import { useLive } from '@/stores/ui';
import type { LivePosition } from '@/api/types';

export const liveRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/positions\/live$/,
    handler: () => {
      // prefer the live store (socket-fed); fall back to sim state
      const store = useLive.getState().positions;
      const positions: LivePosition[] = drivers.map((d) => {
        const p = store[d.userId];
        if (p) return p;
        return {
          userId: d.userId,
          lat: d.lat,
          lng: d.lng,
          speedKmh: +d.speed.toFixed(1),
          motionState: d.motionState,
          ts: d.lastSeen,
          battery: Math.round(d.battery),
          accuracy: 6,
          online: d.online,
          tracking: d.tracking,
          gpsEnabled: d.gpsEnabled,
          dataEnabled: d.dataEnabled,
          lastSeen: d.lastSeen,
        } satisfies LivePosition;
      });
      return ok({ positions, serverTs: new Date().toISOString() });
    },
  },
];
