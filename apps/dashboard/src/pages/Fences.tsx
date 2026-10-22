import { useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { FencesResponse, Site, Zone } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import FenceMap, { type FenceDraft } from '@/components/maps/FenceMap';
import { Btn, Card, CardTitle, Chip, ErrorState, Input, Modal, Num, Select, Skeleton, Toggle } from '@/components/ui';
import { useUi } from '@/stores/ui';

type Draft =
  | { mode: 'new-circle'; target: 'site' | 'zone'; center: [number, number]; radiusM: number; name: string }
  | { mode: 'new-polygon'; target: 'site' | 'zone'; vertices: [number, number][]; name: string }
  | { mode: 'edit-circle'; id: string; kind: 'site' | 'zone'; center: [number, number]; radiusM: number }
  | { mode: 'edit-polygon'; id: string; kind: 'zone'; vertices: [number, number][] }
  | null;

export default function FencesPage() {
  const res = useAsync<FencesResponse>(() => api.get('/places/fences'), []);
  const [draft, setDraft] = useState<Draft>(null);
  const [busy, setBusy] = useState(false);
  const toast = useUi((s) => s.pushToast);
  const fences = res.data;

  const circles = useMemo(() => {
    const outside = fences?.outside ?? [];
    const list: { id: string; center: [number, number]; radiusM: number; alarm: boolean }[] = [];
    fences?.sites.forEach((s) => list.push({ id: s.id, center: [s.lat, s.lng], radiusM: s.radiusM, alarm: false }));
    fences?.zones.filter((z) => z.shape === 'CIRCLE').forEach((z) =>
      list.push({ id: z.id, center: [z.lat, z.lng], radiusM: z.radiusM ?? 1000, alarm: z.activeDriverIds.some((d) => outside.includes(d)) }),
    );
    return list;
  }, [fences]);

  const polygons = useMemo(() => {
    const outside = fences?.outside ?? [];
    return (fences?.zones ?? [])
      .filter((z) => z.shape === 'POLYGON')
      .map((z) => ({ id: z.id, points: z.polygon ?? [], alarm: z.activeDriverIds.some((d) => outside.includes(d)) }));
  }, [fences]);

  const onMapClick = (ll: [number, number]) => {
    if (!draft) {
      setDraft({ mode: 'new-circle', target: 'zone', center: ll, radiusM: 2000, name: '' });
      return;
    }
    switch (draft.mode) {
      case 'new-circle':
        setDraft({ ...draft, center: ll });
        break;
      case 'new-polygon':
      case 'edit-polygon':
        setDraft({ ...draft, vertices: [...draft.vertices, ll] });
        break;
      case 'edit-circle':
        break; // center moves via the draggable marker
    }
  };

  const onDoubleClick = () => {
    if (draft?.mode === 'new-polygon' && draft.vertices.length >= 3) {
      toast({ title: 'تم إغلاق المضلع', body: 'اضغط حفظ للنطاق', kind: 'info' });
    }
  };

  const fenceDraft: FenceDraft =
    draft?.mode === 'new-circle' || draft?.mode === 'edit-circle'
      ? { kind: 'circle', center: draft.center, radiusM: draft.radiusM }
      : draft?.mode === 'new-polygon' || draft?.mode === 'edit-polygon'
        ? { kind: 'polygon', vertices: draft.vertices }
        : null;

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      if (draft.mode === 'new-circle' || draft.mode === 'new-polygon') {
        const isCircle = draft.mode === 'new-circle';
        await api.post('/places/zones', {
          name: ('name' in draft && draft.name) || 'نطاق جديد',
          shape: isCircle ? 'CIRCLE' : 'POLYGON',
          lat: isCircle ? draft.center[0] : centroid(draft.vertices)[0],
          lng: isCircle ? draft.center[1] : centroid(draft.vertices)[1],
          radiusM: isCircle ? draft.radiusM : undefined,
          polygon: isCircle ? undefined : draft.vertices,
          strictReject: false,
        });
      } else if (draft.mode === 'edit-circle') {
        await api.patch(`/places/${draft.kind === 'site' ? 'sites' : 'zones'}/${draft.id}`, { lat: draft.center[0], lng: draft.center[1], radiusM: draft.radiusM });
      } else {
        await api.patch(`/places/zones/${draft.id}`, { polygon: draft.vertices, lat: centroid(draft.vertices)[0], lng: centroid(draft.vertices)[1] });
      }
      toast({ title: 'تم الحفظ', kind: 'info' });
      setDraft(null);
      res.reload();
    } catch {
      toast({ title: 'فشل الحفظ', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const patchZone = async (z: Zone, body: Partial<Zone>) => {
    try {
      await api.patch(`/places/zones/${z.id}`, body);
      res.reload();
    } catch {
      toast({ title: 'فشل التحديث', kind: 'error' });
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)] max-lg:h-auto">
      {/* list */}
      <div className="space-y-3 min-h-0 overflow-y-auto">
        <Card className="p-3">
          <p className="muted mb-2" style={{ fontSize: '.78rem' }}>
            اضغط على الخريطة لإنشاء نطاق دائري؛ اسحب المركز أو غيّر نصف القطر. للمضلع: اضغط "مضلع جديد" ثم نقاط متتالية ودبل كليك للإغلاق.
          </p>
          <div className="flex gap-2">
            <Btn variant="primary" onClick={() => setDraft({ mode: 'new-circle', target: 'zone', center: [30.0444, 31.2357], radiusM: 2000, name: '' })}>
              + دائرة
            </Btn>
            <Btn onClick={() => setDraft({ mode: 'new-polygon', target: 'zone', vertices: [], name: '' })}>+ مضلع</Btn>
          </div>
        </Card>

        {res.loading && <Skeleton className="h-40" />}
        {res.error && <ErrorState message={res.error} onRetry={res.reload} />}

        {fences && (
          <>
            <Card>
              <CardTitle>النطاقات (Zones)</CardTitle>
              <div className="space-y-2 p-3 pt-0">
                {fences.zones.map((z) => (
                  <div key={z.id} className="rounded-xl p-3" style={{ background: 'var(--deep)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-bold">{z.name}</div>
                        <div className="muted" style={{ fontSize: '.72rem' }}>
                          {z.shape === 'CIRCLE' ? <>دائرة <Num>{(z.radiusM ?? 0) / 1000}</Num> كم</> : <><Num>{z.polygon?.length ?? 0}</Num> نقطة</>} · {z.city} · <Num>{z.driverCount}</Num> سواق
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <Btn size="sm" onClick={() => setDraft(z.shape === 'CIRCLE' ? { mode: 'edit-circle', id: z.id, kind: 'zone', center: [z.lat, z.lng], radiusM: z.radiusM ?? 1000 } : { mode: 'edit-polygon', id: z.id, kind: 'zone', vertices: z.polygon ?? [] })}>
                          تعديل
                        </Btn>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2" style={{ fontSize: '.75rem' }}>
                      <label className="flex items-center gap-2 font-bold ink2">
                        رفض خارج النطاق
                        <Toggle checked={z.strictReject} onChange={(v) => void patchZone(z, { strictReject: v })} label={`strictReject ${z.name}`} />
                      </label>
                      <span className="muted flex items-center gap-1">
                        حد <Num>{z.maxSpeedKmh ?? '—'}</Num> · توقف <Num>{z.stopAlertMin ?? '—'}</Num>د
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardTitle>المواقع (Sites)</CardTitle>
              <div className="space-y-2 p-3 pt-0">
                {fences.sites.map((s) => (
                  <div key={s.id} className="rounded-xl p-3" style={{ background: 'var(--deep)' }}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-bold">{s.name}</div>
                        <div className="muted" style={{ fontSize: '.72rem' }}>
                          <Num>{s.radiusM}</Num> م · حضور <Num>{s.attendance.present}</Num>/<Num>{s.attendance.expected}</Num>
                        </div>
                      </div>
                      <Chip tone={s.strictReject ? 'red' : 'gray'}>{s.strictReject ? 'رفض صارم' : 'تسجيل استثنائي'}</Chip>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>

      {/* map */}
      <div className="card relative min-h-[420px] lg:min-h-0 overflow-hidden">
        {res.loading ? (
          <Skeleton className="h-full" />
        ) : (
          <FenceMap
            draft={fenceDraft}
            onMapClick={onMapClick}
            onCenterMove={(ll) => {
              if (draft && (draft.mode === 'new-circle' || draft.mode === 'edit-circle')) setDraft({ ...draft, center: ll });
            }}
            onVertexMove={(i, ll) => {
              if (draft && (draft.mode === 'new-polygon' || draft.mode === 'edit-polygon')) {
                setDraft({ ...draft, vertices: draft.vertices.map((v, j) => (j === i ? ll : v)) });
              }
            }}
            onVertexRemove={() => undefined}
            onDoubleClick={onDoubleClick}
            existingCircles={circles}
            existingPolygons={polygons}
            center={fences?.sites[0] ? [fences.sites[0].lat, fences.sites[0].lng] : [30.0444, 31.2357]}
          />
        )}
      </div>

      {/* editor modal */}
      <Modal open={Boolean(draft)} onClose={() => setDraft(null)} title="حفظ النطاق">
        {draft && (
          <div className="space-y-3">
            {(draft.mode === 'new-circle' || draft.mode === 'new-polygon') && (
              <>
                <label className="label">اسم النطاق</label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="نطاق مدينة نصر" />
              </>
            )}
            {draft.mode === 'new-circle' && (
              <>
                <label className="label">
                  نصف القطر: <Num>{draft.radiusM}</Num> م
                </label>
                <input dir="ltr" type="range" min={300} max={8000} step={100} value={draft.radiusM} onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })} className="w-full accent-brand" />
              </>
            )}
            {draft.mode === 'edit-circle' && (
              <>
                <label className="label">
                  نصف القطر: <Num>{draft.radiusM}</Num> م
                </label>
                <input dir="ltr" type="range" min={300} max={8000} step={100} value={draft.radiusM} onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })} className="w-full accent-brand" />
              </>
            )}
            {draft.mode === 'new-polygon' && (
              <p className="ink2" style={{ fontSize: '.82rem' }}>
                عدد النقاط: <Num>{draft.vertices.length}</Num> — اضغط على الخريطة لإضافة، دبل كليك للإغلاق.
              </p>
            )}
            {draft.mode === 'edit-polygon' && (
              <p className="ink2" style={{ fontSize: '.82rem' }}>
                اسحب الرؤوس لتعديل الحدود، ثم احفظ.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Btn onClick={() => setDraft(null)}>إلغاء</Btn>
              <Btn variant="primary" disabled={busy || (draft.mode === 'new-polygon' && draft.vertices.length < 3)} onClick={() => void save()}>
                حفظ
              </Btn>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function centroid(vs: [number, number][]): [number, number] {
  if (!vs.length) return [30.0444, 31.2357];
  const s = vs.reduce((acc, v) => [acc[0] + v[0], acc[1] + v[1]], [0, 0]);
  return [s[0] / vs.length, s[1] / vs.length];
}
