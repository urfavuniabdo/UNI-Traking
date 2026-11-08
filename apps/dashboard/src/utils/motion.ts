import type { MotionState } from '@/api/types';

/** One glyph per motion state — the marker stays the colour's job, this only says what is moving. */
export const MOTION_EMOJI: Record<MotionState, string> = {
  WALKING: '🚶',
  RIDING: '🚐',
  STOPPED: '🧍',
  UNKNOWN: '❓',
};

export function motionEmoji(state: MotionState): string {
  return MOTION_EMOJI[state] ?? MOTION_EMOJI.UNKNOWN;
}
