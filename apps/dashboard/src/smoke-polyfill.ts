// Browser-globals polyfill — imported FIRST by smoke-entry.ts so the zustand
// persisted stores hydrate safely under plain Node.
const g = globalThis as unknown as Record<string, unknown>;
if (!g.localStorage) {
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
}
if (!g.window) g.window = g;
if (!g.document) {
  g.document = {
    documentElement: { setAttribute: () => undefined, classList: { toggle: () => undefined } },
  };
}
if (!g.Notification) {
  g.Notification = { permission: 'default', requestPermission: async () => 'default' };
}
