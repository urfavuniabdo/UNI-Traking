import { useEffect, useMemo } from 'react';
import { Circle, MapContainer, Marker, Polygon, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { FencesResponse, LivePosition } from '@/api/types';
import { driverIcon } from './icons';

const CAIRO: [number, number] = [30.0444, 31.2357];

function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 14, { duration: 0.6 });
  }, [target, map]);
  return null;
}

interface Props {
  positions: LivePosition[];
  fences: FencesResponse | null;
  focusUserId?: string | null;
  onSelect?: (userId: string) => void;
  className?: string;
}

export default function LiveMap({ positions, fences, focusUserId, onSelect, className = '' }: Props) {
  const focus = useMemo(() => {
    if (!focusUserId) return null;
    const p = positions.find((x) => x.userId === focusUserId);
    return p ? ([p.lat, p.lng] as [number, number]) : null;
  }, [focusUserId, positions]);

  const outsideSet = useMemo(() => new Set(fences?.outside ?? []), [fences]);

  return (
    <MapContainer center={CAIRO} zoom={11} className={`h-full w-full ${className}`} zoomControl>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      <FlyTo target={focus} />

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
              <span className="num">{p.speedKmh?.toFixed?.(0) ?? '—'} كم/س</span>
              {!p.online && <> · <b style={{ color: '#b91c1c' }}>غير متصل</b></>}
            </div>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
