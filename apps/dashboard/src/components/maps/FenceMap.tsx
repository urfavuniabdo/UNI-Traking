import { useEffect, useRef } from 'react';
import { Circle, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import { centerIcon, radiusHandleIcon, vertexIcon } from './icons';
import { haversineM } from '@/utils/format';

export type FenceDraft =
  | { kind: 'circle'; center: [number, number]; radiusM: number }
  | { kind: 'polygon'; vertices: [number, number][] }
  | null;

/** A saved fence, drawn for pointer picking: `id` is the site/zone id. */
export interface ExistingCircle {
  id: string;
  kind: 'site' | 'zone';
  name: string;
  center: [number, number];
  radiusM: number;
  alarm: boolean;
}

export interface ExistingPolygon {
  id: string;
  kind: 'site' | 'zone';
  name: string;
  points: [number, number][];
  alarm: boolean;
}

interface Props {
  draft: FenceDraft;
  onMapClick: (latlng: [number, number]) => void;
  onCenterMove: (latlng: [number, number]) => void;
  onVertexMove: (index: number, latlng: [number, number]) => void;
  onVertexRemove: (index: number) => void;
  onDoubleClick: () => void;
  existingCircles: ExistingCircle[];
  existingPolygons: ExistingPolygon[];
  center: [number, number];
  /** Dragging the edge handle rewrites the radius, metres. */
  onRadiusChange?: (radiusM: number) => void;
  /** Tapping a saved fence opens its details. */
  onSelectFence?: (kind: 'site' | 'zone', id: string) => void;
  selectedId?: string | null;
}

/**
 * Hand-rolled geofence editor: circle = draggable center + draggable edge handle for the
 * radius (the slider in the panel is the numeric twin); polygon = click-to-add vertices,
 * drag to move, double-click closes.
 */
function ClickCatcher({ onMapClick, onDoubleClick }: Pick<Props, 'onMapClick' | 'onDoubleClick'>) {
  const map = useMap();
  useEffect(() => {
    const click = (e: L.LeafletMouseEvent) => onMapClick([e.latlng.lat, e.latlng.lng]);
    const dbl = () => onDoubleClick();
    map.on('click', click);
    map.on('dblclick', dbl);
    return () => {
      map.off('click', click);
      map.off('dblclick', dbl);
    };
  }, [map, onMapClick, onDoubleClick]);
  return null;
}

/** Metres → degrees of latitude; good enough to park a handle on the north edge of the circle. */
const M_PER_DEG_LAT = 111320;

/** The edge handle and the panel slider are two views of one number, so they share its limits. */
export const RADIUS_MIN_M = 50;
export const RADIUS_MAX_M = 20000;

/** Opening a fence that sits off-screen brings it into view; a draft already on screen never jumps. */
function PanToDraft({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target && !map.getBounds().pad(-0.12).contains(target)) map.panTo(target, { duration: 0.5 });
    // keyed on the coordinates, not the array identity: a radius drag rebuilds this prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.[0], target?.[1], map]);
  return null;
}

/** The saved fences are what this page is for, so the first draw frames them all instead of a fixed city. */
function FitFences({ signature, spots }: { signature: string; spots: [number, number][] }) {
  const map = useMap();
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || !signature || !spots.length) return;
    framed.current = true;
    map.fitBounds(L.latLngBounds(spots.map(([a, b]) => [a, b] as L.LatLngExpression)), { padding: [40, 40], maxZoom: 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, map]);
  return null;
}

function pathStyle(color: string, weight: number, fillOpacity: number, dash?: string) {  // bubblingMouseEvents:false keeps a tap on a fence from falling through to the map and
  // starting a brand-new draft under the user's feet.
  return { color, weight, dashArray: dash, fillOpacity, bubblingMouseEvents: false };
}

