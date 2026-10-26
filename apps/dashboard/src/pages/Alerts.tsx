import { useMemo, useState } from 'react';
import { api } from '@/api/client';
import type { AlertPayload } from '@/api/types';
import { ALERT_TYPES, AR_ALERT_TEXT } from '@shared';
import { useAsync, useNow } from '@/hooks/useAsync';
import { ageMin, fmtDateTime, todayISODate, waLink } from '@/utils/format';
import { AlertStatusChip, Btn, Chip, EmptyState, ErrorState, Input, Modal, Num, Select, SeverityChip, Skeleton, statusTone } from '@/components/ui';
import { canManageAlerts } from '@/stores/auth';
import { useAlertFeed, useUi } from '@/stores/ui';

interface Filters {
  status: string;
  type: string;
  severity: string;
  userId: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { status: 'OPEN', type: '', severity: '', userId: '', from: '', to: '' };

function slaTone(a: AlertPayload, now: number): 'green' | 'amber' | 'red' {
  if (a.status === 'RESOLVED') return 'green';
  const m = ageMin(a.createdAt, now);
  if (a.severity === 'CRITICAL') return m > 15 ? 'red' : m > 5 ? 'amber' : 'green';
  return m > 60 ? 'red' : m > 30 ? 'amber' : 'green';
}

export default function AlertsPage() {
  const [f, setF] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolveTarget, setResolveTarget] = useState<AlertPayload | null>(null);
  const [callTarget, setCallTarget] = useState<AlertPayload | null>(null);
  const now = useNow(30000);
  const canAct = canManageAlerts();
  const pushToast = useUi((s) => s.pushToast);

  const res = useAsync<{ alerts: AlertPayload[] }>(() => {
    const q: Record<string, string> = {};
    if (applied.status) q.status = applied.status;
    if (applied.type) q.type = applied.type;
    if (applied.severity) q.severity = applied.severity;
    if (applied.userId) q.userId = applied.userId;
    if (applied.from) q.from = applied.from;
    if (applied.to) q.to = applied.to;
    return api.get('/alerts', q);
  }, [applied]);

  const alerts = res.data?.alerts ?? [];

  const ack = async (id: string) => {
    try {
      await api.post(`/alerts/${id}/ack`, {});
      useAlertFeed.getState().updateAlert(id, { status: 'ACK' });
      res.reload();
    } catch {
      pushToast({ title: 'فشل الاستلام', kind: 'error' });
    }
  };

  const bulkAck = async () => {
    await Promise.allSettled(Array.from(selected).map((id) => api.post(`/alerts/${id}/ack`, {})));
    setSelected(new Set());
    res.reload();
  };

  const total = alerts.length;

