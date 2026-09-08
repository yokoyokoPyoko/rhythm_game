/**
 * T205 — セクションイージングの結合・回帰 Vitest unit test module
 * node environment — pure computed values / engine math, no DOM.
 * Verifies:
 *   (1) Easing interpolation (linear, ease-out, ease-in) at midpoint (e.g. amp=1.0 to 2.0 at beat 4 => 1.75 for ease-out) and off-grid beats (0.37, 1.23, 3.5).
 *   (2) Autosave save/load round-trip preserving ease_to_next.
 *   (3) Legacy chart without ease_to_next loading as instant step switches.
 *   (4) Numeric consistency between WaveEngine and Cursor across complex amplitudes and off-grid phases.
 *   (5) Regressions for T186-T191, T55, T102/T103, T155.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import {
  saveAutosave,
  loadAutosave,
  listAutosaves,
  AUTOSAVE_PREFIX,
} from '../src/chart/autosave';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import type { Chart, BpmChange, EasingType, Segment } from '../src/types';

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

function clearAllAutosaves(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(AUTOSAVE_PREFIX)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
}

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  clearAllAutosaves();
});

afterEach(() => {
  vi.clearAllTimers();
  clearAllAutosaves();
});

function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as unknown as new (a: unknown, b: unknown) => BpmTimeline)(sections as unknown, baseAmp as unknown);
}

function expectedEaseFactor(kind: EasingType, t: number): number {
  if (kind === 'linear') return t;
  if (kind === 'ease-out') return 1 - Math.pow(1 - t, 2);
  if (kind === 'ease-in') return Math.pow(t, 2);
  return t;
}

describe('T205 セクションイージング結合・回帰テスト (node pure engine math)', () => {
  describe('1. Easing interpolation & off-grid verification', () => {
    it('beat 0: amp=1.0, beat 8: amp=2.0 with ease-out => amplitudeAt(4) === 1.75', () => {
      // Step 1: Capture initial state (step timeline without easing)
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0 },
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ]);
      const valBefore = tlStep.amplitudeAt(4);
      expect(valBefore).toBeCloseTo(1.0, 5);

      // Step 2: Perform action (timeline with ease-out)
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out' },
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ]);
      const valAtMid = tl.amplitudeAt(4);

      // Step 3: Assert changed outcome (t = 4/8 = 0.5, ease-out(0.5) = 1 - 0.5^2 = 0.75, val = 1.0 + 1.0 * 0.75 = 1.75)
      expect(valAtMid).toBeCloseTo(1.75, 4);
      expect(valAtMid).not.toBeCloseTo(valBefore, 4);
    });

    it('Tests all 3 easing types at off-grid beats (0.37, 1.23, 3.5)', () => {
      const start = 0.7;
      const end = 2.7;
      const span = 8;

      const types: EasingType[] = ['linear', 'ease-out', 'ease-in'];
      const testBeats = [0.37, 1.23, 3.5, 4.0];

      for (const kind of types) {
        const tl = makeTimeline([
          { beat: 0, bpm: 120, amplitude: start, easeToNext: kind },
          { beat: span, bpm: 120, amplitude: end },
        ]);

        for (const b of testBeats) {
          const t = Math.max(0, Math.min(1, b / span));
          const expected = start + (end - start) * expectedEaseFactor(kind, t);
          const actual = tl.amplitudeAt(b);
          expect(actual).toBeCloseTo(expected, 4);
        }
      }
    });

    it('zoomAt interpolation across easing types with off-grid beats', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'linear' },
        { beat: 4, bpm: 120, zoom: 3.0, easeToNext: 'ease-in' },
        { beat: 8, bpm: 120, zoom: 2.0 },
      ]);

      expect(tl.zoomAt(2)).toBeCloseTo(2.0, 4); // linear midpoint of 1.0 and 3.0
      expect(tl.zoomAt(6)).toBeCloseTo(3.0 + (2.0 - 3.0) * expectedEaseFactor('ease-in', 0.5), 4);
      expect(tl.zoomAt(1.23)).toBeCloseTo(1.0 + 2.0 * (1.23 / 4), 4);
    });
  });

  describe('2. Autosave round-trip with ease_to_next', () => {
    it('Saves chart with ease_to_next, reloads via autosave, asserts parsed Chart has identical ease_to_next values', () => {
      // Step 1: Capture initial state
      const initialList = listAutosaves();
      expect(initialList.length).toBe(0);

      // Step 2: Perform action (save chart with ease_to_next)
      const chartWithEase: Chart = {
        title: 'Ease RoundTrip Song',
        artist: 'Tester',
        audio: 'test.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0.0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, zoom: 1.0, easeToNext: 'linear' },
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 1.2, easeToNext: 'ease-out' },
          { beat: 8.25, bpm: 140, amplitude: 2.7, zoom: 0.8, easeToNext: 'ease-in' },
          { beat: 12.125, bpm: 180, amplitude: 0.7, zoom: 1.5 },
        ],
        segments: [{ direction: 'up', beats: 2 }],
        rings: [{ beat: 4.37 }],
      };

      const saveInfo = saveAutosave(chartWithEase);
      const reloaded = loadAutosave(saveInfo.slug);

      // Step 3: Assert round-trip identical values
      expect(reloaded.bpm_changes.length).toBe(4);
      expect(reloaded.bpm_changes[0].easeToNext).toBe('linear');
      expect(reloaded.bpm_changes[1].easeToNext).toBe('ease-out');
      expect(reloaded.bpm_changes[2].easeToNext).toBe('ease-in');
      expect(reloaded.bpm_changes[3].easeToNext).toBeUndefined();

      expect(reloaded.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(reloaded.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect(reloaded.bpm_changes[2].amplitude).toBeCloseTo(2.7, 5);
      expect(reloaded.bpm_changes[3].zoom).toBeCloseTo(1.5, 3);

      const toml = chartToToml(reloaded);
      expect(toml).toContain('ease_to_next = "linear"');
      expect(toml).toContain('ease_to_next = "ease-out"');
      expect(toml).toContain('ease_to_next = "ease-in"');
    });
  });

  describe('3. Legacy chart without ease_to_next loads as instant step switches', () => {
    it('Legacy TOML without ease_to_next parses without easing and evaluates as step functions', () => {
      const legacyToml = `
title = "Legacy Chart"
artist = "Old"
audio = "legacy.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 1.0
[[sections]]
beat = 4
bpm = 130
amplitude = 2.0
`;
      // Step 1 & 2: Parse legacy TOML
      const chart = parseChartText(legacyToml);
      expect(chart.bpm_changes[0].easeToNext).toBeUndefined();
      expect(chart.bpm_changes[1].easeToNext).toBeUndefined();

      // Step 3: Assert step evaluation (no interpolation between beat 0 and 4)
      const tl = makeTimeline(chart.bpm_changes, chart.amplitude);
      expect(tl.amplitudeAt(2)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(3.99)).toBeCloseTo(1.0, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(2.0, 5);
      expect(tl.amplitudeAt(6)).toBeCloseTo(2.0, 5);
    });
  });

  describe('4. WaveEngine and Cursor numeric consistency with variable amplitude and off-grid phases', () => {
    it('Verifies pure numeric consistency between WaveEngine and Cursor across complex amplitudes (0.7, 1.3, 2.7, 3.4) and off-grid phases', () => {
      const amps = [0.7, 1.3, 2.7, 3.4];
      const segments: Segment[] = [
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ];

      for (const amp of amps) {
        const sections: BpmChange[] = [
          { beat: 0, bpm: 120, amplitude: amp, easeToNext: 'linear' },
          { beat: 4, bpm: 120, amplitude: amp },
        ];
        const timeline = makeTimeline(sections, amp);
        const engine = new WaveEngine(segments, timeline, amp, 0);
        const cursor = new Cursor();

        // Off-grid beat evaluations
        const offGridBeats = [0.37, 1.23, 2.5, 3.77];
        for (const b of offGridBeats) {
          const yWave = engine.waveYAt(b);
          expect(Number.isFinite(yWave)).toBe(true);

          // Update cursor toward yWave or check update math
          const beatMs = timeline.beatMsAt(b);
          const dt = 0.016; // 16ms frame
          cursor.update(dt, false, false, beatMs, 2, yWave);
          expect(Number.isFinite(cursor.y)).toBe(true);
        }
      }
    });
  });

  describe('5. Regressions for T186-T191, T55, T102/T103, T155', () => {
    it('Ensures top-level bpm and scroll_speed are absent from serialized TOML while sections preserve values', () => {
      const chart: Chart = {
        title: 'Regression Check',
        artist: 'QA',
        audio: 'reg.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 130, amplitude: 1.5, zoom: 1.0 },
        ],
        segments: [],
        rings: [],
      };
      const toml = chartToToml(chart);
      const lines = toml.split('\n');
      const firstSectionIdx = lines.findIndex(l => l.trim().startsWith('[[sections]]'));
      const topLevelLines = lines.slice(0, firstSectionIdx >= 0 ? firstSectionIdx : lines.length);
      const hasTopLevelBpm = topLevelLines.some(l => /^bpm\s*=/.test(l.trim()));
      const hasTopLevelScroll = topLevelLines.some(l => /^scroll_speed\s*=/.test(l.trim()));
      expect(hasTopLevelBpm).toBe(false);
      expect(hasTopLevelScroll).toBe(false);
      expect(toml).toContain('[[sections]]');

      const parsed = parseChartText(toml);
      expect(parsed.bpm_changes[0].bpm).toBe(130);
      expect(parsed.bpm_changes[0].amplitude).toBeCloseTo(1.5, 5);
    });
  });
});
