import { useEffect, useMemo } from 'react';
import { Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { FencesResponse, LivePosition, MapEvent, Severity } from '@/api/types';
import { LiveSpeed } from '@/components/ui';
import { driverIcon, eventIcon } from './icons';

const CAIRO: [number, number] = [30.0444, 31.2357];

/** One selected driver's day, drawn over the live map. */
export interface TrailLayer {
  points: [number, number][];
  stops: { lat: number; lng: number; durationMin: number; kind?: string; startTs?: string }[];
  gaps: { from: [number, number]; to: [number, number]; minutes: number }[];
  events: MapEvent[];
}

function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 14, { duration: 0.6 });
  }, [target, map]);
  return null;
}

/** Zoom out to the whole trail only when the user asks — never on its own, or it would fight the live view. */
function FitTrail({ points, signal }: { points: [number, number][]; signal: number }) {
  const map = useMap();
  // Deliberately keyed on `signal` alone: the view must not jump every time a new point lands.
  useEffect(() => {
    if (!signal || points.length < 2) return;
    map.fitBounds(L.latLngBounds(points.map(([a, b]) => [a, b] as L.LatLngExpression)), { padding: [36, 36] });
  }, [signal, map]);
  return null;
}

const SEVERITY_COLORS: Record<Severity, string> = { CRITICAL: '#dc2626', WARNING: '#d97706', INFO: '#2563eb' };

const STOP_KIND_AR: Record<string, string> = { PLANNED: 'موقع مخطط', UNPLANNED: 'توقف غير مخطط', UNKNOWN: 'توقف' };

interface Props {
  positions: LivePosition[];
  fences: FencesResponse | null;
  focusUserId?: string | null;
  onSelect?: (userId: string) => void;
  trail?: TrailLayer | null;
  fitSignal?: number;
  /** Jump the view somewhere the user picked (an event on the line) instead of the moving car. */
  flyTarget?: [number, number] | null;
  onSelectEvent?: (id: string) => void;
  selectedEventId?: string | null;
  className?: string;
}

export default function LiveMap({
  positions,
  fences,
  focusUserId,
  onSelect,
  trail = null,
  fitSignal = 0,
  flyTarget = null,
  onSelectEvent,
  selectedEventId = null,
  className = '',
}: Props) {
  const focus = useMemo(() => {
    if (!focusUserId) return null;
    const p = positions.find((x) => x.userId === focusUserId);
    return p ? ([p.lat, p.lng] as [number, number]) : null;
  }, [focusUserId, positions]);

  const outsideSet = useMemo(() => new Set(fences?.outside ?? []), [fences]);

  return (
    <MapContainer center={CAIRO} zoom={11} className={`h-full w-full ${className}`} zoomControl>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      <FlyTo target={flyTarget ?? focus} />
      <FitTrail points={trail?.points ?? []} signal={fitSignal} />

      {/* Sites: solid light circles */}
      {fences?.sites.map((s) => (
        <Circle
          key={s.id}
          center={[s.lat, s.lng]}
          radius={s.radiusM}
          pathOptions={{ color: '#2563eb', weight: 1.5, fillColor: '#60a5fa', fillOpacity: 0.08 }}
        >
          <Tooltip sticky direction="top">{`🏢 ${s.name}`}</Tooltip>
        </Circle>
      ))}

      {/* Zones: dashed red when any driver is currently outside */}
      {fences?.zones.map((z) => {
        const hasOutsider = z.activeDriverIds.some((id) => outsideSet.has(id));
        const opts = {
          color: hasOutsider ? '#dc2626' : '#1d4ed8',
          weight: hasOutsider ? 2.5 : 1.5,
          dashArray: '6 6',
          fillColor: hasOutsider ? '#ef4444' : '#3b82f6',
          fillOpacity: 0.05,
        };
        return z.shape === 'CIRCLE' ? (
          <Circle key={z.id} center={[z.lat, z.lng]} radius={z.radiusM ?? 1000} pathOptions={opts}>
            <Tooltip sticky direction="top">{`${hasOutsider ? '⚠️ خروج عن ' : ''}${z.name}`}</Tooltip>
          </Circle>
        ) : (
          <Polygon key={z.id} positions={(z.polygon ?? []).map(([a, b]) => [a, b] as L.LatLngExpression)} pathOptions={opts}>
            <Tooltip sticky direction="top">{`${hasOutsider ? '⚠️ خروج عن ' : ''}${z.name}`}</Tooltip>
          </Polygon>
        );
      })}

      {/* Selected driver's day: the trail, the stops, the holes in coverage, then the events on top */}
      {trail && trail.points.length > 1 && (
        <Polyline positions={trail.points} pathOptions={{ color: '#1d4ed8', weight: 4, opacity: 0.8 }} />
      )}
      {trail?.gaps.map((g, i) => (
        <Polyline key={`gap-${i}`} positions={[g.from, g.to]} pathOptions={{ color: '#dc2626', weight: 3, dashArray: '2 8', opacity: 0.85 }}>
          <Tooltip sticky direction="top">{`فجوة تغطية ${g.minutes} دقيقة`}</Tooltip>
        </Polyline>
      ))}
      {trail?.stops.map((s, i) => (
        <CircleMarker
          key={`stop-${s.startTs ?? i}`}
          center={[s.lat, s.lng]}
          radius={7}
          pathOptions={{ color: '#b45309', fillColor: '#f59e0b', fillOpacity: 0.6, weight: 2 }}
        >
          <Tooltip sticky direction="top">
            <span style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
              <b>{STOP_KIND_AR[s.kind ?? 'UNKNOWN'] ?? 'توقف'}</b> · <span className="num">{Math.round(s.durationMin)}</span> دقيقة
            </span>
          </Tooltip>
        </CircleMarker>
      ))}
      {trail?.events.map((ev) => (
        <Marker
          key={ev.id}
          position={[ev.lat, ev.lng]}
          icon={eventIcon(ev.type, SEVERITY_COLORS[ev.severity] ?? '#dc2626')}
          zIndexOffset={ev.id === selectedEventId ? 600 : 300}
          eventHandlers={{ click: () => onSelectEvent?.(ev.id) }}
        >
          <Tooltip direction="top" offset={[0, -14]}>
            <span style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
              <b>{ev.title}</b>
              <br />
              <span className="num">{new Date(ev.ts).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
            </span>
          </Tooltip>
        </Marker>
      ))}

      {positions.map((p) => (
        <Marker
          key={p.userId}
          position={[p.lat, p.lng]}
          icon={driverIcon(p.motionState, { offline: !p.online, selected: p.userId === focusUserId })}
          eventHandlers={{ click: () => onSelect?.(p.userId) }}
        >
          <Tooltip direction="top" offset={[0, -14]}>
            <div style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
              <b>{p.userName ?? p.userId}</b>
              <br />
              <LiveSpeed state={p.motionState} speedKmh={p.speedKmh} />
              {!p.online && <> · <b style={{ color: '#b91c1c' }}>غير متصل</b></>}
            </div>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
