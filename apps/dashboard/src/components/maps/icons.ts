import L from 'leaflet';
import type { AlertType, MotionState } from '@/api/types';

export const MOTION_COLORS: Record<MotionState, string> = {
  WALKING: '#f59e0b',
  RIDING: '#2563eb',
  STOPPED: '#dc2626',
  UNKNOWN: '#64748b',
};

const iconCache = new Map<string, L.DivIcon>();

export function driverIcon(motion: MotionState, opts: { offline?: boolean; selected?: boolean; label?: string } = {}): L.DivIcon {
  const key = `${motion}-${opts.offline ? 'o' : ''}-${opts.selected ? 's' : ''}-${opts.label ?? ''}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const color = MOTION_COLORS[motion];
  const size = opts.selected ? 34 : 26;
  const icon = L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div class="driver-marker" style="background:${color};width:${size}px;height:${size}px;opacity:${opts.offline ? 0.45 : 1};${opts.selected ? 'outline:3px solid rgba(37,99,235,.5);outline-offset:2px;' : ''}">🚐</div>`,
  });
  iconCache.set(key, icon);
  return icon;
}

export const vertexIcon = L.divIcon({
  className: '',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
  html: '<div style="width:14px;height:14px;border-radius:99px;background:#1d4ed8;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>',
});

export const centerIcon = L.divIcon({
  className: '',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
  html: '<div style="width:20px;height:20px;border-radius:99px;background:#f59e0b;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4)"></div>',
});

/** Grab handle sitting on the circle's edge: dragging it rewrites the radius. */
export const radiusHandleIcon = L.divIcon({
  className: '',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
  html: '<div style="width:18px;height:18px;border-radius:99px;background:#fff;border:3px solid #1d4ed8;box-shadow:0 1px 6px rgba(0,0,0,.45);cursor:grab"></div>',
});

/** One glyph per problem type, so a marker on the route line is readable without opening anything. */
const EVENT_GLYPHS: Record<string, string> = {
  SPEEDING: '🔴',
  HARSH_BRAKING: '🛑',
  HARSH_ACCELERATION: '🚀',
  STOP_EXCEEDED: '⏸',
  GEOFENCE_EXIT: '🚪',
  GEOFENCE_ENTER: '🚶',
  CHECK_IN_OUT_OF_FENCE: '📍',
  ROUTE_GAP: '✂️',
  IDLE_LONG: '😴',
  GPS_OFF: '📵',
  DATA_OFF: '📵',
  APP_OFFLINE: '📴',
  HEARTBEAT_MISSING: '📡',
  BUFFER_REPLAYED: '📥',
  CHECKOUT_MISSING: '🕐',
};

export function eventGlyph(type: AlertType | string): string {
  return EVENT_GLYPHS[type] ?? '❗';
}

export function eventIcon(type: AlertType | string, color: string): L.DivIcon {
  const key = `${type}-${color}`;
  const cached = iconCache.get(`e${key}`);
  if (cached) return cached;
  const icon = L.divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html:
      `<div style="width:24px;height:24px;border-radius:99px;background:#fff;border:2px solid ${color};` +
      `display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1;` +
      'box-shadow:0 1px 5px rgba(0,0,0,.4)">' +
      eventGlyph(type) +
      '</div>',
  });
  iconCache.set(`e${key}`, icon);
  return icon;
}
