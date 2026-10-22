import { useEffect, useState } from 'react';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import { api, downloadCsv } from '@/api/client';
import type { DailyReport, ExceptionRow, MileageRow, TimesheetRow } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { fmtDateTime, fmtTime, todayISODate } from '@/utils/format';
import { AR_ALERT_TEXT } from '@shared';
import { Btn, Card, CardTitle, Chip, EmptyState, ErrorState, Input, Kpi, Num, Skeleton } from '@/components/ui';

ChartJS.register(CategoryScale, LinearScale, BarElement, BarController, PointElement, LineElement, LineController, Tooltip, Legend);

const chartColors = (dark: boolean) => ({
  grid: dark ? 'rgba(148,163,184,.15)' : 'rgba(100,116,139,.14)',
  text: dark ? '#94a3b8' : '#64748b',
});

export default function ReportsPage() {
  const [date, setDate] = useState(todayISODate());
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const c = chartColors(dark);

  const daily = useAsync<DailyReport>(() => api.get('/reports/daily', { date }), [date]);
  const [groupBy, setGroupBy] = useState<'driver' | 'zone'>('driver');
  const mileage = useAsync<{ rows: MileageRow[]; totalKm: number }>(() => api.get('/reports/mileage', { from: date, to: date, groupBy }), [date, groupBy]);
  const exceptions = useAsync<{ rows: ExceptionRow[]; total: number; unresolved: number }>(() => api.get('/reports/exceptions', { from: date, to: date }), [date]);
  const timesheet = useAsync<{ rows: TimesheetRow[] }>(() => api.get('/reports/timesheet', { from: date, to: date }), [date]);

  useEffect(() => {
    // redraw when theme flips
  }, [dark]);

  const d = daily.data;

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2 p-3">
        <div>
          <label className="label">تاريخ التقرير</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="!w-44" />
        </div>
        <Btn onClick={() => void downloadCsv('/reports/daily', { date }, `daily-${date}.csv`)}>تصدير اليومي CSV</Btn>
      </div>

      {/* KPI cards */}
      {daily.loading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[92px]" />)}</div>
      ) : d ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
          <Kpi label="حاضرون" value={d.kpis.present} tone="green" />
          <Kpi label="غياب" value={d.kpis.absent} tone="amber" />
          <Kpi label="سواقين نشطين" value={d.kpis.activeDrivers} tone="blue" />
          <Kpi label="تنبيهات مفتوحة" value={d.kpis.openAlerts} tone="sky" />
          <Kpi label="تنبيهات حرجة" value={d.kpis.criticalAlerts} tone="violet" />
          <Kpi label="كيلومترات" value={d.kpis.kmDriven} suffix="كم" tone="green" />
          <Kpi label="استثناءات" value={d.kpis.exceptions} tone="amber" />
          <Kpi label="دقائق أوف لاين" value={d.kpis.offlineMinutes} suffix="د" tone="sky" />
        </div>
      ) : (
        <ErrorState message={daily.error ?? 'خطأ'} onRetry={daily.reload} />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* mileage chart */}
        <Card>
          <CardTitle
            action={
              <div className="flex items-center gap-1.5">
                <Btn size="sm" variant={groupBy === 'driver' ? 'primary' : 'ghost'} onClick={() => setGroupBy('driver')}>
                  بالسواق
                </Btn>
                <Btn size="sm" variant={groupBy === 'zone' ? 'primary' : 'ghost'} onClick={() => setGroupBy('zone')}>
                  بالنطاق
                </Btn>
                <Btn size="sm" onClick={() => void downloadCsv('/reports/mileage', { from: date, to: date, groupBy }, 'mileage.csv')}>
                  CSV
                </Btn>
              </div>
            }
          >
            الأميال بالكيلومتر
          </CardTitle>
          <div className="h-[280px] p-3 pt-0">
            {mileage.loading ? (
              <Skeleton className="h-full" />
            ) : mileage.data ? (
              <Bar
                data={{
                  labels: mileage.data.rows.map((r) => r.label),
                  datasets: [
                    { label: 'لحظي (كم)', data: mileage.data.rows.map((r) => +(r.km - r.replayedKm).toFixed(1)), backgroundColor: '#3b82f6', borderRadius: 6 },
                    { label: 'معاد بثه (كم)', data: mileage.data.rows.map((r) => r.replayedKm), backgroundColor: '#a78bfa', borderRadius: 6 },
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { labels: { color: c.text, font: { family: 'Cairo' } } } },
                  scales: {
                    x: { stacked: true, ticks: { color: c.text, font: { size: 10, family: 'Cairo' } }, grid: { display: false } },
                    y: { stacked: true, ticks: { color: c.text }, grid: { color: c.grid } },
                  },
                }}
              />
            ) : (
              <ErrorState message="تعذّر التحميل" onRetry={mileage.reload} />
            )}
          </div>
        </Card>

        {/* hourly positions */}
        <Card>
          <CardTitle>نقاط الموقع كل ساعة</CardTitle>
          <div className="h-[280px] p-3 pt-0">
            {d ? (
              <Line
                data={{
                  labels: d.hourlyPositions.map((h) => `${h.hour}:00`),
                  datasets: [{ label: 'نقطة', data: d.hourlyPositions.map((h) => h.count), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.15)', fill: true, tension: 0.35, pointRadius: 2 }],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: { legend: { labels: { color: c.text, font: { family: 'Cairo' } } } },
                  scales: { x: { ticks: { color: c.text, font: { size: 10 } }, grid: { display: false } }, y: { ticks: { color: c.text }, grid: { color: c.grid } } },
                }}
              />
            ) : (
              <Skeleton className="h-full" />
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* exceptions breakdown */}
        <Card>
          <CardTitle
            action={
              <Btn size="sm" onClick={() => void downloadCsv('/reports/exceptions', { from: date, to: date }, 'exceptions.csv')}>
                CSV
              </Btn>
            }
          >
            breakdown الاستثناءات
          </CardTitle>
          <div className="space-y-1.5 p-3 pt-0">
            {exceptions.loading && <Skeleton className="h-40" />}
            {exceptions.data?.rows.map((r) => (
              <div key={r.type} className="flex items-center gap-2" style={{ fontSize: '.8rem' }}>
                <span className="w-40 truncate font-bold ink2">{r.type}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, r.count * 7)}%`, background: 'linear-gradient(to left,#3b82f6,#1d4ed8)' }}
                  />
                </div>
                <Num className="font-bold w-8 text-end">{r.count}</Num>
                {r.unresolved > 0 && (
                  <Chip tone="red">
                    <Num>{r.unresolved}</Num> بدون حل
                  </Chip>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* alerts by type */}
        <Card>
          <CardTitle>التنبيهات حسب النوع</CardTitle>
          <div className="flex flex-wrap gap-2 p-3 pt-0">
            {d?.alertsByType.map((t) => (
              <Chip key={t.type} tone={t.type === 'APP_OFFLINE' || t.type === 'GEOFENCE_EXIT' ? 'red' : t.type === 'SPEEDING' ? 'amber' : 'blue'}>
                {AR_ALERT_TEXT[t.type].title} <Num>{t.count}</Num>
              </Chip>
            ))}
            {!d && <EmptyState />}
          </div>
        </Card>
      </div>

      {/* timesheet */}
      <Card>
        <CardTitle
          action={
            <Btn size="sm" onClick={() => void downloadCsv('/reports/timesheet', { from: date, to: date }, 'timesheet.csv')}>
              CSV
            </Btn>
          }
        >
          كشف الورديات
        </CardTitle>
        <div className="overflow-x-auto p-3 pt-0">
          {timesheet.loading ? (
            <Skeleton className="h-40" />
          ) : timesheet.error ? (
            <ErrorState message={timesheet.error} onRetry={timesheet.reload} />
          ) : !timesheet.data?.rows.length ? (
            <EmptyState />
          ) : (
            <table className="w-full min-w-[640px]" style={{ fontSize: '.8rem' }}>
              <thead>
                <tr className="border-b muted" style={{ borderColor: 'var(--line)', fontSize: '.74rem' }}>
                  <th className="p-2 text-start">الشخص</th>
                  <th className="p-2 text-start">اليوم</th>
                  <th className="p-2 text-start">ان</th>
                  <th className="p-2 text-start">أوت</th>
                  <th className="p-2 text-start">ساعات</th>
                  <th className="p-2 text-start">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {timesheet.data.rows.map((r, i) => (
                  <tr key={`${r.userId}-${r.date}`} className="border-b" style={{ borderColor: 'var(--line)', background: r.status === 'MISSING_CHECKOUT' ? '#fef3c7' : undefined }}>
                    <td className="p-2 font-bold">{r.userName}</td>
                    <td className="p-2"><Num>{r.date}</Num></td>
                    <td className="p-2"><Num>{fmtTime(r.checkIn)}</Num></td>
                    <td className="p-2"><Num>{fmtTime(r.checkOut)}</Num></td>
                    <td className="p-2"><Num>{r.hoursWorked}</Num></td>
                    <td className="p-2">
                      <Chip tone={r.status === 'VALID' ? 'green' : r.status === 'MISSING_CHECKOUT' ? 'amber' : 'red'}>{r.status === 'VALID' ? 'سليم' : r.status === 'MISSING_CHECKOUT' ? 'بدون انصراف' : 'خارج النطاق'}</Chip>
                      {r.replayed && <Chip tone="violet" className="ms-1">معاد بثه</Chip>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
      <p className="muted text-center" style={{ fontSize: '.72rem' }}>
        كل الأوقات بتوقيت القاهرة (<Num>{fmtDateTime(new Date().toISOString())}</Num> الآن)
      </p>
    </div>
  );
}
