import { Navigate } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { DASHBOARD_ROLES, ROLE_LABEL_AR } from '@/utils/roles';
import { Btn } from '@/components/ui';

/**
 * The dashboard is a supervisor tool (CONTRACT §1): an employee or a driver lands here when he
 * opens the web app by mistake, and needs to be told where his buttons actually are rather than
 * bounced back to a login form he would fill in again.
 */
export default function AppOnlyPage(): JSX.Element {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  if (!user) return <Navigate to="/login" replace />;
  if (DASHBOARD_ROLES.includes(user.role)) return <Navigate to="/live" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="card w-full max-w-sm p-6 text-center">
        <img src="/logo.png" alt="" className="mx-auto h-14 w-14 rounded-2xl" />
        <h1 className="mt-3 font-extrabold">لوحة التحكم للمشرفين فقط</h1>
        <p className="muted mt-1 text-[.85rem]">
          حسابك ({ROLE_LABEL_AR[user.role]}) بيشتغل من تطبيق الموبايل — بدء اليوم وإنهاء اليوم وطلب الإجازة كلهم هناك.
        </p>
        <Btn variant="primary" className="mt-4 w-full" onClick={() => void logout().then(() => window.location.assign('/login'))}>
          تسجيل الخروج
        </Btn>
      </div>
    </div>
  );
}
