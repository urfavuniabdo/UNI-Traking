import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { FencesResponse, Zone } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import FenceMap, { RADIUS_MAX_M, RADIUS_MIN_M, type FenceDraft } from '@/components/maps/FenceMap';
import { Btn, Card, CardTitle, Chip, ErrorState, Input, Num, Skeleton, Toggle } from '@/components/ui';
import { useUi } from '@/stores/ui';

type Draft =
  | { mode: 'new-circle'; target: 'site' | 'zone'; center: [number, number]; radiusM: number; name: string }
  | { mode: 'new-polygon'; target: 'site' | 'zone'; vertices: [number, number][]; name: string }
  | { mode: 'edit-circle'; id: string; kind: 'site' | 'zone'; center: [number, number]; radiusM: number; name: string }
  | { mode: 'edit-polygon'; id: string; kind: 'zone'; vertices: [number, number][]; name: string }
  | null;

/** Everything the details panel edits, held as text so typing a partial number doesn't fight the field. */
interface FenceForm {
  name: string;
  lat: string;
  lng: string;
  radiusM: string;
  maxSpeedKmh: string;
  stopAlertMin: string;
}

export default function FencesPage() {
  const res = useAsync<FencesResponse>(() => api.get('/places/fences'), []);
  const [draft, setDraft] = useState<Draft>(null);
  const [selected, setSelected] = useState<{ kind: 'site' | 'zone'; id: string } | null>(null);
  const [form, setForm] = useState<FenceForm | null>(null);
  const [armDelete, setArmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useUi((s) => s.pushToast);
  const fences = res.data;

  const circles = useMemo(() => {
    const outside = fences?.outside ?? [];
    const list: { id: string; kind: 'site' | 'zone'; name: string; center: [number, number]; radiusM: number; alarm: boolean }[] = [];
    fences?.sites.forEach((s) => list.push({ id: s.id, kind: 'site', name: s.name, center: [s.lat, s.lng], radiusM: s.radiusM, alarm: false }));
    fences?.zones.filter((z) => z.shape === 'CIRCLE').forEach((z) =>
      list.push({ id: z.id, kind: 'zone', name: z.name, center: [z.lat, z.lng], radiusM: z.radiusM ?? 1000, alarm: z.activeDriverIds.some((d) => outside.includes(d)) }),
    );
    return list;
  }, [fences]);

  const polygons = useMemo(() => {
    const outside = fences?.outside ?? [];
    return (fences?.zones ?? [])
      .filter((z) => z.shape === 'POLYGON')
      .map((z) => ({ id: z.id, kind: 'zone' as const, name: z.name, points: z.polygon ?? [], alarm: z.activeDriverIds.some((d) => outside.includes(d)) }));
  }, [fences]);

  /** The fence the panel is showing, read live from the feed so a save refreshes it. */
  const detail = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'site') return fences?.sites.find((s) => s.id === selected.id) ?? null;
    return fences?.zones.find((z) => z.id === selected.id) ?? null;
  }, [selected, fences]);

  useEffect(() => {
    if (!detail) {
      setForm(null);
      return;
    }
    setArmDelete(false);
    if ('shape' in detail) {
      setForm({
        name: detail.name,
        lat: String(detail.lat),
        lng: String(detail.lng),
        radiusM: String(detail.radiusM ?? 1000),
        maxSpeedKmh: String(detail.maxSpeedKmh ?? ''),
        stopAlertMin: String(detail.stopAlertMin ?? ''),
      });
    } else {
      setForm({ name: detail.name, lat: String(detail.lat), lng: String(detail.lng), radiusM: String(detail.radiusM), maxSpeedKmh: '', stopAlertMin: '' });
    }
    // `detail` is a fresh object only when the feed refetches, so typing is never clobbered
    // while a saved change (map drag, rule toggle) must be pulled back into the fields.
  }, [selected?.id, detail]);

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
        await api.patch(`/places/${draft.kind === 'site' ? 'sites' : 'zones'}/${draft.id}`, {
          name: draft.name || undefined,
          lat: draft.center[0],
          lng: draft.center[1],
          radiusM: draft.radiusM,
        });
      } else {
        await api.patch(`/places/zones/${draft.id}`, { name: draft.name || undefined, polygon: draft.vertices, lat: centroid(draft.vertices)[0], lng: centroid(draft.vertices)[1] });
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

  /** Write the panel back: geometry + name only, so an untouched rule field is never resent. */
  const saveDetails = async () => {
    if (!selected || !form || !detail) return;
    const isPolygon = 'shape' in detail && detail.shape === 'POLYGON';
    const lat = Number(form.lat);
    const lng = Number(form.lng);
    const radiusM = Math.round(Number(form.radiusM));
    // A polygon's geometry lives in its vertex list, so only a circle's numbers are validated here.
    if (!isPolygon && (![lat, lng, radiusM].every(Number.isFinite) || radiusM < 1)) {
      toast({ title: 'بيانات غلط', body: 'العرض والطول رقم، ونصف القطر متر أكبر من صفر', kind: 'error' });
      return;
    }
    if (!form.name.trim()) {
      toast({ title: 'الاسم مطلوب', kind: 'error' });
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = isPolygon ? { name: form.name.trim() } : { name: form.name.trim(), lat, lng, radiusM };
      if (selected.kind === 'zone') {
        body.maxSpeedKmh = form.maxSpeedKmh.trim() === '' ? null : Number(form.maxSpeedKmh);
        body.stopAlertMin = form.stopAlertMin.trim() === '' ? null : Math.round(Number(form.stopAlertMin));
      }
      await api.patch(`/places/${selected.kind === 'site' ? 'sites' : 'zones'}/${selected.id}`, body);
      toast({ title: 'تم الحفظ', kind: 'info' });
      res.reload();
    } catch {
      toast({ title: 'فشل الحفظ', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const removeFence = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.del(`/places/${selected.kind === 'site' ? 'sites' : 'zones'}/${selected.id}`);
      toast({ title: 'تم الحذف', kind: 'info' });
      setSelected(null);
      res.reload();
    } catch {
      toast({ title: 'فشل الحذف', kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** Put the selected fence into the map editor so its handles appear. */
  const editOnMap = () => {
    if (!detail) return;
    if ('shape' in detail) {
      if (detail.shape === 'POLYGON') {
        setDraft({ mode: 'edit-polygon', id: detail.id, kind: 'zone', vertices: detail.polygon ?? [], name: detail.name });
        return;
      }
      setDraft({ mode: 'edit-circle', id: detail.id, kind: 'zone', center: [detail.lat, detail.lng], radiusM: detail.radiusM ?? 1000, name: detail.name });
      return;
    }
    setDraft({ mode: 'edit-circle', id: detail.id, kind: 'site', center: [detail.lat, detail.lng], radiusM: detail.radiusM, name: detail.name });
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)] max-lg:h-auto">
      {/* list */}
      <div className="space-y-3 min-h-0 overflow-y-auto">
        <Card className="p-3">
          <p className="muted mb-2" style={{ fontSize: '.78rem' }}>
            دوس على الخريطة لعمل دائرة؛ اسحب المركز للنقل، واسحب المقبض الأزرق على الحافة لتغيير نصف القطر، أو دوس على أي نطاق محفوظ لفتح تفاصيله كاملة. للمضلع: اضغط &laquo;مضلع جديد&raquo; ثم نقاط متتالية ودبل كليك للإغلاق.
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
                  <div key={z.id} className={`rounded-xl p-3 ${selected?.id === z.id ? 'ring-2 ring-brand-500' : ''}`} style={{ background: 'var(--deep)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-bold">{z.name}</div>
                        <div className="muted" style={{ fontSize: '.72rem' }}>
                          {z.shape === 'CIRCLE' ? <>دائرة <Num>{(z.radiusM ?? 0) / 1000}</Num> كم</> : <><Num>{z.polygon?.length ?? 0}</Num> نقطة</>} · {z.city} · <Num>{z.driverCount}</Num> سواق
                        </div>
                      </div>
                      <div className="flex gap-1.5">
                        <Btn size="sm" onClick={() => setSelected({ kind: 'zone', id: z.id })}>تفاصيل</Btn>
                        <Btn size="sm" onClick={() => setDraft(z.shape === 'CIRCLE' ? { mode: 'edit-circle', id: z.id, kind: 'zone', center: [z.lat, z.lng], radiusM: z.radiusM ?? 1000, name: z.name } : { mode: 'edit-polygon', id: z.id, kind: 'zone', vertices: z.polygon ?? [], name: z.name })}>
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
                  <div key={s.id} className={`rounded-xl p-3 ${selected?.id === s.id ? 'ring-2 ring-brand-500' : ''}`} style={{ background: 'var(--deep)' }}>
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="truncate font-bold">{s.name}</div>
                        <div className="muted" style={{ fontSize: '.72rem' }}>
                          <Num>{s.radiusM}</Num> م · حضور <Num>{s.attendance.present}</Num>/<Num>{s.attendance.expected}</Num>
                        </div>
                      </div>
                      <Btn size="sm" onClick={() => setSelected({ kind: 'site', id: s.id })}>تفاصيل</Btn>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2" style={{ fontSize: '.75rem' }}>
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
            onRadiusChange={(m) => {
              if (draft && (draft.mode === 'new-circle' || draft.mode === 'edit-circle')) setDraft({ ...draft, radiusM: m });
            }}
            onSelectFence={(kind, id) => setSelected({ kind, id })}
            selectedId={selected?.id ?? null}
            onVertexMove={(i, ll) => {
              if (draft && (draft.mode === 'new-polygon' || draft.mode === 'edit-polygon')) {
                setDraft({ ...draft, vertices: draft.vertices.map((v, j) => (j === i ? ll : v)) });
              }
            }}
            onVertexRemove={(i) => {
              // Only a saved polygon loses a vertex on tap; while drawing, a tap is how you place points.
              if (draft?.mode === 'edit-polygon' && draft.vertices.length > 3) {
                setDraft({ ...draft, vertices: draft.vertices.filter((_, j) => j !== i) });
              }
            }}
            onDoubleClick={onDoubleClick}
            existingCircles={circles}
            existingPolygons={polygons}
            center={fences?.sites[0] ? [fences.sites[0].lat, fences.sites[0].lng] : [30.0444, 31.2357]}
          />
        )}

        {detail && form && (
          <div className="card absolute end-2 top-16 z-[500] max-h-[calc(100%-5rem)] w-[300px] overflow-y-auto p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="truncate font-bold" style={{ fontSize: '.9rem' }}>
                {selected?.kind === 'site' ? '🏢 موقع' : '🔵 نطاق'}
              </h3>
              <Btn size="sm" onClick={() => setSelected(null)}>✕</Btn>
            </div>

            <label className="label">{selected?.kind === 'site' ? 'اسم الموقع' : 'اسم النطاق'}</label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="نطاق مدينة نصر" />

            {'shape' in detail && detail.shape === 'POLYGON' ? (
              <p className="muted mt-2" style={{ fontSize: '.72rem' }}>
                حدود المضلع <Num>{detail.polygon?.length ?? 0}</Num> نقطة — عدّلها بسحب النقاط على الخريطة من زر «تعديل نقاط المضلع» بالأسفل.
              </p>
            ) : (
              <>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <label className="label">خط العرض</label>
                    <Input dir="ltr" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} inputMode="decimal" />
                  </div>
                  <div>
                    <label className="label">خط الطول</label>
                    <Input dir="ltr" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} inputMode="decimal" />
                  </div>
                </div>

                <label className="label mt-2 block">
                  نصف القطر (متر): <Num>{Number(form.radiusM) || 0}</Num>
                </label>
                <Input dir="ltr" value={form.radiusM} onChange={(e) => setForm({ ...form, radiusM: e.target.value })} inputMode="numeric" />
                <input
                  dir="ltr"
                  type="range"
                  min={RADIUS_MIN_M}
                  max={RADIUS_MAX_M}
                  step={50}
                  value={Number(form.radiusM) || RADIUS_MIN_M}
                  onChange={(e) => setForm({ ...form, radiusM: e.target.value })}
                  className="mt-1 w-full accent-brand"
                />
              </>
            )}

            {selected?.kind === 'zone' && 'shape' in detail && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label className="label">حد السرعة</label>
                  <Input dir="ltr" value={form.maxSpeedKmh} onChange={(e) => setForm({ ...form, maxSpeedKmh: e.target.value })} inputMode="numeric" placeholder="كم/س" />
                </div>
                <div>
                  <label className="label">تنبيه توقف (د)</label>
                  <Input dir="ltr" value={form.stopAlertMin} onChange={(e) => setForm({ ...form, stopAlertMin: e.target.value })} inputMode="numeric" placeholder="دقيقة" />
                </div>
              </div>
            )}

            <div className="muted mt-2 space-y-0.5" style={{ fontSize: '.72rem' }}>
              <div>الكود: <Num>{detail.code}</Num> · المدينة: {detail.city || '—'}</div>
              <div>
                {'shape' in detail && detail.shape === 'POLYGON'
                  ? <>مضلع <Num>{detail.polygon?.length ?? 0}</Num> نقطة</>
                  : <>دائرة على <Num>{Number(form.lat).toFixed(5)}</Num>, <Num>{Number(form.lng).toFixed(5)}</Num></>}
              </div>
              {'driverCount' in detail && (
                <div>سواقين في النطاق: <Num>{detail.driverCount}</Num>{'activeDriverIds' in detail && detail.activeDriverIds.length > 0 && <> · نشطين الآن <Num>{detail.activeDriverIds.length}</Num></>}</div>
              )}
              {'attendance' in detail && (
                <div>حضور اليوم: <Num>{detail.attendance.present}</Num>/<Num>{detail.attendance.expected}</Num> · خارج النطاق <Num>{detail.attendance.outOfFence}</Num></div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Btn variant="primary" size="sm" disabled={busy} onClick={() => void saveDetails()}>حفظ</Btn>
              <Btn size="sm" onClick={editOnMap}>
                {'shape' in detail && detail.shape === 'POLYGON' ? 'تعديل نقاط المضلع على الخريطة' : 'تحريك وتكبير على الخريطة'}
              </Btn>
            </div>
            {!armDelete ? (
              <Btn size="sm" className="mt-2 w-full" onClick={() => setArmDelete(true)}>
                {selected?.kind === 'site' ? 'حذف الموقع' : 'حذف النطاق'}
              </Btn>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <span className="ink2 font-bold" style={{ fontSize: '.75rem' }}>متأكد؟</span>
                <Btn size="sm" variant="danger" disabled={busy} onClick={() => void removeFence()}>نعم، احذف</Btn>
                <Btn size="sm" onClick={() => setArmDelete(false)}>إلغاء</Btn>
              </div>
            )}
          </div>
        )}
        {/* Editor lives in a corner card inside the map, never a modal: a full-screen dialog would
            swallow the pointer and make dragging/resizing the circle on the map impossible. */}
        {draft && (
          <div className="card absolute start-2 top-16 z-[500] w-[272px] space-y-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-bold" style={{ fontSize: '.9rem' }}>
                {draft.mode === 'new-circle'
                  ? 'دائرة نطاق جديدة'
                  : draft.mode === 'new-polygon'
                    ? 'مضلع جديد'
                    : draft.mode === 'edit-circle'
                      ? draft.kind === 'site'
                        ? 'تعديل الموقع'
                        : 'تعديل النطاق'
                      : 'تعديل المضلع'}
              </h3>
              <Btn size="sm" onClick={() => setDraft(null)} aria-label="إغلاق المحرر">✕</Btn>
            </div>

            <div>
              <label className="label" htmlFor="fence-name">اسم النطاق</label>
              <Input id="fence-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="نطاق مدينة نصر" />
            </div>

            {(draft.mode === 'new-circle' || draft.mode === 'edit-circle') && (
              <div>
                <label className="label" htmlFor="fence-radius">
                  نصف القطر: <Num>{draft.radiusM}</Num> م
                </label>
                <input
                  id="fence-radius"
                  dir="ltr"
                  type="range"
                  min={RADIUS_MIN_M}
                  max={RADIUS_MAX_M}
                  step={50}
                  value={Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, Number(draft.radiusM) || RADIUS_MIN_M))}
                  onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })}
                  className="w-full accent-brand"
                />
              </div>
            )}

            <p className="muted" style={{ fontSize: '.72rem' }}>
              {draft.mode === 'new-polygon' && (
                <>عدد النقاط: <Num>{draft.vertices.length}</Num> — دوس على الخريطة لإضافة نقطة، ودبل كليك للإغلاق.</>
              )}
              {draft.mode === 'edit-polygon' && <>اسحب الرؤوس لتعديل الحدود، ودوس على رأس لحذفه، ثم احفظ.</>}
              {draft.mode === 'edit-circle' && 'اسحب المركز للنقل، والمقبض الأزرق على الحافة للتكبير والتصغير.'}
              {draft.mode === 'new-circle' && 'دوس على الخريطة لنقل المركز، واسحب المقبض الأزرق لتحديد نصف القطر.'}
            </p>

            <div className="flex justify-end gap-2">
              <Btn size="sm" onClick={() => setDraft(null)}>إلغاء</Btn>
              <Btn size="sm" variant="primary" disabled={busy || (draft.mode === 'new-polygon' && draft.vertices.length < 3)} onClick={() => void save()}>
                حفظ
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function centroid(vs: [number, number][]): [number, number] {
  if (!vs.length) return [30.0444, 31.2357];
  const s = vs.reduce((acc, v) => [acc[0] + v[0], acc[1] + v[1]], [0, 0]);
  return [s[0] / vs.length, s[1] / vs.length];
}
