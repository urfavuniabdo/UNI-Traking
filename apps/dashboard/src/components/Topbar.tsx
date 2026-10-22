import { useLocation, Link } from 'react-router-dom';
import { Icon } from './Icon';
import { NAV_ITEMS } from './Sidebar';
import { useLive, useUi, useAlertFeed } from '@/stores/ui';
import { useAuth } from '@/stores/auth';
import { Num } from './ui';

export default function Topbar() {
  const { pathname } = useLocation();
  const connected = useLive((s) => s.connected);
  const critical = useAlertFeed((s) => s.unreadCritical);
  const ui = useUi();
  const user = useAuth((s) => s.user);
  const title = NAV_ITEMS.find((n) => pathname.startsWith(n.to))?.label ?? 'UNI Tracking';

  return (
    // 60px plain bar on desktop; floating rounded card on small screens
    <header className="shrink-0 px-3 pt-3 lg:h-[60px] lg:px-4 lg:pt-0">
      <div className="card flex items-center justify-between gap-2 px-3 lg:h-full lg:border-0 lg:bg-transparent lg:px-2 lg:shadow-none">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className="btn btn-ghost !min-h-[44px] !px-2.5 lg:hidden"
            aria-label="فتح القائمة"
            onClick={() => ui.setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <h1 className="truncate font-extrabold text-[1.05rem]">{title}</h1>
          <span
            className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 font-bold sm:flex"
            style={{ background: connected ? '#dcfce7' : '#fee2e2', color: connected ? '#15803d' : '#b91c1c', fontSize: '.72rem' }}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: connected ? '#16a34a' : '#dc2626' }} />
            {connected ? 'اتصال لحظي' : 'غير متصل'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Link to="/alerts" className="btn btn-ghost relative !min-h-[44px] !px-3" title="تنبيهات حرجة جديدة">
            <Icon name="alerts" />
            {critical > 0 && (
              <span className="absolute -top-1 -start-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 font-extrabold text-white" style={{ fontSize: '.68rem' }}>
                <Num>{critical}</Num>
              </span>
            )}
          </Link>
          <button
            type="button"
            className="btn btn-ghost !min-h-[44px] !px-2.5"
            aria-label={ui.soundEnabled ? 'كتم الصوت' : 'تشغيل الصوت'}
            onClick={() => ui.setSound(!ui.soundEnabled)}
          >
            <Icon name={ui.soundEnabled ? 'sound' : 'mute'} />
          </button>
          <button
            type="button"
            className="btn btn-ghost !min-h-[44px] !px-2.5"
            aria-label="تبديل الوضع الليلي"
            onClick={ui.toggleTheme}
          >
            <Icon name={ui.theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <span className="ms-1 hidden font-bold muted sm:inline" style={{ fontSize: '.8rem' }}>
            {user?.name}
          </span>
          <button
            type="button"
            className="btn btn-ghost !min-h-[44px] !px-3"
            onClick={() => {
              void useAuth.getState().logout();
            }}
          >
            خروج
          </button>
        </div>
      </div>
    </header>
  );
}
