import { useEffect, useState } from 'react';
import { useUi } from '@/stores/ui';
import { stopSosSiren } from '@/utils/sound';
import { Icon } from './Icon';

/** Max toasts shown before the remainder collapses behind the "+N" pill. */
const VISIBLE_CAP = 3;

export default function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  const siren = useUi((s) => s.siren);
  const stopSiren = useUi((s) => s.stopSiren);
  const soundEnabled = useUi((s) => s.soundEnabled);
  const [expanded, setExpanded] = useState(false);

  // Muting the board is also a way to stop the siren — no alarm should outlive its switch.
  useEffect(() => {
    if (!soundEnabled && siren) {
      stopSosSiren();
      stopSiren();
    }
  }, [soundEnabled, siren, stopSiren]);

  // newest first → newest renders on top of the stack
  const ordered = [...toasts].reverse();
  const overflow = ordered.length - VISIBLE_CAP;
  const collapsed = overflow > 0 && !expanded;
  const shown = collapsed ? ordered.slice(0, VISIBLE_CAP) : ordered;

  return (
    <>
      {siren && (
        <div
          className="siren-banner fixed inset-x-3 top-3 z-[1300] mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] items-center gap-3 rounded-2xl px-4 py-2.5 text-white shadow-float"
          style={{ background: 'linear-gradient(135deg,#b91c1c,#7f1d1d)' }}
          role="alert"
          aria-live="assertive"
        >
          <span className="animate-pulse text-xl leading-none" aria-hidden="true">🚨</span>
          <div className="min-w-0">
            <div className="font-extrabold" style={{ fontSize: '.9rem' }}>إنذار استغاثة</div>
            <div className="truncate" style={{ fontSize: '.76rem', opacity: 0.9 }}>{siren.label}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              stopSosSiren();
              stopSiren();
            }}
            className="shrink-0 rounded-lg bg-white px-3 py-1.5 font-extrabold"
            style={{ color: '#b91c1c' }}
          >
            إيقاف الإنذار
          </button>
        </div>
      )}

    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[1200] flex flex-col items-center gap-2 px-3 lg:inset-x-auto lg:bottom-4 lg:start-4 lg:items-start lg:px-0">
      {shown.map((t) => (
        <div
          key={t.id}
          className="card pointer-events-auto flex w-full max-w-sm items-start gap-3 p-3 shadow-float"
          role="status"
        >
          <span
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: t.kind === 'alert' ? '#fee2e2' : t.kind === 'error' ? '#fef3c7' : '#dbeafe',
              color: t.kind === 'alert' ? '#b91c1c' : t.kind === 'error' ? '#b45309' : '#1d4ed8',
            }}
          >
            <Icon name={t.kind === 'info' ? 'check' : 'alerts'} />
          </span>
          <div className="min-w-0 flex-1 leading-snug">
            <div className="font-bold truncate">{t.title}</div>
            {t.body && <div className="muted truncate" style={{ fontSize: '.78rem' }}>{t.body}</div>}
          </div>
          <button type="button" className="muted font-bold" onClick={() => dismiss(t.id)} aria-label="إغلاق التنبيه">
            ✕
          </button>
        </div>
      ))}

      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={!collapsed}
          className="card pointer-events-auto flex w-fit items-center gap-1.5 rounded-full px-3 py-1 font-bold shadow-float"
          style={{ fontSize: '.75rem', color: '#1d4ed8' }}
        >
          {collapsed ? (
            <>
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-100 px-1 font-extrabold">
                +{overflow}
              </span>
              عرض التنبيهات
            </>
          ) : (
            <>طيّ التنبيهات ▲</>
          )}
        </button>
      )}
    </div>
    </>
  );
}
