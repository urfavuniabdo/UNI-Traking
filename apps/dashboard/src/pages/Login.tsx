import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { Btn, Input, Num } from '@/components/ui';

export default function LoginPage() {
  const { login, busy, error } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('admin');
  const [password, setPassword] = useState('');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.classList.remove('dark');
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await login(identifier, password);
    if (ok) navigate(useAuth.getState().mustChangePassword ? '/change-password' : '/live');
  };

  return (
    <div
      className="flex min-h-dvh items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg,#1d4ed8 0%,#2563eb 55%,#1e74e5 100%)' }}
    >
      <div className="w-full max-w-md">
        {/* Brand mark */}
        <div className="mb-6 text-center text-white">
          <img
            src="/logo.png"
            alt=""
            className="mx-auto mb-3 h-16 w-16 rounded-2xl"
            style={{ boxShadow: '0 8px 20px rgba(0,0,0,.25)' }}
          />
          <h1 className="text-2xl font-extrabold">UNI Tracking</h1>
          <p className="mt-1 font-semibold text-blue-100" style={{ fontSize: '.85rem' }}>
            مراقبة الموظفين والسواقين
          </p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="identifier">
              المعرّف الوظيفي
            </label>
            <Input
              id="identifier"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="مثال: DRV-001 أو الرقم الوظيفي"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              كلمة المرور
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <p className="rounded-xl px-3 py-2 font-bold" style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '.82rem' }}>
              {error}
            </p>
          )}

          <Btn variant="primary" type="submit" disabled={busy || !identifier || !password} className="w-full">
            {busy ? 'جارٍ التحقق…' : 'تسجيل الدخول'}
          </Btn>

          <p className="muted text-center" style={{ fontSize: '.75rem' }}>
            Uni Group Egypt — <Num>Uni Track</Num> · UNI Tracking
          </p>
        </form>
      </div>
    </div>
  );
}
