let ctx: AudioContext | null = null;
let master: DynamicsCompressorNode | null = null;

type AlertSound = 'critical' | 'info';

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
 *  * `critical` — two bursts of piercing high beeps, audibly above the old ping.
 *  * `info`     — a soft two-note chime.
 */
export function playPing(kind: AlertSound = 'info'): void {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime + 0.01;

  if (kind === 'critical') {
    // Two bursts of four alternating beeps — longer, higher and harsher than a chime.
    for (let burst = 0; burst < 2; burst++) {
      const base = t + burst * 1.35;
      for (let i = 0; i < 4; i++) {
        blip(a, {
          at: base + i * 0.22,
          dur: 0.15,
          freq: i % 2 ? 1318.51 : 1975.53,
          gain: 0.65,
          type: 'square',
        });
      }
    }
    return;
  }

  blip(a, { at: t, dur: 0.18, freq: 880, gain: 0.36, type: 'triangle' });
  blip(a, { at: t + 0.16, dur: 0.26, freq: 1174.66, gain: 0.34, type: 'triangle' });
}

interface Siren {
  osc: OscillatorNode;
  low: OscillatorNode;
  lfo: OscillatorNode;
  lowLfo: OscillatorNode;
  amp: GainNode;
}

let siren: Siren | null = null;

/**
 * SOS siren: a continuous wailing tone that only stops when the operator stops it (or mutes the
 * board, or acknowledges the alert). Idempotent — a second SOS while it rings does not stack.
 */
export function startSosSiren(): void {
  if (siren) return;
  const a = audio();
  if (!a) return;
  const c = a.ctx;
  const t = c.currentTime + 0.02;

  const amp = c.createGain();
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(0.55, t + 0.08);
  amp.connect(a.out);

  // Wailing voice: 820 Hz swept ±380 Hz about once a second.
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(820, t);
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(0.9, t);
  const depth = c.createGain();
  depth.gain.setValueAtTime(380, t);
  lfo.connect(depth).connect(osc.frequency);
  osc.connect(amp);

  // A lower square voice gives the siren the body of a building alarm.
  const low = c.createOscillator();
  low.type = 'square';
  low.frequency.setValueAtTime(410, t);
  const lowLfo = c.createOscillator();
  lowLfo.type = 'sine';
  lowLfo.frequency.setValueAtTime(0.9, t);
  const lowDepth = c.createGain();
  lowDepth.gain.setValueAtTime(190, t);
  lowLfo.connect(lowDepth).connect(low.frequency);
  const lowGain = c.createGain();
  lowGain.gain.setValueAtTime(0.22, t);
  low.connect(lowGain).connect(amp);

  for (const n of [osc, low, lfo, lowLfo]) n.start(t);
  siren = { osc, low, lfo, lowLfo, amp };
}

export function stopSosSiren(): void {
  const active = siren;
  if (!active) return;
  siren = null;
  const c = ctx;
  if (!c) return;
  const t = c.currentTime;
  try {
    active.amp.gain.cancelScheduledValues(t);
    active.amp.gain.setValueAtTime(Math.max(active.amp.gain.value, 0.0001), t);
    active.amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  } catch {
    /* already gone */
  }
  for (const n of [active.osc, active.low, active.lfo, active.lowLfo]) {
    try {
      n.stop(t + 0.1);
    } catch {
      /* already stopped */
    }
  }
  setTimeout(() => {
    try {
      for (const n of [active.osc, active.low, active.lfo, active.lowLfo]) n.disconnect();
      active.amp.disconnect();
    } catch {
      /* already disconnected */
    }
  }, 250);
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
