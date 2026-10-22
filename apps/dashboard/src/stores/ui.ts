import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AlertType } from '@shared';
import type { AlertPayload, FencesResponse, LivePosition } from '@/api/types';

export interface Toast {
  id: string;
  title: string;
  body?: string;
  kind: 'alert' | 'info' | 'error';
}

interface UiState {
  theme: 'light' | 'dark';
  sidebarOpen: boolean;
  soundEnabled: boolean;
  notifyPermission: NotificationPermission | 'unsupported';
  toasts: Toast[];
  setTheme: (t: 'light' | 'dark') => void;
  toggleTheme: () => void;
  setSidebarOpen: (v: boolean) => void;
  setSound: (v: boolean) => void;
  setNotifyPermission: (p: NotificationPermission | 'unsupported') => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

function applyTheme(t: 'light' | 'dark') {
  const el = document.documentElement;
  el.setAttribute('data-theme', t);
  el.classList.toggle('dark', t === 'dark');
}

export const useUi = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      sidebarOpen: false,
      soundEnabled: true,
      notifyPermission: 'default',
      toasts: [],
      setTheme: (t) => {
        applyTheme(t);
        set({ theme: t });
      },
      toggleTheme: () => {
        const t = get().theme === 'light' ? 'dark' : 'light';
        applyTheme(t);
        set({ theme: t });
      },
      setSidebarOpen: (v) => set({ sidebarOpen: v }),
      setSound: (v) => set({ soundEnabled: v }),
      setNotifyPermission: (p) => set({ notifyPermission: p }),
      pushToast: (t) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        // Keep the full pool (bounded) so the Toaster can collapse the overflow behind a
        // "+N" pill; the visible cap lives in the Toaster, not here. Auto-dismiss unchanged.
        set({ toasts: [...get().toasts, { ...t, id }].slice(-50) });
        setTimeout(() => get().dismissToast(id), 6000);
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
    }),
    {
      name: 'traccer.ui',
      partialize: (s) => ({ theme: s.theme, soundEnabled: s.soundEnabled }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

interface LiveState {
  /** latest position per userId */
  positions: Record<string, LivePosition>;
  fences: FencesResponse | null;
  connected: boolean;
  applyPosition: (p: LivePosition) => void;
  mergePosition: (userId: string, patch: Partial<LivePosition>) => void;
  setFences: (f: FencesResponse) => void;
  setConnected: (v: boolean) => void;
}

export const useLive = create<LiveState>((set, get) => ({
  positions: {},
  fences: null,
  connected: false,
  applyPosition: (p) => set({ positions: { ...get().positions, [p.userId]: p } }),
  mergePosition: (userId, patch) => {
    const cur = get().positions[userId];
    if (!cur) return;
    set({ positions: { ...get().positions, [userId]: { ...cur, ...patch } } });
  },
  setFences: (f) => set({ fences: f }),
  setConnected: (v) => set({ connected: v }),
}));

interface AlertFeedState {
  /** realtime feed — newest first, capped */
  feed: AlertPayload[];
  unreadCritical: number;
  addAlert: (a: AlertPayload) => void;
  updateAlert: (id: string, patch: Partial<AlertPayload>) => void;
  clearUnread: () => void;
}

export const useAlertFeed = create<AlertFeedState>((set, get) => ({
  feed: [],
  unreadCritical: 0,
  addAlert: (a) => {
    if (get().feed.some((x) => x.id === a.id)) return;
    set({
      feed: [a, ...get().feed].slice(0, 120),
      unreadCritical: a.severity === 'CRITICAL' ? get().unreadCritical + 1 : get().unreadCritical,
    });
  },
  updateAlert: (id, patch) =>
    set({ feed: get().feed.map((x) => (x.id === id ? { ...x, ...patch } : x)) }),
  clearUnread: () => set({ unreadCritical: 0 }),
}));

/** prefs mirrored for notification types (persisted locally, synced from /me/preferences) */
interface PrefsState {
  types: AlertType[];
  setTypes: (t: AlertType[]) => void;
}
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      types: [],
      setTypes: (t) => set({ types: t }),
    }),
    { name: 'traccer.prefs' },
  ),
);
