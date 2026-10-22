import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './stores/auth';
import { canSee, DASHBOARD_ROLES, homeFor } from './utils/roles';
import LoginPage from './pages/Login';
import ChangePasswordPage from './pages/ChangePassword';
import LivePage from './pages/Live';
import DriverRoutePage from './pages/DriverRoute';
import AlertsPage from './pages/Alerts';
import AttendancePage from './pages/Attendance';
import LeavePage from './pages/Leave';
import ReportsPage from './pages/Reports';
import DriversPage from './pages/Drivers';
import DriverDetailPage from './pages/DriverDetail';
import FencesPage from './pages/Fences';
import SyncPage from './pages/Sync';
import SettingsPage from './pages/Settings';
import AppOnlyPage from './pages/AppOnly';

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const token = useAuth((s) => s.token);
  const mustChangePassword = useAuth((s) => s.mustChangePassword);
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace />;
  if (mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return children;
}

/**
 * A role only ever reaches the pages of his own job (§1): an employee or a driver has no
 * dashboard at all, and a deep link he is not allowed to open is sent to his own landing page
 * rather than showing a forbidden shell. The API refuses the same paths, so this is presentation.
 */
function RoleGate({ children }: { children: JSX.Element }): JSX.Element {
  const role = useAuth((s) => s.user?.role);
  const location = useLocation();
  if (!role) return <Navigate to="/login" replace />;
  if (!DASHBOARD_ROLES.includes(role)) return <Navigate to="/app-only" replace />;
  if (!canSee(role, location.pathname)) return <Navigate to={homeFor(role)} replace />;
  return children;
}

function HomeRedirect(): JSX.Element {
  const role = useAuth((s) => s.user?.role);
  if (!role) return <Navigate to="/login" replace />;
  return <Navigate to={DASHBOARD_ROLES.includes(role) ? homeFor(role) : '/app-only'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/change-password"
        element={
          <RequireAuth>
            <ChangePasswordPage />
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <RoleGate>
              <Layout />
            </RoleGate>
          </RequireAuth>
        }
      >
        <Route path="/live" element={<LivePage />} />
        <Route path="/live/:userId" element={<DriverRoutePage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/leave" element={<LeavePage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/drivers" element={<DriversPage />} />
        <Route path="/drivers/:id" element={<DriverDetailPage />} />
        <Route path="/fences" element={<FencesPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="/app-only" element={<RequireAuth><AppOnlyPage /></RequireAuth>} />
      <Route path="*" element={<HomeRedirect />} />    </Routes>
  );
}
