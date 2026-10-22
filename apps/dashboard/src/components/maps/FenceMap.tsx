import { useEffect } from 'react';
import { Circle, MapContainer, Marker, Polygon, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { centerIcon, vertexIcon } from './icons';

export type FenceDraft =
  | { kind: 'circle'; center: [number, number]; radiusM: number }
  | { kind: 'polygon'; vertices: [number, number][] }
  | null;

interface Props {
  draft: FenceDraft;
  onMapClick: (latlng: [number, number]) => void;
  onCenterMove: (latlng: [number, number]) => void;
  onVertexMove: (index: number, latlng: [number, number]) => void;
  onVertexRemove: (index: number) => void;
  onDoubleClick: () => void;
  existingCircles: { id: string; center: [number, number]; radiusM: number; alarm: boolean }[];
  existingPolygons: { id: string; points: [number, number][]; alarm: boolean }[];
  center: [number, number];
}

/**
 * Hand-rolled geofence editor: circle = draggable center + radius (slider lives
 * in the panel); polygon = click-to-add vertices, drag to move, double-click closes.
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

export default function FenceMap(props: Props) {
  const { draft, onCenterMove, onVertexMove, onVertexRemove, existingCircles, existingPolygons, center } = props;
  return (
    <MapContainer center={center} zoom={12} className="h-full w-full">
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
      <ClickCatcher onMapClick={props.onMapClick} onDoubleClick={props.onDoubleClick} />

      {existingCircles.map((c) => (
        <Circle
          key={c.id}
          center={c.center}
          radius={c.radiusM}
          pathOptions={{ color: c.alarm ? '#dc2626' : '#1d4ed8', dashArray: '6 6', weight: 1.5, fillOpacity: 0.04 }}
        />
      ))}
      {existingPolygons.map((p) => (
        <Polygon
          key={p.id}
          positions={p.points.map(([a, b]) => [a, b] as L.LatLngExpression)}
          pathOptions={{ color: p.alarm ? '#dc2626' : '#1d4ed8', dashArray: '6 6', weight: 1.5, fillOpacity: 0.04 }}
        />
      ))}

      {draft?.kind === 'circle' && (
        <>
          <Circle
            center={draft.center}
            radius={draft.radiusM}
            pathOptions={{ color: '#1d4ed8', weight: 2.5, fillColor: '#3b82f6', fillOpacity: 0.12 }}
          />
          <Marker
            position={draft.center}
            icon={centerIcon}
            draggable
            eventHandlers={{ dragend: (e) => onCenterMove([(e.target as L.Marker).getLatLng().lat, (e.target as L.Marker).getLatLng().lng]) }}
          />
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
