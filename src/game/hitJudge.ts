import type { HitJudgement, RingState } from '../types';

const Y_HIT_TOLERANCE = 60;
const Y_PERFECT_TOLERANCE = 30;
const PERFECT_MS = 50;

export function judgeHit(
  pressTimeMs: number,
  cursorY: number,
  rings: RingState[],
  currentBeatMs: number,
): HitJudgement | null {
  let nearest: RingState | null = null;
  let nearestError = Infinity;

  for (const ring of rings) {
    if (ring.resolved) continue;
    const error = Math.abs(ring.hitTime - pressTimeMs);
    if (error < nearestError) {
      nearestError = error;
      nearest = ring;
    }
  }

  if (!nearest) return null;

  const timingError = Math.abs(nearest.hitTime - pressTimeMs);
  const yDistance = Math.abs(cursorY - nearest.targetY);

  if (timingError < currentBeatMs * 0.4 && yDistance < Y_HIT_TOLERANCE) {
    nearest.resolved = true;
    nearest.hit = true;
    if (timingError < PERFECT_MS && yDistance < Y_PERFECT_TOLERANCE) {
      return { result: 'perfect', errorMs: timingError };
    }
    return { result: 'good', errorMs: timingError };
  }

  return null;
}