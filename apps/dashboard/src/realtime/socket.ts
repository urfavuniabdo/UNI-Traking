import { io, type Socket } from 'socket.io-client';
import { API_BASE, isMock, refreshOnce } from '@/api/client';
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

let authRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** The gateway verifies the token *after* accepting the socket, then answers with one of these. */
const RT_READY = 'rt:ready';
const RT_ERROR = 'rt:error';

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/**
 * A rejected handshake is followed by `io server disconnect`, which socket.io never retries.
 * Without this the live channel stays dead for the rest of the session once the 15-minute
 * access token expires.
 */
function retryWithFreshToken(): void {
  if (retryTimer) return;
  authRetries += 1;
  useLive.getState().setConnected(false);
  const delay = Math.min(30000, 1000 * 2 ** Math.min(authRetries, 5));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void refreshOnce().finally(() => connectRealtime());
  }, delay);
}

export function connectRealtime(): void {
  if (isMock) {
    useLive.getState().setConnected(true);
    busEmit('connect', undefined);
    return;
  }
  clearRetry();
  if (socket) socket.disconnect();
  socket = io(`${API_BASE.replace(/\/api\/v1\/?$/, '')}/rt`, {
    // A function, not a snapshot: socket.io re-reads `auth` on every attempt, so a token the
    // retry below just minted is the one that goes out.
    auth: (cb: (data: object) => void) => cb({ token: token() }),
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 4000,
  });
  socket.on('connect', () => {
    // re-subscribe after every (re)connect
    socket?.emit(SOCKET_EVENTS.SUBSCRIBE_LIVE, {});
  });
  socket.on(RT_READY, () => {
    authRetries = 0;
    useLive.getState().setConnected(true);
  });
  socket.on(RT_ERROR, () => retryWithFreshToken());
  socket.on('disconnect', () => useLive.getState().setConnected(false));
  socket.on('connect_error', () => retryWithFreshToken());
  for (const a of attached) socket.on(a.event, a.cb);
}

export function disconnectRealtime(): void {
  if (isMock) {
    useLive.getState().setConnected(false);
    return;
  }
  clearRetry();
  authRetries = 0;
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
