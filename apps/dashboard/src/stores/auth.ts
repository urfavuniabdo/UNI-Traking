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
  login: (identifier: string, password: string) => Promise<boolean>;
  fetchMe: () => Promise<void>;
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
      login: async (identifier, password) => {
        set({ busy: true, error: null });
        try {
          const res = await api.post<LoginResponse>('/auth/login', { identifier, password }, undefined, { noAuth: true });
          set({ token: res.accessToken, refreshToken: res.refreshToken, user: res.user, busy: false });
          return true;
        } catch (e) {
          set({ busy: false, error: e instanceof Error ? e.message : 'فشل تسجيل الدخول' });
          return false;
        }
      },
      fetchMe: async () => {
        try {
          const me = await api.get<{ user: ApiUser; permissions: string[] }>('/auth/me');
          set({ user: me.user });
        } catch {
          // token invalid — client.ts already handled refresh/logout
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
