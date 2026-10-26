import type { MotionState } from '../../shared/constants';

export interface PositionItemDto {
  clientTs: string;
  lat: number;
  lng: number;
  speed?: number;
  bearing?: number;
  accuracy?: number;
  altitude?: number;
  battery?: number;
  provider?: string;
  motionState?: string;
  buffered?: boolean;
  /**
   * The phone's own motion evidence (§5): steps/minute and the accelerometer's acceleration
   * variance over the last seconds, in m/s². Both optional — a device that cannot measure them
   * sends nothing and is judged on the ground alone.
   */
  stepsPerMin?: number;
  motionEnergy?: number;
}

export interface PositionBatchDto {
  deviceId: string;
  batchSeq?: number;
  positions: PositionItemDto[];
}

export interface BatchRejectedItem {
  index: number;
  reason: string;
}

export interface BatchResult {
  accepted: number;
  deduped: number;
  rejected: BatchRejectedItem[];
  alertsRaised: number;
  nextServerTs: string;
}

/** Motion state stored on a Position row. */
export type StoredMotion = MotionState;
