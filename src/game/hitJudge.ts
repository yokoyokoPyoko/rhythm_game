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

  const candidates: { ring: RingState; err: number; yDist: number }[] = [];
  for (const ring of rings) {
    if (ring.resolved) continue;
    const err = Math.abs(pressTimeMs - ring.hitTime);
    if (err < windowMs) {
      const yDist = Math.abs(cursorY - ring.targetY);
      candidates.push({ ring, err, yDist });
    }
  }

  if (candidates.length === 0) return null;

  const hitCandidates = candidates.filter((c) => c.yDist < HIT_Y);

  let selected: { ring: RingState; err: number; yDist: number };
  let result: 'perfect' | 'good' | 'miss';

  if (hitCandidates.length > 0) {
    hitCandidates.sort((a, b) => a.err - b.err);
    selected = hitCandidates[0];
    if (selected.err < PERFECT_MS && selected.yDist < PERFECT_Y) {
      result = 'perfect';
    } else {
      result = 'good';
    }
  } else {
    candidates.sort((a, b) => a.err - b.err);
    selected = candidates[0];
    result = 'miss';
  }

  selected.ring.resolved = true;
  if (result !== 'miss') {
    selected.ring.hit = true;
  }

  return { result, errorMs: pressTimeMs - selected.ring.hitTime };
}
