import { Injectable } from '@nestjs/common';
import { MOTION, type MotionState } from '../../shared/constants';

export interface MotionTrack {
  state: MotionState;
  ema: number | null;
  pending: MotionState;
  pendingCount: number;
  /** When the coordinates first claimed a move; the state may leave STOPPED only after MOVE_CONFIRM_S. */
  moveStartTs: number | null;
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
  /** steps/minute from the phone's motion sensor; ≥ STEPS_PER_MIN_ON_FOOT means feet, not a vehicle */
  stepsPerMin?: number | null;
  /**
   * Acceleration variance (m/s²) the phone's own accelerometer measured over the last seconds.
   * A device lying flat has ~0.02; a vehicle on any road never falls below a few tenths. Below
   * STILL_ENERGY_MS2 nothing under the phone moved, whatever the receiver claims.
   */
  motionEnergyMs2?: number | null;
  /** the speed the ground believed at the previous fix — the start point of the accel test */
  prevKmh?: number | null;
}

export interface GroundSpeedResult {
  speedKmh: number | null;
  /** true when the coordinates put him outside the anchor's noise circle — a confirmed move. */
  moved: boolean;
  /** true when the coordinates conclusive prove he did not move — no hysteresis needed. */
  stationary: boolean;
  /**
   * true when the step demanded more acceleration than grip allows. Such a reading is not a fast
   * driver, it is a relocated or cached fix — so nothing built on it may raise an alert.
   */
  implausible: boolean;
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
    return { state: 'UNKNOWN', ema: null, pending: 'UNKNOWN', pendingCount: 0, moveStartTs: null };
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
   *    same span, **and** the step is one a body could have performed. Then the coordinates vouch for
   *    the *fact* of the travel and the device is believed on *how fast*: how far he went is the
   *    metres he actually covered (TraceService.stepMetres), not this number.
   *  - no — his speed is the displacement left over *after* the bubble is subtracted, which inside
   *    the bubble is nothing. Here the device is NOT believed: measured on his apartment floor the
   *    Doppler field said 136 km/h while his coordinates had carried him 24 m in 16 s. "He has not
   *    left his bubble in half a minute" is not an estimate any more: it is a fact, so STOPPED
   *    commits without waiting for the hysteresis samples.
   * What the IMU adds on top is corroboration, not arithmetic: steps cap him at the walking band and
   * a flat phone (STILL_ENERGY_MS2) puts him back in the stationary band whatever the satellites say.
   */
  groundSpeed(i: GroundSpeedInput): GroundSpeedResult {
    // A step smaller than the noise circle is not a step: the phone ping-ponging 4 m either way at
    // 25 m accuracy covers "12 km/h" on paper every 5 s without going anywhere.
    const stepDerived =
      i.stepDtS !== null && i.stepDtS > 0 && i.stepM > i.noiseRadiusM ? (i.stepM / i.stepDtS) * 3.6 : null;
    const spanS = i.anchorDtS ?? 0;
    const netKmh = spanS > 0 ? (i.anchorM / spanS) * 3.6 : null;
    const reported = this.resolveSpeed(i.deviceKmh, this.resolveSpeed(stepDerived, netKmh));
    // Fewer than MIN_WINDOW_FIXES fixes: the coordinates have no opinion yet, so the phone's reading
    // stands and no state is confirmed either way. The next fix settles it.
    if (i.netSamples < MOTION.MIN_WINDOW_FIXES) {
      return { speedKmh: this.onFoot(i.stepsPerMin, reported), moved: false, stationary: false, implausible: false };
    }
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
    // What the coordinates support once the bubble is taken out: the ceiling for a driver the window
    // never saw leave home, the floor for one it did.
    const grounded = spanS > 0 ? (Math.max(0, i.anchorM - bubbleM) / spanS) * 3.6 : 0;
    // The accelerometer is the witness the receiver cannot bribe. A phone lying flat in a pocket
    // varies by ~0.02 m/s² whatever the satellites say; the 2026-10-26 ghost block claimed 137 km/h
    // for eleven minutes over a device that had not been touched. So below STILL_ENERGY_MS2 nothing
    // moved him, his speed is the stationary band, and STOPPED commits without an argument.
    const still = i.motionEnergyMs2 !== null && i.motionEnergyMs2 !== undefined && i.motionEnergyMs2 < MOTION.STILL_ENERGY_MS2;
    if (still) {
      return {
        speedKmh: this.onFoot(i.stepsPerMin, Math.min(grounded, MOTION.STATIONARY_SPEED_KMH)),
        moved: false,
        stationary: true,
        implausible: false,
      };
    }
    const moved = spanS > 0 && i.anchorM > allowanceM && (i.netSamples >= MOTION.MIN_NET_SAMPLES || provesVehicle);
    if (!moved) {
      // Inside his bubble the device is not believed: what the coordinates leave over is his speed.
      const bounded = reported === null ? grounded : Math.min(reported, grounded);
      return { speedKmh: this.onFoot(i.stepsPerMin, bounded), moved: false, stationary: grounded <= MOTION.STATIONARY_SPEED_KMH, implausible: false };
    }

    // Kinematic plausibility, the last gate before the state changes: a body that held `prevKmh` a
    // few seconds ago cannot be doing `claimed` now — the jump needs more grip than a tyre or a shoe
    // has. His own upload: 0.9 → 77 → 136 → 12.9 km/h inside 16 s, which is what a phone waking from
    // a doze with a cached fix from the other side of the block looks like, not a driver.
    const claimed = reported ?? grounded;
    if (!this.plausibleAccel(i.prevKmh, claimed, i.stepDtS)) {
      // Refuse the step: nothing new is asserted about him, so he keeps the last believed speed and
      // state, and no alert may be built on the interval. The position itself still moved, so the
      // caller restarts the window from here rather than calling him stationary.
      return { speedKmh: i.prevKmh ?? claimed, moved: false, stationary: false, implausible: true };
    }
    return { speedKmh: this.onFoot(i.stepsPerMin, claimed), moved: true, stationary: false, implausible: false };
  }

