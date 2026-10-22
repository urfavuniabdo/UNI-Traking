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

  /** Absurd-jump guard: a GPS jump larger than accuracyDriftM within <2s is not credible. */
  isAbsurd(speedKmh: number | null, distanceM: number, dtS: number | null, accuracyDriftM: number): boolean {
    if (speedKmh !== null && speedKmh > 250) return true;
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

    if (instant === track.pending) track.pendingCount += 1;
    else {
      track.pending = instant;
      track.pendingCount = 1;
    }

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
