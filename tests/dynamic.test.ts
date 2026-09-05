/**
 * @vitest-environment node
 * T162 Unit Tests: Score adjustment, Great judgment, and Stats update.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { judgeHit } from '../src/game/hitJudge';
import { ScoreManager } from '../src/game/score';
import type { RingState } from '../src/types';

describe('T162: Hit Judgment & Scoring Expansion (Perfect=50, Great=30, Good=10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('judgeHit with Great category', () => {
    it('should judge PERFECT when timing error < 50ms and Y distance < 30px', () => {
      // [Step1] Initial ring state
      const rings: RingState[] = [
        { id: 1, spawnTime: 0, hitTime: 1000, targetY: 300, resolved: false, hit: false }
      ];
      // [Step2] Press at 1020ms (error = 20ms < 50ms), cursorY = 310 (dist = 10px < 30px), beatMs = 500 (window = 200ms)
      const judgment = judgeHit(1020, 310, rings, 500);
      // [Step3] Assert result
      expect(judgment).not.toBeNull();
      expect(judgment?.result).toBe('perfect');
      expect(judgment?.errorMs).toBe(20);
      expect(rings[0].resolved).toBe(true);
      expect(rings[0].hit).toBe(true);
    });

    it('should judge GREAT when timing error is between 50ms and 100ms and Y distance < 60px (off-grid / boundary validation)', () => {
      // [Step1] Initial ring state
      const rings: RingState[] = [
        { id: 2, spawnTime: 0, hitTime: 1000, targetY: 300, resolved: false, hit: false }
      ];
      // [Step2] Press at 1075ms (error = 75ms, which is 50ms <= err < 100ms), cursorY = 345 (dist = 45px < 60px)
      const judgment = judgeHit(1075, 345, rings, 500);
      // [Step3] Assert result
      expect(judgment).not.toBeNull();
      expect(judgment?.result).toBe('great');
      expect(judgment?.errorMs).toBe(75);
      expect(rings[0].resolved).toBe(true);
      expect(rings[0].hit).toBe(true);
    });

    it('should judge GOOD when timing error is >= 100ms (and < window) or Y distance >= 30px (up to 60px)', () => {
      // [Step1] Initial ring state
      const rings: RingState[] = [
        { id: 3, spawnTime: 0, hitTime: 1000, targetY: 300, resolved: false, hit: false }
      ];
      // [Step2] Press at 1120ms (error = 120ms >= 100ms, but within window 200ms), cursorY = 320 (dist = 20px < 60px)
      const judgment = judgeHit(1120, 320, rings, 500);
      // [Step3] Assert result
      expect(judgment).not.toBeNull();
      expect(judgment?.result).toBe('good');
      expect(judgment?.errorMs).toBe(120);
      expect(rings[0].resolved).toBe(true);
      expect(rings[0].hit).toBe(true);
    });

    it('should judge MISS when Y distance >= 60px or timing error >= window', () => {
      // [Step1] Initial ring state
      const rings: RingState[] = [
        { id: 4, spawnTime: 0, hitTime: 1000, targetY: 300, resolved: false, hit: false }
      ];
      // [Step2] Press at 1010ms (error = 10ms), but cursorY = 370 (dist = 70px >= 60px)
      const judgment = judgeHit(1010, 370, rings, 500);
      // [Step3] Assert result
      expect(judgment).not.toBeNull();
      expect(judgment?.result).toBe('miss');
      expect(rings[0].resolved).toBe(true);
      expect(rings[0].hit).toBe(false);
    });
  });

  describe('ScoreManager with Perfect(50), Great(30), Good(10) and stats update', () => {
    it('should award 50 points for perfect, 30 for great, 10 for good, and update respective stats (3-step)', () => {
      // [Step1] Capture initial state
      const sm = new ScoreManager();
      const initialStats = sm.getStats();
      expect(initialStats.score).toBe(0);
      expect(initialStats.perfect).toBe(0);
      expect(initialStats.great).toBe(0);
      expect(initialStats.good).toBe(0);
      expect(initialStats.miss).toBe(0);
      expect(initialStats.combo).toBe(0);

      // [Step2] Perform perfect hit
      sm.recordHit('perfect');
      // [Step3] Assert perfect transition
      let stats = sm.getStats();
      expect(stats.score).toBe(50);
      expect(stats.perfect).toBe(1);
      expect(stats.combo).toBe(1);

      // [Step2] Perform great hit
      sm.recordHit('great');
      // [Step3] Assert great transition
      stats = sm.getStats();
      expect(stats.score).toBe(50 + 30); // 80
      expect(stats.great).toBe(1);
      expect(stats.combo).toBe(2);

      // [Step2] Perform good hit
      sm.recordHit('good');
      // [Step3] Assert good transition
      stats = sm.getStats();
      expect(stats.score).toBe(80 + 10); // 90
      expect(stats.good).toBe(1);
      expect(stats.combo).toBe(3);
    });

    it('should reset combo and preserve stats on miss', () => {
      // [Step1] Initial state with some hits
      const sm = new ScoreManager();
      sm.recordHit('perfect');
      sm.recordHit('great');
      expect(sm.getStats().combo).toBe(2);
      expect(sm.getStats().score).toBe(80);

      // [Step2] Record miss
      sm.recordHit('miss');

      // [Step3] Assert stats after miss
      const stats = sm.getStats();
      expect(stats.combo).toBe(0);
      expect(stats.miss).toBe(1);
      expect(stats.perfect).toBe(1);
      expect(stats.great).toBe(1);
      expect(stats.score).toBe(80); // score remains
    });
  });
});
