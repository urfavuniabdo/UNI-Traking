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

  it('a fix that never left the anchor cannot outrun the radius over its window', () => {
    // parked, phone screaming a stale 150 km/h: 12 m of noise over a minute is 0.72 km/h at best
    const frozen = c.groundSpeed({ deviceKmh: 150, stepM: 0, stepDtS: 60, anchorM: 0, anchorDtS: 60, noiseRadiusM: 12 });
    expect(frozen.speedKmh).toBeCloseTo(0.72, 2);
    expect(frozen.moved).toBe(false);
    expect(frozen.stationary).toBe(true);
    // the same reading a heartbeat apart: still no trip's worth of ground, but not conclusive yet
    const justLanded = c.groundSpeed({ deviceKmh: 150, stepM: 0, stepDtS: 5, anchorM: 0, anchorDtS: 5, noiseRadiusM: 12 });
    expect(justLanded.speedKmh).toBeLessThanOrEqual(8.64);
    expect(justLanded.stationary).toBe(false);
  });

  it('confirms a move the coordinates show — walking included', () => {
    const moved = c.groundSpeed({ deviceKmh: 40, stepM: 100, stepDtS: 15, anchorM: 100, anchorDtS: 15, noiseRadiusM: 12 });
    expect(moved).toEqual({ speedKmh: 40, moved: true, stationary: false });
    // Doppler ~0 at walking pace: the metres covered carry the driver out of STOPPED
    const walking = c.groundSpeed({ deviceKmh: 0.4, stepM: 6.7, stepDtS: 5, anchorM: 6.7, anchorDtS: 5, noiseRadiusM: 12 });
    expect(walking.speedKmh).toBeCloseTo(4.8, 1);
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
