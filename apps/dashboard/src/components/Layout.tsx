import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Topbar from './Topbar';
import Toaster from './Toaster';
import { useUi } from '@/stores/ui';
import { useRealtime } from '@/realtime/useRealtime';

export default function Layout() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  useRealtime();

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:block h-full">
        <Sidebar />
      </div>

      {/* Mobile drawer + backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-[1000] lg:hidden" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setSidebarOpen(false)} />
          <div className="absolute inset-y-0 start-0 w-[260px] shadow-float">
            <Sidebar mobile />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-y-auto p-3 lg:p-4">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
