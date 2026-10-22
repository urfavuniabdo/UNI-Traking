import { useState } from 'react';
import { api, downloadCsv } from '@/api/client';
import type { AttendanceRecord, AttendanceStatus } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { fmtDistance, fmtTime, todayISODate } from '@/utils/format';
import { Btn, Chip, EmptyState, ErrorState, Input, Num, Select, Skeleton } from '@/components/ui';

/** A LEAVE row is synthesised from an approved request (§3) — it has no check-in at all. */
const STATUS_AR: Record<AttendanceStatus, { label: string; tone: 'green' | 'red' | 'amber' | 'gray' | 'violet' }> = {
  VALID: { label: 'سليم', tone: 'green' },
  OUT_OF_FENCE: { label: 'خارج النطاق', tone: 'red' },
  MISSING_CHECKOUT: { label: 'بدون انصراف', tone: 'amber' },
  AUTO_CLOSED: { label: 'أُغلق تلقائيًا', tone: 'gray' },
  LEAVE: { label: 'إجازة معتمدة', tone: 'violet' },
};

interface AttResponse {
  records: AttendanceRecord[];
  total: number;
  stats: {
    present: number;
    missingCheckout: number;
    outOfFence: number;
    onLeave: number;
    sites: { id: string; name: string; present: number; expected: number }[];
    zones: { id: string; name: string; present: number }[];
  };
}

export default function AttendancePage() {
  const [date, setDate] = useState(todayISODate());
  const [siteId, setSiteId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [status, setStatus] = useState('');
  const [busyCsv, setBusyCsv] = useState(false);

  const res = useAsync<AttResponse>(() => {
    const q: Record<string, string> = { from: date, to: date };
    if (siteId) q.siteId = siteId;
    if (zoneId) q.zoneId = zoneId;
    if (status) q.status = status;
    return api.get('/attendance', q);
  }, [date, siteId, zoneId, status]);

  const rows = res.data?.records ?? [];
  const stats = res.data?.stats;

  return (
    <div className="space-y-3">
      <div className="card grid grid-cols-2 gap-2 p-3 md:grid-cols-5">
        <div>
          <label className="label">اليوم</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">الموقع</label>
          <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">كل المواقع</option>
            {stats?.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="label">النطاق</label>
          <Select value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            <option value="">كل النطاقات</option>
            {stats?.zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="label">الحالة</label>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">الكل</option>
            <option value="VALID">سليم</option>
            <option value="OUT_OF_FENCE">خارج النطاق</option>
            <option value="MISSING_CHECKOUT">بدون انصراف</option>
            <option value="LEAVE">إجازة معتمدة</option>
          </Select>
        </div>
        <div className="col-span-2 flex items-end md:col-span-1">
          <Btn
            variant="primary"
            disabled={busyCsv}
            onClick={async () => {
              setBusyCsv(true);
              try {
                await downloadCsv('/attendance', { from: date, to: date, siteId, zoneId, status }, `attendance-${date}.csv`);
              } finally {
                setBusyCsv(false);
              }
            }}
          >
            تصدير CSV
          </Btn>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="card p-3 text-center" style={{ background: '#e9f8ef', borderColor: 'transparent' }}>
            <div className="label !mb-0">حاضرون</div>
            <div className="font-extrabold text-xl"><Num>{stats.present}</Num></div>
          </div>
          <div className="card p-3 text-center" style={{ background: '#fdf2e6', borderColor: 'transparent' }}>
            <div className="label !mb-0">خارج النطاق</div>
            <div className="font-extrabold text-xl"><Num>{stats.outOfFence}</Num></div>
          </div>
          <div className="card p-3 text-center" style={{ background: '#f1ecfd', borderColor: 'transparent' }}>
            <div className="label !mb-0">بدون انصراف</div>
            <div className="font-extrabold text-xl"><Num>{stats.missingCheckout}</Num></div>
          </div>
          <div className="card p-3 text-center" style={{ background: '#dbeafe', borderColor: 'transparent' }}>
            <div className="label !mb-0">في إجازة</div>
            <div className="font-extrabold text-xl"><Num>{stats.onLeave}</Num></div>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        {res.loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : res.error ? (
          <ErrorState message={res.error} onRetry={res.reload} />
        ) : !rows.length ? (
          <EmptyState title="لا سجلات حضور لهذا اليوم" />
        ) : (
          <table className="w-full min-w-[760px]" style={{ fontSize: '.82rem' }}>
            <thead>
              <tr className="border-b muted" style={{ borderColor: 'var(--line)', fontSize: '.74rem' }}>
                <th className="p-2.5 text-start">الشخص</th>
                <th className="p-2.5 text-start">الموقع / النطاق</th>
                <th className="p-2.5 text-start">بدء اليوم</th>
                <th className="p-2.5 text-start">إنهاء اليوم</th>
                <th className="p-2.5 text-start">حالة الحضور</th>
                <th className="p-2.5 text-start">المسافة للنطاق</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const onLeave = r.checkInStatus === 'LEAVE';
                const missingOut = Boolean(r.checkInTs) && !r.checkOutTs;
                const st = STATUS_AR[r.checkInStatus] ?? { label: r.checkInStatus, tone: 'gray' as const };
                return (
                  <tr
                    key={r.id}
                    className="border-b"
                    style={{ borderColor: 'var(--line)', background: missingOut ? '#fef3c7' : onLeave ? '#eff6ff' : undefined }}
                  >
                    <td className="p-2.5 font-bold">
                      {r.userName}
                      {r.replayed && (
                        <Chip tone="violet" className="ms-2">
                          معاد بثه
                        </Chip>
                      )}
                    </td>
                    <td className="p-2.5 ink2">{r.siteName ?? r.zoneName ?? '—'}</td>
                    <td className="p-2.5">
                      {onLeave ? <span className="muted">—</span> : <Num>{fmtTime(r.checkInTs)}</Num>}
                    </td>
                    <td className="p-2.5">
                      {missingOut ? (
                        <b style={{ color: '#b45309' }}>مفتوح — بدون انصراف</b>
                      ) : onLeave ? (
                        <span className="muted">—</span>
                      ) : (
                        <Num>{fmtTime(r.checkOutTs)}</Num>
                      )}
                    </td>
                    <td className="p-2.5">
                      <Chip tone={st.tone}>{st.label}</Chip>
                      {r.fenceName && <span className="muted ms-2" style={{ fontSize: '.72rem' }}>{r.fenceName}</span>}
                    </td>
                    <td className="p-2.5">
                      {r.distanceToCenterM !== null && r.distanceToCenterM !== undefined ? (
                        <Num>{fmtDistance(r.distanceToCenterM)}</Num>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
