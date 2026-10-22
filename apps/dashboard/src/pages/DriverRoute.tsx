import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '@/api/client';
import type { AlertsResponse, MapEvent, RouteResponse } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { MOTION_STATE_AR } from '@shared';
import RouteMap, { nearestPointIndex } from '@/components/maps/RouteMap';
import { MOTION_COLORS, eventGlyph } from '@/components/maps/icons';
import { Btn, Chip, ErrorState, IconBtn, Num, Skeleton } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { fmtTime, todayISODate } from '@/utils/format';
import { subscribeRoute } from '@/realtime/socket';

const SPEEDS = [1, 2, 4, 8, 16] as const;

export default function DriverRoutePage() {
  const { userId = '' } = useParams();
  const [searchParams] = useSearchParams();
  // The live map hands over its chosen day through ?date=, so a filtered day stays filtered.
  const [date, setDate] = useState(() => searchParams.get('date') || todayISODate());
  const res = useAsync<RouteResponse>(() => api.get('/positions/route', { userId, date }), [userId, date]);
  const dayRes = useAsync<AlertsResponse>(
    () =>
      api.get('/alerts', {
        userId,
        from: `${date}T00:00:00.000Z`,
        to: `${date}T23:59:59.999Z`,
        pageSize: 200,
      }),
    [userId, date],
  );
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(4);
  const raf = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    subscribeRoute(userId);
  }, [userId]);

  useEffect(() => {
    setIdx(0);
  }, [date]);

  const route = res.data;
  const count = route?.points.length ?? 0;

  useEffect(() => {
    if (!playing || count === 0) return;
    raf.current = setInterval(() => {
      setIdx((i) => {
        if (i >= count - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, Math.max(40, 400 / speed));
    return () => {
      if (raf.current) clearInterval(raf.current);
    };
  }, [playing, speed, count]);

  const current = route?.points[Math.min(idx, Math.max(0, count - 1))];
  const replayedPct = route && count ? Math.round((route.replayedPoints / count) * 100) : 0;

  const motionRuns = useMemo(() => {
    if (!route) return [];
    const runs: { state: keyof typeof MOTION_COLORS; from: number; to: number }[] = [];
    route.points.forEach((p, i) => {
      const last = runs[runs.length - 1];
      if (last && last.state === p.motionState) last.to = i;
      else runs.push({ state: p.motionState, from: i, to: i });
    });
    return runs;
  }, [route]);

  const events = useMemo<MapEvent[]>(
    () =>
      (dayRes.data?.alerts ?? dayRes.data?.data ?? [])
        .filter((a) => Number.isFinite(a.meta?.lat) && Number.isFinite(a.meta?.lng))
        .map((a) => ({
          id: a.id,
          type: a.type,
          lat: a.meta.lat as number,
          lng: a.meta.lng as number,
          title: a.title,
          ts: a.createdAt,
          severity: a.severity,
        })),
    [dayRes.data],
  );

  // Pin each event on the point it happened at, so its symbol sits on the day's line, not in a list.
  const marks = useMemo(() => {
    if (!route || count < 2) return [];
    return events.map((ev) => ({ ev, at: (nearestPointIndex(route, ev.ts) / (count - 1)) * 100 }));
  }, [route, count, events]);

  if (res.loading) {
    return (
      <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
        <Skeleton className="min-h-[300px]" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (res.error || !route) {
    return <ErrorState message={res.error ?? 'لا يوجد خط سير'} onRetry={res.reload} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* header strip */}
      <div className="card flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/live" className="btn btn-ghost !min-h-[40px] !px-3" title="رجوع">
            →
          </Link>
          <div className="min-w-0">
            <h2 className="truncate font-extrabold">{route.userName}</h2>
            <span className="muted" style={{ fontSize: '.75rem' }}>
              خط سير يوم <Num>{date}</Num> · <Num>{route.distanceKm}</Num> كم · <Num>{route.points.length}</Num> نقطة
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            dir="ltr"
            type="date"
            value={date}
            max={todayISODate()}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="input !h-9 !w-auto px-2 py-0"
            aria-label="اختيار اليوم"
          />
          {route.replayedPoints > 0 && (
            <Chip tone="violet" title="وصلت هذه النقاط من المخزن المحلي أوف لاين">
              معاد بثه <Num>{replayedPct}%</Num>
            </Chip>
          )}
          {route.gaps.length > 0 && (
            <Chip tone="amber">
              <Num>{route.gaps.length}</Num> فجوات
            </Chip>
          )}
          {route.stops.length > 0 && (
            <Chip tone="gray">
              <Num>{route.stops.length}</Num> توقفات
            </Chip>
          )}
          {events.length > 0 && (
            <Chip tone="red" title="أحداث اليوم المرشومة على الخط">
              <Num>{events.length}</Num> حدث
            </Chip>
          )}
        </div>
      </div>

      {/* map */}
      <div className="card relative min-h-0 flex-1 overflow-hidden">
        <RouteMap route={route} index={idx} events={events} onSelectPoint={setIdx} />
        {current && (
          <div className="card absolute bottom-3 start-3 z-[500] px-3 py-2" style={{ fontSize: '.78rem' }}>
            <div className="flex items-center gap-3">
              <b className="num">{fmtTime(current.clientTs)}</b>
              <Chip tone={current.buffered ? 'violet' : 'blue'}>{current.buffered ? 'من المخزن المحلي' : 'لحظي'}</Chip>
              <span>
                <Num>{Math.round(current.speedKmh)}</Num> كم/س — {MOTION_STATE_AR[current.motionState]}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* playback controls + motion timeline */}
      <div className="card space-y-2 p-3">
        <div className="flex items-center gap-3">
          <IconBtn onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'إيقاف' : 'تشغيل'}>
            <Icon name={playing ? 'pause' : 'play'} />
          </IconBtn>
          <input
            dir="ltr"
            type="range"
            min={0}
            max={Math.max(0, count - 1)}
            value={idx}
            onChange={(e) => setIdx(Number(e.target.value))}
            className="h-2 flex-1 cursor-pointer accent-brand"
            aria-label="شريط التشغيل"
          />
          <div className="flex items-center gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={`rounded-lg px-2 py-1 font-bold ${speed === s ? 'text-white' : 'muted'}`}
                style={{ fontSize: '.72rem', background: speed === s ? 'linear-gradient(to left,#3b82f6,#1d4ed8)' : 'transparent' }}
              >
                <Num>{s}</Num>×
              </button>
            ))}
          </div>
          <Btn size="sm" onClick={() => setIdx(0)}>
            للبداية
          </Btn>
        </div>

        {/* motion-state timeline under the map, with every abnormal event pinned at its own spot */}
        <div className="relative pt-5" dir="ltr">
          {marks.map(({ ev, at }) => (
            <button
              key={ev.id}
              type="button"
              onClick={() => setIdx(nearestPointIndex(route, ev.ts))}
              className="absolute top-0 -translate-x-1/2 leading-none transition-transform hover:scale-125"
              style={{ left: `${at}%`, fontSize: '14px' }}
              title={`${ev.title} — ${fmtTime(ev.ts)}`}
              aria-label={ev.title}
            >
              {eventGlyph(ev.type)}
            </button>
          ))}
          <div className="flex h-3 overflow-hidden rounded-full" title="تسلسل حالات الحركة">
            {motionRuns.map((r, i) => (
              <div
                key={i}
                style={{
                  width: `${((r.to - r.from + 1) / count) * 100}%`,
                  background: MOTION_COLORS[r.state],
                  opacity: idx >= r.from && idx <= r.to ? 1 : 0.45,
                }}
              />
            ))}
          </div>
          <div
            className="absolute bottom-[-3px] h-[18px] w-[3px] -translate-x-1/2 rounded-full bg-brand-700"
            style={{ left: `${(idx / Math.max(1, count - 1)) * 100}%` }}
            aria-hidden="true"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3" style={{ fontSize: '.72rem' }}>
          {(['WALKING', 'RIDING', 'STOPPED', 'UNKNOWN'] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: MOTION_COLORS[s] }} />
              {MOTION_STATE_AR[s]}
            </span>
          ))}
          <span className="muted ms-auto">
            النقطة <Num>{idx + 1}</Num> من <Num>{count}</Num>
          </span>
        </div>
      </div>
    </div>
  );
}
