import type { HitResult, RingDef } from '../types';

const PERFECT_SCORE = 50;
const GREAT_SCORE = 30;
const GOOD_SCORE = 10;
const TRACE_INTERVAL = 0.15;
const TRACE_BASE_SCORE = 2;
const TRACE_BONUS_STEP_BEATS = 16;
const TRACE_BONUS_STEP = 2;
const OFF_BEAT_RESET = 3;
const OFF_BEAT_EPS = 1e-9;
// Trace base points per 0.15s tick by difficulty level (1..5, index 0..4).
// Harder charts earn more while tracing the wave.
const TRACE_BASE_BY_DIFFICULTY = [1, 3, 4, 5, 8];

/** Trace tick base points for a difficulty level (1..5). Out-of-range/non-finite falls back to NORMAL. */
export function traceBaseForDifficulty(difficulty: number): number {
  const level = Number.isFinite(difficulty)
    ? Math.min(5, Math.max(1, Math.round(difficulty)))
    : 3;
  return TRACE_BASE_BY_DIFFICULTY[level - 1];
}
// Hold tick: while a hold ring is held, +combo & fixed score every 0.5 beats.
export const HOLD_TICK_BEATS = 0.5;
export const HOLD_TICK_SCORE = 5;

export interface ScoreStats {
  score: number;
  combo: number;
  maxCombo: number;
  perfect: number;
  great: number;
  good: number;
  miss: number;
}

export type Rank = 'S' | 'A' | 'B' | 'C' | 'D';

export class ScoreManager {
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private perfect = 0;
  private great = 0;
  private good = 0;
  private miss = 0;
  private traceAccumulator = 0;
  private comboBonus = 0;
  private traceBeats = 0;
  private offBeats = 0;
  private holdBeats = 0;
  private traceBase: number;

  constructor(traceBase: number = TRACE_BASE_SCORE) {
    this.traceBase = traceBase;
  }

  recordHit(result: HitResult): void {
    switch (result) {
      case 'perfect':
        this.perfect++;
        this.score += PERFECT_SCORE;
        this.incrementCombo();
        break;
      case 'great':
        this.great++;
        this.score += GREAT_SCORE;
        this.incrementCombo();
        break;
      case 'good':
        this.good++;
        this.score += GOOD_SCORE;
        this.incrementCombo();
        break;
      case 'miss':
        this.miss++;
        this.combo = 0;
        this.comboBonus = 0;
        this.traceBeats = 0;
        this.offBeats = 0;
        this.traceAccumulator = 0;
        this.holdBeats = 0;
        break;
    }
  }

  recordTrace(dt: number, isOnWave: boolean, beatMs: number): void {
    const beats = (dt * 1000) / beatMs;
    if (!isOnWave) {
      this.traceAccumulator = 0;
      this.traceBeats = 0;
      this.offBeats += beats;
      if (this.offBeats >= OFF_BEAT_RESET - OFF_BEAT_EPS) {
        this.combo = 0;
        this.comboBonus = 0;
        this.traceBeats = 0;
        this.traceAccumulator = 0;
      }
      return;
    }
    this.offBeats = 0;
    this.traceBeats += beats;
    while (this.traceBeats >= TRACE_BONUS_STEP_BEATS) {
      this.traceBeats -= TRACE_BONUS_STEP_BEATS;
      this.comboBonus += TRACE_BONUS_STEP;
    }
    this.traceAccumulator += dt;
    while (this.traceAccumulator >= TRACE_INTERVAL) {
      this.traceAccumulator -= TRACE_INTERVAL;
      this.score += this.traceBase + this.comboBonus;
    }
  }

  /**
   * Hold tick scoring: while a hold ring is held, every HOLD_TICK_BEATS
   * beats grant combo+1 and HOLD_TICK_SCORE points. No Y/wave condition —
   * holding alone counts. Call every tick with the current holding state;
   * passing false resets the accumulator (hold ended).
   */
  recordHold(dt: number, beatMs: number, holding: boolean): void {
    if (!holding) {
      this.holdBeats = 0;
      return;
    }
    this.holdBeats += (dt * 1000) / beatMs;
    while (this.holdBeats >= HOLD_TICK_BEATS) {
      this.holdBeats -= HOLD_TICK_BEATS;
      this.score += HOLD_TICK_SCORE;
      this.incrementCombo();
    }
  }

  getStats(): ScoreStats {
    return {
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      perfect: this.perfect,
      great: this.great,
      good: this.good,
      miss: this.miss,
    };
  }

  getRank(): Rank {
    const total = this.perfect + this.great + this.good + this.miss;
    if (total === 0) return 'D';
    const perfectRatio = this.perfect / total;
    if (perfectRatio >= 0.95) return 'S';
    if (perfectRatio >= 0.8) return 'A';
    if (perfectRatio >= 0.6) return 'B';
    if (perfectRatio >= 0.4) return 'C';
    return 'D';
  }

  // NOTE: getRank() (PERFECT-rate based) is legacy. Rank is now decided by
  // score alone (rankForScore below), computed where the chart is available.

  private incrementCombo(): void {
    this.combo++;
    if (this.combo > this.maxCombo) {
      this.maxCombo = this.combo;
    }
  }
}

const HOLD_MAX_SCORE = PERFECT_SCORE * 2; // head 50 + release 50

/** Theoretical max ring score of a chart (trace bonus excluded). */
export function maxRingScore(rings: RingDef[]): number {
  let max = 0;
  for (const r of rings ?? []) {
    if (!r) continue;
    max += r.type === 'hold' ? HOLD_MAX_SCORE : PERFECT_SCORE;
  }
  return max;
}

/**
 * Rank decided by score alone: ratio of score to the chart's max ring
 * score. Trace bonus counts toward the score (can exceed 100%).
 */
export function rankForScore(score: number, maxRing: number): Rank {
  if (!Number.isFinite(score) || !Number.isFinite(maxRing) || maxRing <= 0) return 'D';
  const ratio = score / maxRing;
  if (ratio >= 0.9) return 'S';
  if (ratio >= 0.75) return 'A';
  if (ratio >= 0.6) return 'B';
  if (ratio >= 0.4) return 'C';
  return 'D';
}
