import type { HitResult } from '../types';

const PERFECT_SCORE = 50;
const GREAT_SCORE = 30;
const GOOD_SCORE = 10;
const TRACE_INTERVAL = 0.15;
const TRACE_BASE_SCORE = 2;
const TRACE_BONUS_STEP_BEATS = 16;
const TRACE_BONUS_STEP = 2;
const OFF_BEAT_RESET = 3;
const OFF_BEAT_EPS = 1e-9;

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
      this.score += TRACE_BASE_SCORE + this.comboBonus;
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

  private incrementCombo(): void {
    this.combo++;
    if (this.combo > this.maxCombo) {
      this.maxCombo = this.combo;
    }
  }
}
