import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { useAuth } from './stores/auth';
import LoginPage from './pages/Login';
import ChangePasswordPage from './pages/ChangePassword';
import LivePage from './pages/Live';
import DriverRoutePage from './pages/DriverRoute';
import AlertsPage from './pages/Alerts';
import AttendancePage from './pages/Attendance';
import ReportsPage from './pages/Reports';
import DriversPage from './pages/Drivers';
import DriverDetailPage from './pages/DriverDetail';
import FencesPage from './pages/Fences';
import SyncPage from './pages/Sync';
import SettingsPage from './pages/Settings';

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
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/live" element={<LivePage />} />
        <Route path="/live/:userId" element={<DriverRoutePage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/drivers" element={<DriversPage />} />
        <Route path="/drivers/:id" element={<DriverDetailPage />} />
        <Route path="/fences" element={<FencesPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/live" replace />} />
    </Routes>
  );
}
