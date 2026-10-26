import { useState } from 'react';
import { api } from '@/api/client';
import type { LeaveListResponse, LeaveRequestItem } from '@/api/types';
import { LEAVE_STATUS, type LeaveStatus } from '@shared';
import { useAsync } from '@/hooks/useAsync';
import { fmtDate, fmtDateTime } from '@/utils/format';
import { Btn, Chip, EmptyState, ErrorState, Input, Kpi, Modal, Select, Skeleton } from '@/components/ui';

const STATUS_AR: Record<LeaveStatus, string> = {
  PENDING: 'بانتظار القرار',
  APPROVED: 'معتمدة',
  REJECTED: 'مرفوضة',
  CANCELLED: 'ملغاة',
};

const statusTone = (s: LeaveStatus): 'amber' | 'green' | 'red' | 'gray' =>
  s === 'APPROVED' ? 'green' : s === 'REJECTED' ? 'red' : s === 'PENDING' ? 'amber' : 'gray';

const period = (r: LeaveRequestItem): string =>
  r.dateFrom === r.dateTo ? fmtDate(`${r.dateFrom}T00:00:00`) : `${fmtDate(`${r.dateFrom}T00:00:00`)} → ${fmtDate(`${r.dateTo}T00:00:00`)}`;

/** The decision note travels with the request and is what the employee sees in his app. */
function DecisionDialog({
  row,
  approve,
  onClose,
  onDone,
}: {
  row: LeaveRequestItem;
  approve: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(`/leave/${row.id}/${approve ? 'approve' : 'reject'}`, note.trim() ? { note: note.trim() } : {});
      onDone(approve ? 'تم اعتماد الطلب — اليوم صار إجازة في الحضور' : 'تم رفض الطلب');
    } catch (e) {
      // A decided request 409s (LEAVE_ALREADY_DECIDED): keep the dialog open so the reason is readable.
      setFailure(e instanceof Error ? e.message : 'تعذّر تسجيل القرار');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={approve ? 'اعتماد إجازة' : 'رفض إجازة'}>
      <div className="space-y-3">
        <div className="rounded-xl px-3 py-2.5" style={{ background: '#f1f5f9' }}>
          <div className="font-bold">{row.employeeName ?? '—'}</div>
          <div className="muted" style={{ fontSize: '.76rem' }}>
            {period(row)} · <span className="num">{row.days}</span> يوم
          </div>
          {row.reason && <div className="mt-1.5 text-[.82rem]">{row.reason}</div>}
        </div>
        <div>
          <label className="label">ملاحظة للموظف (اختيارية)</label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="مثال: معتمدة ضمن رصيد الشهر" />
        </div>
        {failure && (
          <p className="font-bold text-[.8rem]" style={{ color: '#b91c1c' }}>
            {failure}
          </p>
        )}
        <div className="flex gap-2">
          <Btn variant={approve ? 'primary' : 'danger'} disabled={busy} onClick={() => void send()}>
            {approve ? 'اعتماد' : 'رفض'}
          </Btn>
          <Btn onClick={onClose}>إلغاء</Btn>
        </div>
      </div>
    </Modal>
  );
}

