let ctx: AudioContext | null = null;

/** Short WebAudio ping used for CRITICAL alerts (no audio assets needed). */
export function playPing(kind: 'critical' | 'info' = 'info'): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = ctx ?? new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kind === 'critical' ? 880 : 660, t);
    if (kind === 'critical') osc.frequency.setValueAtTime(660, t + 0.18);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.45);
  } catch {
    /* audio not available — ignore */
  }
}

export async function ensureNotifyPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'default') {
    try {
      return await Notification.requestPermission();
    } catch {
      return 'denied';
    }
  }
  return Notification.permission;
}

export function browserNotify(title: string, body: string): void {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, dir: 'rtl', lang: 'ar' });
    }
  } catch {
    /* ignore */
  }
}
