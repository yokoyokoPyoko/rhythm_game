import type { HitJudgement, RingState } from '../types';

const PERFECT_MS = 50;
const PERFECT_Y = 30;
const HIT_Y = 60;

export function judgeHit(
  pressTimeMs: number,
  cursorY: number,
  rings: RingState[],
  currentBeatMs: number,
): HitJudgement | null {
  const windowMs = currentBeatMs * 0.4;

  let nearest: RingState | null = null;
  let nearestErr = Infinity;
  for (const ring of rings) {
    if (ring.resolved) continue;
    const err = Math.abs(pressTimeMs - ring.hitTime);
    if (err < nearestErr) {
      nearestErr = err;
      nearest = ring;
    }
  }

  if (!nearest) return null;
  if (nearestErr >= windowMs) return null;

  const yDist = Math.abs(cursorY - nearest.targetY);
  if (yDist >= HIT_Y) {
    return { result: 'miss', errorMs: pressTimeMs - nearest.hitTime };
  }

  if (nearestErr < PERFECT_MS && yDist < PERFECT_Y) {
    return { result: 'perfect', errorMs: pressTimeMs - nearest.hitTime };
  }

  return { result: 'good', errorMs: pressTimeMs - nearest.hitTime };
}
