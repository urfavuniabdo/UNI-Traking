import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '@/api/client';
import type { AlertPayload, Employee, LivePosition, Zone } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { fmtDateTime, timeAgo, waLink } from '@/utils/format';
import { Btn, Card, CardTitle, Chip, EmptyState, ErrorState, Input, MotionChip, Num, Select, Skeleton } from '@/components/ui';
import { useUi } from '@/stores/ui';

interface EnrichedEmployee extends Employee {
  live?: LivePosition;
  zoneName?: string | null;
  siteName?: string | null;
  /** what this driver's own card saved; null fields mean the number in force is inherited */
  ruleOverride?: { maxSpeedKmh: number | null; stopAlertMin: number | null } | null;
}

export default function DriverDetailPage() {
  const { id = '' } = useParams();
  const toast = useUi((s) => s.pushToast);
  const emp = useAsync<EnrichedEmployee>(() => api.get(`/employees/${id}`), [id]);
  const zones = useAsync<{ zones: Zone[] }>(() => api.get('/places/fences'), []);
  const summary = useAsync<{ motionMinutes: { stopped: number; walking: number; riding: number }; openAlerts: number; totalAlerts: number }>(
    () => api.get(`/employees/${id}/summary`),
    [id],
  );
  const devices = useAsync<{ devices: { id: string; deviceId: string; platform: string; appVersion: string; token: string; lastSeen: string; battery?: number | null }[] }>(
    () => api.get(`/employees/${id}/devices`),
    [id],
  );
  const alerts = useAsync<{ alerts: AlertPayload[] }>(() => api.get('/alerts', { userId: id }), [id]);

  const [maxSpeed, setMaxSpeed] = useState<string>('');
  const [stopMin, setStopMin] = useState<string>('');
  const [touched, setTouched] = useState<{ speed: boolean; stop: boolean }>({ speed: false, stop: false });
  const [zoneId, setZoneId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const e = emp.data;
  const zoneList = zones.data?.zones ?? [];

  // Show the number that is actually in force in the box itself — an empty box next to a grey
  // hint reads like a field that does nothing.
  useEffect(() => {
    if (!e) return;
    setMaxSpeed(String(e.maxSpeedKmh ?? ''));
    setStopMin(String(e.stopAlertMin ?? ''));
    setTouched({ speed: false, stop: false });
  }, [e?.id, e?.maxSpeedKmh, e?.stopAlertMin]);

  const saveRules = async () => {
    setSaving(true);
    try {
      // an untouched box re-saves the override that was already there, so opening the page and
      // hitting حفظ cannot silently pin an inherited number onto this driver
      const num = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
      await api.patch(`/employees/${id}/rules`, {
        maxSpeedKmh: touched.speed ? num(maxSpeed) : e?.ruleOverride?.maxSpeedKmh ?? null,
        stopAlertMin: touched.stop ? num(stopMin) : e?.ruleOverride?.stopAlertMin ?? null,
        zoneId: zoneId || (e?.zoneId ?? null),
      });
      toast({ title: 'تم حفظ القواعد', kind: 'info' });
      emp.reload();
    } catch {
      toast({ title: 'فشل الحفظ', kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (emp.loading) return <Skeleton className="h-96" />;
  if (emp.error || !e) return <ErrorState message={emp.error ?? 'سواق غير موجود'} onRetry={emp.reload} />;

  const mm = summary.data?.motionMinutes;

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-3">
          <Link to="/drivers" className="btn btn-ghost !min-h-[40px] !px-3">←</Link>
          <div>
            <h2 className="font-extrabold text-lg">{e.name}</h2>
            <span className="muted num" dir="ltr" style={{ fontSize: '.75rem' }}>
              {e.identifier} · {e.phone}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <MotionChip state={e.live?.motionState ?? 'UNKNOWN'} />
          <Chip tone={e.live?.online ? 'green' : 'red'}>{e.live?.online ? 'متصل' : 'أوف لاين'}</Chip>
          <a href={waLink(e.phone)} target="_blank" rel="noreferrer" className="btn btn-ghost !min-h-[40px] text-green-700">
            شغّل الآن — واتساب
          </a>
          <Link to={`/live/${e.id}`} className="btn btn-primary !min-h-[40px]">
            خط سير اليوم
          </Link>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* rules */}
        <Card>
          <CardTitle>قواعد هذا السواق (Override)</CardTitle>
          <div className="grid grid-cols-2 gap-3 p-3 pt-0">
            <div>
              <label className="label">حد السرعة (كم/س)</label>
              <Input
                dir="ltr"
                type="number"
                min={10}
                max={160}
                value={maxSpeed}
                onChange={(ev) => {
                  setMaxSpeed(ev.target.value);
                  setTouched((t) => ({ ...t, speed: true }));
                }}
              />
              <div className="muted mt-1" style={{ fontSize: '.7rem' }}>
                {e.ruleOverride?.maxSpeedKmh != null ? 'override لهذا السواق' : 'مورّث من النطاق / الإعدادات العامة'}
              </div>
            </div>
            <div>
              <label className="label">تنبيه التوقف (دقيقة)</label>
              <Input
                dir="ltr"
                type="number"
                min={5}
                max={180}
                value={stopMin}
                onChange={(ev) => {
                  setStopMin(ev.target.value);
                  setTouched((t) => ({ ...t, stop: true }));
                }}
              />
              <div className="muted mt-1" style={{ fontSize: '.7rem' }}>
                {e.ruleOverride?.stopAlertMin != null ? 'override لهذا السواق' : 'مورّث من النطاق / الإعدادات العامة'}
              </div>
            </div>
            <div className="col-span-2">
              <label className="label">النطاق المُسند</label>
              <Select value={zoneId || e.zoneId || ''} onChange={(ev) => setZoneId(ev.target.value)}>
                <option value="">— بدون تغيير —</option>
                {zoneList.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="col-span-2">
              <Btn variant="primary" disabled={saving} onClick={() => void saveRules()} className="w-full">
                {saving ? 'جارٍ الحفظ…' : 'حفظ القواعد'}
              </Btn>
            </div>
          </div>
        </Card>

        {/* motion minutes */}
        <Card>
          <CardTitle>دقائق الحركة اليوم</CardTitle>
          <div className="space-y-2 p-3 pt-0" style={{ fontSize: '.85rem' }}>
            {summary.loading && <Skeleton className="h-32" />}
            {mm && (
              <>
                <MotionBar label="في رحلة (قيادة)" min={mm.riding} tone="#2563eb" />
                <MotionBar label="ماشي" min={mm.walking} tone="#f59e0b" />
                <MotionBar label="واقف" min={mm.stopped} tone="#dc2626" />
                <div className="flex justify-between pt-2 font-bold ink2">
                  <span>تنبيهات مفتوحة</span>
                  <Chip tone="red"><Num>{summary.data?.openAlerts ?? 0}</Num></Chip>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* devices */}
      <Card>
        <CardTitle>الأجهزة</CardTitle>
        <div className="overflow-x-auto p-3 pt-0">
          {devices.loading && <Skeleton className="h-20" />}
          {devices.data && devices.data.devices.length === 0 && <EmptyState title="لا أجهزة مسجلة" />}
          {devices.data?.devices.map((dv) => (
            <div key={dv.id} className="mb-2 rounded-xl p-3" style={{ background: 'var(--deep)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-bold num">{dv.deviceId}</div>
                  <div className="muted num" style={{ fontSize: '.72rem' }}>
                    {dv.platform} · {dv.appVersion} · توكِن {dv.token.slice(0, 12)}…
                  </div>
                </div>
                <div className="flex items-center gap-2" style={{ fontSize: '.75rem' }}>
                  <Chip tone="blue">بطارية <Num>{dv.battery ?? '—'}</Num>%</Chip>
                  <span className="muted">
                    آخر ظهور <Num>{timeAgo(dv.lastSeen)}</Num>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* alert history */}
      <Card>
        <CardTitle>سجل التنبيهات</CardTitle>
        <div className="overflow-x-auto p-3 pt-0">
          {alerts.loading && <Skeleton className="h-24" />}
          {alerts.data?.alerts.length === 0 && <EmptyState title="لا سجل تنبيهات" />}
          {alerts.data?.alerts.map((a) => (
            <div key={a.id} className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl p-2.5" style={{ background: 'var(--deep)', fontSize: '.8rem' }}>
              <div>
                <b>{a.title}</b> <span className="muted num">{fmtDateTime(a.createdAt)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Chip tone={a.severity === 'CRITICAL' ? 'red' : a.severity === 'WARNING' ? 'amber' : 'green'}>{a.severity === 'CRITICAL' ? 'حرج' : a.severity === 'WARNING' ? 'تحذير' : 'معلومة'}</Chip>
                <Chip tone={a.status === 'OPEN' ? 'red' : a.status === 'ACK' ? 'amber' : 'green'}>{a.status === 'OPEN' ? 'مفتوح' : a.status === 'ACK' ? 'مستلَم' : 'محلول'}</Chip>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function MotionBar({ label, min, tone }: { label: string; min: number; tone: string }) {
  const max = 360;
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 font-bold ink2" style={{ fontSize: '.8rem' }}>
        {label}
      </span>
      <div className="h-4 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--line)' }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, (min / max) * 100)}%`, background: tone }} />
      </div>
      <Num className="font-bold w-12 text-end">{min}</Num> د
    </div>
  );
}
