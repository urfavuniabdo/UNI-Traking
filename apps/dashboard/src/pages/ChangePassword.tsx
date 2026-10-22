import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { Btn, Input } from '@/components/ui';

/** Shown instead of the app whenever the backend flags the account (seeded/first login). */
export default function ChangePasswordPage() {
  const { changePassword, busy, error, user } = useAuth();
  const navigate = useNavigate();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = next.length >= 6 && next === confirm && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (await changePassword(next)) navigate('/login', { replace: true });
  };

  return (
    <div
      className="flex min-h-dvh items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg,#1d4ed8 0%,#2563eb 55%,#1e74e5 100%)' }}
    >
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-6">
        <div>
          <h1 className="text-xl font-extrabold">تعيين كلمة مرور جديدة</h1>
          <p className="muted mt-1" style={{ fontSize: '.8rem' }}>
            حساب <b>{user?.name ?? user?.identifier}</b> لسه على كلمة المرور الافتراضية.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="next">
            كلمة المرور الجديدة
          </label>
          <Input
            id="next"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="confirm">
            تأكيد كلمة المرور
          </label>
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
          {mismatch && (
            <p className="mt-1 font-bold" style={{ color: '#b91c1c', fontSize: '.78rem' }}>
              كلمتا المرور غير متطابقتين
            </p>
          )}
        </div>

        {error && (
          <p className="rounded-xl px-3 py-2 font-bold" style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '.82rem' }}>
            {error}
          </p>
        )}

        <p className="muted" style={{ fontSize: '.75rem' }}>
          تغيير كلمة المرور بيُقفل كل الجلسات المفتوحة، فهتدخل تاني بعدها مباشرة.
        </p>

        <Btn variant="primary" type="submit" disabled={!canSubmit} className="w-full">
          {busy ? 'جارٍ الحفظ…' : 'حفظ ودخول'}
        </Btn>
      </form>
    </div>
  );
}
