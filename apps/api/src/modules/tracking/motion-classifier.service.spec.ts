import { MotionClassifierService } from './motion-classifier.service';
import { MOTION } from '../../shared/constants';

describe('MotionClassifierService (pure)', () => {
  const c = new MotionClassifierService();

  it('maps speed to state per §5 thresholds', () => {
    expect(c.instantState(0)).toBe('STOPPED');
    expect(c.instantState(MOTION.STATIONARY_SPEED_KMH)).toBe('STOPPED');
    expect(c.instantState(3)).toBe('WALKING');
    expect(c.instantState(MOTION.WALK_MAX_KMH)).toBe('WALKING');
    expect(c.instantState(40)).toBe('RIDING');
    expect(c.instantState(null)).toBe('UNKNOWN');
  });

  it('takes the higher of the reported and the GPS-derived speed (a walking phone reads ~0)', () => {
    expect(c.resolveSpeed(0.4, 4.6)).toBe(4.6);
    expect(c.resolveSpeed(58, 3)).toBe(58);
    expect(c.resolveSpeed(null, 4.6)).toBe(4.6);
    expect(c.resolveSpeed(4.6, null)).toBe(4.6);
    expect(c.resolveSpeed(null, null)).toBeNull();
  });

  it('walks out of STOPPED: three covered-metre samples commit WALKING', () => {
    const t = c.newTrack();
    c.classify(t, 0);
    expect(t.state).toBe('STOPPED');
    // the device keeps saying ~0.4 km/h; only the displacement proves the driver is walking
    expect(c.classify(t, c.resolveSpeed(0.4, 4.6)).state).toBe('STOPPED');
    expect(c.classify(t, c.resolveSpeed(0.4, 4.6)).state).toBe('STOPPED');
    expect(c.classify(t, c.resolveSpeed(0.4, 4.6)).state).toBe('WALKING');
  });

  it('commits the first usable sample immediately (cold start out of UNKNOWN)', () => {
    const t = c.newTrack();
    const r = c.classify(t, 40);
    expect(r.state).toBe('RIDING');
    expect(r.changed).toBe(true);
  });

  it('a fix that never left its bubble cannot outrun it', () => {
    // parked, phone screaming a stale 150 km/h: nothing past the bubble is nothing travelled
    const frozen = c.groundSpeed({ deviceKmh: 150, stepM: 0, stepDtS: 60, anchorM: 0, anchorDtS: 60, netSamples: 12, noiseRadiusM: 12 });
    expect(frozen.speedKmh).toBe(0);
    expect(frozen.moved).toBe(false);
    expect(frozen.stationary).toBe(true);
    // the same reading a heartbeat apart — a position that has not moved is conclusive at any span
    const justLanded = c.groundSpeed({ deviceKmh: 150, stepM: 0, stepDtS: 5, anchorM: 0, anchorDtS: 5, netSamples: 2, noiseRadiusM: 12 });
    expect(justLanded.speedKmh).toBe(0);
    expect(justLanded.stationary).toBe(true);
  });

  it('the drift burst he actually produced while standing reads واقف', () => {
    // D0203, 2026-10-26 10:16:52→10:17:49: 104 m of wandering path, 1.4 m of net progress, the
    // window means 21 m apart over 57 s — every one of those numbers used to say "ماشي".
    const drift = c.groundSpeed({ deviceKmh: 6.2, stepM: 23, stepDtS: 14, anchorM: 21, anchorDtS: 57, netSamples: 10, noiseRadiusM: 12 });
    expect(drift.moved).toBe(false);
    // what survives the bubble is inside the stationary band, so the state machine reads واقف
    expect(drift.speedKmh).toBeLessThan(MOTION.STATIONARY_SPEED_KMH);
    expect(c.instantState(drift.speedKmh)).toBe('STOPPED');
    expect(drift.stationary).toBe(true);
  });

  it('a window full of fixes needs less travel than a window of two', () => {
    // 12 m of mean-to-mean displacement over 24 s is one phone's wander or another's slow crawl;
    // the more samples back the mean, the smaller a move the coordinates are allowed to call.
    const sparse = c.groundSpeed({ deviceKmh: 1.8, stepM: 6, stepDtS: 12, anchorM: 12, anchorDtS: 24, netSamples: 2, noiseRadiusM: 12 });
    const dense = c.groundSpeed({ deviceKmh: 1.8, stepM: 6, stepDtS: 12, anchorM: 12, anchorDtS: 24, netSamples: 16, noiseRadiusM: 12 });
    expect(sparse.moved).toBe(false);
    expect(dense.moved).toBe(true);
  });

  it('a window younger than MIN_NET_SAMPLES may prove a vehicle, never a walk', () => {
    // 40 m of mean-to-mean over 15 s = 9.6 km/h: above the walking band, so three fixes are enough
    // to say he is in a moving car — and the trip opens on the second fix of his day.
    const car = c.groundSpeed({ deviceKmh: 40, stepM: 100, stepDtS: 15, anchorM: 100, anchorDtS: 15, netSamples: 4, noiseRadiusM: 12 });
    expect(car.moved).toBe(true);
    // the same three fixes at 4.8 km/h sit exactly in the band GPS cannot resolve yet: no move, and
    // so no phantom trip for a phone that has only averaged four wanderings.
    const walkTooYoung = c.groundSpeed({ deviceKmh: 4.8, stepM: 20, stepDtS: 15, anchorM: 20, anchorDtS: 15, netSamples: 4, noiseRadiusM: 12 });
    expect(walkTooYoung.moved).toBe(false);
  });

  it('confirms a move the coordinates show — walking included', () => {
    // The window proves *that* he travels; the device is believed on *how fast*, and the metres he
    // actually covered — TraceService.stepMetres, not this number — are what the mileage counts.
    const moved = c.groundSpeed({ deviceKmh: 40, stepM: 100, stepDtS: 15, anchorM: 100, anchorDtS: 15, netSamples: 8, noiseRadiusM: 12 });
    expect(moved).toEqual({ speedKmh: 40, moved: true, stationary: false, implausible: false });
    // Doppler ~0 at walking pace: the 60 m his window travelled carry him out of STOPPED
    const walking = c.groundSpeed({ deviceKmh: 0.4, stepM: 6.7, stepDtS: 5, anchorM: 60, anchorDtS: 45, netSamples: 10, noiseRadiusM: 12 });
    expect(walking.moved).toBe(true);
    expect(walking.speedKmh).toBeCloseTo(4.8, 1);
  });

  it('one fix is not a window: the coordinates have no opinion until the next one lands', () => {
    // The day's first fix — or a phone whose fix gaps starved the window — is judged on the pair it
    // is part of, never on its own Doppler. Before that, no state is confirmed either way.
    const alone = c.groundSpeed({ deviceKmh: 137, stepM: 509, stepDtS: 67, anchorM: 0, anchorDtS: null, netSamples: 1, noiseRadiusM: 12 });
    expect(alone).toEqual({ speedKmh: 137, moved: false, stationary: false, implausible: false });
  });

  it('refuses a speed change no body could have performed', () => {
    // D0203's wake-up block, to the km/h: 0.9 km/h three seconds ago, 60 m of "ground" and a 77 km/h
    // Doppler now. The claim needs 7 m/s²; nothing but a receiver waking up with a cached fix does.
    const ghost = c.groundSpeed({ deviceKmh: 77, stepM: 60, stepDtS: 3, anchorM: 60, anchorDtS: 3, netSamples: 3, noiseRadiusM: 12, prevKmh: 0.9 });
    expect(ghost.moved).toBe(false);
    expect(ghost.stationary).toBe(false);
    expect(ghost.implausible).toBe(true);
    expect(ghost.speedKmh).toBe(0.9); // he keeps the last speed the ground believed
    // a real car pulling out of a standstill at 24 km/h in 15 s is well inside the ceiling
    const car = c.groundSpeed({ deviceKmh: 24, stepM: 100, stepDtS: 15, anchorM: 100, anchorDtS: 15, netSamples: 3, noiseRadiusM: 12, prevKmh: 0 });
    expect(car.implausible).toBe(false);
    expect(car.moved).toBe(true);
  });

  it('the accelerometer outrules a receiver that is internally consistent and simply fictional', () => {
    const args = { deviceKmh: 136, stepM: 509, stepDtS: 67, anchorM: 509, anchorDtS: 67, netSamples: 8, noiseRadiusM: 12 };
    // A phone lying flat varies by ~0.02 m/s²: nothing moved him, whatever the satellites all agree
    // they saw.
    expect(c.groundSpeed({ ...args, motionEnergyMs2: 0.02 })).toEqual({ speedKmh: 1.5, moved: false, stationary: true, implausible: false });
    // a hand in a pocket on the way to the gate never goes quiet, so the ground keeps its say
    expect(c.groundSpeed({ ...args, motionEnergyMs2: 1.4 }).moved).toBe(true);
    // and no device that sends nothing is disbelieved — the rule degrades to coordinates alone
    expect(c.groundSpeed(args).moved).toBe(true);
  });

  it('steps on the ground cap him at the walking band, whatever the fix suggests', () => {
    // 4.8 km/h of net travel with a Doppler burst of 30 km/h: a man is walking past a mirror, not
    // driving. Feet are a fact the IMU reports and the coordinates cannot contradict.
    const onFoot = c.groundSpeed({ deviceKmh: 30, stepM: 20, stepDtS: 5, anchorM: 60, anchorDtS: 45, netSamples: 10, noiseRadiusM: 12, stepsPerMin: 96 });
    expect(onFoot.moved).toBe(true);
    expect(onFoot.speedKmh).toBeLessThanOrEqual(MOTION.WALK_MAX_KMH);
    const noSteps = c.groundSpeed({ deviceKmh: 30, stepM: 20, stepDtS: 5, anchorM: 60, anchorDtS: 45, netSamples: 10, noiseRadiusM: 12 });
    expect(noSteps.speedKmh).toBe(30);
  });

  it('a standing driver is not stated as moving on one young claim', () => {
    const t = c.newTrack();
    c.confirmStationary(t, 0.2);
    const young = { moved: true, mature: false };
    // the first claim: nothing is committed yet
    expect(c.confirmMove(t, 1_000, 137, young)?.reason).toBe('MOVE_HELD');
    // a sample that claims nothing does not break the run — a slow walker's window is full of them
    expect(c.confirmMove(t, 6_000, 137, { moved: false, mature: false })).toBeNull();
    expect(t.moveStartTs).toBe(1_000);
    // still inside the hold: the claim has not lasted MOVE_CONFIRM_S yet
    expect(c.confirmMove(t, 6_000, 137, young)?.reason).toBe('MOVE_HELD');
    expect(t.pendingCount).toBe(0);
    // once it has held, the commit is immediate: no three more samples asked for
    expect(c.confirmMove(t, MOTION.MOVE_CONFIRM_S * 1000 + 1_000, 137, young)).toBeNull();
    expect(t.pendingCount).toBe(MOTION.HYSTERESIS_SAMPLES);
    expect(t.moveStartTs).toBeNull();

    // a window that already averaged MIN_NET_SAMPLES fixes is itself the sustained evidence: no hold
    const mature = c.newTrack();
    c.confirmStationary(mature, 0.2);
    expect(c.confirmMove(mature, 1_000, 4.8, { moved: true, mature: true })).toBeNull();
    expect(mature.pendingCount).toBe(MOTION.HYSTERESIS_SAMPLES);
    expect(mature.moveStartTs).toBeNull();

    // and the ground putting him back in his bubble clears the clock
    c.confirmStationary(t, 0.1);
    expect(t.moveStartTs).toBeNull();
  });

  it('stops the averaging dead when the ground is conclusive', () => {
    const t = c.newTrack();
    c.classify(t, 150);
    expect(t.state).toBe('RIDING');
    const r = c.confirmStationary(t, 0.5);
    expect(r.state).toBe('STOPPED');
    expect(r.changed).toBe(true);
    expect(t.ema).toBe(0.5);
    expect(t.pendingCount).toBe(0);
  });

  it('applies hysteresis — needs HYSTERESIS_SAMPLES consistent samples before switching', () => {
    const t = c.newTrack();
    c.classify(t, 0); // → STOPPED (cold start)
    expect(t.state).toBe('STOPPED');

    // 1st RIDING sample: still STOPPED
    expect(c.classify(t, 60).state).toBe('STOPPED');
    // 2nd RIDING: still STOPPED
    expect(c.classify(t, 60).state).toBe('STOPPED');
    // 3rd RIDING: switch (MOTION.HYSTERESIS_SAMPLES === 3)
    expect(c.classify(t, 60).state).toBe('RIDING');
  });

  it('keeps the committed state until enough consistent samples accumulate (hysteresis floor)', () => {
    const t = c.newTrack();
    c.classify(t, 0); // cold → STOPPED, ema 0
    // a single brief spike raises ema but must not switch immediately
    expect(c.classify(t, 60).state).toBe('STOPPED');
    expect(t.pending).toBe('RIDING');
    expect(t.pendingCount).toBe(1);
    // consistent RIDING samples continue accumulating toward the switch
    c.classify(t, 60);
    expect(t.pendingCount).toBe(2);
    expect(t.state).toBe('STOPPED');
  });

  it('smooths speed with EMA (alpha 0.35)', () => {
    const t = c.newTrack();
    c.classify(t, 100);
    expect(t.ema).toBeCloseTo(100, 6);
    c.classify(t, 0);
    // ema = 0.35*0 + 0.65*100 = 65
    expect(t.ema).toBeCloseTo(65, 6);
  });

  it('drops poor-accuracy and sub-interval samples', () => {
    expect(c.isDroppable({ accuracyM: MOTION.ACCURACY_REJECT_M + 1, dtS: 5, speedKmh: 30 }).dropped).toBe(true);
    expect(c.isDroppable({ accuracyM: 5, dtS: MOTION.MIN_INTERVAL_S - 1, speedKmh: 30 }).dropped).toBe(true);
    expect(c.isDroppable({ accuracyM: 5, dtS: 5, speedKmh: 30 }).dropped).toBe(false);
  });

  it('flags absurd speed / GPS jumps', () => {
    expect(c.isAbsurd(300, 10, 5, 120)).toBe(true); // > 250 km/h
    expect(c.isAbsurd(50, 200, 1, 120)).toBe(true); // > accuracyDrift in < 2s
    expect(c.isAbsurd(50, 200, 10, 120)).toBe(false);
  });

  it('harsh braking math: ≤ -2.2 m/s² is braking, ≥ 2.8 is acceleration', () => {
    // (20 - 60) km/h over 2 s → -5.56 m/s²
    const braking = c.harsh((20 - 60) / 3.6 / 2, -2.2, 2.8);
    expect(braking?.type).toBe('HARSH_BRAKING');
    expect(braking?.severity).toBe('WARNING');
    const accel = c.harsh((80 - 20) / 3.6 / 3, -2.2, 2.8);
    expect(accel?.type).toBe('HARSH_ACCELERATION');
    expect(c.harsh(-1, -2.2, 2.8)).toBeNull();
    expect(c.harsh(0.5, -2.2, 2.8)).toBeNull();
  });

  it('harsh() returns null for non-finite values', () => {
    expect(c.harsh(null, -2.2, 2.8)).toBeNull();
    expect(c.harsh(Number.NaN, -2.2, 2.8)).toBeNull();
  });
});
