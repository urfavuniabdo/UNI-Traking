import { useState } from 'react';
import { api } from '@/api/client';
import type { SyncIssue, SyncMatrixRow, SyncRun, SyncSource } from '@/api/types';
import { useAsync, useNow } from '@/hooks/useAsync';
import { fmtDateTime, timeAgo } from '@/utils/format';
import { Btn, Card, CardTitle, Chip, EmptyState, ErrorState, Input, Num, Skeleton } from '@/components/ui';
import { useUi } from '@/stores/ui';

export default function SyncPage() {
  const sources = useAsync<{ sources: SyncSource[] }>(() => api.get('/sync/sources'), []);
  const runs = useAsync<{ runs: SyncRun[] }>(() => api.get('/sync/runs'), []);
  const issues = useAsync<{ issues: SyncIssue[] }>(() => api.get('/sync/issues'), []);
  const matrix = useAsync<{ rows: SyncMatrixRow[] }>(() => api.get('/sync/matrix'), []);
  const now = useNow(30000);
  const toast = useUi((s) => s.pushToast);
  const [busyRun, setBusyRun] = useState<string | null>(null);
  const [revealSecret, setRevealSecret] = useState(false);

  const runNow = async (sourceId: string) => {
    setBusyRun(sourceId);
    try {
      await api.post('/sync/runs', { sourceId });
      toast({ title: 'أُطلق التشغيل', body: 'سيظهر في السجل خلال ثوانٍ', kind: 'info' });
      setTimeout(() => {
        runs.reload();
        sources.reload();
      }, 1600);
    } finally {
      setBusyRun(null);
    }
  };

  const resolveIssue = async (id: string) => {
    await api.post(`/sync/issues/${id}/resolve`, {});
    issues.reload();
  };

  const webhookUrl = `${apiBase()}/sync/webhook?source=${sources.data?.sources[0]?.id ?? '<source-id>'}`;

  return (
    <div className="space-y-3">
      {/* sources */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {sources.loading && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-36" />)}
        {sources.error && <ErrorState message={sources.error} onRetry={sources.reload} />}
        {sources.data?.sources.map((s) => (
          <Card key={s.id} className="p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-bold">{s.name}</div>
                <div className="muted" style={{ fontSize: '.72rem' }}>
                  {s.kind.toUpperCase()} · مجدول <span className="num">{s.scheduleCron}</span>
                </div>
              </div>
              <Chip tone={s.enabled ? 'green' : 'gray'}>{s.enabled ? 'مفعّل' : 'موقوف'}</Chip>
            </div>
            <div className="muted mt-1" style={{ fontSize: '.75rem' }}>
              آخر تشغيل: {s.lastRunAt ? <>منذ <Num>{timeAgo(s.lastRunAt, now)}</Num></> : 'لم يعمل بعد'}
            </div>
            <div className="mt-2 flex gap-2">
              <Btn variant="primary" size="sm" disabled={busyRun === s.id || !s.enabled} onClick={() => void runNow(s.id)}>
                {busyRun === s.id ? 'جارٍ التشغيل…' : 'شغّل الآن'}
              </Btn>
              <Btn
                size="sm"
                onClick={async () => {
                  await api.patch(`/sync/sources/${s.id}`, { enabled: !s.enabled });
                  sources.reload();
                }}
              >
                {s.enabled ? 'إيقاف' : 'تفعيل'}
              </Btn>
            </div>
          </Card>
        ))}
        <Card className="p-3">
          <Btn variant="ghost" className="w-full h-36 flex-col">
            + مصدر جديد (SQL / REST / CSV)
          </Btn>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* runs history */}
        <Card>
          <CardTitle action={<Btn size="sm" onClick={runs.reload}>تحديث</Btn>}>سجل التشغيلات</CardTitle>
          <div className="overflow-x-auto p-3 pt-0">
            {runs.loading && <Skeleton className="h-40" />}
            {runs.error && <ErrorState message={runs.error} onRetry={runs.reload} />}
            {!runs.loading && !runs.data?.runs.length && <EmptyState />}
            {runs.data && (
              <table className="w-full min-w-[480px]" style={{ fontSize: '.78rem' }}>
                <thead>
                  <tr className="border-b muted" style={{ borderColor: 'var(--line)', fontSize: '.72rem' }}>
                    <th className="p-2 text-start">المصدر</th>
                    <th className="p-2 text-start">بدأ</th>
                    <th className="p-2">جديد</th>
                    <th className="p-2">محدّث</th>
                    <th className="p-2">بدون تغيير</th>
                    <th className="p-2">موقوف</th>
                    <th className="p-2 text-start">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.runs.map((r) => (
                    <tr key={r.id} className="border-b" style={{ borderColor: 'var(--line)' }}>
                      <td className="p-2 font-bold truncate max-w-[140px]">{r.sourceName}</td>
                      <td className="p-2 num" dir="ltr">{fmtDateTime(r.startedAt)}</td>
                      <td className="p-2 text-center"><Num>{r.created}</Num></td>
                      <td className="p-2 text-center"><Num>{r.updated}</Num></td>
                      <td className="p-2 text-center"><Num>{r.unchanged}</Num></td>
                      <td className="p-2 text-center"><Num>{r.deactivated}</Num></td>
                      <td className="p-2">
                        <Chip tone={r.status === 'SUCCESS' ? 'green' : r.status === 'FAILED' ? 'red' : 'blue'}>
                          {r.status === 'SUCCESS' ? 'نجح' : r.status === 'FAILED' ? 'فشل' : 'يعمل…'}
                        </Chip>
                        <span className="muted ms-1" style={{ fontSize: '.68rem' }}>{r.triggeredBy}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* issues */}
        <Card>
          <CardTitle>مشاكل المزامنة</CardTitle>
          <div className="space-y-2 p-3 pt-0">
            {issues.loading && <Skeleton className="h-32" />}
            {!issues.loading && !issues.data?.issues.some((i) => !i.resolved) && <EmptyState title="لا مشاكل مفتوحة" />}
            {issues.data?.issues
              .filter((i) => !i.resolved)
              .map((i) => (
                <div key={i.id} className="rounded-xl p-3" style={{ background: 'var(--deep)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <Chip tone={i.code === 'MISSING_PHONE' ? 'red' : i.code === 'IDENTIFIER_COLLISION' ? 'amber' : 'violet'}>{i.code}</Chip>
                      <div className="mt-1 font-bold truncate">
                        {i.name} <span className="muted num" style={{ fontSize: '.72rem' }}>{i.externalId}</span>
                      </div>
                      <div className="muted" style={{ fontSize: '.74rem' }}>{i.detail}</div>
                    </div>
                    <Btn size="sm" onClick={() => void resolveIssue(i.id)}>
                      حل
                    </Btn>
                  </div>
                </div>
              ))}
          </div>
        </Card>
      </div>

      {/* freshness matrix */}
      <Card>
        <CardTitle>مصفوفة حداثة البيانات</CardTitle>
        <div className="overflow-x-auto p-3 pt-0">
          {matrix.loading && <Skeleton className="h-24" />}
          {matrix.data && (
            <table className="w-full min-w-[480px]" style={{ fontSize: '.78rem' }}>
              <thead>
                <tr className="border-b muted" style={{ borderColor: 'var(--line)', fontSize: '.72rem' }}>
                  <th className="p-2 text-start">المصدر</th>
                  <th className="p-2 text-start">الحقل</th>
                  <th className="p-2 text-start">آخر مزامنة</th>
                  <th className="p-2 text-start">الحداثة</th>
                  <th className="p-2 text-start">صفوف</th>
                </tr>
              </thead>
              <tbody>
                {matrix.data.rows.map((r, i) => (
                  <tr key={i} className="border-b" style={{ borderColor: 'var(--line)' }}>
                    <td className="p-2 font-bold">{r.source}</td>
                    <td className="p-2 num" dir="ltr">{r.field}</td>
                    <td className="p-2 num" dir="ltr">{fmtDateTime(r.lastSyncAt)}</td>
                    <td className="p-2">
                      <Chip tone={r.freshnessMin < 30 ? 'green' : r.freshnessMin < 120 ? 'amber' : 'red'}>
                        <Num>{r.freshnessMin}</Num> د
                      </Chip>
                    </td>
                    <td className="p-2"><Num>{r.rows}</Num></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {/* webhook */}
      <Card>
        <CardTitle>Webhook للتغييرات اللحظية</CardTitle>
        <div className="space-y-2 p-3 pt-0" style={{ fontSize: '.8rem' }}>
          <div>
            <span className="label">رابط الاستدعاء (POST)</span>
            <input readOnly value={webhookUrl} className="input w-full num" dir="ltr" onFocus={(e) => e.target.select()} />
          </div>
          <div>
            <span className="label">سر التوقيع — هيدر <span className="num">x-sync-secret</span></span>
            <Input
              readOnly
              dir="ltr"
              value={revealSecret ? sources.data?.sources[0]?.webhookSecret ?? 'whsec_—' : '••••••••••••••'}
              onFocus={() => setRevealSecret(true)}
            />
          </div>
          <p className="muted" style={{ fontSize: '.72rem' }}>
            عند أي تغيير في قاعدة البيانات الرئيسية يُستدعى الرابط فتتم المزامنة فورًا دون انتظار الجدولة.
          </p>
        </div>
      </Card>
    </div>
  );
}

function apiBase(): string {
  return import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
}
