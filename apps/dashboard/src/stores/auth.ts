import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/api/client';
import type { ApiUser, LoginResponse } from '@/api/types';

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  user: ApiUser | null;
  busy: boolean;
  error: string | null;
  mustChangePassword: boolean;
  login: (identifier: string, password: string) => Promise<boolean>;
  fetchMe: () => Promise<void>;
  changePassword: (newPassword: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      refreshToken: null,
      user: null,
      busy: false,
      error: null,
      mustChangePassword: false,
      login: async (identifier, password) => {
        set({ busy: true, error: null });
        try {
          const res = await api.post<LoginResponse>('/auth/login', { identifier, password }, undefined, { noAuth: true });
          set({
            token: res.accessToken,
            refreshToken: res.refreshToken,
            user: res.user,
            mustChangePassword: res.mustChangePassword === true,
            busy: false,
          });
          return true;
        } catch (e) {
          set({ busy: false, error: e instanceof Error ? e.message : 'فشل تسجيل الدخول' });
          return false;
        }
      },
      fetchMe: async () => {
        try {
          const me = await api.get<{ user: ApiUser; permissions: string[]; mustChangePassword?: boolean }>('/auth/me');
          set({ user: me.user, mustChangePassword: me.mustChangePassword === true });
        } catch {
          // token invalid — client.ts already handled refresh/logout
        }
      },
      /** The API revokes every session on success, so the caller must sign the user out after. */
      changePassword: async (newPassword) => {
        set({ busy: true, error: null });
        try {
          await api.post('/auth/change-password', { newPassword });
          set({ token: null, refreshToken: null, user: null, mustChangePassword: false, busy: false });
          localStorage.removeItem('traccer.auth');
          return true;
        } catch (e) {
          set({ busy: false, error: e instanceof Error ? e.message : 'فشل تغيير كلمة المرور' });
          return false;
        }
      },
      logout: async () => {
        try {
          await api.post('/auth/logout', {});
        } catch {
          /* best-effort */
        }
        set({ token: null, refreshToken: null, user: null });
        localStorage.removeItem('traccer.auth');
      },
    }),
    { name: 'traccer.auth' },
  ),
);

export const isAdmin = () => useAuth.getState().user?.role === 'ADMIN';
export const canManageAlerts = () => {
  const r = useAuth.getState().user?.role;
  return r === 'ADMIN' || r === 'SUPERVISOR';
};