  return (
    <div className="space-y-3">
      {/* filters */}
      <div className="card grid grid-cols-2 gap-2 p-3 md:grid-cols-3 lg:grid-cols-7">
        <div>
          <label className="label">الحالة</label>
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">الكل</option>
            <option value="OPEN">مفتوح</option>
            <option value="ACK">تم الاستلام</option>
            <option value="RESOLVED">تم الحل</option>
          </Select>
        </div>
        <div>
          <label className="label">النوع</label>
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="">الكل</option>
            {ALERT_TYPES.map((t) => (
              <option key={t} value={t}>
                {AR_ALERT_TEXT[t].title}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="label">الخطورة</label>
          <Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
            <option value="">الكل</option>
            <option value="CRITICAL">حرج</option>
            <option value="WARNING">تحذير</option>
            <option value="INFO">معلومة</option>
          </Select>
        </div>
        <div>
          <label className="label">السائق (ID)</label>
          <Input value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} placeholder="u-ahmed" />
        </div>
        <div>
          <label className="label">من</label>
          <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </div>
        <div>
          <label className="label">إلى</label>
          <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <div className="col-span-2 flex items-end gap-2 md:col-span-1">
          <Btn variant="primary" onClick={() => setApplied(f)}>
            تصفية
          </Btn>
          <Btn
            size="sm"
            onClick={() => {
              const d = todayISODate();
              const nf = { ...EMPTY, status: 'OPEN', from: d, to: d };
              setF(nf);
              setApplied(nf);
            }}
          >
            اليوم
          </Btn>
        </div>
      </div>

      {/* toolbar */}
      <div className="card flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="ink2 font-bold" style={{ fontSize: '.82rem' }}>
          <Num>{total}</Num> تنبيه
          {selected.size > 0 && <> · محدد <Num>{selected.size}</Num></>}
        </span>
        {canAct && selected.size > 0 && (
          <Btn size="sm" variant="primary" onClick={bulkAck}>
            استلام المحدد
          </Btn>
        )}
      </div>

      {/* table */}
      <div className="card overflow-x-auto">
        {res.loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : res.error ? (
          <ErrorState message={res.error} onRetry={res.reload} />
        ) : !alerts.length ? (
          <EmptyState title="لا توجد تنبيهات مطابقة" hint="وسّع عوامل التصفية" />
        ) : (
          <table className="w-full min-w-[820px] text-start" style={{ fontSize: '.82rem' }}>
            <thead>
              <tr className="border-b text-start muted" style={{ borderColor: 'var(--line)', fontSize: '.74rem' }}>
                {canAct && (
                  <th className="p-2.5 w-9">
                    <input
                      type="checkbox"
                      aria-label="تحديد الكل"
                      checked={selected.size === alerts.filter((a) => a.status === 'OPEN').length && selected.size > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(alerts.filter((a) => a.status === 'OPEN').map((a) => a.id)) : new Set())}
                    />
                  </th>
                )}
                <th className="p-2.5 text-start">التنبيه</th>
                <th className="p-2.5 text-start">الشخص</th>
                <th className="p-2.5 text-start">الخطورة</th>
                <th className="p-2.5 text-start">الحالة</th>
                <th className="p-2.5 text-start">العمر</th>
                <th className="p-2.5 text-start">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <AlertRow
                  key={a.id}
                  a={a}
                  now={now}
                  canAct={canAct}
                  expanded={expanded === a.id}
                  onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                  selected={selected.has(a.id)}
                  onSelect={(v) => {
                    const n = new Set(selected);
                    if (v) n.add(a.id);
                    else n.delete(a.id);
                    setSelected(n);
                  }}
                  onAck={() => void ack(a.id)}
                  onResolve={() => setResolveTarget(a)}
                  onCall={() => setCallTarget(a)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ResolveModal alert={resolveTarget} onClose={() => setResolveTarget(null)} onDone={res.reload} />
      <CallLogModal alert={callTarget} onClose={() => setCallTarget(null)} onDone={res.reload} />
    </div>
  );
}

function AlertRow({
  a,
  now,
  canAct,
  expanded,
  onToggle,
  selected,
  onSelect,
  onAck,
  onResolve,
  onCall,
}: {
  a: AlertPayload;
  now: number;
  canAct: boolean;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: (v: boolean) => void;
  onAck: () => void;
  onResolve: () => void;
  onCall: () => void;
}) {
  const tone = slaTone(a, now);
  const meta = a.meta;
  return (
    <>
      <tr className="border-b hover:bg-brand-50/60 dark:hover:bg-[#1a2744]" style={{ borderColor: 'var(--line)' }}>
        {canAct && (
          <td className="p-2.5">
            {a.status === 'OPEN' ? (
              <input type="checkbox" aria-label={`تحديد ${a.id}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
            ) : null}
          </td>
        )}
        <td className="p-2.5">
          <button type="button" onClick={onToggle} className="flex items-center gap-1.5 text-start font-bold">
            <span className={`transition-transform ${expanded ? 'rotate-180' : ''} muted`}>▾</span>
            {a.title}
          </button>
        </td>
        <td className="p-2.5">
          <div className="font-bold">{a.userName}</div>
          <div className="muted num" dir="ltr" style={{ fontSize: '.72rem' }}>
            {a.phone}
          </div>
        </td>
        <td className="p-2.5">
          <SeverityChip severity={a.severity} />
        </td>
        <td className="p-2.5">
          <AlertStatusChip status={a.status} />
        </td>
        <td className="p-2.5">
          <Chip tone={statusTone(a.status) === 'green' && tone === 'green' ? tone : tone}>
            <Num>{ageMin(a.createdAt, now)}</Num> د
          </Chip>
        </td>
        <td className="p-2.5">
          {canAct && (
            <div className="flex flex-wrap items-center gap-1.5">
              {a.status === 'OPEN' && (
                <Btn size="sm" onClick={onAck}>
                  استلام
                </Btn>
              )}
              {a.status !== 'RESOLVED' && (
                <Btn size="sm" variant="primary" onClick={onResolve}>
                  حل
                </Btn>
              )}
              <Btn size="sm" onClick={onCall}>
                اتصال
              </Btn>
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b bg-brand-50/50 dark:bg-[#0f172a]" style={{ borderColor: 'var(--line)' }}>
          <td colSpan={8}>
            <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4" style={{ fontSize: '.78rem' }}>
              <Meta label="السرعة" value={meta.speedKmh !== undefined ? <><Num>{meta.speedKmh}</Num> كم/س</> : '—'} />
              <Meta label="الحد" value={meta.threshold !== undefined ? <><Num>{meta.threshold}</Num> كم/س</> : '—'} />
              <Meta label="مدة التوقف" value={meta.stopDurationS !== undefined ? <><Num>{Math.round(meta.stopDurationS / 60)}</Num> د</> : '—'} />
              <Meta label="أوف لاين منذ" value={meta.offlineSince ? <Num>{fmtDateTime(meta.offlineSince)}</Num> : '—'} />
              <Meta label="نقاط بالمخزن" value={meta.bufferCount !== undefined ? <Num>{meta.bufferCount}</Num> : '—'} />
              <Meta label="إحداثيات" value={meta.lat !== undefined ? <span dir="ltr" className="num">{meta.lat?.toFixed(4)}, {meta.lng?.toFixed(4)}</span> : '—'} />
              <Meta label="النطاق" value={meta.fenceName ?? '—'} />
              <Meta label="المسافة للمركز" value={meta.distanceToCenterM !== undefined ? <><Num>{meta.distanceToCenterM}</Num> م</> : '—'} />
              <Meta label="واتساب" value={a.channel.whatsapp ?? '—'} />
              <Meta label="أنشئ" value={<Num>{fmtDateTime(a.createdAt)}</Num>} />
              {a.ackAt && <Meta label="استلام بواسطة" value={`${a.ackBy ?? ''} · ${fmtDateTime(a.ackAt)}`} />}
            </div>
            <div className="flex gap-2 px-3 pb-3">
              <a href={waLink(a.phone)} target="_blank" rel="noreferrer" className="btn btn-ghost !min-h-[40px] text-green-700">
                فتح واتساب
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl p-2" style={{ background: 'var(--deep)' }}>
      <span className="label !mb-0">{label}</span>
      <span className="font-bold ink2">{value}</span>
    </div>
  );
}

function ResolveModal({ alert, onClose, onDone }: { alert: AlertPayload | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  if (!alert) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/alerts/${alert.id}/resolve`, { note });
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`حل التنبيه — ${alert.title}`}>
      <div className="space-y-3">
        <label className="label">ملاحظة الحل (اختيارية)</label>
        <textarea className="input w-full min-h-[88px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ما الذي تم؟" />
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>إلغاء</Btn>
          <Btn variant="primary" disabled={busy} onClick={() => void submit()}>
            تأكيد الحل
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function CallLogModal({ alert, onClose, onDone }: { alert: AlertPayload | null; onClose: () => void; onDone: () => void }) {
  const [called, setCalled] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useMemo(() => (alert?.meta as Record<string, unknown> | undefined)?.callLog as { called: boolean; note: string; at: string } | undefined, [alert]);
  if (!alert) return null;
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/alerts/${alert.id}/call-log`, { called, note });
      onDone();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`سجل الاتصال — ${alert.userName}`}>
      <div className="space-y-3">
        {log && (
          <p className="rounded-xl bg-brand-soft px-3 py-2 text-brand-800 dark:bg-[#1a2744] dark:text-brand-200" style={{ fontSize: '.8rem' }}>
            آخر ملاحظة: {log.called ? 'تم الاتصال ✓' : 'لم يتم الاتصال'} — {log.note} (<Num>{fmtDateTime(log.at)}</Num>)
          </p>
        )}
        <div className="flex gap-2">
          <Btn size="sm" variant={called ? 'primary' : 'ghost'} onClick={() => setCalled(true)}>
            تم الاتصال ✓
          </Btn>
          <Btn size="sm" variant={!called ? 'danger' : 'ghost'} onClick={() => setCalled(false)}>
            لم يتم الاتصال
          </Btn>
        </div>
        <label className="label">ملاحظة</label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="رد السائق / لم يرد…" />
        <div className="flex justify-end gap-2">
          <Btn onClick={onClose}>إلغاء</Btn>
          <Btn variant="primary" disabled={busy} onClick={() => void submit()}>
            حفظ
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
