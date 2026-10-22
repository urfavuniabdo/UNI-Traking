import { useEffect, useMemo } from 'react';
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { MapEvent, RouteResponse } from '@/api/types';
import { MOTION_COLORS, eventIcon } from './icons';
import { driverIcon } from './icons';

const SEVERITY_COLORS: Record<string, string> = { CRITICAL: '#dc2626', WARNING: '#d97706', INFO: '#2563eb' };

interface Props {
  route: RouteResponse;
  index: number;
  /** Abnormal events of the day, pinned where they happened. */
  events?: MapEvent[];
  onSelectPoint?: (index: number) => void;
  className?: string;
}

function FitRoute({ positions }: { positions: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length) {
      const b = L_latLngBounds(positions);
      map.fitBounds(b, { padding: [24, 24] });
    }
  }, [positions, map]);
  return null;
}

function L_latLngBounds(positions: [number, number][]): [number, number][] {
  const lats = positions.map((p) => p[0]);
  const lngs = positions.map((p) => p[1]);
  return [
    [Math.min(...lats), Math.min(...lngs)],
    [Math.max(...lats), Math.max(...lngs)],
  ];
}

export default function RouteMap({ route, index, events = [], onSelectPoint, className = '' }: Props) {
  const coords = useMemo(() => route.points.map((p) => [p.lat, p.lng] as [number, number]), [route]);
  const current = route.points[Math.min(index, route.points.length - 1)];

  // color segments by motion state for visual richness
  const segments = useMemo(() => {
    const out: { positions: [number, number][]; color: string }[] = [];
    let cur: { positions: [number, number][]; color: string } | null = null;
    for (const p of route.points) {
      const c = MOTION_COLORS[p.motionState];
      if (!cur || cur.color !== c) {
        if (cur) cur.positions.push([p.lat, p.lng]);
        cur = { positions: [[p.lat, p.lng]], color: c };
        out.push(cur);
      } else {
        if (cur.positions[cur.positions.length - 1][0] !== p.lat) cur.positions.push([p.lat, p.lng]);
      }
    }
    return out;
  }, [route]);

  return (
    <MapContainer center={coords[0] ?? [30.0444, 31.2357]} zoom={13} className={`h-full w-full ${className}`}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      <FitRoute positions={coords} />

      {segments.map((s, i) => (
        <Polyline key={i} positions={s.positions} pathOptions={{ color: s.color, weight: 4, opacity: 0.75 }} />
      ))}

      {/* gaps: dashed red */}
      {route.gaps.map((g, i) => {
        const from = route.points.findIndex((p) => p.clientTs === g.fromTs);
        const to = route.points.findIndex((p) => p.clientTs === g.toTs);
        if (from < 0 || to < 0) return null;
        return (
          <Polyline
            key={`g${i}`}
            positions={[
              [route.points[from].lat, route.points[from].lng],
              [route.points[to].lat, route.points[to].lng],
            ]}
            pathOptions={{ color: '#dc2626', weight: 3, dashArray: '2 8' }}
          >
            <Tooltip sticky direction="top">{`فجوة ${g.minutes} دقيقة`}</Tooltip>
          </Polyline>
        );
      })}

      {/* stops: amber circles */}
      {route.stops.map((s, i) => (
        <CircleMarker key={`s${i}`} center={[s.lat, s.lng]} radius={7} pathOptions={{ color: '#b45309', fillColor: '#f59e0b', fillOpacity: 0.6, weight: 2 }}>
          <Tooltip sticky direction="top">{`توقف ${s.durationMin} دقيقة`}</Tooltip>
        </CircleMarker>
      ))}

      {events.map((ev) => (
        <Marker
          key={ev.id}
          position={[ev.lat, ev.lng]}
          icon={eventIcon(ev.type, SEVERITY_COLORS[ev.severity] ?? '#dc2626')}
          eventHandlers={{ click: () => onSelectPoint?.(nearestPointIndex(route, ev.ts)) }}
        >
          <Tooltip direction="top" offset={[0, -14]}>
            <span style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
              <b>{ev.title}</b>
            </span>
          </Tooltip>
        </Marker>
      ))}

      {current && (
        <Marker position={[current.lat, current.lng]} icon={driverIcon(current.motionState, { selected: true })} />
      )}
    </MapContainer>
  );
}

/** Which recorded point an event happened at, so tapping its symbol can jump the replay there. */
export function nearestPointIndex(route: RouteResponse, ts: string): number {
  const target = Date.parse(ts);
  let best = 0;
  let bestGap = Number.POSITIVE_INFINITY;
  route.points.forEach((p, i) => {
    const d = Math.abs(Date.parse(p.clientTs) - target);
    if (d < bestGap) {
      bestGap = d;
      best = i;
    }
  });
  return best;
}
