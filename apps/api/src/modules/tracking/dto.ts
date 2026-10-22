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
