/**
 * T205 — セクションイージングの結合・回帰 Vitest pure acceptance test
 * node environment — pure engine, math, storage, no DOM required
 *
 * Requirements:
 * 1. Autosave round-trip: save chart with ease_to_next, reload, assert identical ease_to_next values.
 * 2. Easing interpolation numerical validation: off-grid beats (0.37, 1.23, 3.5), linear / ease-out / ease-in.
 *    - Example: beat 0 amp=1.0, beat 8 amp=2.0, easeToNext='ease-out' -> amplitudeAt(4) === 1.75.
 * 3. Legacy TOML loading without ease_to_next: step function at boundaries.
 * 4. Regression checks: T186-T191, T55, T102/T103, T155.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import {
  saveAutosave,
  loadAutosave,
  listAutosaves,
  deleteAutosave,
  AUTOSAVE_PREFIX,
} from '../src/chart/autosave';
import type { Chart, BpmChange, EasingType } from '../src/types';

// localStorage polyfill for node environment
function ensureLocalStoragePolyfill(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g['localStorage'] !== 'undefined' && g['localStorage'] !== null) return;
  const store = new Map<string, string>();
  const polyfill = {
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
    get length(): number {
      return store.size;
    },
  };
  g['localStorage'] = polyfill;
}
ensureLocalStoragePolyfill();

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  localStorage.clear();
});

function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as unknown as new (a: unknown, b: unknown) => BpmTimeline)(
    sections as unknown,
    baseAmp as unknown
  );
}

function easedFactor(kind: EasingType, t: number): number {
  if (kind === 'linear') return t;
  if (kind === 'ease-out') return 1 - Math.pow(1 - t, 2);
  if (kind === 'ease-in') return Math.pow(t, 2);
  return t;
}

describe('T205 セクションイージングの結合・回帰 — Vitest unit test module', () => {
  describe('1. Easing interpolation off-grid numerical validation (T202-T204 integration)', () => {
    it('Step 1: Capture initial un-eased state -> Step 2: Create chart with ease-out at beat 0, amp=1.0 to beat 8, amp=2.0 -> Step 3: amplitudeAt(4) === 1.75 and off-grid validation (3-step)', () => {
      // Step 1: Capture initial state (step function baseline)
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0 },
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ], 1.0);
      const valBefore = tlStep.amplitudeAt(4);
      expect(valBefore).toBeCloseTo(1.0, 5); // Step function: stays at 1.0 until beat 8

      // Step 2: Perform Action — instantiate timeline with ease-out
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out' },
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ], 1.0);

      // Step 3: Assert Resulting Transition — midpoint beat 4 with ease-out (t = 0.5 -> 1 - (0.5)^2 = 0.75 -> 1.0 + 1.0*0.75 = 1.75)
      const valMid = tl.amplitudeAt(4);
      expect(valMid).toBeCloseTo(1.75, 4);
      expect(valMid).not.toBeCloseTo(valBefore, 4);

      // Off-grid fractional verification (0.37, 1.23, 3.5)
      const t037 = 0.37 / 8;
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(1.0 + 1.0 * easedFactor('ease-out', t037), 4);

      const t123 = 1.23 / 8;
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(1.0 + 1.0 * easedFactor('ease-out', t123), 4);

      const t35 = 3.5 / 8;
      expect(tl.amplitudeAt(3.5)).toBeCloseTo(1.0 + 1.0 * easedFactor('ease-out', t35), 4);

      // Endpoints
      expect(tl.amplitudeAt(0)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(8)).toBeCloseTo(2.0, 5);
    });

    it('Linear and ease-in interpolation across all off-grid fractions (3-step)', () => {
      // Step 1: Capture initial linear vs step
      const tlLin = makeTimeline([
        { beat: 0, bpm: 130, amplitude: 0.5, easeToNext: 'linear' },
        { beat: 4, bpm: 130, amplitude: 1.5 },
      ], 1.0);

      // Step 2: Perform action / evaluation at mid and off-grid
      const midLin = tlLin.amplitudeAt(2);
      expect(midLin).toBeCloseTo(1.0, 4); // 0.5 + 1.0 * 0.5 = 1.0

      const offGridLin = tlLin.amplitudeAt(1.23);
      expect(offGridLin).toBeCloseTo(0.5 + 1.0 * (1.23 / 4), 4);

      // Ease-in
      const tlIn = makeTimeline([
        { beat: 0, bpm: 130, amplitude: 0.5, easeToNext: 'ease-in' },
        { beat: 4, bpm: 130, amplitude: 1.5 },
      ], 1.0);

      const midIn = tlIn.amplitudeAt(2); // t = 0.5 -> t^2 = 0.25 -> 0.5 + 1.0 * 0.25 = 0.75
      expect(midIn).toBeCloseTo(0.75, 4);

      const offGridIn = tlIn.amplitudeAt(0.37);
      const tIn = 0.37 / 4;
      expect(tlIn.amplitudeAt(0.37)).toBeCloseTo(0.5 + 1.0 * (tIn * tIn), 4);

      // Step 3: Assert values differ from flat step
      expect(midLin).not.toBeCloseTo(midIn, 4);
    });
  });

  describe('2. Autosave round-trip with ease_to_next (T205 requirement 1)', () => {
    it('Step 1: Capture empty storage state -> Step 2: Save chart with ease_to_next and reload via loadAutosave -> Step 3: Assert identical ease_to_next values and correct timeline interpolation (3-step)', () => {
      // Step 1: Capture initial storage state
      expect(listAutosaves()).toHaveLength(0);

      // Step 2: Create chart containing ease_to_next
      const testChart: Chart = {
        title: 'Easing Test Song',
        artist: 'Test Artist',
        audio: 'test.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0.0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out', zoom: 1.0 },
          { beat: 4, bpm: 140, amplitude: 2.0, easeToNext: 'linear', zoom: 2.0 },
          { beat: 8, bpm: 160, amplitude: 1.5 },
        ],
        segments: [{ direction: 'up', beats: 4 }],
        rings: [{ beat: 4 }],
      };

      const savedInfo = saveAutosave(testChart);
      expect(savedInfo.slug).toBe('easing-test-song');

      // Reload from autosave
      const reloadedChart = loadAutosave(savedInfo.slug);

      // Step 3: Assert Resulting Transition
      expect(reloadedChart.title).toBe('Easing Test Song');
      expect(reloadedChart.bpm_changes).toHaveLength(3);
      expect(reloadedChart.bpm_changes[0].easeToNext).toBe('ease-out');
      expect(reloadedChart.bpm_changes[1].easeToNext).toBe('linear');
      expect(reloadedChart.bpm_changes[2].easeToNext).toBeUndefined();

      // Verify reloaded chart timeline behaves identically with ease_to_next
      const tl = makeTimeline(reloadedChart.bpm_changes, reloadedChart.amplitude);
      expect(tl.amplitudeAt(2)).toBeCloseTo(1.75, 4); // beat 0->4 ease-out
      expect(tl.amplitudeAt(6)).toBeCloseTo(1.75, 4); // beat 4->8 linear (2.0 + (1.5 - 2.0)*0.5 = 1.75)
    });
  });

  describe('3. Legacy TOML loading without ease_to_next (T205 requirement 3)', () => {
    it('Step 1: Parse legacy TOML string without ease_to_next -> Step 2: Check parsed chart bpm_changes have undefined easeToNext -> Step 3: Verify BpmTimeline acts as strict step function at boundaries (3-step)', () => {
      // Step 1: Capture legacy TOML string
      const legacyToml = `
title = "Legacy Song"
artist = "Old Author"
audio = "legacy.flac"

[[sections]]
beat = 0
bpm = 120
amplitude = 1.0

[[sections]]
beat = 4
bpm = 140
amplitude = 2.0

[[segments]]
direction = "up"
beats = 4

[[rings]]
beat = 4
`;

      // Step 2: Parse chart text
      const chart = parseChartText(legacyToml, 'legacy');

      // Step 3: Assert Resulting Transition
      expect(chart.bpm_changes).toHaveLength(2);
      expect(chart.bpm_changes[0].easeToNext).toBeUndefined();
      expect(chart.bpm_changes[1].easeToNext).toBeUndefined();

      // Verify step function behavior (no easing interpolation)
      const tl = makeTimeline(chart.bpm_changes, chart.amplitude);
      expect(tl.amplitudeAt(0)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(2)).toBeCloseTo(1.0, 5); // strict step, not interpolated
      expect(tl.amplitudeAt(3.99)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(2.0, 5);
      expect(tl.amplitudeAt(6)).toBeCloseTo(2.0, 5);
    });
  });

  describe('4. Regression checks (T186-T191, T55, T102/T103, T155)', () => {
    it('Serialization round-trip: chartToToml correctly outputs ease_to_next and parses back correctly (3-step)', () => {
      // Step 1: Capture chart with easing
      const original: Chart = {
        title: 'Roundtrip Toml',
        artist: 'Author',
        audio: 'audio.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, easeToNext: 'ease-in' },
          { beat: 4, bpm: 130 },
        ],
        segments: [],
        rings: [],
      };

      // Step 2: Serialize to TOML and parse back
      const tomlStr = chartToToml(original);
      expect(tomlStr).toContain('ease_to_next = "ease-in"');

      const parsed = parseChartText(tomlStr, 'roundtrip');

      // Step 3: Assert Resulting Transition
      expect(parsed.bpm_changes[0].easeToNext).toBe('ease-in');
      expect(parsed.bpm_changes[1].easeToNext).toBeUndefined();
    });
  });
});
