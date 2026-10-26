import { Injectable } from '@nestjs/common';
import { MOTION, type MotionState } from '../../shared/constants';

export interface MotionTrack {
  state: MotionState;
  ema: number | null;
  pending: MotionState;
  pendingCount: number;
}

export interface SampleGate {
  accuracyM: number | null;
  dtS: number | null; // seconds since previous usable sample (null on the first)
  speedKmh: number | null;
}

export interface GroundSpeedInput {
  /** what the phone's Doppler says this fix is doing (km/h) */
  deviceKmh: number | null;
  stepM: number; // metres covered since the previous accepted fix
  stepDtS: number | null;
  /**
   * Net displacement over the window: the mean of its older half to the mean of its newer half.
   * Means, not endpoints — GPS drift is zero-mean noise, so the noise cancels out of a mean and a
   * driver standing still has nothing to report, while one on foot translates the whole window.
   */
  anchorM: number;
  anchorDtS: number | null;
  /** fixes in the window — the more of them, the less a single wander counts against the move */
  netSamples: number;
  /** his own accuracy circle, floored — inside it a "move" is a guess, not a fact */
  noiseRadiusM: number;
}

export interface GroundSpeedResult {
  speedKmh: number | null;
  /** true when the coordinates put him outside the anchor's noise circle — a confirmed move. */
  moved: boolean;
  /** true when the coordinates conclusive prove he did not move — no hysteresis needed. */
  stationary: boolean;
}

export interface ClassifyResult {
  state: MotionState;
  ema: number | null;
  changed: boolean;
  dropped: boolean;
  reason?: string;
}

export interface HarshResult {
  type: 'HARSH_BRAKING' | 'HARSH_ACCELERATION';
  severity: 'WARNING' | 'INFO';
  accelMs2: number;
}

/**
 * Pure, dependency-free motion-state classifier (mirrors apps/mobile/lib/core/motion_states.dart).
 *  - EMA speed smoothing (SPEED_EMA_ALPHA)
 *  - hysteresis: HYSTERESIS_SAMPLES consecutive same-state samples before switching
 *  - sample gating: drop poor-accuracy (ACCURACY_REJECT_M) / too-fast (MIN_INTERVAL_S) samples
 *  - groundSpeed: the coordinates, not the phone's speed field, decide whether he moved — and they
 *    decide it on the NET displacement of a window measured between the means of its two halves,
 *    because drift is zero-mean noise and endpoint-to-endpoint steps read it as speed
 * Thresholds are §5 of the CONTRACT. No DB access → trivially unit-testable.
 */
@Injectable()
export class MotionClassifierService {
  newTrack(): MotionTrack {
    return { state: 'UNKNOWN', ema: null, pending: 'UNKNOWN', pendingCount: 0 };
  }

  /** Raw instantaneous class from a speed (km/h). No data → UNKNOWN. */
  instantState(speedKmh: number | null): MotionState {
    if (speedKmh === null || !Number.isFinite(speedKmh)) return 'UNKNOWN';
    if (speedKmh <= MOTION.STATIONARY_SPEED_KMH) return 'STOPPED';
    if (speedKmh <= MOTION.WALK_MAX_KMH) return 'WALKING';
    return 'RIDING';
  }

  /**
   * Best speed for a sample. A phone walking slowly reports a GPS-Doppler speed of 0–1 km/h
   * (the receiver averages over the last second and a hand-held device swings), which would
   * pin a walking driver in STOPPED. The metres actually covered between two fixes say
   * otherwise, so the higher of the two wins.
   */
  resolveSpeed(reported: number | null, derived: number | null): number | null {
    if (reported === null || !Number.isFinite(reported)) return derived;
    if (derived === null || !Number.isFinite(derived)) return reported;
    return Math.max(reported, derived);
  }

  /** true when a sample must be discarded before classification (poor accuracy or sub-interval dt). */
  isDroppable(gate: SampleGate): { dropped: boolean; reason?: string } {
    if (gate.accuracyM !== null && Number.isFinite(gate.accuracyM) && gate.accuracyM > MOTION.ACCURACY_REJECT_M) {
      return { dropped: true, reason: 'LOW_ACCURACY' };
    }
    if (gate.dtS !== null && Number.isFinite(gate.dtS) && gate.dtS < MOTION.MIN_INTERVAL_S) {
      return { dropped: true, reason: 'TOO_FAST' };
    }
    return { dropped: false };
  }

