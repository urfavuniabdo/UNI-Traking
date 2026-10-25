import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import type { AlertPayload, AlertsResponse, Employee, FencesResponse, LivePosition, MapEvent, RoutePoint, RouteResponse, TrailsResponse } from '@/api/types';
import { useAlertFeed, useLive } from '@/stores/ui';
import { useAsync, useNow } from '@/hooks/useAsync';
import { fmtTime, timeAgo, todayISODate, waLink, telLink } from '@/utils/format';
import LiveMap, { type BoardTrail, type TrailLayer } from '@/components/maps/LiveMap';
import { eventGlyph } from '@/components/maps/icons';
import { Btn, Chip, EmptyState, ErrorState, LiveSpeed, MotionChip, Num, Select, SeverityChip, Skeleton } from '@/components/ui';
import { Icon } from '@/components/Icon';

/** Each present driver keeps his own colour, picked from his id so a poll never repaints the map. */
const TRAIL_COLORS = ['#0ea5e9', '#7c3aed', '#f97316', '#059669', '#db2777', '#65a30d', '#0891b2', '#b45309'];
const colorOf = (id: string): string => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return TRAIL_COLORS[h % TRAIL_COLORS.length];
};

export default function LivePage() {
  const positions = useLive((s) => s.positions);
  const applyPosition = useLive((s) => s.applyPosition);
  const setFences = useLive((s) => s.setFences);
  const fences = useLive((s) => s.fences);
  const feed = useAlertFeed((s) => s.feed);
  const [focus, setFocus] = useState<string | null>(null);
  const [date, setDate] = useState<string>(() => todayISODate());
  const [fitSignal, setFitSignal] = useState(0);
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [liveTrail, setLiveTrail] = useState<[number, number][]>([]);
  const now = useNow(10000);
  const snapshotTs = useRef('');

  const isToday = date === todayISODate();

  // seed once, then socket `position:update` keeps the store fresh
  const boot = useAsync<{ positions: LivePosition[] }>(
    () => api.get('/positions/live'),
    [],
  );
  useEffect(() => {
    if (boot.data) for (const p of boot.data.positions) applyPosition(p);
  }, [boot.data, applyPosition]);

  const fenceBoot = useAsync<FencesResponse>(() => api.get('/places/fences'), []);
  useEffect(() => {
    if (fenceBoot.data) setFences(fenceBoot.data);
  }, [fenceBoot.data, setFences]);

  const driversRes = useAsync<{ employees: Employee[] }>(() => api.get('/employees', { role: 'DRIVER' }), []);

  // Every present driver's recent line, in one read, re-read every 30s; the socket grows it between reads.
  const trailsRes = useAsync<TrailsResponse>(() => api.get('/positions/trails', { minutes: 180 }), []);
  const [tails, setTails] = useState<Record<string, [number, number][]>>({});
  useEffect(() => {
    const t = setInterval(() => trailsRes.reload(), 30_000);
    return () => clearInterval(t);
  }, [trailsRes.reload]);
  useEffect(() => {
    const data = trailsRes.data;
    if (!data) return;
    setTails((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const trail of data.trails) {
        const p = positions[trail.userId] as LivePosition | undefined;
        if (!p || p.ts <= trail.lastTs) continue; // already inside the line the board read
        const arr = next[trail.userId] ?? [];
        const last = arr[arr.length - 1];
        if (last && last[0] === p.lat && last[1] === p.lng) continue;
        next[trail.userId] = [...arr.slice(-1500), [p.lat, p.lng]];
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [trailsRes.data, positions]);

  // The selected vehicle's day: the trail from /positions/route, the abnormal events from /alerts.
  const routeRes = useAsync<RouteResponse | null>(
    () => (focus ? api.get<RouteResponse>('/positions/route', { userId: focus, date }) : Promise.resolve(null)),
    [focus, date],
  );
  const dayRes = useAsync<AlertsResponse | null>(
    () =>
      focus
        ? api.get<AlertsResponse>('/alerts', {
            userId: focus,
            from: `${date}T00:00:00.000Z`,
            to: `${date}T23:59:59.999Z`,
            pageSize: 200,
          })
        : Promise.resolve(null),
    [focus, date],
  );
  const dayAlerts = useMemo(() => dayRes.data?.alerts ?? dayRes.data?.data ?? [], [dayRes.data]);

  useEffect(() => {
    if (routeRes.data) snapshotTs.current = new Date().toISOString();
  }, [routeRes.data]);

  // Switching vehicle or day must not carry the previous trail's live tail over.
  useEffect(() => {
    setLiveTrail([]);
    setFlyTarget(null);
    setSelectedEventId(null);
  }, [focus, date]);

  const livePos = focus ? (positions[focus] as LivePosition | undefined) : undefined;

  // Today's line keeps growing while it is on screen: anything newer than the snapshot the
  // route call took is pushed straight onto it, so the trail is live, not a 30-second-old copy.
  useEffect(() => {
    if (!focus || !livePos || !isToday) return;
    if (livePos.ts && livePos.ts <= snapshotTs.current) return;
    setLiveTrail((prev) => {
      const last = prev[prev.length - 1];
      if (last && last[0] === livePos.lat && last[1] === livePos.lng) return prev;
      return [...prev.slice(-2000), [livePos.lat, livePos.lng]];
    });
  }, [livePos, focus, isToday]);

  const trail = useMemo<TrailLayer | null>(() => {
    if (!focus) return null;
    const r = routeRes.data;
    if (!r && !liveTrail.length) return null;
    const points: [number, number][] = (r?.points ?? []).map((p) => [p.lat, p.lng] as [number, number]);
    const gaps = (r?.gaps ?? []).flatMap((g) => {
      const a = pointNear(r?.points ?? [], g.fromTs, 'before');
      const b = pointNear(r?.points ?? [], g.toTs, 'after');
      return a && b ? [{ from: a, to: b, minutes: g.minutes }] : [];
    });
    const events: MapEvent[] = dayAlerts
      .filter((a) => Number.isFinite(a.meta?.lat) && Number.isFinite(a.meta?.lng))
      .map((a) => ({
        id: a.id,
        type: a.type,
        lat: a.meta.lat as number,
        lng: a.meta.lng as number,
        title: a.title,
        ts: a.createdAt,
        severity: a.severity,
      }));
    return {
      points: liveTrail.length ? [...points, ...liveTrail] : points,
      stops: (r?.stops ?? []).map((s) => ({ lat: s.lat, lng: s.lng, durationMin: s.durationMin, kind: s.kind, startTs: s.startTs })),
      gaps,
      events,
    };
  }, [focus, routeRes.data, liveTrail, dayAlerts]);

  const list = useMemo(() => Object.values(positions), [positions]);

  // The selected vehicle already gets his bold day line; the others are drawn in their own colour.
  const boardTrails = useMemo<BoardTrail[]>(
    () =>
      isToday
        ? (trailsRes.data?.trails ?? [])
            .filter((t) => t.userId !== focus)
            .map((t) => ({ ...t, color: colorOf(t.userId), line: [...t.line, ...(tails[t.userId] ?? [])] }))
        : [],
    [trailsRes.data, tails, focus, isToday],
  );
  const nameOf = (id: string) => driversRes.data?.employees.find((e) => e.id === id)?.name ?? id;
  const focusedEmp = focus ? driversRes.data?.employees.find((e) => e.id === focus) : undefined;

  const driverCards = useMemo(() => {
    const emps = driversRes.data?.employees.filter((e) => e.driver) ?? [];
    return emps.map((e) => ({ emp: e, pos: positions[e.id] as LivePosition | undefined }));
  }, [driversRes.data, positions]);

  const eventsOnMap = trail?.events ?? [];

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)_320px] max-lg:h-auto">
      {/* LEFT: driver cards */}
      <section className="card order-2 flex min-h-0 flex-col max-lg:order-3 lg:order-1" aria-label="السواقين">
        <div className="flex items-center justify-between border-b p-3 pb-2" style={{ borderColor: 'var(--line)' }}>
          <h2 className="font-bold">السواقين <Num className="muted">({driverCards.length})</Num></h2>
          <Chip tone="blue"><Num>{list.filter((p) => p.online).length}</Num> متصل</Chip>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-2">
          {driversRes.loading &&
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          {driversRes.error && <ErrorState message={driversRes.error} onRetry={driversRes.reload} />}
          {!driversRes.loading && !driverCards.length && <EmptyState title="لا يوجد سواقين" />}
          {driverCards.map(({ emp, pos }) => (
            <DriverCard
              key={emp.id}
              name={emp.name}
              phone={emp.phone}
              pos={pos}
              now={now}
              active={focus === emp.id}
              onFocus={() => setFocus(emp.id)}
            />
          ))}
        </div>
      </section>

      {/* CENTER: live map */}
      <section className="card order-1 relative min-h-[420px] overflow-hidden lg:min-h-0" aria-label="الخريطة الحية">
        <div className="absolute inset-x-0 top-0 z-[500] flex items-center justify-between gap-2 p-2.5">
          <div className="card flex items-center gap-2 px-3 py-1.5" style={{ fontSize: '.75rem' }}>
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-600" />
            </span>
            <b>مباشر</b>
            <span className="muted">· <Num>{list.length}</Num> سيارة على الخريطة</span>
          </div>
          <div className="card hidden items-center gap-2 px-2 py-1 sm:flex" style={{ fontSize: '.72rem' }}>
            <Chip tone="amber">ماشي</Chip>
            <Chip tone="blue">في رحلة</Chip>
            <Chip tone="red">واقف</Chip>
            <Chip tone="gray">غير معروف</Chip>
          </div>
        </div>

        {/* day + driver filter */}
        <div className="card absolute start-2 top-[58px] z-[500] flex flex-wrap items-center gap-2 p-2" style={{ fontSize: '.75rem' }}>
          <label className="ink2 font-bold" htmlFor="live-date">اليوم</label>
          <input
            id="live-date"
            dir="ltr"
            type="date"
            value={date}
            max={todayISODate()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="input !h-9 !w-auto px-2 py-0"
          />
          <label className="ink2 font-bold" htmlFor="live-driver">السواق</label>
          <Select
            id="live-driver"
            value={focus ?? ''}
            onChange={(e) => setFocus(e.target.value || null)}
            className="!h-9 !w-auto min-w-[130px] px-2 py-0"
          >
            <option value="">— كل السواقين —</option>
            {driverCards.map(({ emp }) => (
              <option key={emp.id} value={emp.id}>{emp.name}</option>
            ))}
          </Select>
          {!isToday && <Chip tone="violet">أرشيف <Num>{date}</Num></Chip>}
          {!isToday && <Btn size="sm" onClick={() => setDate(todayISODate())}>رجّع لليوم</Btn>}
          <span className="muted flex items-center gap-1.5" title="رموز الأحداث على خط السير">
            <span>🔴 سرعة</span><span>🛑 فرملة</span><span>⏸ توقف طويل</span><span>🚪 خروج نطاق</span>
          </span>
        </div>

        {boot.error ? (
          <div className="flex h-full items-center justify-center">
            <ErrorState message="تعذّر تحميل المواقع" onRetry={boot.reload} />
          </div>
        ) : (
          <LiveMap
            positions={list}
            fences={fences}
            focusUserId={focus}
            onSelect={setFocus}
            trail={trail}
            trails={boardTrails}
            fitSignal={fitSignal}
            flyTarget={flyTarget}
            selectedEventId={selectedEventId}
            onSelectEvent={setSelectedEventId}
          />
        )}

        {focus && livePos && (
          <CarDetails
            pos={livePos}
            emp={focusedEmp}
            name={nameOf(focus)}
            date={date}
            isToday={isToday}
            route={routeRes.data}
            routeLoading={routeRes.loading}
            events={dayAlerts}
            eventsOnMap={eventsOnMap.length}
            selectedEventId={selectedEventId}
            onClose={() => setFocus(null)}
            onFit={() => setFitSignal((n) => n + 1)}
            onPickEvent={(ev) => {
              setSelectedEventId(ev.id);
              if (Number.isFinite(ev.meta?.lat) && Number.isFinite(ev.meta?.lng)) {
                setFlyTarget([ev.meta.lat as number, ev.meta.lng as number]);
              }
            }}
            now={now}
          />
        )}
      </section>

      {/* RIGHT: realtime alert feed */}
      <section className="card order-3 flex min-h-0 flex-col" aria-label="التنبيهات اللحظية">
        <div className="flex items-center justify-between border-b p-3 pb-2" style={{ borderColor: 'var(--line)' }}>
          <h2 className="font-bold">التنبيهات اللحظية</h2>
          <Link to="/alerts" className="text-brand-700 font-bold hover:underline" style={{ fontSize: '.78rem' }}>
            الكل ←
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-2">
          {!feed.length && <EmptyState title="لا تنبيهات لحظية بعد" hint="ستظهر هنا فور وصولها" />}
          {feed.slice(0, 40).map((a) => (
            <AlertFeedItem key={a.id} alert={a} now={now} onFocus={() => setFocus(a.userId)} />
          ))}
        </div>
      </section>
    </div>
  );
}

/** Closest logged point to a timestamp, so a coverage gap can be drawn between real coordinates. */
function pointNear(points: RoutePoint[], ts: string, side: 'before' | 'after'): [number, number] | null {
  const target = Date.parse(ts);
  let best: RoutePoint | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of points) {
    const d = Date.parse(p.clientTs) - target;
    if (side === 'before' ? d > 0 : d < 0) continue;
    if (Math.abs(d) < bestGap) {
      bestGap = Math.abs(d);
      best = p;
    }
  }
  return best ? [best.lat, best.lng] : null;
}

function CarDetails({
  pos,
  emp,
  name,
  date,
  isToday,
  route,
  routeLoading,
  events,
  eventsOnMap,
  selectedEventId,
  onClose,
  onFit,
  onPickEvent,
  now,
}: {
  pos: LivePosition;
  emp?: Employee;
  name: string;
  date: string;
  isToday: boolean;
  route: RouteResponse | null;
  routeLoading: boolean;
  events: AlertPayload[];
  eventsOnMap: number;
  selectedEventId: string | null;
  onClose: () => void;
  onFit: () => void;
  onPickEvent: (a: AlertPayload) => void;
  now: number;
}) {
  const phone = emp?.phone ?? '';
  return (
    <div className="card absolute bottom-3 end-3 z-[500] max-h-[78%] w-[320px] overflow-y-auto p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-bold" style={{ fontSize: '.92rem' }}>🚐 {name}</h3>
          <div className="muted" style={{ fontSize: '.7rem' }} dir="ltr">
            {pos.externalId ? <span>{pos.externalId} · </span> : null}
            <span className="num">{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</span>
          </div>
        </div>
        <Btn size="sm" onClick={onClose} aria-label="إغلاق تفاصيل السيارة">✕</Btn>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <MotionChip state={pos.motionState} />
        <Chip tone="blue"><LiveSpeed state={pos.motionState} speedKmh={pos.speedKmh} /></Chip>
        <Chip tone={pos.online ? 'green' : 'red'}>{pos.online ? 'متصل' : 'غير متصل'}</Chip>
        <Chip tone={pos.gpsEnabled ? 'green' : 'red'}>GPS {pos.gpsEnabled ? '✓' : '✗'}</Chip>
        <Chip tone={pos.dataEnabled !== false ? 'green' : 'red'}>داتا {pos.dataEnabled !== false ? '✓' : '✗'}</Chip>
        <Chip tone={pos.tracking ? 'green' : 'gray'}>{pos.tracking ? 'تتبع شغّال' : 'بدون تتبع'}</Chip>
      </div>

      <div className="muted mt-2 space-y-0.5" style={{ fontSize: '.73rem' }}>
        <div>آخر نقطة: <Num>{timeAgo(pos.ts, now)}</Num> · آخر ظهور <Num>{pos.lastSeen ? timeAgo(pos.lastSeen, now) : '—'}</Num></div>
        <div>بطارية <Num>{pos.battery ?? '—'}</Num>٪ · دقة <Num>{pos.accuracy ? Math.round(pos.accuracy) : '—'}</Num> م</div>
        <div>
          النطاق: {pos.zoneName ?? '—'}{' '}
          {pos.insideZone === true && <Chip tone="green">داخل النطاق</Chip>}
          {pos.insideZone === false && <Chip tone="red">خارج النطاق</Chip>}
        </div>
        {isToday ? <Chip tone="blue">خط السير لايف</Chip> : <Chip tone="violet">خط سير يوم <Num>{date}</Num></Chip>}
      </div>

      <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)', fontSize: '.75rem' }}>
        <div className="flex items-center justify-between font-bold ink2">
          <span>خط السير</span>
          <span className="muted flex items-center gap-2">
            <Num>{route ? Math.round((route.distanceKm ?? 0) * 10) / 10 : '—'}</Num> كم ·
            <Num>{route?.pointCount ?? route?.points?.length ?? 0}</Num> نقطة
          </span>
        </div>
        {routeLoading && <Skeleton className="mt-1 h-4" />}
        {!routeLoading && !trailLength(route) && (
          <p className="muted mt-1">لا نقاط مسجّلة في اليوم ده — سيظهر الخط أول ما وصلت نقاط اليوم.</p>
        )}
        {!routeLoading && trailLength(route) > 0 && (
          <div className="muted mt-1 flex flex-wrap items-center gap-2">
            <span>⬤ <Num>{route?.stops?.length ?? 0}</Num> توقف</span>
            <span>✂️ <Num>{route?.gaps?.length ?? 0}</Num> فجوة</span>
            <span>⚑ <Num>{eventsOnMap}</Num> حدث على الخريطة</span>
            <Btn size="sm" onClick={onFit}>وسّع للخط</Btn>
          </div>
        )}
      </div>

      <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--line)' }}>
        <div className="flex items-center justify-between">
          <span className="font-bold" style={{ fontSize: '.78rem' }}>أحداث اليوم <Num className="muted">({events.length})</Num></span>
        </div>
        {!events.length && <p className="muted mt-1" style={{ fontSize: '.73rem' }}>لا أحداث في اليوم ده.</p>}
        <div className="mt-1 space-y-1">
          {events.slice(0, 30).map((a) => {
            const onMap = Number.isFinite(a.meta?.lat) && Number.isFinite(a.meta?.lng);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onPickEvent(a)}
                className={`flex w-full items-center gap-2 rounded-lg p-1.5 text-start ${selectedEventId === a.id ? 'ring-2 ring-brand-500' : ''}`}
                style={{ background: 'var(--deep)', fontSize: '.73rem' }}
                title={onMap ? 'مركزه على الخريطة' : 'حدث على الجهاز بدون إحداثيات'}
              >
                <span style={{ fontSize: '15px' }}>{eventGlyph(a.type)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{a.title}</span>
                  <span className="muted">{onMap ? '' : 'بدون موقع · '}{fmtTime(a.createdAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          to={`/live/${pos.userId}?date=${date}`}
          className="btn btn-ghost min-h-[36px] px-3 py-1 font-bold"
          style={{ fontSize: '.8rem' }}
        >
          التشغيل اليومي ←
        </Link>
        {phone && (
          <>
            <a href={waLink(phone)} target="_blank" rel="noreferrer" className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100 text-green-700" title="واتساب">
              <Icon name="whatsapp" className="h-4 w-4" />
            </a>
            <a href={telLink(phone)} className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700" title="اتصال">
              <Icon name="phone" className="h-4 w-4" />
            </a>
          </>
        )}
      </div>
    </div>
  );
}

function trailLength(route: RouteResponse | null): number {
  return route?.pointCount ?? route?.points?.length ?? 0;
}

function DriverCard({
  name,
  phone,
  pos,
  now,
  active,
  onFocus,
}: {
  name: string;
  phone: string;
  pos?: LivePosition;
  now: number;
  active: boolean;
  onFocus: () => void;
}) {
  const speed = pos?.speedKmh;
  const motion = pos?.motionState ?? 'UNKNOWN';
  const online = pos?.online ?? false;
  return (
    <div className={`card w-full p-3 transition-shadow hover:shadow-float ${active ? 'ring-2 ring-brand-500' : ''}`}>
      {/* Primary action — open this driver's details and centre the map. The button wraps only
          non-link content so no anchor ends up nested inside another clickable. */}
      <button type="button" onClick={onFocus} className="block w-full text-start" aria-label={`تمركز الخريطة على ${name}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-bold">{name}</div>
            <div className="muted truncate" style={{ fontSize: '.72rem' }} dir="ltr">
              <Num>{phone}</Num>
            </div>
          </div>
          <MotionChip state={motion} />
        </div>
        <div className="mt-2 flex items-center justify-between" style={{ fontSize: '.75rem' }}>
          <LiveSpeed state={motion} speedKmh={speed} className="ink2 font-bold" />
          <span className="muted" title="آخر ظهور">
            منذ <Num>{pos ? timeAgo(pos.lastSeen ?? pos.ts, now) : '—'}</Num>
          </span>
        </div>
      </button>
      {/* Secondary actions — sibling clickables (WhatsApp / call / route). */}
      <div className="mt-1.5 flex items-center gap-2" style={{ fontSize: '.75rem' }}>
        <span className={pos?.tracking ? 'text-green-700' : 'text-red-600 font-bold'} title="التتبع">
          تتبع {pos?.tracking ? '✓' : '✗'}
        </span>
        <span className={pos?.gpsEnabled ? 'text-green-700' : 'text-red-600 font-bold'} title="GPS">
          GPS {pos?.gpsEnabled ? '✓' : '✗'}
        </span>
        <span className={online ? 'text-green-700' : 'text-red-600 font-bold'} title="الاتصال">
          داتا {pos?.dataEnabled !== false && online ? '✓' : '✗'}
        </span>
        <span className="ms-auto flex items-center gap-2">
          <a
            href={waLink(phone)}
            target="_blank"
            rel="noreferrer"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100 text-green-700"
            title="اتصال واتساب"
          >
            <Icon name="whatsapp" className="h-4 w-4" />
          </a>
          <a
            href={telLink(phone)}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700"
            title="اتصال هاتفي"
          >
            <Icon name="phone" className="h-4 w-4" />
          </a>
        </span>
      </div>
      {pos && (
        <Link
          to={`/live/${pos.userId}`}
          className="mt-2 block text-center font-bold text-brand-700"
          style={{ fontSize: '.75rem' }}
        >
          خط سير اليوم ←
        </Link>
      )}
    </div>
  );
}

function AlertFeedItem({ alert, now, onFocus }: { alert: AlertPayload; now: number; onFocus: () => void }) {
  return (
    <button
      type="button"
      onClick={onFocus}
      className="card w-full text-start p-2.5 hover:shadow-float transition-shadow"
      style={alert.severity === 'CRITICAL' ? { borderColor: '#fecaca' } : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-bold" style={{ fontSize: '.8rem' }}>
          {alert.title}
        </span>
        <SeverityChip severity={alert.severity} />
      </div>
      <div className="mt-1 flex items-center justify-between muted" style={{ fontSize: '.72rem' }}>
        <span className="truncate">{alert.userName}</span>
        <Num>{timeAgo(alert.createdAt, now)}</Num>
      </div>
    </button>
  );
}