  /**
   * Feet or wheels is not a speed question: a man striding down a corridor and a car crawling in
   * traffic sit in the same GPS band, and every production classifier settles it from the IMU
   * instead. At STEPS_PER_MIN_ON_FOOT or above his feet are on the ground, so the state may be
   * WALKING and never RIDING, whatever the fix suggests.
   */
  onFoot(stepsPerMin: number | null | undefined, kmh: number | null): number | null {
    if (kmh === null) return null;
    if (stepsPerMin !== null && stepsPerMin !== undefined && stepsPerMin >= MOTION.STEPS_PER_MIN_ON_FOOT) {
      return Math.min(kmh, MOTION.WALK_MAX_KMH);
    }
    return kmh;
  }

  /** Can a body actually get from `prevKmh` to `kmh` in `dtS`? No pair of numbers → nothing to test. */
  plausibleAccel(prevKmh: number | null | undefined, kmh: number | null | undefined, dtS: number | null | undefined): boolean {
    if (prevKmh === null || prevKmh === undefined || kmh === null || kmh === undefined) return true;
    if (dtS === null || dtS === undefined || dtS <= 0) return true;
    return Math.abs(kmh - prevKmh) / 3.6 / dtS <= MOTION.MAX_ACCEL_MS2;
  }

  /**
   * A move is only a move if it **holds**. One window whose two means land a bubble apart is also
   * exactly what a single ghost fix looks like — and his apartment produced one burst of them: 20
   * fixes, 1.93 km of "route", a trip that never closed. Telematics rules state their conditions as
   * durations for the same reason. So: while he is standing, a *young* window may not state him as
   * moving until MOVE_CONFIRM_S after the coordinates first claimed it — he keeps the last speed and
   * state the ground believed, so the chip can never claim more motion than the line does.
   *  - a window that already averaged MIN_NET_SAMPLES fixes of one-direction travel is itself the
   *    sustained evidence (that is what the averaging is for), and states him at once;
   *  - a driver who is not standing still has nothing to protect — the cold start of the day and an
   *    ongoing run are classified as they always were;
   *  - a sample that claims nothing neither commits nor acquits him: the clock keeps running, because
   *    a slow walker's window is exactly what produces those. Only the ground concluding he is
   *    *stationary* clears it — he came home, so the next journey starts a fresh claim.
   * Once the hold expires the commit is immediate: a proven move — a mature window, or a claim that
   * held — is a stronger statement than the three disagreeing samples hysteresis would ask for.
   */
  confirmMove(track: MotionTrack, ts: number, speedKmh: number | null, evidence: { moved: boolean; mature: boolean }): ClassifyResult | null {
    if (track.state !== 'STOPPED') {
      track.moveStartTs = null;
      return null;
    }
    if (!evidence.moved) return null;
    if (!evidence.mature) {
      if (track.moveStartTs === null) track.moveStartTs = ts;
      if ((ts - track.moveStartTs) / 1000 < MOTION.MOVE_CONFIRM_S) {
        return { state: track.state, ema: track.ema, changed: false, dropped: false, reason: 'MOVE_HELD' };
      }
    }
    track.moveStartTs = null;
    track.pendingCount = MOTION.HYSTERESIS_SAMPLES;
    track.pending = this.instantState(speedKmh);
    return null;
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
    track.moveStartTs = null;
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
