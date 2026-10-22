import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadCsv } from '@/api/client';
import type { Employee, LivePosition } from '@/api/types';
import { useAsync, useNow } from '@/hooks/useAsync';
import { timeAgo, waLink } from '@/utils/format';
import { Chip, EmptyState, ErrorState, Input, MotionChip, Num, Skeleton } from '@/components/ui';
import { Icon } from '@/components/Icon';

export default function DriversPage() {
  const [q, setQ] = useState('');
  const now = useNow(20000);
  const res = useAsync<{ employees: Employee[]; total: number }>(() => api.get('/employees', { role: 'DRIVER' }), []);

  const list = useMemo(() => {
    const emps = res.data?.employees ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? emps.filter((e) => e.name.toLowerCase().includes(needle) || e.identifier.toLowerCase().includes(needle) || e.phone.includes(needle)) : emps;
  }, [res.data, q]);

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="w-full max-w-xs">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث بالاسم أو المعرّف أو الرقم…" aria-label="بحث" />
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="blue"><Num>{list.length}</Num> سواق</Chip>
          <Chip tone="green"><Num>{list.filter((e) => (e as Employee & { live?: LivePosition }).live?.online).length}</Num> متصل الآن</Chip>
          <button type="button" className="btn btn-ghost" onClick={() => void downloadCsv('/employees', { role: 'DRIVER' }, 'drivers.csv')}>
            تصدير CSV
          </button>
        </div>
      </div>

      {res.loading ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !list.length ? (
        <EmptyState title="لا سواقين مطابقين" />
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
          {list.map((e) => {
            const live = (e as Employee & { live?: LivePosition }).live;
            return (
              <Link key={e.id} to={`/drivers/${e.id}`} className="card p-3 hover:shadow-float transition-shadow block">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-bold">{e.name}</div>
                    <div className="muted num" dir="ltr" style={{ fontSize: '.72rem' }}>
                      {e.identifier}
                    </div>
                  </div>
                  <MotionChip state={live?.motionState ?? 'UNKNOWN'} />
                </div>
                <div className="mt-2 space-y-1" style={{ fontSize: '.75rem' }}>
                  <div className="muted">{e.zoneName ?? '—'}</div>
                  <div className="flex items-center justify-between">
                    <span className="ink2 font-bold">
                      <Num>{live ? Math.round(live.speedKmh) : '—'}</Num> كم/س
                    </span>
                    <span className="muted">منذ <Num>{live ? timeAgo(live.lastSeen, now) : '—'}</Num></span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Chip tone={live?.online ? 'green' : 'red'}>{live?.online ? 'متصل' : 'أوف لاين'}</Chip>
                    <Chip tone={live?.tracking ? 'green' : 'gray'}>{live?.tracking ? 'تتبع' : 'بدون تتبع'}</Chip>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-brand-700 font-bold">الملف ←</span>
                    <a
                      href={waLink(e.phone)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(ev) => ev.preventDefault()}
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100 text-green-700"
                      title="واتساب"
                    >
                      <Icon name="whatsapp" className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
