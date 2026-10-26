import { useEffect } from 'react';
import { connectRealtime, on, subscribeLive } from './socket';
import { SOCKET_EVENTS } from '@shared';
import { useLive, useAlertFeed, useUi, usePrefs } from '@/stores/ui';
import { browserNotify, ensureNotifyPermission, playPing } from '@/utils/sound';
import type { AlertPayload, LivePosition, SocketPositionUpdate, SocketPresence } from '@/api/types';

/**
 * Wires the `/rt` stream (or the mock bus) into the stores + toast + sound +
 * browser-notification pipeline. Mount once inside the app shell.
 */
export function useRealtime(): void {
  useEffect(() => {
    connectRealtime();
    subscribeLive();
    void ensureNotifyPermission().then((p) => useUi.getState().setNotifyPermission(p));

    const offs = [
      on(SOCKET_EVENTS.POSITION_UPDATE, (p: SocketPositionUpdate) => {
        const prev = useLive.getState().positions[p.userId];
        useLive.getState().applyPosition({
          ...(prev ?? ({} as LivePosition)),
          userId: p.userId,
          lat: p.lat,
          lng: p.lng,
          speedKmh: p.speedKmh,
          motionState: p.motionState,
          ts: p.ts,
          lastSeen: p.ts,
          online: true,
        });
      }),
      on(SOCKET_EVENTS.ALERT_NEW, (a: AlertPayload) => {
        const feed = useAlertFeed.getState();
        const prefs = usePrefs.getState();
        if (prefs.types.length && !prefs.types.includes(a.type)) return;
        feed.addAlert(a);
        if (a.severity === 'CRITICAL') {
          const ui = useUi.getState();
          if (ui.soundEnabled) playPing('critical');
          browserNotify(a.title, `${a.userName} — ${a.body}`);
          ui.pushToast({ title: a.title, body: `${a.userName} · ${a.body}`, kind: 'alert' });
        }
      }),
      on(SOCKET_EVENTS.ALERT_UPDATED, (u: { id: string; status: AlertPayload['status']; ackBy?: string | null; ackAt?: string | null }) => {
        useAlertFeed.getState().updateAlert(u.id, { status: u.status, ackBy: u.ackBy, ackAt: u.ackAt });
      }),
      on(SOCKET_EVENTS.DRIVER_PRESENCE, (p: SocketPresence) => {
        useLive.getState().mergePosition(p.userId, {
          online: p.online,
          tracking: p.tracking,
          gpsEnabled: p.gpsEnabled,
          dataEnabled: p.dataEnabled ?? p.online,
          lastSeen: p.lastSeen,
        });
        if (!p.online) {
          useUi.getState().pushToast({ title: 'السائق غير متصل', body: 'لم تصل بيانات من الجهاز', kind: 'error' });
        }
      }),
      on(SOCKET_EVENTS.ATTENDANCE_CHANGED, () => {
        useUi.getState().pushToast({ title: 'تحديث حضور', body: 'تم تسجيل بدء أو إنهاء يوم جديد', kind: 'info' });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
