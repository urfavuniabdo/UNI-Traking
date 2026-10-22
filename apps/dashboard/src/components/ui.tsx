import type { HTMLAttributes, ReactNode, InputHTMLAttributes, SelectHTMLAttributes, ButtonHTMLAttributes } from 'react';
import type { MotionState, Severity, AlertStatus } from '@/api/types';
import { MOTION, MOTION_STATE_AR } from '@shared';

/** Renders any value LTR + tabular-nums, safe inside Arabic RTL text. */
export function Num({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`num ${className}`}>{children}</span>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 p-3.5 pb-2">
      <h3 className="font-bold text-[.95rem]">{children}</h3>
      {action}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Btn({ variant = 'ghost', size = 'md', className = '', ...rest }: BtnProps) {
  const v = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-ghost';
  const s = size === 'sm' ? 'min-h-[36px] px-3 py-1 text-[.82rem]' : '';
  return <button type="button" className={`btn ${v} ${s} ${className}`} {...rest} />;
}

export function IconBtn({ className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`btn btn-ghost !min-h-[44px] !min-w-[44px] !px-0 ${className}`}
      {...rest}
    />
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input w-full ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input w-full ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors"
      style={{ background: checked ? 'linear-gradient(to left,#3b82f6,#1d4ed8)' : 'var(--line)', borderColor: checked ? 'transparent' : 'var(--line)' }}
    >
      <span
        className="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? 'translateX(-6px)' : 'translateX(-26px)' }}
      />
    </button>
  );
}

/** semantic chip palette per design system */
const chipPalette: Record<string, { bg: string; fg: string }> = {
  amber: { bg: '#fef3c7', fg: '#b45309' },
  red: { bg: '#fee2e2', fg: '#b91c1c' },
  green: { bg: '#dcfce7', fg: '#15803d' },
  blue: { bg: '#dbeafe', fg: '#1d4ed8' },
  violet: { bg: '#ede9fe', fg: '#6d28d9' },
  gray: { bg: '#e5e7eb', fg: '#374151' },
};

export function Chip({ tone = 'gray', children, className = '', title }: { tone?: keyof typeof chipPalette; children: ReactNode; className?: string; title?: string }) {
  const c = chipPalette[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-bold whitespace-nowrap ${className}`}
      style={{ background: c.bg, color: c.fg, fontSize: '.74rem' }}
    >
      {children}
    </span>
  );
}

export function motionTone(m: MotionState): 'amber' | 'blue' | 'red' | 'gray' {
  return m === 'WALKING' ? 'amber' : m === 'RIDING' ? 'blue' : m === 'STOPPED' ? 'red' : 'gray';
}

export function MotionChip({ state }: { state: MotionState }) {
  return <Chip tone={motionTone(state)}>{MOTION_STATE_AR[state]}</Chip>;
}

/**
 * A position carries the speed of its own sample, while the motion state is smoothed over EMA and
 * only commits after HYSTERESIS_SAMPLES — so one fast sample inside a standing stretch pairs
 * «واقف» with «55 كم/س». Labelled rather than hidden, because a supervisor reads that pair as a
 * broken board and the raw number is still the honest measurement of the sample.
 */
export function LiveSpeed({ state, speedKmh, className = '' }: { state: MotionState; speedKmh: number | null | undefined; className?: string }) {
  if (speedKmh === null || speedKmh === undefined || !Number.isFinite(speedKmh)) {
    return <span className={className}><Num>—</Num> كم/س</span>;
  }
  const instant = state !== 'UNKNOWN' && (speedKmh <= MOTION.STATIONARY_SPEED_KMH ? 'STOPPED' : speedKmh <= MOTION.WALK_MAX_KMH ? 'WALKING' : 'RIDING') !== state;
  return (
    <span className={className} title={instant ? `قراءة العينة دي لحظية — الحالة بتتثبت بعد ${MOTION.HYSTERESIS_SAMPLES} عينات متتالية` : undefined}>
      <Num>{Math.round(speedKmh)}</Num> كم/س
      {instant && <span className="muted" style={{ fontSize: '.68rem' }}> لحظية</span>}
    </span>
  );
}

export function severityTone(s: Severity): 'red' | 'amber' | 'green' {
  return s === 'CRITICAL' ? 'red' : s === 'WARNING' ? 'amber' : 'green';
}

export function SeverityChip({ severity }: { severity: Severity }) {
  const label = severity === 'CRITICAL' ? 'حرج' : severity === 'WARNING' ? 'تحذير' : 'معلومة';
  return <Chip tone={severityTone(severity)}>{label}</Chip>;
}

export function statusTone(s: AlertStatus): 'red' | 'amber' | 'green' {
  return s === 'OPEN' ? 'red' : s === 'ACK' ? 'amber' : 'green';
}

export function AlertStatusChip({ status }: { status: AlertStatus }) {
  const label = status === 'OPEN' ? 'مفتوح' : status === 'ACK' ? 'تم الاستلام' : 'تم الحل';
  return <Chip tone={statusTone(status)}>{label}</Chip>;
}

export function Kpi({ label, value, suffix, tone = 'blue' }: { label: string; value: ReactNode; suffix?: string; tone?: 'green' | 'amber' | 'violet' | 'blue' | 'sky' }) {
  const bg: Record<string, string> = {
    green: '#e9f8ef',
    amber: '#fdf2e6',
    violet: '#f1ecfd',
    blue: '#d2e4fc',
    sky: '#eef4fd',
  };
  return (
    <div className="card p-4 flex flex-col justify-between min-h-[92px]" style={{ background: bg[tone], borderColor: 'transparent' }}>
      <span className="font-bold" style={{ fontSize: '.74rem', color: '#475569' }}>
        {label}
      </span>
      <span className="font-extrabold leading-tight" style={{ fontSize: '1.5rem' }}>
        {typeof value === 'number' ? <Num>{value.toLocaleString('en-US')}</Num> : value}
        {suffix && <span className="font-bold text-[.8rem] me-1 muted">{suffix}</span>}
      </span>
    </div>
  );
}

export function Skeleton({ className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`skeleton ${className}`} {...rest} />;
}

export function EmptyState({ title = 'لا توجد بيانات', hint, action }: { title?: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="muted">
        <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2Z" />
      </svg>
      <p className="font-bold ink2">{title}</p>
      {hint && <p className="muted text-[.8rem]">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <p className="font-bold" style={{ color: '#b91c1c' }}>
        {message}
      </p>
      {onRetry && <Btn size="sm" onClick={onRetry}>إعادة المحاولة</Btn>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-3" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className={`card relative w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[85vh] overflow-y-auto p-4 shadow-float`}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold">{title}</h3>
          <button type="button" onClick={onClose} className="btn btn-ghost !min-h-[40px] !px-3" aria-label="إغلاق">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-6 muted">
      <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
      {label && <span className="text-[.85rem]">{label}</span>}
    </div>
  );
}
