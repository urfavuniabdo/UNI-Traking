import L from 'leaflet';
import type { MotionState } from '@/api/types';

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
