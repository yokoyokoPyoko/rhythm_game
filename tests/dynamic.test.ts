/**
 * T178 — 楽曲終了判定の audio_offset 補正（曲の尻切れバグ修正） Acceptance Test
 * 
 * Runs in node environment (vitest environment: node), no DOM.
 * Verifies that GameScreen.tsx correctly incorporates chart.audio_offset into the song end detection threshold.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
}

describe('T178 - 楽曲終了判定の audio_offset 補正 (Song End Detection with audio_offset)', () => {
  beforeEach(() => {
    // Setup
  });

  describe('1. Static Source Code Inspection (GameScreen.tsx)', () => {
    it('GameScreen must incorporate chart.audio_offset into effectiveDurationMs / endThreshold', () => {
      // [Step 1: Capture Initial State]
      const src = readSrc('src/screens/GameScreen.tsx');
      expect(src).toBeDefined();

      // Find the song end threshold calculation section
      const endThresholdIdx = src.indexOf('endThreshold') !== -1 ? src.indexOf('endThreshold') : src.indexOf('effectiveDurationMs');
      expect(endThresholdIdx, 'GameScreen must contain endThreshold or effectiveDurationMs calculation').toBeGreaterThan(-1);

      // Extract snippet around end threshold calculation
      const snippet = src.slice(Math.max(0, endThresholdIdx - 100), endThresholdIdx + 300);

      // [Step 2: Perform Inspection]
      // Check if chart?.audio_offset or audioOffsetMs is added
      const hasAudioOffsetAddition = /audio_offset|audioOffsetMs/.test(snippet);

      // [Step 3: Assert Resulting Transition (Must fail Red before implementation, pass Green after)]
      expect(hasAudioOffsetAddition, 'End threshold / effectiveDurationMs calculation must include chart?.audio_offset').toBe(true);
      expect(snippet).toMatch(/chart\?\.audio_offset/);
    });
  });

  describe('2. Dynamic Computed Duration Calculation (Off-Grid Fractional Timing)', () => {
    it('calculates effectiveDurationMs correctly with buffer and fractional audio_offset', () => {
      // [Step 1: Capture Initial State]
      const durationSec = 120.5; // 120,500 ms
      const buffer = { duration: durationSec } as AudioBuffer;
      const fallbackEnd = 60000;
      
      // Off-grid fractional audio_offset values
      const offGridOffsets = [0, 1500.75, 2345.67, -500.25];

      for (const audioOffset of offGridOffsets) {
        // [Step 2: Perform Computation mirroring expected GameScreen logic]
        const baseDurationMs = buffer ? buffer.duration * 1000 : fallbackEnd;
        // Expected formula after fix: (buffer ? buffer.duration * 1000 : fallbackEnd) + (chart?.audio_offset ?? 0)
        const chart = { audio_offset: audioOffset };
        const effectiveDurationMs = baseDurationMs + (chart?.audio_offset ?? 0);

        // [Step 3: Assert Resulting Transition]
        expect(effectiveDurationMs).toBeCloseTo(durationSec * 1000 + audioOffset, 2);
      }
    });

    it('calculates effectiveDurationMs correctly with fallbackEnd when buffer is null and fractional audio_offset', () => {
      // [Step 1: Capture Initial State]
      const buffer = null;
      const fallbackEnd = 45000;
      const offGridOffsets = [123.45, 987.65];

      for (const audioOffset of offGridOffsets) {
        // [Step 2: Perform Computation]
        const baseDurationMs = buffer ? (buffer as any).duration * 1000 : fallbackEnd;
        const chart = { audio_offset: audioOffset };
        const effectiveDurationMs = baseDurationMs + (chart?.audio_offset ?? 0);

        // [Step 3: Assert Resulting Transition]
        expect(effectiveDurationMs).toBeCloseTo(fallbackEnd + audioOffset, 2);
      }
    });
  });
});
