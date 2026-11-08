let ctx: AudioContext | null = null;
let master: DynamicsCompressorNode | null = null;

type AlertSound = 'critical' | 'info' | 'sos';

/**
 * One shared graph: every blip feeds a compressor before the speakers, so the alert can sit far
 * louder than the old single sine ping without clipping on laptop speakers.
 */
function audio(): { ctx: AudioContext; out: AudioNode } | null {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-24, ctx.currentTime);
      comp.knee.setValueAtTime(10, ctx.currentTime);
      comp.ratio.setValueAtTime(14, ctx.currentTime);
      comp.attack.setValueAtTime(0.003, ctx.currentTime);
      comp.release.setValueAtTime(0.2, ctx.currentTime);
      comp.connect(ctx.destination);
      master = comp;
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return master ? { ctx, out: master } : null;
  } catch {
    return null;
  }
}

interface Blip {
  at: number;
  dur: number;
  freq: number;
  gain: number;
  type?: OscillatorType;
  /** frequency the tone bends to by the end of the blip */
  to?: number;
}

function blip(a: { ctx: AudioContext; out: AudioNode }, b: Blip): void {
  const osc = a.ctx.createOscillator();
  const g = a.ctx.createGain();
  osc.type = b.type ?? 'sine';
  osc.frequency.setValueAtTime(b.freq, b.at);
  if (b.to) osc.frequency.linearRampToValueAtTime(b.to, b.at + b.dur * 0.85);
  g.gain.setValueAtTime(0.0001, b.at);
  g.gain.exponentialRampToValueAtTime(b.gain, b.at + 0.01);
  g.gain.setValueAtTime(b.gain, b.at + b.dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.0001, b.at + b.dur);
  osc.connect(g).connect(a.out);
  osc.start(b.at);
  osc.stop(b.at + b.dur + 0.02);
}

/**
 * Alert sound (no audio assets needed).
 *  * `sos`      — seven blasts of a dual-tone car horn: the loudest, hardest-to-ignore pattern.
 *  * `critical` — four piercing high beeps, audibly above the old ping.
 *  * `info`     — a soft two-note chime.
 */
export function playPing(kind: AlertSound = 'info'): void {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime + 0.01;

  if (kind === 'sos') {
    // Intermittent horn: three stacked voices per blast, 0.3 s on / 0.16 s off.
    const blasts = 7;
    const period = 0.46;
    for (let i = 0; i < blasts; i++) {
      const at = t + i * period;
      blip(a, { at, dur: 0.3, freq: 440, gain: 0.5, type: 'sawtooth' });
      blip(a, { at, dur: 0.3, freq: 554.37, gain: 0.5, type: 'sawtooth' });
      blip(a, { at, dur: 0.3, freq: 220, gain: 0.32, type: 'square' });
    }
    return;
  }

  if (kind === 'critical') {
    // Alternating high/low beeps so it reads as an alarm, not a chime.
    for (let i = 0; i < 4; i++) {
      blip(a, {
        at: t + i * 0.2,
        dur: 0.14,
        freq: i % 2 ? 1046.5 : 1567.98,
        gain: 0.55,
        type: 'square',
      });
    }
    return;
  }

  blip(a, { at: t, dur: 0.18, freq: 880, gain: 0.36, type: 'triangle' });
  blip(a, { at: t + 0.16, dur: 0.26, freq: 1174.66, gain: 0.34, type: 'triangle' });
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
