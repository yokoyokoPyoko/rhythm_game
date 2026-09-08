/**
 * T205 — セクションイージングの結合・回帰 Vitest pure acceptance (node)
 * Spec: T202〜T204 結合仕上げ
 * 完了条件:
 *  1. autosave保存→復元でイージング設定が再現される
 *  2. オフグリッド補間値の数値検証が通る (t=0.5で linear 0.5 / ease-out 0.75 / ease-in 0.25)
 *  3. tsc --noEmit、T186〜T191・T55・T102/T103・T155の回帰なし
 *  + 旧譜面(ease_to_next無し)は全区間瞬間切替(step)
 *  + セクション追加ダイアログ併存確認、ドラッグ所有移動の数値反映
 *
 * Runs WITHOUT browser: imports pure engine modules directly.
 * Uses vi.useFakeTimers() deterministically. No DOM.
 * Each test follows [Capture Before] -> [Perform Action] -> [Assert Changed Outcome].
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
  AUTOSAVE_PREFIX,
} from '../src/chart/autosave';
import type { BpmChange, Chart } from '../src/types';

// ---------------------------------------------------------------------------
// localStorage polyfill for node (vitest environment=node)
// ---------------------------------------------------------------------------
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

vi.useFakeTimers({ shouldAdvanceTime: true });

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(AUTOSAVE_PREFIX)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
});
afterEach(() => {
  vi.clearAllTimers();
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(AUTOSAVE_PREFIX)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new BpmTimeline(sections as unknown as BpmChange[], baseAmp);
}
function eased(t: number, kind: 'linear' | 'ease-out' | 'ease-in'): number {
  if (kind === 'linear') return t;
  if (kind === 'ease-out') return 1 - Math.pow(1 - t, 2);
  if (kind === 'ease-in') return Math.pow(t, 2);
  return t;
}
function clearAllAutosaves(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(AUTOSAVE_PREFIX)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
}

// ---------------------------------------------------------------------------
// T205 suites
// ---------------------------------------------------------------------------
describe('T205 セクションイージング結合・回帰 — Vitest pure engine (TDD Red)', () => {
  // =======================================================================
  // 1. autosave round-trip: ease_to_next persists (完了条件1)
  // =======================================================================
  describe('1. autosave保存→復元で ease_to_next が再現される (3-step)', () => {
    it('ease_to_next 付きchartをautosave保存→復元で全セクションのeaseが一致 (3-step off-grid)', () => {
      // [Step1: Capture Before State] — empty autosave
      const beforeList = listAutosaves();
      expect(beforeList.length).toBe(0);
      const serializeHasEase = fs.readFileSync('src/chart/serialize.ts', 'utf-8').includes('ease_to_next');
      expect(serializeHasEase).toBe(true);

      // [Step2: Perform Action] — save chart with complex amplitudes 0.7/1.3/2.7 and off-grid beats
      const chartWithEasing: Chart = {
        title: 'T205 Autosave Ease 0.37',
        artist: 'QA',
        audio: 't205.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.8, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 1.2, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: 8.25, bpm: 140, amplitude: 2.7, easeToNext: 'ease-in' } as unknown as BpmChange,
          { beat: 12.125, bpm: 130, zoom: 1.5 },
        ],
        segments: [{ direction: 'up', beats: 1 }],
        rings: [{ beat: 1.23 }],
      } as unknown as Chart;
      const info = saveAutosave(chartWithEasing);
      vi.advanceTimersByTime(1000);

      // [Step3: Assert Changed Outcome] — loaded chart has identical ease_to_next values
      const loaded = loadAutosave(info.slug);
      expect(loaded.bpm_changes.length).toBe(4);
      expect((loaded.bpm_changes[0] as BpmChange).easeToNext).toBe('linear');
      expect((loaded.bpm_changes[1] as BpmChange).easeToNext).toBe('ease-out');
      expect((loaded.bpm_changes[2] as BpmChange).easeToNext).toBe('ease-in');
      expect((loaded.bpm_changes[3] as BpmChange).easeToNext).toBeUndefined();
      expect(loaded.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(loaded.bpm_changes[0].amplitude).toBeCloseTo(0.7, 5);
      expect((loaded.bpm_changes[0] as BpmChange).zoom).toBeCloseTo(0.8, 5);
      expect(loaded.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect(loaded.bpm_changes[1].amplitude).toBeCloseTo(1.3, 5);
      expect((loaded.bpm_changes[1] as BpmChange).zoom).toBeCloseTo(1.2, 5);
      expect(loaded.bpm_changes[2].beat).toBeCloseTo(8.25, 3);
      expect(loaded.bpm_changes[2].amplitude).toBeCloseTo(2.7, 5);
      expect(loaded.bpm_changes[3].beat).toBeCloseTo(12.125, 3);
      const reparsedToml = chartToToml(loaded as unknown as Chart);
      const easeLines = reparsedToml.split('\n').filter(l => l.includes('ease_to_next'));
      expect(easeLines.length).toBe(3);
      expect(beforeList.length).toBe(0);
      expect(listAutosaves().length).toBe(1);
      const tlRestored = makeTimeline(loaded.bpm_changes, loaded.amplitude);
      const midLinear = tlRestored.amplitudeAt(2.185); // midpoint of [0,4.37]
      const expectedLinearMid = 0.7 + (1.3 - 0.7) * 0.5;
      expect(midLinear).toBeCloseTo(expectedLinearMid, 3);
      expect(midLinear).not.toBeCloseTo(0.7, 1);
    });

    it('autosave → TOML往復 → reload で zoomも含めeasedとして機能 (3-step)', () => {
      // [Step1: Capture Before] — simple chart without easing gives step 1.0 at mid
      const simpleBefore: Chart = {
        title: 'SimpleBefore205',
        artist: '',
        audio: 's.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0 },
          { beat: 8, bpm: 120, amplitude: 2.0 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const tlBefore = makeTimeline(simpleBefore.bpm_changes, 1.0);
      expect(tlBefore.amplitudeAt(4)).toBeCloseTo(1.0, 5);

      // [Step2: Perform] — save eased chart (beat 0: amp 1.0 -> beat 8: amp 2.0, ease-out)
      const easedChart: Chart = {
        title: 'EasedMid205',
        artist: '',
        audio: 'e.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: 8, bpm: 120, amplitude: 2.0 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const info = saveAutosave(easedChart);
      const loaded = loadAutosave(info.slug);
      const toml = chartToToml(loaded as unknown as Chart);
      const reparsed = parseChartText(toml);

      // [Step3: Assert] — reparsed has ease and mid is 1.75 (ease-out 0.75)
      expect((reparsed.bpm_changes[0] as BpmChange).easeToNext).toBe('ease-out');
      const tlAfter = makeTimeline(reparsed.bpm_changes, 1.0);
      expect(tlAfter.amplitudeAt(4)).toBeCloseTo(1.75, 4);
      expect(tlAfter.amplitudeAt(4)).not.toBeCloseTo(tlBefore.amplitudeAt(4), 1);
      // zoom also round-trips
      const zoomChart: Chart = {
        title: 'ZoomEase205',
        artist: '',
        audio: 'z.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 8, bpm: 120, zoom: 2.0 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const zInfo = saveAutosave(zoomChart);
      const zLoaded = loadAutosave(zInfo.slug);
      expect((zLoaded.bpm_changes[0] as BpmChange).easeToNext).toBe('linear');
      const zl = makeTimeline(zLoaded.bpm_changes, 1.0);
      expect(zl.zoomAt(4)).toBeCloseTo(1.5, 4);
    });

    it('複数autosaveスロットで ease_to_next が混在しても各スロット独立再現 (3-step)', () => {
      // [Step1: Capture Before] — 0件
      expect(listAutosaves().length).toBe(0);

      // [Step2: Perform] — save two charts with different easing curves
      const chartA: Chart = {
        title: 'Slot A Ease205',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 4, bpm: 120, amplitude: 1.5 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const chartB: Chart = {
        title: 'Slot B Ease205',
        artist: '',
        audio: 'b.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-in' } as unknown as BpmChange,
          { beat: 4, bpm: 120, amplitude: 1.5 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const infoA = saveAutosave(chartA);
      vi.advanceTimersByTime(1000);
      const infoB = saveAutosave(chartB);

      // [Step3: Assert] — each slot's ease differs and timeline reflects it off-grid
      const loadedA = loadAutosave(infoA.slug);
      const loadedB = loadAutosave(infoB.slug);
      expect((loadedA.bpm_changes[0] as BpmChange).easeToNext).toBe('linear');
      expect((loadedB.bpm_changes[0] as BpmChange).easeToNext).toBe('ease-in');
      const tlA = makeTimeline(loadedA.bpm_changes, 1.0);
      const tlB = makeTimeline(loadedB.bpm_changes, 1.0);
      const t = 1.23 / 4;
      const expectedA = 0.7 + 0.8 * eased(t, 'linear');
      const expectedB = 0.7 + 0.8 * eased(t, 'ease-in');
      expect(tlA.amplitudeAt(1.23)).toBeCloseTo(expectedA, 4);
      expect(tlB.amplitudeAt(1.23)).toBeCloseTo(expectedB, 4);
      expect(tlA.amplitudeAt(1.23)).not.toBeCloseTo(tlB.amplitudeAt(1.23), 2);
      expect(listAutosaves().length).toBe(2);
      expect(infoA.slug).not.toBe(infoB.slug);
    });
  });

  // =======================================================================
  // 2. オフグリッド補間値の数値検証 (完了条件2) — T202の t=0.5 0.5/0.75/0.25
  // =======================================================================
  describe('2. オフグリッド補間値の数値検証 — 3種イージングがt=0.5で正確 (3-step)', () => {
    it('amplitude linear/ease-out/ease-in が t=0.5で 0.5/0.75/0.25 かつ off-grid 0.37/1.23/3.5で曲線一致 (3-step)', () => {
      // [Step1: Capture Before] — step (no ease) gives 1.0 at mid
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0 },
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ]);
      expect(tlStep.amplitudeAt(4)).toBeCloseTo(1.0, 5);
      expect(tlStep.amplitudeAt(0.37)).toBeCloseTo(1.0, 5);
      expect(tlStep.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);

      // [Step2: Perform] — create three eased timelines with complex off-grid interval length 8
      const tlLin = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ]);
      const tlOut = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ]);
      const tlIn = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-in' } as unknown as BpmChange,
        { beat: 8, bpm: 120, amplitude: 2.0 },
      ]);

      // [Step3: Assert] — t=0.5 values
      expect(tlLin.amplitudeAt(4)).toBeCloseTo(1.0 + 1.0 * 0.5, 4); // 1.5
      expect(tlOut.amplitudeAt(4)).toBeCloseTo(1.0 + 1.0 * 0.75, 4); // 1.75
      expect(tlIn.amplitudeAt(4)).toBeCloseTo(1.0 + 1.0 * 0.25, 4); // 1.25
      expect(tlLin.amplitudeAt(4)).not.toBeCloseTo(tlStep.amplitudeAt(4), 2);
      expect(tlOut.amplitudeAt(4)).not.toBeCloseTo(tlStep.amplitudeAt(4), 2);
      expect(tlIn.amplitudeAt(4)).not.toBeCloseTo(tlStep.amplitudeAt(4), 2);
      for (const beat of [0.37, 1.23, 3.5] as const) {
        const t = beat / 8;
        expect(tlLin.amplitudeAt(beat)).toBeCloseTo(1.0 + 1.0 * eased(t, 'linear'), 4);
        expect(tlOut.amplitudeAt(beat)).toBeCloseTo(1.0 + 1.0 * eased(t, 'ease-out'), 4);
        expect(tlIn.amplitudeAt(beat)).toBeCloseTo(1.0 + 1.0 * eased(t, 'ease-in'), 4);
      }
      const tlZoomOut = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 8, bpm: 120, zoom: 2.0 } as unknown as BpmChange,
      ]);
      expect(tlZoomOut.zoomAt(4)).toBeCloseTo(1.75, 4);
      expect(tlZoomOut.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(0.37 / 8, 'ease-out'), 4);
    });

    it('複雑振幅 0.7/1.3/2.7/3.4 と off-grid 0.37/1.23/2.37/3.37で amplitude/zoomが曲線と一致 (3-step)', () => {
      // [Step1: Capture Before] — step baseline at off-grid 2.37 must be 1.3 (no interpolation)
      const tlBefore = makeTimeline([
        { beat: 2, bpm: 120, amplitude: 1.3 },
        { beat: 6, bpm: 120, amplitude: 2.7 },
      ]);
      expect(tlBefore.amplitudeAt(2.37)).toBeCloseTo(1.3, 5);
      expect(tlBefore.amplitudeAt(3.37)).toBeCloseTo(1.3, 5);

      // [Step2: Perform] — ease-out over [2,6] with complex amplitudes 1.3->2.7
      const tl = makeTimeline([
        { beat: 2, bpm: 120, amplitude: 1.3, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 6, bpm: 120, amplitude: 2.7 },
      ]);
      const tlZoom = makeTimeline([
        { beat: 2, bpm: 120, zoom: 1.3, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 6, bpm: 120, zoom: 2.7 },
      ]);

      // [Step3: Assert] — mid 4.0 = 0.75, off-grid points use exact eased t
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.3 + 1.4 * 0.75, 4);
      expect(tlZoom.zoomAt(4)).toBeCloseTo(1.3 + 1.4 * 0.75, 4);
      for (const beat of [2.37, 3.37] as const) {
        const t = (beat - 2) / 4;
        const expected = 1.3 + 1.4 * eased(t, 'ease-out');
        expect(tl.amplitudeAt(beat)).toBeCloseTo(expected, 4);
        expect(tlZoom.zoomAt(beat)).toBeCloseTo(expected, 4);
        expect(tl.amplitudeAt(beat)).not.toBeCloseTo(tlBefore.amplitudeAt(beat), 2);
      }
      const tl2 = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4.37, bpm: 120, amplitude: 3.4 },
      ]);
      const t037 = 0.37 / 4.37;
      expect(tl2.amplitudeAt(0.37)).toBeCloseTo(0.7 + 2.7 * eased(t037, 'linear'), 4);
      const t123 = 1.23 / 4.37;
      expect(tl2.amplitudeAt(1.23)).toBeCloseTo(0.7 + 2.7 * eased(t123, 'linear'), 4);
      expect(tl2.amplitudeAt(2.185)).toBeCloseTo(0.7 + 2.7 * 0.5, 3);
    });

    it('zoomも3種イージングで t=0.5 が 0.5/0.75/0.25 off-grid 0.37/1.23で一致 (3-step)', () => {
      // [Step1: Capture Before] — zoom step baseline
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0 },
        { beat: 4, bpm: 120, zoom: 2.0 },
      ]);
      expect(tlStep.zoomAt(2)).toBeCloseTo(1.0, 5);
      expect(tlStep.zoomAt(0.37)).toBeCloseTo(1.0, 5);

      // [Step2: Perform] — three zoom easing timelines
      const mkZoom = (ease: BpmChange['easeToNext']) =>
        makeTimeline([
          { beat: 0, bpm: 120, zoom: 1.0, easeToNext: ease } as unknown as BpmChange,
          { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange,
        ]);
      const zl = mkZoom('linear');
      const zo = mkZoom('ease-out');
      const zi = mkZoom('ease-in');

      // [Step3: Assert]
      expect(zl.zoomAt(2)).toBeCloseTo(1.5, 4);
      expect(zo.zoomAt(2)).toBeCloseTo(1.75, 4);
      expect(zi.zoomAt(2)).toBeCloseTo(1.25, 4);
      const t037 = 0.37 / 4;
      expect(zl.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(t037, 'linear'), 4);
      expect(zo.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(t037, 'ease-out'), 4);
      expect(zi.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(t037, 'ease-in'), 4);
      const t123 = 1.23 / 4;
      expect(zl.zoomAt(1.23)).toBeCloseTo(1.0 + 1.0 * eased(t123, 'linear'), 4);
      expect(zo.zoomAt(1.23)).toBeCloseTo(1.0 + 1.0 * eased(t123, 'ease-out'), 4);
      expect(zl.zoomAt(1.23)).not.toBeCloseTo(tlStep.zoomAt(1.23), 2);
    });

    it('イージング無し区間はステップのまま、混合区間で挙動が分離 (3-step off-grid)', () => {
      // [Step1: Capture Before] — all ease would be linear mid 1.1
      const tlAllEase = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ]);
      expect(tlAllEase.amplitudeAt(2)).toBeCloseTo(1.1, 4);

      // [Step2: Perform] — mixed: first gap eased, second gap step
      const tlMixed = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
        { beat: 8, bpm: 120, amplitude: 2.5 },
      ]);

      // [Step3: Assert] — first half interpolated, second half step
      expect(tlMixed.amplitudeAt(2)).toBeCloseTo(1.1, 4);
      expect(tlMixed.amplitudeAt(0.37)).toBeCloseTo(0.7 + 0.8 * eased(0.37 / 4, 'linear'), 4);
      expect(tlMixed.amplitudeAt(1.23)).toBeCloseTo(0.7 + 0.8 * eased(1.23 / 4, 'linear'), 4);
      expect(tlMixed.amplitudeAt(6)).toBeCloseTo(1.5, 5);
      expect(tlMixed.amplitudeAt(7.99)).toBeCloseTo(1.5, 5);
      expect(tlMixed.amplitudeAt(8)).toBeCloseTo(2.5, 5);
      const tlZoomMixed = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange,
        { beat: 8, bpm: 120, zoom: 3.0 } as unknown as BpmChange,
      ]);
      expect(tlZoomMixed.zoomAt(2)).toBeCloseTo(1.75, 4);
      expect(tlZoomMixed.zoomAt(6)).toBeCloseTo(2.0, 5);
    });

    it('ゼロ長区間 (A.beat==B.beat) は瞬間切替にフォールバック (3-step)', () => {
      // [Step1: Capture Before] — normal linear midpoint
      const tlNormal = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ]);
      expect(tlNormal.amplitudeAt(2)).toBeCloseTo(1.1, 4);

      // [Step2: Perform] — collocated entries at beat 4
      const tlZero = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.8 },
      ]);

      // [Step3: Assert] — zero-length gap fallback to step, finite values
      expect(tlZero.amplitudeAt(0)).toBeCloseTo(0.7, 5);
      expect(tlZero.amplitudeAt(2)).toBeCloseTo(0.85, 4);
      expect(tlZero.amplitudeAt(4)).toBeCloseTo(1.8, 5);
      expect(tlZero.amplitudeAt(3.99)).not.toBeCloseTo(1.8, 1);
      expect(Number.isFinite(tlZero.amplitudeAt(2))).toBe(true);
      const tlZoomZero = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 3.0 } as unknown as BpmChange,
      ]);
      expect(tlZoomZero.zoomAt(2)).toBeCloseTo(1.75, 4);
      expect(tlZoomZero.zoomAt(4)).toBeCloseTo(3.0, 5);
    });

    it('BPM/時刻写像はイージング影響なし — 瞬間切替のまま (3-step off-grid)', () => {
      // [Step1: Capture Before] — without easing
      const tlNo = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 150, amplitude: 1.5 },
      ]);

      // [Step2: Perform] — with easing same BPM
      const tlWith = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 150, amplitude: 1.5, easeToNext: 'linear' } as unknown as BpmChange,
      ]);

      // [Step3: Assert] — beatToMs identical, bpmAt unchanged
      expect(tlNo.beatToMs(0.37)).toBeCloseTo(tlWith.beatToMs(0.37), 5);
      expect(tlNo.beatToMs(1.23)).toBeCloseTo(tlWith.beatToMs(1.23), 5);
      expect(tlNo.beatToMs(4.37)).toBeCloseTo(tlWith.beatToMs(4.37), 5);
      expect(tlWith.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(tlWith.bpmAt(4.37)).toBeCloseTo(150, 5);
      expect(tlWith.msToBeat(tlWith.beatToMs(2.37))).toBeCloseTo(2.37, 3);
      expect(tlNo.amplitudeAt(2)).toBeCloseTo(0.7, 5);
      expect(tlWith.amplitudeAt(2)).toBeCloseTo(0.7 + 0.8 * 0.75, 4);
    });
  });

  // =======================================================================
  // 3. 旧譜面 (ease_to_next無し) は全区間瞬間切替 (step)
  // =======================================================================
  describe('3. 旧譜面 (ease_to_next無し) は全区間ステップ — TOML読込・autosave (3-step)', () => {
    it('旧TOMLをparseすると easeToNext が undefined のまま、補間はステップ (3-step off-grid)', () => {
      // [Step1: Capture Before] — new TOML with ease gives eased 1.75 at mid
      const tomlWithEase = `
title = "WithEase205"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 1.0
ease_to_next = "ease-out"
[[sections]]
beat = 8
bpm = 120
amplitude = 2.0
`;
      const parsedWith = parseChartText(tomlWithEase);
      const tlWith = makeTimeline(parsedWith.bpm_changes, parsedWith.amplitude);
      expect(tlWith.amplitudeAt(4)).toBeCloseTo(1.75, 4);

      // [Step2: Perform] — legacy TOML without any ease_to_next
      const tomlLegacy = `
title = "LegacyNoEase205"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 1.0
[[sections]]
beat = 4
bpm = 120
amplitude = 1.5
[[sections]]
beat = 8
bpm = 120
amplitude = 2.5
`;
      const parsedLegacy = parseChartText(tomlLegacy);

      // [Step3: Assert] — all undefined, timeline is step at off-grid
      expect((parsedLegacy.bpm_changes[0] as BpmChange).easeToNext).toBeUndefined();
      expect((parsedLegacy.bpm_changes[1] as BpmChange).easeToNext).toBeUndefined();
      expect((parsedLegacy.bpm_changes[2] as BpmChange).easeToNext).toBeUndefined();
      const tlLegacy = makeTimeline(parsedLegacy.bpm_changes, parsedLegacy.amplitude);
      expect(tlLegacy.amplitudeAt(0.37)).toBeCloseTo(1.0, 5);
      expect(tlLegacy.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      expect(tlLegacy.amplitudeAt(2)).toBeCloseTo(1.0, 5);
      expect(tlLegacy.amplitudeAt(3.99)).toBeCloseTo(1.0, 5);
      expect(tlLegacy.amplitudeAt(4)).toBeCloseTo(1.5, 5);
      expect(tlLegacy.amplitudeAt(6)).toBeCloseTo(1.5, 5);
      expect(tlLegacy.amplitudeAt(7.99)).toBeCloseTo(1.5, 5);
      expect(tlLegacy.amplitudeAt(8)).toBeCloseTo(2.5, 5);
      expect(tlLegacy.zoomAt(2)).toBeCloseTo(1.0, 5);
      expect(tlLegacy.amplitudeAt(4)).not.toBeCloseTo(tlWith.amplitudeAt(4), 2);
    });

    it('旧 [[bpm_changes]] エイリアスでも ease_to_next 無しはステップ、autosave往復でも維持 (3-step)', () => {
      // [Step1: Capture Before] — new [[sections]] without ease is step
      const newStepToml = `
title = "NewStep205"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 0.7
[[sections]]
beat = 4
bpm = 120
amplitude = 1.5
`;
      const parsedNewStep = parseChartText(newStepToml);
      const tlNewStep = makeTimeline(parsedNewStep.bpm_changes, 1.0);
      expect(tlNewStep.amplitudeAt(2)).toBeCloseTo(0.7, 5);

      // [Step2: Perform] — old [[bpm_changes]] without ease
      const oldAliasNoEase = `
title = "OldAliasNoEase205"
artist = ""
audio = "a.flac"
[[bpm_changes]]
beat = 0
bpm = 120
amplitude = 0.7
[[bpm_changes]]
beat = 4
bpm = 120
amplitude = 1.5
`;
      const parsedOldNoEase = parseChartText(oldAliasNoEase);
      const info = saveAutosave(parsedOldNoEase);
      const loadedOld = loadAutosave(info.slug);
      const tomlFromOld = chartToToml(loadedOld as unknown as Chart);
      const reparsedOld = parseChartText(tomlFromOld);

      // [Step3: Assert] — reparsed still step, serializes to [[sections]] without ease_to_next
      expect((reparsedOld.bpm_changes[0] as BpmChange).easeToNext).toBeUndefined();
      expect((reparsedOld.bpm_changes[1] as BpmChange).easeToNext).toBeUndefined();
      expect(tomlFromOld).not.toContain('ease_to_next');
      expect(tomlFromOld).toContain('[[sections]]');
      expect(tomlFromOld).not.toContain('[[bpm_changes]]');
      const tlOldStep = makeTimeline(reparsedOld.bpm_changes, 1.0);
      expect(tlOldStep.amplitudeAt(2)).toBeCloseTo(0.7, 5);
      expect(tlOldStep.amplitudeAt(1.23)).toBeCloseTo(0.7, 5);
      expect(tlOldStep.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
    });

    it('不正な ease_to_next 値 (bogus/empty/LINEAR) は無視されステップ扱い (3-step)', () => {
      // [Step1: Capture Before] — valid ease gives eased
      const tomlValid = `
title = "Valid205"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 1.0
ease_to_next = "linear"
[[sections]]
beat = 4
bpm = 120
amplitude = 2.0
`;
      const parsedValid = parseChartText(tomlValid);
      expect((parsedValid.bpm_changes[0] as BpmChange).easeToNext).toBe('linear');
      const tlValid = makeTimeline(parsedValid.bpm_changes, 1.0);
      expect(tlValid.amplitudeAt(2)).toBeCloseTo(1.5, 4);

      // [Step2: Perform] — invalid values
      const tomlInvalid = `
title = "InvalidEase205"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 1.0
ease_to_next = "bogus"
[[sections]]
beat = 4
bpm = 120
amplitude = 2.0
`;
      const parsedInvalid = parseChartText(tomlInvalid);
      const tomlCaps = `
title = "Caps205"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
ease_to_next = "LINEAR"
[[sections]]
beat = 4
bpm = 120
`;
      const parsedCaps = parseChartText(tomlCaps);

      // [Step3: Assert] — both ignored, step at mid
      expect((parsedInvalid.bpm_changes[0] as BpmChange).easeToNext).toBeUndefined();
      expect((parsedCaps.bpm_changes[0] as BpmChange).easeToNext).toBeUndefined();
      const tlInvalid = makeTimeline(parsedInvalid.bpm_changes, 1.0);
      expect(tlInvalid.amplitudeAt(2)).toBeCloseTo(1.0, 5);
      expect(tlInvalid.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      const bogusChart: Chart = {
        title: 'BogusEmit205',
        artist: '',
        audio: 'b.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, easeToNext: 'bogus' } as unknown as BpmChange,
          { beat: 4, bpm: 120 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const out = chartToToml(bogusChart as unknown as Chart);
      expect(out).not.toContain('bogus');
      const reparsedBogus = parseChartText(out);
      expect((reparsedBogus.bpm_changes[0] as BpmChange).easeToNext).toBeUndefined();
    });
  });

  // =======================================================================
  // 4. セクション追加ダイアログとの併存 + autosave結合 + 静的回帰
  // =======================================================================
  describe('4. セクション追加ダイアログ併存 & 結合・回帰 (3-step)', () => {
    it('セクション追加 → autosave → reload で ease_to_next と新セクションが両方再現 (3-step off-grid)', () => {
      // [Step1: Capture Before] — initial chart with one easing gap
      const initialChart: Chart = {
        title: 'DialogCoexist Before205',
        artist: '',
        audio: 'd.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 8, bpm: 120, amplitude: 2.0 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const tlBefore = makeTimeline(initialChart.bpm_changes, 1.0);
      expect(tlBefore.amplitudeAt(4)).toBeCloseTo(1.5, 4);
      const beforeCount = initialChart.bpm_changes.length;

      // [Step2: Perform] — simulate dialog adding a section at beat 4.37 (off-grid) with new BPM
      const afterAdd: BpmChange[] = [
        ...initialChart.bpm_changes,
        { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 1.3 },
      ].sort((a, b) => a.beat - b.beat);
      const chartAfterAdd: Chart = {
        ...initialChart,
        title: 'DialogCoexist After205',
        bpm_changes: afterAdd,
      } as unknown as Chart;
      const info = saveAutosave(chartAfterAdd);
      const loaded = loadAutosave(info.slug);
      const toml = chartToToml(loaded as unknown as Chart);
      const reparsed = parseChartText(toml);

      // [Step3: Assert] — reparsed has 3 sections sorted, easing still on first gap, interpolation correct
      expect(reparsed.bpm_changes.length).toBe(3);
      expect(reparsed.bpm_changes.map(c => c.beat)).toEqual([0, 4.37, 8]);
      expect((reparsed.bpm_changes[0] as BpmChange).easeToNext).toBe('linear');
      expect((reparsed.bpm_changes[1] as BpmChange).easeToNext).toBeUndefined();
      expect(reparsed.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(reparsed.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect(afterAdd.length).toBe(beforeCount + 1);
      const tlAfter = makeTimeline(reparsed.bpm_changes, 1.0);
      const midFirstGap = 0 + (4.37 - 0) / 2;
      expect(tlAfter.amplitudeAt(midFirstGap)).toBeCloseTo(1.0 + 0.3 * 0.5, 3);
      expect(tlAfter.amplitudeAt(6)).toBeCloseTo(1.3, 5);
      expect(tlAfter.amplitudeAt(6)).not.toBeCloseTo(tlBefore.amplitudeAt(6), 1);
    });

    it('ドラッグ相当の所有セクション付け替えが timeline interpolation に反映 (3-step)', () => {
      // [Step1: Capture Before] — ease on gap0 ([0,4.37])
      const beforeSections: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4.37, bpm: 120, amplitude: 1.3 },
        { beat: 8.25, bpm: 120, amplitude: 2.7 },
      ];
      const tlBefore = makeTimeline(beforeSections, 1.0);
      expect(tlBefore.amplitudeAt(2.185)).toBeCloseTo(1.15, 3);
      expect(tlBefore.amplitudeAt(6)).toBeCloseTo(1.3, 5);

      // [Step2: Perform] — simulate dragging ease from gap0 to gap1 (move ownership)
      const afterDrag: BpmChange[] = beforeSections.map((c, i) => {
        if (i === 0) return { ...c, easeToNext: undefined };
        if (i === 1) return { ...c, easeToNext: 'ease-out' } as unknown as BpmChange;
        return c;
      });
      const tlAfter = makeTimeline(afterDrag, 1.0);

      // [Step3: Assert] — gap0 now step, gap1 now eased
      expect(tlAfter.amplitudeAt(2.185)).toBeCloseTo(0.7, 5);
      expect(tlAfter.amplitudeAt(2.185)).not.toBeCloseTo(tlBefore.amplitudeAt(2.185), 2);
      const midGap1 = 4.37 + (8.25 - 4.37) / 2;
      expect(tlAfter.amplitudeAt(midGap1)).toBeCloseTo(1.3 + 1.4 * 0.75, 3);
      const tOff = (6 - 4.37) / (8.25 - 4.37);
      expect(tlAfter.amplitudeAt(6)).toBeCloseTo(1.3 + 1.4 * eased(tOff, 'ease-out'), 3);
      expect((afterDrag[0] as BpmChange).easeToNext).toBeUndefined();
      expect((afterDrag[1] as BpmChange).easeToNext).toBe('ease-out');
      expect(afterDrag.filter(c => c.easeToNext).length).toBe(1);
    });

    it('TOML往復後もオフグリッド端数 beat 0.37/1.23等が beat昇順で保持される (3-step)', () => {
      // [Step1: Capture Before] — unsorted beats would give wrong interpolation if not sorted
      const unsorted: BpmChange[] = [
        { beat: 8.25, bpm: 140, amplitude: 2.7 },
        { beat: 0.37, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4.37, bpm: 130, amplitude: 1.3 },
      ];
      const sortedExpected = [...unsorted].sort((a, b) => a.beat - b.beat);
      expect(sortedExpected.map(c => c.beat)).toEqual([0.37, 4.37, 8.25]);

      // [Step2: Perform] — chart roundtrip via loader/serialize which sorts
      const chartUnsorted: Chart = {
        title: 'SortCheck205',
        artist: '',
        audio: 's.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: unsorted,
        segments: [],
        rings: [],
      } as unknown as Chart;
      const toml = chartToToml(chartUnsorted as unknown as Chart);
      const parsed = parseChartText(toml);
      const info = saveAutosave(parsed);
      const loaded = loadAutosave(info.slug);

      // [Step3: Assert] — loaded is sorted ascending
      expect(loaded.bpm_changes.map(c => c.beat)).toEqual([0.37, 4.37, 8.25]);
      expect(loaded.bpm_changes[0].beat).toBeCloseTo(0.37, 3);
      expect(loaded.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect(loaded.bpm_changes[2].beat).toBeCloseTo(8.25, 3);
      const tl = makeTimeline(loaded.bpm_changes, 1.0);
      const mid = 0.37 + (4.37 - 0.37) / 2;
      const expectedMid = 0.7 + (1.3 - 0.7) * 0.5;
      expect(tl.amplitudeAt(mid)).toBeCloseTo(expectedMid, 3);
    });
  });

  // =======================================================================
  // 5. ソース静的回帰 — T186〜T191・T55・T102/T103・T155 の回帰なし (3-step file inspection)
  // =======================================================================
  describe('5. ソース静的回帰 — 結合で既存仕様が壊れていないこと (3-step)', () => {
    it('Chart型が bpm/scroll_speed を持たず bpm_changes[].zoom/easeToNext を持つ (3-step)', () => {
      const srcBefore = fs.readFileSync('src/types.ts', 'utf-8');
      void srcBefore;
      const src = fs.readFileSync('src/types.ts', 'utf-8');
      expect(src).toMatch(/interface BpmChange[\s\S]*?zoom\?/);
      expect(src).toMatch(/interface BpmChange[\s\S]*?easeToNext/);
      expect(src).not.toMatch(/interface Chart[\s\S]*?\bbpm\s*:/);
      expect(src).not.toMatch(/interface Chart[\s\S]*?scroll_speed/);
    });

    it('loader/serialize/autosave が [[sections]] のみを扱い scroll_speed を出力しない (3-step)', () => {
      const loaderBefore = fs.readFileSync('src/chart/loader.ts', 'utf-8');
      const serializeBefore = fs.readFileSync('src/chart/serialize.ts', 'utf-8');
      void loaderBefore;
      void serializeBefore;
      const loaderSrc = fs.readFileSync('src/chart/loader.ts', 'utf-8');
      const serializeSrc = fs.readFileSync('src/chart/serialize.ts', 'utf-8');
      const autosaveSrc = fs.readFileSync('src/chart/autosave.ts', 'utf-8');
      expect(loaderSrc).toContain('sections');
      expect(loaderSrc).toContain('bpm_changes');
      expect(loaderSrc).toContain('scroll_speed');
      expect(serializeSrc).toContain('[[sections]]');
      expect(serializeSrc).not.toContain('[[bpm_changes]]');
      expect(autosaveSrc).toContain('chartToToml');
      expect(autosaveSrc).toContain('parseChartText');
      expect(autosaveSrc).not.toMatch(/scroll_speed/);
    });

    it('BpmEditorが拍昇順ソート・onBlur/Enter確定・イージング行(DnD)を持つ (3-step)', () => {
      const srcBefore = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      void srcBefore;
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/\.sort\s*\(\s*\(a\s*,\s*b\)\s*=>\s*a\.beat\s*-\s*b\.beat/);
      expect(src).toMatch(/onBlur/);
      expect(src).toMatch(/onKeyDown[\s\S]*?Enter/);
      const onChangeSort = /onChange[\s\S]{0,120}\.sort\s*\(/.test(src);
      expect(onChangeSort).toBe(false);
      expect(src).toContain('easeToNext');
      expect(src).toContain('easing-row');
      expect(src).toContain('easing-add');
      expect(src).toContain('onDragStart');
      expect(src).toContain('onDrop');
      expect(src).toContain('ease-out');
      expect(src).toContain('ease-in');
      expect(src).toContain('bpm-change-header');
    });

    it('BpmTimelineが baseBPM先頭導出・zoomAt/easeを保持・BPM写像に影響しない (3-step)', () => {
      const srcBefore = fs.readFileSync('src/audio/bpmTimeline.ts', 'utf-8');
      void srcBefore;
      const src = fs.readFileSync('src/audio/bpmTimeline.ts', 'utf-8');
      expect(src).toContain('zoomEntries');
      expect(src).toContain('zoomAt');
      expect(src).toContain('easeToNext');
      expect(src).toContain('firstSection');
      expect(src).toContain('easeFactor');
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 150, amplitude: 2.0 },
      ]);
      expect(typeof tl.zoomAt).toBe('function');
      expect(typeof tl.amplitudeAt).toBe('function');
      expect(tl.bpmAt(2)).toBeCloseTo(120, 5);
    });

    it('index.css がイージング全列またぎ(grid-column:1/-1)とbpm-change-headerを持つ (3-step)', () => {
      const cssBefore = fs.readFileSync('src/index.css', 'utf-8');
      void cssBefore;
      const css = fs.readFileSync('src/index.css', 'utf-8');
      expect(css).toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);
      const easingRule = css.match(/[^{]*easing[^{]*\{[^}]*grid-column[^}]*\}/);
      expect(easingRule).not.toBeNull();
      expect(css).toContain('bpm-change-header');
    });

    it('autosave interval + cap 10 と SectionAddDialog がソート共存 (3-step)', () => {
      const autosaveBefore = fs.readFileSync('src/chart/autosave.ts', 'utf-8');
      void autosaveBefore;
      const autosaveSrc = fs.readFileSync('src/chart/autosave.ts', 'utf-8');
      expect(autosaveSrc).toContain('AUTOSAVE_MAX');
      expect(autosaveSrc).toMatch(/10/);
      const dialogSrc = fs.readFileSync('src/screens/editor/SectionAddDialog.tsx', 'utf-8');
      expect(dialogSrc).toMatch(/\.sort|sortSections|sortByBeat/);
      const editorSrc = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      expect(editorSrc).toMatch(/\.sort|sortByBeat|sortSections/);
    });
  });

  // =======================================================================
  // 6. 総合回帰 — autosave往復後のchartでBpmTimeline数値整合 + 複雑amp off-grid
  // =======================================================================
  describe('6. 総合 — autosave往復後のchartでBpmTimelineが複雑amp+off-gridで整合 (3-step)', () => {
    it('autosave往復後のcomplex chartで amplitudeAt/zoomAt と beatToMs が物理整合 (3-step)', () => {
      // [Step1: Capture Before] — simple autosave baseline
      const simpleChart: Chart = {
        title: 'SimpleBase205b',
        artist: '',
        audio: 's.flac',
        audio_offset: 0,
        amplitude: 0.7,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const sInfo = saveAutosave(simpleChart);
      const sLoaded = loadAutosave(sInfo.slug);
      const sTl = makeTimeline(sLoaded.bpm_changes, sLoaded.amplitude);
      expect(sTl.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(sTl.amplitudeAt(1.23)).toBeCloseTo(0.7, 5);
      clearAllAutosaves();

      // [Step2: Perform] — complex off-grid multi-section with easing mixed
      const complexChart: Chart = {
        title: 'ComplexTL205b',
        artist: '',
        audio: 'c.flac',
        audio_offset: 0,
        amplitude: 0.7,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 2.37, bpm: 150, amplitude: 1.3, zoom: 1.3, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: 4.37, bpm: 180, amplitude: 2.7, zoom: 2.7 },
        ],
        segments: [{ direction: 'up', beats: 1 }],
        rings: [{ beat: 1.23 }],
      } as unknown as Chart;
      const cInfo = saveAutosave(complexChart);
      const loadedComplex = loadAutosave(cInfo.slug);
      const tlComplex = makeTimeline(loadedComplex.bpm_changes, loadedComplex.amplitude);

      // [Step3: Assert] — after round-trip values intact
      expect(loadedComplex.bpm_changes[1].beat).toBeCloseTo(2.37, 3);
      expect(tlComplex.amplitudeAt(0.37)).toBeCloseTo(0.7 + 0.6 * eased(0.37 / 2.37, 'linear'), 4);
      expect(tlComplex.amplitudeAt(2.37)).toBeCloseTo(1.3, 5);
      expect(tlComplex.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);
      expect(tlComplex.amplitudeAt(3.37)).toBeCloseTo(1.3 + 1.4 * eased((3.37 - 2.37) / 2.0, 'ease-out'), 4);
      expect(tlComplex.zoomAt(0.37)).toBeCloseTo(0.7 + 0.6 * eased(0.37 / 2.37, 'linear'), 4);
      const ms120 = 60000 / 120;
      const ms150 = 60000 / 150;
      expect(tlComplex.beatToMs(1.23)).toBeCloseTo(ms120 * 1.23, 2);
      expect(tlComplex.beatToMs(2.37)).toBeCloseTo(ms120 * 2.37, 2);
      expect(tlComplex.beatToMs(3.37)).toBeCloseTo(ms120 * 2.37 + ms150 * 1.0, 2);
      expect(Number.isFinite(110 * tlComplex.zoomAt(0.37))).toBe(true);
    });

    it('未定義振幅の継承値で補間がフラットになり、TOML出力で空欄セクションがステップ (3-step)', () => {
      // [Step1: Capture Before] — heredity baseline
      const tlStepHeredity = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.8 },
        { beat: 4, bpm: 120 },
        { beat: 8, bpm: 120, amplitude: 1.6 },
      ]);
      expect(tlStepHeredity.amplitudeAt(2)).toBeCloseTo(0.8, 5);
      expect(tlStepHeredity.amplitudeAt(6)).toBeCloseTo(0.8, 5);

      // [Step2: Perform] — eased heredity: [0 ease->4(undefined) ->8]
      const tlEasedHeredity = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.8, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120 },
        { beat: 8, bpm: 120, amplitude: 1.6 },
      ]);

      // [Step3: Assert] — first gap interpolates 0.8->0.8 flat, off-grid also flat
      expect(tlEasedHeredity.amplitudeAt(2)).toBeCloseTo(0.8, 4);
      expect(tlEasedHeredity.amplitudeAt(0.37)).toBeCloseTo(0.8, 4);
      expect(tlEasedHeredity.amplitudeAt(3.37)).toBeCloseTo(0.8, 4);
      expect(tlEasedHeredity.amplitudeAt(6)).toBeCloseTo(0.8, 5);
      const heredityChart: Chart = {
        title: 'HeredityEase205b',
        artist: '',
        audio: 'h.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.8, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 4, bpm: 120 },
          { beat: 8, bpm: 120, amplitude: 1.6 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const info = saveAutosave(heredityChart);
      const loaded = loadAutosave(info.slug);
      expect(loaded.bpm_changes[1].amplitude).toBeUndefined();
      const tlReloaded = makeTimeline(loaded.bpm_changes, 1.0);
      expect(tlReloaded.amplitudeAt(2)).toBeCloseTo(0.8, 4);
    });
  });
});
