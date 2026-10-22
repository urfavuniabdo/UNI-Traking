import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type { NotificationLogEntry, RuleSettings } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { fmtDateTime } from '@/utils/format';
import { ALERT_TYPES, AR_ALERT_TEXT, type AlertType } from '@shared';
import { Btn, Card, CardTitle, Chip, EmptyState, ErrorState, Input, Num, Skeleton, Toggle } from '@/components/ui';
import { useUi } from '@/stores/ui';

interface SettingsResponse {
  rules: RuleSettings;
  timezone: string;
  notifications: NotificationLogEntry[];
}

export default function SettingsPage() {
  const res = useAsync<SettingsResponse>(() => api.get('/settings'), []);
  const prefs = useAsync<{ push: boolean; whatsapp: boolean; email: boolean; sound: boolean; types: AlertType[] }>(
    () => api.get('/me/preferences'),
    [],
  );
  const ui = useUi();
  const [rules, setRules] = useState<RuleSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = ui.pushToast;

  useEffect(() => {
    if (res.data) setRules(res.data.rules);
  }, [res.data]);

  const saveRules = async () => {
    if (!rules) return;
    setSaving(true);
    try {
      await api.patch('/settings', { rules });
      toast({ title: 'تم حفظ الإعدادات', kind: 'info' });
    } catch {
      toast({ title: 'فشل الحفظ', kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const toggleType = async (t: AlertType) => {
    const p = prefs.data;
    if (!p) return;
    const nextTypes = p.types.includes(t) ? p.types.filter((x) => x !== t) : [...p.types, t];
    await api.patch('/me/preferences', { types: nextTypes });
    prefs.reload();
  };

  const failed = (res.data?.notifications ?? []).filter((n) => n.status === 'FAILED' || n.status === 'NO_PROVIDER');

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {/* rule defaults */}
      <Card>
        <CardTitle>الافتراضات العامة للقواعد</CardTitle>
        <div className="p-3 pt-0">
          {res.loading && <Skeleton className="h-64" />}
          {res.error && <ErrorState message={res.error} onRetry={res.reload} />}
          {rules && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="حد السرعة (كم/س)" value={rules.maxSpeedKmh} onChange={(v) => setRules({ ...rules, maxSpeedKmh: v })} />
              <Field label="تنبيه التوقف (دقيقة)" value={rules.stopAlertMin} onChange={(v) => setRules({ ...rules, stopAlertMin: v })} />
              <Field label="سماح النطاق (ثانية)" value={rules.geofenceGraceS} onChange={(v) => setRules({ ...rules, geofenceGraceS: v })} />
              <Field label="تحول السرعة لحرج (ثانية)" value={rules.speedingCriticalS} onChange={(v) => setRules({ ...rules, speedingCriticalS: v })} />
              <Field label="كولداون التنبيه (ثانية)" value={rules.cooldownS} onChange={(v) => setRules({ ...rules, cooldownS: v })} />
              <Field label="فجوة المسار (دقيقة)" value={rules.gapMinMin} onChange={(v) => setRules({ ...rules, gapMinMin: v })} />
              <Field label="سماح نهاية الوردية (دقيقة)" value={rules.shiftGraceMin} onChange={(v) => setRules({ ...rules, shiftGraceMin: v })} />
              <Field label="أقصى عمر لإعادة البث (ساعة)" value={rules.replayMaxAgeHours} onChange={(v) => setRules({ ...rules, replayMaxAgeHours: v })} />
              <label className="col-span-2 flex items-center justify-between gap-2 font-bold ink2" style={{ fontSize: '.82rem' }}>
                رفض التشيك ان خارج النطاق (strictReject)
                <Toggle checked={rules.attendanceStrictReject} onChange={(v) => setRules({ ...rules, attendanceStrictReject: v })} label="strictReject" />
              </label>
              <div className="col-span-2">
                <Btn variant="primary" disabled={saving} onClick={() => void saveRules()} className="w-full">
                  {saving ? 'جارٍ الحفظ…' : 'حفظ الافتراضات'}
                </Btn>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* notifications prefs */}
      <Card>
        <CardTitle>تفضيلات الإشعارات</CardTitle>
        <div className="space-y-3 p-3 pt-0">
          {prefs.loading && <Skeleton className="h-52" />}
          {prefs.data && (
            <>
              <div className="grid grid-cols-3 gap-2">
                {(['push', 'whatsapp', 'email'] as const).map((k) => (
                  <label key={k} className="flex flex-col items-center gap-1.5 rounded-xl p-2 font-bold" style={{ background: 'var(--deep)', fontSize: '.74rem' }}>
                    {k === 'push' ? 'Push' : k === 'whatsapp' ? 'واتساب' : 'إيميل'}
                    <Toggle
                      checked={Boolean(prefs.data![k])}
                      onChange={async (v) => {
                        await api.patch('/me/preferences', { [k]: v });
                        prefs.reload();
                      }}
                      label={k}
                    />
                  </label>
                ))}
              </div>
              <label className="flex items-center justify-between font-bold ink2" style={{ fontSize: '.82rem' }}>
                صوت التنبيهات الحرجة
                <Toggle checked={ui.soundEnabled} onChange={ui.setSound} label="sound" />
              </label>
              <div>
                <span className="label">الأنواع التي تصلني</span>
                <div className="flex flex-wrap gap-1.5">
                  {ALERT_TYPES.map((t) => {
                    const on = prefs.data!.types.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => void toggleType(t)}
                        className="rounded-full px-2.5 py-1.5 font-bold transition-colors"
                        style={{ fontSize: '.72rem', background: on ? 'linear-gradient(to left,#3b82f6,#1d4ed8)' : 'var(--line)', color: on ? '#fff' : 'var(--muted)', minHeight: 36 }}
                      >
                        {AR_ALERT_TEXT[t].title}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="muted" style={{ fontSize: '.72rem' }}>
                صلاحية الإشعارات بالمتصفح: <Num>{ui.notifyPermission === 'unsupported' ? 'غير مدعوم' : ui.notifyPermission}</Num> · المنطقة الزمنية: <Num>Africa/Cairo</Num>
              </p>
            </>
          )}
        </div>
      </Card>

      {/* delivery health */}
      <Card className="lg:col-span-2">
        <CardTitle action={<Btn size="sm" onClick={res.reload}>تحديث</Btn>}>حالة التوصيل — لا إشعار ضائع بصمت</CardTitle>
        <div className="overflow-x-auto p-3 pt-0">
          {res.loading && <Skeleton className="h-32" />}
          {res.data && failed.length === 0 && <EmptyState title="كل الإشعارات وصلت ✓" />}
          {res.data && failed.length > 0 && (
            <>
              <p className="mb-2 font-bold" style={{ color: '#b91c1c', fontSize: '.8rem' }}>
                <Num>{failed.length}</Num> إشعار لم يُسلَّم — راجع القنوات
              </p>
              <table className="w-full min-w-[560px]" style={{ fontSize: '.78rem' }}>
                <thead>
                  <tr className="border-b muted" style={{ borderColor: 'var(--line)', fontSize: '.72rem' }}>
                    <th className="p-2 text-start">القناة</th>
                    <th className="p-2 text-start">المستخدم</th>
                    <th className="p-2 text-start">النوع</th>
                    <th className="p-2 text-start">المحاولات</th>
                    <th className="p-2 text-start">الوقت</th>
                    <th className="p-2 text-start">السبب</th>
                  </tr>
                </thead>
                <tbody>
                  {failed.map((n) => (
                    <tr key={n.id} className="border-b" style={{ borderColor: 'var(--line)' }}>
                      <td className="p-2"><Chip tone="blue">{n.channel}</Chip></td>
                      <td className="p-2 font-bold">{n.userName}</td>
                      <td className="p-2">{AR_ALERT_TEXT[n.alertType].title}</td>
                      <td className="p-2"><Num>{n.attempts}</Num>/3</td>
                      <td className="p-2 num" dir="ltr">{fmtDateTime(n.at)}</td>
                      <td className="p-2" style={{ color: '#b91c1c' }}>{n.error ?? n.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="label">{label}</label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