  /**
   * The speed the *ground* supports, from coordinates alone. One question, at any span: did the
   * window actually go somewhere?
   *  - yes — the window's net displacement (mean of its older half to mean of its newer half) beat
   *    both the noise bubble, MOVED_CIRCLE_FACTOR circles — a parked phone wanders three times its
   *    own "accuracy", 40 m out and back at 5 m — and what the stationary band could drift over the
   *    same span. Then the phone's reading stands, and the metres covered can raise it (a walking
   *    phone under-reports Doppler by design).
   *  - no — his speed is the displacement left over *after* the bubble is subtracted, which inside
   *    the bubble is nothing. "He has not left his bubble in half a minute" is not an estimate any
   *    more: it is a fact, so STOPPED commits without waiting for the hysteresis samples.
   */
  groundSpeed(i: GroundSpeedInput): GroundSpeedResult {
    // A step smaller than the noise circle is not a step: the phone ping-ponging 4 m either way at
    // 25 m accuracy covers "12 km/h" on paper every 5 s without going anywhere.
    const stepDerived =
      i.stepDtS !== null && i.stepDtS > 0 && i.stepM > i.noiseRadiusM ? (i.stepM / i.stepDtS) * 3.6 : null;
    const spanS = i.anchorDtS ?? 0;
    const netKmh = spanS > 0 ? (i.anchorM / spanS) * 3.6 : null;
    const candidate = this.resolveSpeed(i.deviceKmh, this.resolveSpeed(stepDerived, netKmh));
    // One fix is not a window: the coordinates have no opinion yet, so the phone's reading stands and
    // no state is confirmed either way. The next fix — seconds later for a moving device — settles it.
    if (i.netSamples < 2) return { speedKmh: candidate, moved: false, stationary: false };
    // The bubble around the *pair of means*, not around a single fix: averaging n fixes cuts the
    // wander by √n, so the more of the window the phone has uploaded, the smaller a real
    // translation has to be before the coordinates are allowed to call it a move.
    const bubbleM = (MOTION.MOVED_CIRCLE_FACTOR * i.noiseRadiusM * Math.sqrt(2)) / Math.sqrt(Math.max(2, i.netSamples));
    // He left his bubble only if the window travelled more than the bubble *and* more than the
    // stationary band could itself wander across the same time.
    const allowanceM = Math.max(bubbleM, (MOTION.STATIONARY_SPEED_KMH / 3.6) * spanS);
    // A window younger than MIN_NET_SAMPLES fixes has averaged too little wander to tell a 3 km/h
    // drift burst from a 3 km/h walk — but a car is far above the walking band, so an immature
    // window is allowed to prove a vehicle and nothing else.
    const provesVehicle = netKmh !== null && netKmh > MOTION.WALK_MAX_KMH;
    if (spanS > 0 && i.anchorM > allowanceM && (i.netSamples >= MOTION.MIN_NET_SAMPLES || provesVehicle)) {
      return { speedKmh: candidate, moved: true, stationary: false };
    }

    // What the coordinates prove past the bubble is his speed; the part inside it is noise.
    const bounded = spanS > 0 ? (Math.max(0, i.anchorM - bubbleM) / spanS) * 3.6 : 0;
    const speedKmh = candidate === null ? null : Math.min(candidate, bounded);
    return { speedKmh, moved: false, stationary: bounded <= MOTION.STATIONARY_SPEED_KMH };
  }

  /**
   * Commits STOPPED straight away. Hysteresis damps noisy speed *estimates*; "he has not left his
   * accuracy circle in a minute" is not one, and smoothing it would keep a parked driver showing a
   * trip for the eight samples it takes the average to forget a stale fast reading.
   */
  confirmStationary(track: MotionTrack, speedKmh: number | null): ClassifyResult {
    const changed = track.state !== 'STOPPED';
    track.state = 'STOPPED';
    track.pending = 'STOPPED';
    track.pendingCount = 0;
    track.ema = speedKmh;
    return { state: 'STOPPED', ema: speedKmh, changed, dropped: false };
  }

  /** Absurd-jump guard: a GPS jump larger than accuracyDriftM within <2s is not credible. */
  isAbsurd(speedKmh: number | null, distanceM: number, dtS: number | null, accuracyDriftM: number): boolean {
    if (speedKmh !== null && speedKmh > MOTION.MAX_CREDIBLE_SPEED_KMH) return true;
    if (dtS !== null && dtS < 2 && distanceM > accuracyDriftM) return true;
    return false;
  }

  /** Mutates & returns the track after applying one sample (caller supplies the best-known speed). */
  classify(track: MotionTrack, speedKmh: number | null): ClassifyResult {
    // No credible speed: keep the last committed state, don't touch EMA.
    if (speedKmh === null || !Number.isFinite(speedKmh)) {
      return { state: track.state, ema: track.ema, changed: false, dropped: false };
    }
    const a = MOTION.SPEED_EMA_ALPHA;
    track.ema = track.ema === null ? speedKmh : a * speedKmh + (1 - a) * track.ema;
    const instant = this.instantState(track.ema);

    // Cold start (UNKNOWN) commits immediately.
    if (track.state === 'UNKNOWN') {
      track.state = instant;
      track.pending = instant;
      track.pendingCount = 0;
      return { state: instant, ema: track.ema, changed: true, dropped: false };
    }

    if (instant === track.state) {
      track.pending = instant;
      track.pendingCount = 0;
      return { state: track.state, ema: track.ema, changed: false, dropped: false };
    }

    // Hysteresis counts samples that disagree with the committed state — NOT samples that agree
    // with each other. A driver on foot produces a noisy estimate (his recorded trace judged
    // 3.4 → 18 → 8.3 → 4.7 → 9.1 → 8.2 km/h as GPS steps landed either side of the 7 km/h line),
    // so the WALKING and RIDING candidates kept resetting one another and he never left STOPPED.
    track.pending = instant;
    track.pendingCount += 1;

    if (track.pendingCount >= MOTION.HYSTERESIS_SAMPLES) {
      track.state = instant;
      track.pending = instant;
      track.pendingCount = 0;
      return { state: instant, ema: track.ema, changed: true, dropped: false };
    }
    return { state: track.state, ema: track.ema, changed: false, dropped: false };
  }

  /** Harsh braking / acceleration from a signed m/s² value and effective thresholds. */
  harsh(accelMs2: number | null, brakingMs2: number, accelTh: number): HarshResult | null {
    if (accelMs2 === null || !Number.isFinite(accelMs2)) return null;
    if (accelMs2 <= brakingMs2) return { type: 'HARSH_BRAKING', severity: 'WARNING', accelMs2 };
    if (accelMs2 >= accelTh) return { type: 'HARSH_ACCELERATION', severity: 'INFO', accelMs2 };
    return null;
  }
}
