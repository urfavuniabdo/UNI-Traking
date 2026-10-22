import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import type { AlertPayload, Employee, FencesResponse, LivePosition } from '@/api/types';
import { useAlertFeed, useLive } from '@/stores/ui';
import { useAsync, useNow } from '@/hooks/useAsync';
import { timeAgo, waLink, telLink } from '@/utils/format';
import LiveMap from '@/components/maps/LiveMap';
import { Chip, EmptyState, ErrorState, MotionChip, Num, SeverityChip, Skeleton } from '@/components/ui';
import { Icon } from '@/components/Icon';

export default function LivePage() {
  const positions = useLive((s) => s.positions);
  const applyPosition = useLive((s) => s.applyPosition);
  const setFences = useLive((s) => s.setFences);
  const fences = useLive((s) => s.fences);
  const feed = useAlertFeed((s) => s.feed);
  const [focus, setFocus] = useState<string | null>(null);
  const now = useNow(10000);

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

  const list = useMemo(() => Object.values(positions), [positions]);
  const nameOf = (id: string) => driversRes.data?.employees.find((e) => e.id === id)?.name ?? id;

  const driverCards = useMemo(() => {
    const emps = driversRes.data?.employees.filter((e) => e.driver) ?? [];
    return emps.map((e) => ({ emp: e, pos: positions[e.id] as LivePosition | undefined }));
  }, [driversRes.data, positions]);

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
        {boot.error ? (
          <div className="flex h-full items-center justify-center">
            <ErrorState message="تعذّر تحميل المواقع" onRetry={boot.reload} />
          </div>
        ) : (
          <LiveMap positions={list} fences={fences} focusUserId={focus} onSelect={setFocus} />
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
    <button
      type="button"
      onClick={onFocus}
      className={`card w-full text-start p-3 transition-shadow hover:shadow-float ${active ? 'ring-2 ring-brand-500' : ''}`}
    >
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
        <span className="ink2 font-bold">
          <Num>{speed !== undefined ? Math.round(speed) : '—'}</Num> كم/س
        </span>
        <span className="muted" title="آخر ظهور">
          منذ <Num>{pos ? timeAgo(pos.lastSeen ?? pos.ts, now) : '—'}</Num>
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2" style={{ fontSize: '.75rem' }}>
        <span className={pos?.tracking ? 'text-green-700' : 'text-red-600 font-bold'} title="التتبع">
          {pos?.tracking ? 'تتبع ✓' : 'تتبع ✗'}
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
            onClick={(e) => e.stopPropagation()}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-100 text-green-700"
            title="اتصال واتساب"
          >
            <Icon name="whatsapp" className="h-4 w-4" />
          </a>
          <a
            href={telLink(phone)}
            onClick={(e) => e.stopPropagation()}
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
          onClick={(e) => e.stopPropagation()}
          className="mt-2 block text-center font-bold text-brand-700"
          style={{ fontSize: '.75rem' }}
        >
          خط سير اليوم ←
        </Link>
      )}
    </button>
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
