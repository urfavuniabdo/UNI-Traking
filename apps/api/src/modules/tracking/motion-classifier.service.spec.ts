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

  it('commits the first usable sample immediately (cold start out of UNKNOWN)', () => {
    const t = c.newTrack();
    const r = c.classify(t, 40);
    expect(r.state).toBe('RIDING');
    expect(r.changed).toBe(true);
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
