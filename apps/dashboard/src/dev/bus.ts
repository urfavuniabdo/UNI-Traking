/**
 * Tiny pub/sub used by the mock server to imitate Socket.IO `/rt` events.
 * The realtime layer subscribes to this when VITE_USE_MOCK=1.
 */
export type RealtimeEventName =
  | 'position:update'
  | 'alert:new'
  | 'alert:updated'
  | 'attendance:changed'
  | 'driver:presence'
  | 'notify:me'
  | 'connect'
  | 'disconnect';

type Handler = (payload: unknown) => void;

const map = new Map<RealtimeEventName, Set<Handler>>();

export function busOn(event: RealtimeEventName, cb: Handler): () => void {
  const set = map.get(event) ?? new Set();
  set.add(cb);
  map.set(event, set);
  return () => set.delete(cb);
}

export function busEmit(event: RealtimeEventName, payload: unknown): void {
  const set = map.get(event);
  if (!set) return;
  for (const cb of Array.from(set)) {
    try {
      cb(payload);
    } catch {
      /* one bad handler must not break the rest */
    }
  }
}