export default function LeavePage() {
  const [status, setStatus] = useState<string>(LEAVE_STATUS.PENDING);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<{ row: LeaveRequestItem; approve: boolean } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const res = useAsync<LeaveListResponse>(() => {
    const q: Record<string, string> = { page: String(page), pageSize: '50' };
    if (status) q.status = status;
    if (from) q.from = from;
    if (to) q.to = to;
    return api.get('/leave', q);
  }, [status, from, to, page]);

  const rows = res.data?.items ?? [];
  const total = res.data?.total ?? 0;
  const pageSize = res.data?.pageSize ?? 50;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="card grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
        <div>
          <label className="label">الحالة</label>
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">الكل</option>
            <option value={LEAVE_STATUS.PENDING}>بانتظار القرار</option>
            <option value={LEAVE_STATUS.APPROVED}>معتمدة</option>
            <option value={LEAVE_STATUS.REJECTED}>مرفوضة</option>
            <option value={LEAVE_STATUS.CANCELLED}>ملغاة</option>
          </Select>
        </div>
        <div>
          <label className="label">من تاريخ</label>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label className="label">إلى تاريخ</label>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="col-span-2 flex items-end md:col-span-1">
          <Btn
            onClick={() => {
              setFrom('');
              setTo('');
              setStatus('');
              setPage(1);
            }}
          >
            مسح الفلاتر
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Kpi label="بانتظار قرارك" value={res.data?.pendingCount ?? 0} tone="amber" />
        <Kpi label="إجمالي الطلبات" value={total} tone="blue" />
        <div className="hidden md:block" />
      </div>

      {toast && (
        <div className="card flex items-center justify-between gap-3 px-3 py-2 font-bold text-[.82rem]" style={{ background: '#e9f8ef', borderColor: 'transparent' }}>
          <span>{toast}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="إغلاق">
            ✕
          </button>
        </div>
      )}

      <div className="card overflow-x-auto">
        {res.loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : res.error ? (
          <ErrorState message={res.error} onRetry={res.reload} />
        ) : !rows.length ? (
          <EmptyState title="لا طلبات إجازة" hint={status === LEAVE_STATUS.PENDING ? 'لا توجد طلبات بانتظار القرار' : undefined} />
        ) : (
          <table className="w-full min-w-[860px]" style={{ fontSize: '.82rem' }}>
            <thead>
              <tr className="border-b muted" style={{ borderColor: 'var(--line)', fontSize: '.74rem' }}>
                <th className="p-2.5 text-start">الموظف</th>
                <th className="p-2.5 text-start">الفترة</th>
                <th className="p-2.5 text-start">المدة</th>
                <th className="p-2.5 text-start">السبب</th>
                <th className="p-2.5 text-start">تقديم</th>
                <th className="p-2.5 text-start">الحالة</th>
                <th className="p-2.5 text-start">القرار</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b" style={{ borderColor: 'var(--line)', background: r.status === LEAVE_STATUS.PENDING ? '#fffbeb' : undefined }}>
                  <td className="p-2.5 font-bold">
                    {r.employeeName ?? '—'}
                    {r.employeeExternalId && (
                      <span className="muted ms-2 num" style={{ fontSize: '.72rem' }}>
                        {r.employeeExternalId}
                      </span>
                    )}
                  </td>
                  <td className="p-2.5 ink2">{period(r)}</td>
                  <td className="p-2.5">
                    <span className="num">{r.days}</span> يوم
                  </td>
                  <td className="p-2.5 ink2" style={{ maxWidth: 220 }}>
                    {r.reason ?? '—'}
                  </td>
                  <td className="p-2.5 muted" style={{ fontSize: '.74rem' }}>
                    {fmtDateTime(r.requestedAt)}
                  </td>
                  <td className="p-2.5">
                    <Chip tone={statusTone(r.status)}>{STATUS_AR[r.status]}</Chip>
                  </td>
                  <td className="p-2.5">
                    {r.status === LEAVE_STATUS.PENDING ? (
                      <div className="flex gap-1.5">
                        <Btn size="sm" variant="primary" onClick={() => setDialog({ row: r, approve: true })}>
                          اعتماد
                        </Btn>
                        <Btn size="sm" variant="danger" onClick={() => setDialog({ row: r, approve: false })}>
                          رفض
                        </Btn>
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: '.74rem' }}>
                        {r.decidedByName ?? '—'} · {fmtDateTime(r.decidedAt)}
                        {r.decisionNote && <div className="ink2">{r.decisionNote}</div>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {lastPage > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Btn size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            السابق
          </Btn>
          <span className="muted text-[.78rem]">
            <span className="num">{page}</span> / <span className="num">{lastPage}</span>
          </span>
          <Btn size="sm" disabled={page >= lastPage} onClick={() => setPage((p) => p + 1)}>
            التالي
          </Btn>
        </div>
      )}

      {dialog && (
        <DecisionDialog
          row={dialog.row}
          approve={dialog.approve}
          onClose={() => setDialog(null)}
          onDone={(msg) => {
            setDialog(null);
            setToast(msg);
            res.reload();
          }}
        />
      )}
    </div>
  );
}
