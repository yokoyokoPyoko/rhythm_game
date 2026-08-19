import type { HitResult } from '../types';

const PERFECT_SCORE = 300;
const GOOD_SCORE = 100;
const TRACE_INTERVAL = 0.15;
const TRACE_BASE_SCORE = 8;

export interface ScoreStats {
  score: number;
  combo: number;
  maxCombo: number;
  perfect: number;
  good: number;
  miss: number;
}

export type Rank = 'S' | 'A' | 'B' | 'C' | 'D';

export class ScoreManager {
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private perfect = 0;
  private good = 0;
  private miss = 0;
  private traceAccumulator = 0;

  recordHit(result: HitResult): void {
    switch (result) {
      case 'perfect':
        this.perfect++;
        this.score += PERFECT_SCORE;
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
        break;
    }
  }

  recordTrace(dt: number, isOnWave: boolean): void {
    if (!isOnWave) {
      this.traceAccumulator = 0;
      return;
    }
    this.traceAccumulator += dt;
    while (this.traceAccumulator >= TRACE_INTERVAL) {
      this.traceAccumulator -= TRACE_INTERVAL;
      this.incrementCombo();
      this.score += TRACE_BASE_SCORE + this.combo;
    }
  }

  getStats(): ScoreStats {
    return {
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      perfect: this.perfect,
      good: this.good,
      miss: this.miss,
    };
  }

  getRank(): Rank {
    const total = this.perfect + this.good + this.miss;
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