export default function FenceMap(props: Props) {
  const {
    draft,
    onCenterMove,
    onVertexMove,
    onVertexRemove,
    existingCircles,
    existingPolygons,
    center,
    onRadiusChange,
    onSelectFence,
    selectedId,
  } = props;

  const handlePos: [number, number] | null =
    draft?.kind === 'circle' ? [draft.center[0] + draft.radiusM / M_PER_DEG_LAT, draft.center[1]] : null;

  // A circle's edge is part of it too, so a wide fence is not cut off by the frame.
  const spots: [number, number][] = [
    ...existingCircles.flatMap((c) => [c.center, [c.center[0] + c.radiusM / M_PER_DEG_LAT, c.center[1]] as [number, number]]),
    ...existingPolygons.flatMap((p) => p.points),
  ];

  return (
    <MapContainer center={center} zoom={12} className="h-full w-full">
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      <ClickCatcher onMapClick={props.onMapClick} onDoubleClick={props.onDoubleClick} />
      <FitFences signature={`${existingCircles.length}-${existingPolygons.length}`} spots={spots} />
      <PanToDraft target={draft?.kind === 'circle' ? draft.center : null} />

      {existingCircles.map((c) => {
        const selected = c.id === selectedId;
        return (
          <Circle
            key={c.id}
            center={c.center}
            radius={c.radiusM}
            pathOptions={pathStyle(c.alarm ? '#dc2626' : selected ? '#0f766e' : '#1d4ed8', selected ? 3 : 1.5, selected ? 0.1 : 0.04, '6 6')}
            eventHandlers={{ click: () => onSelectFence?.(c.kind, c.id) }}
          >
            <Tooltip sticky direction="top" permanent={selected}>
              <span style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
                <b>{c.name}</b> · <span className="num">{Math.round(c.radiusM)}</span> م — دوس للتفاصيل
              </span>
            </Tooltip>
          </Circle>
        );
      })}
      {existingPolygons.map((p) => {
        const selected = p.id === selectedId;
        return (
          <Polygon
            key={p.id}
            positions={p.points.map(([a, b]) => [a, b] as L.LatLngExpression)}
            pathOptions={pathStyle(p.alarm ? '#dc2626' : selected ? '#0f766e' : '#1d4ed8', selected ? 3 : 1.5, selected ? 0.1 : 0.04, '6 6')}
            eventHandlers={{ click: () => onSelectFence?.(p.kind, p.id) }}
          >
            <Tooltip sticky direction="top" permanent={selected}>
              <span style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
                <b>{p.name}</b> — <span className="num">{p.points.length}</span> نقطة · دوس للتفاصيل
              </span>
            </Tooltip>
          </Polygon>
        );
      })}

      {draft?.kind === 'circle' && (
        <>
          <Circle
            center={draft.center}
            radius={draft.radiusM}
            pathOptions={{ color: '#1d4ed8', weight: 2.5, fillColor: '#3b82f6', fillOpacity: 0.12 }}
          />
          {handlePos && (
            <Polyline
              positions={[draft.center, handlePos]}
              pathOptions={{ color: '#1d4ed8', weight: 1.5, dashArray: '2 6', opacity: 0.8 }}
            />
          )}
          <Marker
            position={draft.center}
            icon={centerIcon}
            draggable
            eventHandlers={{ dragend: (e) => onCenterMove([(e.target as L.Marker).getLatLng().lat, (e.target as L.Marker).getLatLng().lng]) }}
          />
          {handlePos && onRadiusChange && (
            <Marker
              position={handlePos}
              icon={radiusHandleIcon}
              draggable
              zIndexOffset={400}
              eventHandlers={{
                dragend: (e) => {
                  const ll = (e.target as L.Marker).getLatLng();
                  const metres = haversineM(draft.center[0], draft.center[1], ll.lat, ll.lng);
                  onRadiusChange(Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, Math.round(metres / 10) * 10)));
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -12]}>
                <span style={{ direction: 'rtl', fontFamily: 'Cairo' }}>
                  اسحب لتغيير نصف القطر (<span className="num">{Math.round(draft.radiusM)}</span> م)
                </span>
              </Tooltip>
            </Marker>
          )}
        </>
      )}

      {draft?.kind === 'polygon' && (
        <>
          {draft.vertices.length > 1 && (
            <Polygon
              positions={draft.vertices.map(([a, b]) => [a, b] as L.LatLngExpression)}
              pathOptions={{ color: '#1d4ed8', weight: 2.5, dashArray: draft.vertices.length < 3 ? '4 6' : undefined, fillColor: '#3b82f6', fillOpacity: 0.12 }}
            />
          )}
          {draft.vertices.map((v, i) => (
            <Marker
              key={`${i}-${v[0]}-${v[1]}`}
              position={v}
              icon={vertexIcon}
              draggable
              eventHandlers={{
                dragend: (e) => onVertexMove(i, [(e.target as L.Marker).getLatLng().lat, (e.target as L.Marker).getLatLng().lng]),
                click: () => onVertexRemove(i),
              }}
            />
          ))}
        </>
      )}
    </MapContainer>
  );
}
