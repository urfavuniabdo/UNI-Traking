import { io, type Socket } from 'socket.io-client';
import { API_BASE, isMock } from '@/api/client';
import { busOn, busEmit, type RealtimeEventName } from '@/dev/bus';
import { useLive } from '@/stores/ui';
import { SOCKET_EVENTS } from '@shared';

export { SOCKET_EVENTS };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RealtimeHandler = (payload: any) => void;

let socket: Socket | null = null;
const attached: { event: string; cb: RealtimeHandler }[] = [];

function token(): string | null {
  try {
    const raw = localStorage.getItem('traccer.auth');
    if (!raw) return null;
    return (JSON.parse(raw) as { state?: { token?: string } }).state?.token ?? null;
  } catch {
    return null;
  }
}

export function connectRealtime(): void {
  if (isMock) {
    useLive.getState().setConnected(true);
    busEmit('connect', undefined);
    return;
  }
  if (socket) socket.disconnect();
  socket = io(`${API_BASE.replace(/\/api\/v1\/?$/, '')}/rt`, {
    auth: { token: token() },
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 4000,
  });
  socket.on('connect', () => {
    useLive.getState().setConnected(true);
    // re-subscribe after every (re)connect
    socket?.emit(SOCKET_EVENTS.SUBSCRIBE_LIVE, {});
  });
  socket.on('disconnect', () => useLive.getState().setConnected(false));
  for (const a of attached) socket.on(a.event, a.cb);
}

export function disconnectRealtime(): void {
  if (isMock) {
    useLive.getState().setConnected(false);
    return;
  }
  socket?.disconnect();
  socket = null;
  useLive.getState().setConnected(false);
}

/** Subscribe to a realtime event — works in both mock + real modes. */
export function on(event: RealtimeEventName, cb: RealtimeHandler): () => void {
  if (isMock) return busOn(event, cb as (p: unknown) => void);
  const wrapped = cb as (...args: unknown[]) => void;
  attached.push({ event, cb });
  socket?.on(event, wrapped);
  return () => {
    socket?.off(event, wrapped);
    const i = attached.findIndex((a) => a.cb === cb);
    if (i >= 0) attached.splice(i, 1);
  };
}

export function subscribeLive(userIds?: string[]): void {
  if (isMock) return;
  socket?.emit(SOCKET_EVENTS.SUBSCRIBE_LIVE, { userIds });
}

export function subscribeRoute(userId: string): void {
  if (isMock) return;
  socket?.emit(SOCKET_EVENTS.SUBSCRIBE_ROUTE, { userIds: [userId] });
}
