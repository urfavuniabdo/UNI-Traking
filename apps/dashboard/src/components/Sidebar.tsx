import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';
import { canSee, ROLE_LABEL_AR } from '@/utils/roles';
import { isMock } from '@/api/client';

export const NAV_ITEMS: { to: string; label: string; icon: IconName }[] = [
  { to: '/live', label: 'المراقبة الحية', icon: 'live' },
  { to: '/alerts', label: 'التنبيهات', icon: 'alerts' },
  { to: '/attendance', label: 'الحضور والانصراف', icon: 'attendance' },
  { to: '/leave', label: 'الإجازات', icon: 'leave' },
  { to: '/drivers', label: 'السائقون', icon: 'drivers' },
  { to: '/fences', label: 'المواقع والنطاقات', icon: 'fences' },
  { to: '/reports', label: 'التقارير', icon: 'reports' },
  { to: '/sync', label: 'مزامنة الموظفين', icon: 'sync' },
  { to: '/settings', label: 'الإعدادات', icon: 'settings' },
];

export default function Sidebar({ mobile }: { mobile?: boolean }) {
  const user = useAuth((s) => s.user);
  // Every role sees the tabs of his own job and nothing else (§1).
  const items = NAV_ITEMS.filter((item) => canSee(user?.role, item.to));
  return (
    <aside className="sidebar-glass flex h-full w-[228px] shrink-0 flex-col border-e lg:w-[252px]" style={{ borderColor: 'var(--line)' }}>
      {/* Brand mark */}
      <div className="flex items-center gap-3 px-4 py-4">
        <img
          src="/logo.png"
          alt=""
          className="h-10 w-10 shrink-0 rounded-xl"
          style={{ boxShadow: '0 8px 20px rgba(59,130,246,.28)' }}
        />
        <div className="leading-tight">
          <div className="font-extrabold">UNI Tracking</div>
          <div className="muted font-semibold" style={{ fontSize: '.7rem' }}>
            مراقبة الموظفين والسائقين
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="التنقل الرئيسي">
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                onClick={() => mobile && useUi.getState().setSidebarOpen(false)}
                className={({ isActive }) => `nav-pill ${isActive ? 'active' : ''}`}
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t p-3" style={{ borderColor: 'var(--line)' }}>
        {isMock && (
          <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 font-bold text-amber-700" style={{ fontSize: '.72rem' }}>
            وضع الموك — بدون باك-إند
          </div>
        )}
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700">
            {user?.name?.slice(1, 2) ?? 'م'}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate font-bold" style={{ fontSize: '.85rem' }}>
              {user?.name ?? '—'}
            </div>
            <div className="muted truncate" style={{ fontSize: '.72rem' }}>
              {user?.role ? ROLE_LABEL_AR[user.role] : '—'}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
