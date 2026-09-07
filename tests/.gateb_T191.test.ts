/**
 * T191 — セクション設定の結合・回帰（autosave・旧譜面・TOML往復） Vitest pure acceptance
 * node environment — pure engine/math, no DOM, TDD Red->Green
 * Verifies:
 *  (1) autosave保存→復元でセクション4値(beat/bpm/amplitude/zoom)再現
 *  (2) 旧TOML(bpm＋[[bpm_changes]]＋scroll_speed)読込でscroll_speedのみ捨てる
 *  (3) 回帰なし: T55/T186〜T190, zoomAt, baseBPM導出, scrollSpeed時変
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import {
  saveAutosave,
  loadAutosave,
  listAutosaves,
  deleteAutosave,
  getAutosaveInterval,
  setAutosaveInterval,
  AUTOSAVE_PREFIX,
} from '../src/chart/autosave';
import type { Chart, BpmChange } from '../src/types';

// ---------------------------------------------------------------------------
// localStorage polyfill for node environment (vitest without jsdom)
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

vi.useFakeTimers();

// helpers — distinct names from variables (postmortem rule)
function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as unknown as new (a: unknown, b: unknown) => BpmTimeline)(sections as unknown, baseAmp as unknown);
}
function hasSingleBpmLine(toml: string): boolean {
  const lines = toml.split('\n').map(l => l.trim());
  const firstSectionIdx = lines.findIndex(l => l === '[[sections]]' || l === '[[bpm_changes]]');
  const candidateIdx = lines.findIndex(l => /^bpm\s*=\s*[-+\d.]+/.test(l));
  if (candidateIdx === -1) return false;
  if (firstSectionIdx === -1) return true;
  return candidateIdx < firstSectionIdx;
}
function hasScrollSpeedLine(toml: string): boolean {
  return toml.split('\n').some(l => l.trim().startsWith('scroll_speed'));
}
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
  localStorage.removeItem('rhythmEditorAutosaveInterval');
});
afterEach(() => {
  vi.clearAllTimers();
  clearAllAutosaves();
});

describe('T191 セクション設定の結合・回帰（autosave・旧譜面・TOML往復） Vitest pure', () => {
  // ======================================================================
  // 1) autosave保存→復元でセクション4値再現 (完了条件1)
  // ======================================================================
  describe('1. autosave保存→復元で sections 4値 (beat/bpm/amplitude/zoom) 再現', () => {
    it('複雑な振幅0.7/1.3/2.7とzoom+端数拍0.37/1.23を含むchartがautosave往復で一致 (3-step)', () => {
      // [Step1: Capture Initial State] — empty autosave list
      const beforeList = listAutosaves();
      expect(beforeList.length).toBe(0);

      // [Step2: Perform] — build chart with off-grid beats + complex 4-value sections
      const complexChart: Chart = {
        title: 'T191 Complex 0.37',
        artist: 'Tester',
        audio: 'test.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.8 },
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 1.2 },
          { beat: 8.25, bpm: 140, zoom: 0.5 },
          { beat: 12.125, bpm: 180, amplitude: 2.7, zoom: 1.5 },
        ],
        segments: [{ direction: 'up', beats: 1 }],
        rings: [{ beat: 4.37 }],
      } as unknown as Chart;

      const saveInfo = saveAutosave(complexChart);
      const loadedChart = loadAutosave(saveInfo.slug);

      // [Step3: Assert Resulting Transition] — all 4 fields preserved within 1e-3
      expect(loadedChart.bpm_changes.length).toBe(4);
      expect(loadedChart.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(loadedChart.bpm_changes[0].bpm).toBeCloseTo(120, 5);
      expect(loadedChart.bpm_changes[0].amplitude).toBeCloseTo(0.7, 5);
      expect((loadedChart.bpm_changes[0] as BpmChange).zoom).toBeCloseTo(0.8, 5);

      expect(loadedChart.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect(loadedChart.bpm_changes[1].bpm).toBeCloseTo(150, 5);
      expect(loadedChart.bpm_changes[1].amplitude).toBeCloseTo(1.3, 5);
      expect((loadedChart.bpm_changes[1] as BpmChange).zoom).toBeCloseTo(1.2, 5);

      expect(loadedChart.bpm_changes[2].beat).toBeCloseTo(8.25, 3);
      expect(loadedChart.bpm_changes[2].amplitude).toBeUndefined();
      expect((loadedChart.bpm_changes[2] as BpmChange).zoom).toBeCloseTo(0.5, 5);

      expect(loadedChart.bpm_changes[3].beat).toBeCloseTo(12.125, 3);
      expect((loadedChart.bpm_changes[3] as BpmChange).zoom).toBeCloseTo(1.5, 3);
      expect(loadedChart.bpm_changes[3].amplitude).toBeCloseTo(2.7, 5);

      // Also verify autosave list contains the slug
      const afterList = listAutosaves();
      expect(afterList.length).toBe(1);
      expect(afterList[0].slug).toBe(saveInfo.slug);
    });

    it('amplitude未設定のセクションはautosave往復でundefinedを維持しzoom無しは出力されない (3-step)', () => {
      // [Step1] Capture: chart with single section no zoom/amplitude
      const chartNoExtras: Chart = {
        title: 'NoExtras',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const infoNoExtras = saveAutosave(chartNoExtras);
      const loadedNoExtras = loadAutosave(infoNoExtras.slug);
      expect(loadedNoExtras.bpm_changes[0].zoom).toBeUndefined();
      expect(loadedNoExtras.bpm_changes[0].amplitude).toBeUndefined();
      clearAllAutosaves();

      // [Step2] Perform: mixed sections, one with zoom only
      const chartMixed: Chart = {
        title: 'Mixed Zoom',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120 },
          { beat: 4, bpm: 150, zoom: 2.5 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const infoMixed = saveAutosave(chartMixed);
      const loadedMixed = loadAutosave(infoMixed.slug);

      // [Step3] Assert
      expect(loadedMixed.bpm_changes[0].zoom).toBeUndefined();
      expect((loadedMixed.bpm_changes[1] as BpmChange).zoom).toBeCloseTo(2.5, 5);
      // serialize check: first block no zoom, second has zoom
      const tomlMixed = chartToToml(chartMixed as unknown as Chart);
      const blocksMixed = tomlMixed.split('[[sections]]');
      expect(blocksMixed.length).toBe(3);
      expect(blocksMixed[1]).not.toContain('zoom');
      expect(blocksMixed[2]).toContain('zoom = 2.5');
    });

    it('autosaveが複数タイトルで上限10件→11件目で最古が削除される (3-step)', () => {
      // [Step1: Capture Initial State] — 0件
      expect(listAutosaves().length).toBe(0);

      // [Step2: Perform] — save 11 distinct titles with advancing fake time
      for (let i = 0; i < 11; i++) {
        const c: Chart = {
          title: `Song ${i}`,
          artist: '',
          audio: 'a.flac',
          audio_offset: 0,
          amplitude: 1.0,
          start_position: 0,
          bpm_changes: [{ beat: 0, bpm: 120 + i, zoom: 1 + i * 0.1 }],
          segments: [],
          rings: [],
        } as unknown as Chart;
        saveAutosave(c);
        vi.advanceTimersByTime(1000);
      }

      // [Step3: Assert Resulting Transition]
      const slotsAfter = listAutosaves();
      expect(slotsAfter.length).toBe(10);
      // oldest (Song 0) must have been evicted
      const slugsAfter = slotsAfter.map(s => s.slug);
      const hasSong0 = slugsAfter.some(s => s.includes('song-0'));
      expect(hasSong0).toBe(false);
      // newest must exist
      const hasSong10 = slugsAfter.some(s => s.includes('song-10'));
      expect(hasSong10).toBe(true);
    });

    it('autosaveIntervalのclampと永続化が機能する (3-step)', () => {
      // [Step1: Capture Initial State] default 3
      const beforeInterval = getAutosaveInterval();
      expect(beforeInterval).toBe(3);

      // [Step2: Perform] set to valid, invalid, out-of-range
      setAutosaveInterval(5);
      const fiveVal = getAutosaveInterval();
      setAutosaveInterval(0);
      const zeroClamped = getAutosaveInterval();
      setAutosaveInterval(99);
      const highClamped = getAutosaveInterval();
      setAutosaveInterval(2);
      const twoVal = getAutosaveInterval();

      // [Step3: Assert]
      expect(fiveVal).toBe(5);
      expect(zeroClamped).toBe(1);
      expect(highClamped).toBe(5);
      expect(twoVal).toBe(2);
    });
  });

  // ======================================================================
  // 2) 旧TOML(bpm＋[[bpm_changes]]＋scroll_speed)読込でscroll_speedのみ捨てる (完了条件2)
  // ======================================================================
  describe('2. 旧TOML読込マイグレーション — scroll_speedのみ捨てる・他は維持', () => {
    it('旧bpm_changes形式が同等に読め、scroll_speed=999はChartに残らない (3-step)', () => {
      // [Step1: Capture] new format without scroll_speed
      const newTomlNoLegacy = `
title = "NewF"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
`;
      const parsedNew = parseChartText(newTomlNoLegacy);
      expect((parsedNew as unknown as Record<string, unknown>)['scroll_speed']).toBeUndefined();

      // [Step2: Perform] old format with scroll_speed + bpm single + bpm_changes
      const oldWithLegacy = `
title = "OldF"
artist = ""
bpm = 120
audio = "a.flac"
scroll_speed = 999
audio_offset = 0
amplitude = 1.0
[[bpm_changes]]
beat = 2
bpm = 140
[[segments]]
direction = "up"
beats = 2
`;
      const parsedOld = parseChartText(oldWithLegacy);

      // [Step3: Assert] scroll_speed ignored, bpm single migrated, amplitude preserved
      expect((parsedOld as unknown as Record<string, unknown>)['scroll_speed']).toBeUndefined();
      expect((parsedOld as unknown as Record<string, unknown>)['bpm']).toBeUndefined();
      expect(parsedOld.audio_offset).toBeCloseTo(0, 5);
      expect(parsedOld.amplitude).toBeCloseTo(1.0, 5);
      // bpm=120 single should have been migrated to beat 0
      const hasBeat0Migrated = parsedOld.bpm_changes.some(c => c.beat === 0 && c.bpm === 120);
      expect(hasBeat0Migrated).toBe(true);
      // old bpm_changes entry preserved
      expect(parsedOld.bpm_changes.some(c => c.beat === 2 && c.bpm === 140)).toBe(true);
      expect(parsedOld.segments.length).toBe(1);
    });

    it('scroll_speedが含まれてもserializeには出力されない (3-step)', () => {
      // [Step1] parse old toml with scroll_speed
      const legacyTomlWithScroll = `
title = "Tscroll"
artist = ""
bpm = 120
audio = "a.flac"
scroll_speed = 250
[[bpm_changes]]
beat = 4
bpm = 150
`;
      const parsedLegacyChart = parseChartText(legacyTomlWithScroll);

      // [Step2] serialize to new format
      const outToml = chartToToml(parsedLegacyChart as unknown as Chart);

      // [Step3] assert no scroll_speed, no bpm changes, uses [[sections]]
      expect(hasScrollSpeedLine(outToml)).toBe(false);
      expect(hasSingleBpmLine(outToml)).toBe(false);
      expect(outToml).toContain('[[sections]]');
      expect(outToml).not.toContain('[[bpm_changes]]');
    });

    it('旧bpm_changesのbeat=0が新仕様で保持される (3-step)', () => {
      // [Step1] old alias beat 0
      const tomlBeat0OldAlias = `
title = "Beat0Old"
artist = ""
audio = "a.flac"
[[bpm_changes]]
beat = 0
bpm = 120
zoom = 1.5
`;
      const parsedOldBeat0 = parseChartText(tomlBeat0OldAlias);

      // [Step2] new sections beat 0
      const tomlBeat0NewSpec = `
title = "Beat0New"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
zoom = 1.5
`;
      const parsedNewBeat0 = parseChartText(tomlBeat0NewSpec);

      // [Step3] both must keep beat 0 with zoom 1.5
      expect(parsedOldBeat0.bpm_changes.some(c => c.beat === 0)).toBe(true);
      expect((parsedOldBeat0.bpm_changes.find(c => c.beat === 0) as BpmChange).zoom).toBeCloseTo(1.5, 5);
      expect(parsedNewBeat0.bpm_changes.some(c => c.beat === 0)).toBe(true);
      expect((parsedNewBeat0.bpm_changes.find(c => c.beat === 0) as BpmChange).zoom).toBeCloseTo(1.5, 5);
    });

    it('bpm単一がない場合はsections 0件時に120フォールバック、ある場合は旧bpmで移行 (3-step)', () => {
      // [Step1: Capture] empty toml -> default 120
      const emptyNoBpm = `
title = "Empty"
artist = ""
audio = "e.flac"
`;
      const parsedDefaultFallback = parseChartText(emptyNoBpm);
      expect(parsedDefaultFallback.bpm_changes.length).toBe(1);
      expect(parsedDefaultFallback.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedDefaultFallback.bpm_changes[0].bpm).toBeCloseTo(120, 5);

      // [Step2: Perform] legacy bpm=135 no sections
      const legacy135 = `
title = "Legacy135"
artist = ""
bpm = 135
audio = "e.flac"
`;
      const parsed135 = parseChartText(legacy135);

      // [Step3] assert migrated 135 not 120
      expect(parsed135.bpm_changes.length).toBe(1);
      expect(parsed135.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsed135.bpm_changes[0].bpm).toBeCloseTo(135, 5);
      expect((parsed135 as unknown as Record<string, unknown>)['bpm']).toBeUndefined();
    });

    it('旧チャートReply風の総合移行: bpm/scroll_speed→sections, segments/rings維持 (3-step off-grid)', () => {
      // [Step1: Capture] old reply-like legacy
      const oldReplyLike = `
title = "Reply"
artist = ""
bpm = 120
audio = "/rhythm_game/audio/08.Reply.flac"
scroll_speed = 110
amplitude = 1.0
[[bpm_changes]]
beat = 64
bpm = 150
[[segments]]
direction = "up"
beats = 2
[[segments]]
direction = "down"
beats = 2
[[rings]]
beat = 4.0
[[rings]]
beat = 8.0
`;
      const parsedReplyLegacy = parseChartText(oldReplyLike);

      // [Step2: Perform] serialize to new then reparse
      const newReplyToml = chartToToml(parsedReplyLegacy as unknown as Chart);
      const reparsedReply = parseChartText(newReplyToml);

      // [Step3: Assert]
      expect(newReplyToml).toContain('[[sections]]');
      expect(newReplyToml).not.toContain('[[bpm_changes]]');
      expect(hasSingleBpmLine(newReplyToml)).toBe(false);
      expect(hasScrollSpeedLine(newReplyToml)).toBe(false);
      const hasMigrated0 = reparsedReply.bpm_changes.some(c => c.beat === 0 && c.bpm === 120);
      expect(hasMigrated0).toBe(true);
      expect(reparsedReply.bpm_changes.some(c => c.beat === 64 && c.bpm === 150)).toBe(true);
      expect(reparsedReply.segments.length).toBe(2);
      expect(reparsedReply.rings.length).toBe(2);
      expect(reparsedReply.bpm_changes.length).toBe(2);
    });

    it('複雑な端数拍0.37/1.23/4.37での旧形式zoom顕在と新往復の数値一致 (3-step)', () => {
      // [Step1] Build chart with off-grid sections
      const beforeChartOffGrid: Chart = {
        title: 'OffGridLegacy',
        artist: '',
        audio: 'c.flac',
        audio_offset: 5,
        start_position: 0.5,
        bpm_changes: [
          { beat: 0.37, bpm: 120, amplitude: 0.7, zoom: 0.8 },
          { beat: 1.23, bpm: 150, amplitude: 1.3, zoom: 1.2 },
          { beat: 4.37, bpm: 180, amplitude: 2.7, zoom: 2.0 },
        ],
        segments: [{ direction: 'up', beats: 1 }],
        rings: [{ beat: 1.23 }],
      } as unknown as Chart;
      const beforeTomlOffGrid = chartToToml(beforeChartOffGrid as unknown as Chart);
      const parsedBeforeOffGrid = parseChartText(beforeTomlOffGrid);
      expect(parsedBeforeOffGrid.bpm_changes[0].beat).toBeCloseTo(0.37, 3);

      // [Step2] Perform complex off-grid with sections 4 values
      const complexOffGrid: Chart = {
        title: 'ComplexOff',
        artist: '',
        audio: 'c.flac',
        audio_offset: 5,
        start_position: 0.5,
        bpm_changes: [
          { beat: 0.37, bpm: 123.456, amplitude: 0.7, zoom: 0.75 },
          { beat: 1.23, bpm: 178.9, amplitude: 3.4, zoom: 1.33 },
          { beat: 4.37, bpm: 180, amplitude: 2.7, zoom: 2.0 },
        ],
        segments: [{ direction: 'up', beats: 1 }],
        rings: [{ beat: 4.37 }],
      } as unknown as Chart;
      const tomlOffGrid = chartToToml(complexOffGrid as unknown as Chart);
      const parsedOffGrid = parseChartText(tomlOffGrid);

      // [Step3] Assert off-grid preservation within 1e-3
      expect(parsedOffGrid.bpm_changes[0].beat).toBeCloseTo(0.37, 3);
      expect(parsedOffGrid.bpm_changes[1].beat).toBeCloseTo(1.23, 3);
      expect(parsedOffGrid.bpm_changes[2].beat).toBeCloseTo(4.37, 3);
      expect((parsedOffGrid.bpm_changes[0] as BpmChange).zoom).toBeCloseTo(0.75, 3);
      expect((parsedOffGrid.bpm_changes[1] as BpmChange).zoom).toBeCloseTo(1.33, 3);
      expect((parsedOffGrid.bpm_changes[2] as BpmChange).zoom).toBeCloseTo(2.0, 3);
    });
  });

  // ======================================================================
  // 3) Chart型から bpm / scroll_speed 削除 & serializeが新形式のみ出力
  // ======================================================================
  describe('3. Chart.bpm / scroll_speed 廃止と新TOML形式のみ出力', () => {
    it('Chartに bpm / scroll_speed プロパティが存在しない (3-step)', () => {
      // [Step1] Create chart via new-form TOML
      const tomlNewFormat = `
title = "NoSingle"
artist = ""
audio = "n.flac"
[[sections]]
beat = 0
bpm = 135
zoom = 1.2
`;
      const chartNewFormat = parseChartText(tomlNewFormat);

      // [Step2] Inspect properties
      const hasBpmProp = 'bpm' in chartNewFormat && (chartNewFormat as unknown as Record<string, unknown>)['bpm'] !== undefined;
      const hasScrollProp = 'scroll_speed' in chartNewFormat && (chartNewFormat as unknown as Record<string, unknown>)['scroll_speed'] !== undefined;

      // [Step3] Assert absent
      expect(hasBpmProp).toBe(false);
      expect(hasScrollProp).toBe(false);
      expect((chartNewFormat as unknown as Record<string, unknown>)['bpm']).toBeUndefined();
      expect((chartNewFormat as unknown as Record<string, unknown>)['scroll_speed']).toBeUndefined();
    });

    it('chartToTomlが bpm= / scroll_speed= 単一行を出力しない (3-step)', () => {
      // [Step1] Capture chart with sections
      const chartForSerializeCheck: Chart = {
        title: 'NoSingleOut',
        artist: '',
        audio: 'n.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120, zoom: 1 }],
        segments: [],
        rings: [],
      } as unknown as Chart;

      // [Step2] Serialize
      const tomlOutCheck = chartToToml(chartForSerializeCheck as unknown as Chart);

      // [Step3] Assert
      expect(hasSingleBpmLine(tomlOutCheck)).toBe(false);
      expect(hasScrollSpeedLine(tomlOutCheck)).toBe(false);
      const linesOutCheck = tomlOutCheck.split('\n');
      const idxSections = linesOutCheck.findIndex(l => l.trim() === '[[sections]]');
      const beforeSectionsOut = linesOutCheck.slice(0, idxSections);
      expect(beforeSectionsOut.some(l => l.trim().startsWith('bpm'))).toBe(false);
      expect(beforeSectionsOut.some(l => l.trim().startsWith('scroll_speed'))).toBe(false);
    });

    it('sections 0件時に beat=0 bpm=120 フォールバックがchartToTomlでも出力される (3-step)', () => {
      // [Step1] chart with empty bpm_changes via alternative creation
      const emptyChart: Chart = {
        title: 'EmptyS',
        artist: '',
        audio: 'e.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const tomlEmptySections = chartToToml(emptyChart as unknown as Chart);

      // [Step2] Parse the generated toml (should have been seeded with beat 0 / bpm 120 by serialize)
      const parsedEmptyGenerated = parseChartText(tomlEmptySections);

      // [Step3] Assert serialize produced a beat0 120 entry and parse keeps it
      expect(tomlEmptySections).toContain('[[sections]]');
      expect(tomlEmptySections).toContain('beat = 0');
      expect(tomlEmptySections).toContain('bpm = 120');
      expect(parsedEmptyGenerated.bpm_changes.length).toBe(1);
      expect(parsedEmptyGenerated.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedEmptyGenerated.bpm_changes[0].bpm).toBeCloseTo(120, 5);
    });
  });

  // ======================================================================
  // 4) BpmTimeline基準BPM導出＋zoomAt / scrollSpeed時変の回帰 (T186〜T190)
  // ======================================================================
  describe('4. BpmTimeline基準BPM導出＋zoomAt＋scrollSpeed時変 (T187/T188回帰)', () => {
    it('空sectionsは120フォールバック、beat0=180はoff-grid 0.37/1.23で180基準になる (3-step)', () => {
      // [Step1: Capture] empty fallback 120
      const emptyTimelineFallback = makeTimeline([], 1.0);
      expect(emptyTimelineFallback.beatToMs(1)).toBeCloseTo(500, 2);
      expect(emptyTimelineFallback.bpmAt(0.37)).toBeCloseTo(120, 5);

      // [Step2: Perform] derived from beat0=180
      const tl180Derived = makeTimeline([{ beat: 0, bpm: 180 }], 1.0);
      const beatMs180Derived = 60000 / 180;

      // [Step3: Assert]
      expect(tl180Derived.bpmAt(0)).toBeCloseTo(180, 5);
      expect(tl180Derived.bpmAt(0.37)).toBeCloseTo(180, 5);
      expect(tl180Derived.bpmAt(1.23)).toBeCloseTo(180, 5);
      expect(tl180Derived.beatToMs(0.37)).toBeCloseTo(beatMs180Derived * 0.37, 2);
      expect(tl180Derived.beatToMs(1.23)).toBeCloseTo(beatMs180Derived * 1.23, 2);
      expect(tl180Derived.msToBeat(beatMs180Derived * 0.37)).toBeCloseTo(0.37, 4);
    });

    it('zoomAtステップが off-grid 境界 0.37/1.23 で正確に切替、scrollSpeed=110*zoomAt (3-step)', () => {
      // [Step1: Capture] empty -> zoom 1.0 => scroll 110
      const emptyTlForZoom = makeTimeline([], 1.0);
      expect(emptyTlForZoom.zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect(110 * emptyTlForZoom.zoomAt(1.23)).toBeCloseTo(110, 5);

      // [Step2: Perform] complex zoom 0.7/1.3/2.7 at off-grid boundaries
      const complexZoomTl = makeTimeline([
        { beat: 0, bpm: 120, zoom: 0.7 },
        { beat: 2, bpm: 120, zoom: 1.3 },
        { beat: 4, bpm: 120, zoom: 2.7 },
      ], 1.0);

      // [Step3: Assert] zoomAt and scrollSpeed
      expect(complexZoomTl.zoomAt(0.37)).toBeCloseTo(0.7, 5);
      expect(110 * complexZoomTl.zoomAt(0.37)).toBeCloseTo(77, 5);
      expect(complexZoomTl.zoomAt(2.37)).toBeCloseTo(1.3, 5);
      expect(110 * complexZoomTl.zoomAt(2.37)).toBeCloseTo(143, 5);
      expect(complexZoomTl.zoomAt(4.37)).toBeCloseTo(2.7, 5);
      expect(110 * complexZoomTl.zoomAt(4.37)).toBeCloseTo(297, 5);

      // off-grid step inclusive check at exact boundary
      const offGridBoundaryTl = makeTimeline([
        { beat: 0.37, bpm: 120, zoom: 0.8 },
        { beat: 1.23, bpm: 120, zoom: 1.2 },
      ], 1.0);
      expect(offGridBoundaryTl.zoomAt(0.36)).toBeCloseTo(1.0, 5);
      expect(offGridBoundaryTl.zoomAt(0.37)).toBeCloseTo(0.8, 5);
      expect(offGridBoundaryTl.zoomAt(1.22)).toBeCloseTo(0.8, 5);
      expect(offGridBoundaryTl.zoomAt(1.23)).toBeCloseTo(1.2, 5);
    });

    it('zoomはBPM計算(beatToMs)に影響しない — 同じBPMでzoom有無のbeatToMs一致 (3-step)', () => {
      // [Step1] without zoom
      const withoutZoomTimeline = makeTimeline([{ beat: 0, bpm: 150 }], 1.0);
      const msWithoutZoom = withoutZoomTimeline.beatToMs(1.23);

      // [Step2] with zoom same BPM
      const withZoomTimeline = makeTimeline([{ beat: 0, bpm: 150, zoom: 2.5 }], 1.0);
      const msWithZoom = withZoomTimeline.beatToMs(1.23);

      // [Step3] time conversion identical, scrollSpeed differs
      expect(msWithZoom).toBeCloseTo(msWithoutZoom, 5);
      expect((withZoomTimeline as unknown as { zoomAt: (b: number) => number }).zoomAt(1.23)).toBeCloseTo(2.5, 5);
      expect((withoutZoomTimeline as unknown as { zoomAt: (b: number) => number }).zoomAt(1.23)).toBeCloseTo(1.0, 5);
    });

    it('amplitudeAtとzoomAtは独立 — 片方変更が他方に影響しない (3-step off-grid)', () => {
      // [Step1] zoom only
      const zoomOnlyTimeline = makeTimeline([{ beat: 2, bpm: 120, zoom: 2.0 }], 1.0);
      expect(zoomOnlyTimeline.zoomAt(2.37)).toBeCloseTo(2.0, 5);
      expect(zoomOnlyTimeline.amplitudeAt(2.37)).toBeCloseTo(1.0, 5);

      // [Step2] amplitude only
      const ampOnlyTimeline = makeTimeline([{ beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(ampOnlyTimeline.amplitudeAt(2.37)).toBeCloseTo(2.0, 5);
      expect(ampOnlyTimeline.zoomAt(2.37)).toBeCloseTo(1.0, 5);

      // [Step3] both set simultaneously
      const bothTimeline = makeTimeline([
        { beat: 2, bpm: 120, amplitude: 1.7, zoom: 0.5 },
        { beat: 4, bpm: 120, amplitude: 2.7, zoom: 2.5 },
      ], 1.0);
      expect(bothTimeline.amplitudeAt(2.37)).toBeCloseTo(1.7, 5);
      expect(bothTimeline.zoomAt(2.37)).toBeCloseTo(0.5, 5);
      expect(bothTimeline.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);
      expect(bothTimeline.zoomAt(4.37)).toBeCloseTo(2.5, 5);
    });
  });

  // ======================================================================
  // 5) ソース静的検証: chart.bpm / scroll_speed 参照の洗い替え
  // ======================================================================
  describe('5. ソース静的検証 — chart.bpm / scroll_speed 残存参照の洗い替え', () => {
    it('GameScreen.tsx が chart.bpm_changes由来でBpmTimelineを生成し chart.bpm/scroll_speedを参照しない (3-step)', () => {
      // [Step1: Capture] read file
      const srcGameScreen = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
      const hasBpmChangesUse = srcGameScreen.includes('chart.bpm_changes');
      const hasNewCtorPattern = srcGameScreen.includes('new BpmTimeline(chart.bpm_changes');

      // [Step2: Perform] detect legacy patterns
      const hasLegacyBpmProp = /chart\.bpm(?!_changes)/.test(srcGameScreen);
      const hasScrollProp = /scroll_speed/.test(srcGameScreen);
      const hasZoomAt110 = srcGameScreen.includes('110 * timeline.zoomAt') || srcGameScreen.includes('110*timeline.zoomAt');

      // [Step3: Assert]
      expect(hasBpmChangesUse).toBe(true);
      expect(hasNewCtorPattern).toBe(true);
      expect(hasLegacyBpmProp).toBe(false);
      expect(hasScrollProp).toBe(false);
      expect(hasZoomAt110).toBe(true);
      expect(/scrollSpeed\s*:\s*110\s*\*\s*timeline\.zoomAt/.test(srcGameScreen)).toBe(true);
    });

    it('CalibrationModal.tsx が chart.bpmを参照せず zoomAtでscrollSpeedを算出 (3-step)', () => {
      // [Step1] read calibration file
      const srcCalib = fs.readFileSync('src/screens/editor/CalibrationModal.tsx', 'utf-8');
      const hasLegacyBpmC = /chart\.bpm(?!_changes)/.test(srcCalib);
      const hasScrollC = /scroll_speed/.test(srcCalib);

      // [Step2] zoomAt and scrollSpeed
      const hasZoomAtC = srcCalib.includes('timeline.zoomAt');
      const has110ZoomC = srcCalib.includes('110 * timeline.zoomAt');
      const hasFixedTimeline = srcCalib.includes('CAL_BPM') && /new BpmTimeline\(\s*\[\s*\{\s*beat:\s*0/.test(srcCalib);

      // [Step3] assert
      expect(hasLegacyBpmC).toBe(false);
      expect(hasScrollC).toBe(false);
      expect(hasZoomAtC).toBe(true);
      expect(has110ZoomC).toBe(true);
      expect(hasFixedTimeline).toBe(true);
      expect(/scrollSpeed\s*:\s*110\s*\*\s*timeline\.zoomAt\(currentBeat\)/.test(srcCalib)).toBe(true);
    });

    it('BpmTimelineが baseBPMを先頭sectionから導出し zoomEntries/zoomAtを持つ (3-step)', () => {
      // [Step1] verify instance has zoomAt
      const tlForCheck = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.5 }], 1.0);
      const hasMethodZoomAt = typeof (tlForCheck as unknown as { zoomAt: unknown }).zoomAt === 'function';

      // [Step2] check source file
      const bpmSrcCheck = fs.readFileSync('src/audio/bpmTimeline.ts', 'utf-8');
      const hasZoomEntriesDef = bpmSrcCheck.includes('zoomEntries');
      const hasZoomAtDef = bpmSrcCheck.includes('zoomAt(beat');
      const hasBaseDerivation = bpmSrcCheck.includes('firstSection') || bpmSrcCheck.includes('Derived from the first');

      // [Step3] assert
      expect(hasMethodZoomAt).toBe(true);
      expect(hasZoomEntriesDef).toBe(true);
      expect(hasZoomAtDef).toBe(true);
      expect(hasBaseDerivation).toBe(true);
      expect(tlForCheck.zoomAt(0.37)).toBeCloseTo(1.5, 5);
    });

    it('autosave.ts が chart.bpm / scroll_speed を参照しない (3-step)', () => {
      // [Step1] read autosave file
      const srcAutosave = fs.readFileSync('src/chart/autosave.ts', 'utf-8');
      const hasLegacyBpmA = /chart\.bpm(?!_changes)/.test(srcAutosave);
      const hasScrollA = /scroll_speed/.test(srcAutosave);
      const hasChartToTomlUse = srcAutosave.includes('chartToToml');
      const hasParseChartUse = srcAutosave.includes('parseChartText');

      // [Step2] also check that autosave stores TOML via chartToToml (new format)
      expect(hasChartToTomlUse).toBe(true);
      expect(hasParseChartUse).toBe(true);

      // [Step3] legacy must be absent
      expect(hasLegacyBpmA).toBe(false);
      expect(hasScrollA).toBe(false);
    });

    it('loader.ts と serialize.ts が [[sections]] のみを扱い旧scroll_speedを捨てる (3-step)', () => {
      // [Step1] read loader and serialize
      const srcLoader = fs.readFileSync('src/chart/loader.ts', 'utf-8');
      const srcSerialize = fs.readFileSync('src/chart/serialize.ts', 'utf-8');

      // [Step2] check patterns
      const loaderDiscardsScroll = srcLoader.includes('scroll_speed') && srcLoader.includes('read-and-discarded');
      const loaderReadsSections = srcLoader.includes('sections');
      const loaderLegacyAlias = srcLoader.includes('bpm_changes');
      const serializeUsesSections = srcSerialize.includes('[[sections]]');
      const serializeNoOldHeader = !srcSerialize.includes('[[bpm_changes]]');

      // [Step3] assert
      expect(loaderReadsSections).toBe(true);
      expect(loaderLegacyAlias).toBe(true);
      expect(loaderDiscardsScroll).toBe(true);
      expect(serializeUsesSections).toBe(true);
      expect(serializeNoOldHeader).toBe(true);
      expect(hasSingleBpmLine(srcSerialize)).toBe(false);
      expect(hasScrollSpeedLine(srcSerialize)).toBe(false);
    });

    it('Chart型が bpm / scroll_speed を持たず bpm_changes[].zoom を持つ (3-step)', () => {
      // [Step1] read types.ts
      const srcTypes = fs.readFileSync('src/types.ts', 'utf-8');
      const hasBpmInChart = /interface Chart[\s\S]*?\bbpm\s*:/.test(srcTypes);
      const hasScrollInChart = /interface Chart[\s\S]*?scroll_speed/.test(srcTypes);
      const hasZoomInBpmChange = /interface BpmChange[\s\S]*?zoom\?/.test(srcTypes);
      const hasAmplitudeInBpmChange = /interface BpmChange[\s\S]*?amplitude\?/.test(srcTypes);

      // [Step2] also check BpmChange has beat/bpm
      const hasBeatInBpmChange = /interface BpmChange[\s\S]*?beat\s*:/.test(srcTypes);

      // [Step3] assert
      expect(hasBpmInChart).toBe(false);
      expect(hasScrollInChart).toBe(false);
      expect(hasZoomInBpmChange).toBe(true);
      expect(hasAmplitudeInBpmChange).toBe(true);
      expect(hasBeatInBpmChange).toBe(true);
    });
  });

  // ======================================================================
  // 6) 総合: autosave往復→BpmTimeline時変で数値整合 (複雑amp+off-grid)
  // ======================================================================
  describe('6. 総合回帰 — autosave往復後のchartでBpmTimeline数値整合 (複雑amp+off-grid)', () => {
    it('autosave往復後のchartで amplitudeAt/zoomAt と beatToMs が物理整合 (3-step)', () => {
      // [Step1: Capture] simple chart autosave before complex
      const simpleChartForTimeline: Chart = {
        title: 'SimpleTL',
        artist: '',
        audio: 's.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const simpleInfo = saveAutosave(simpleChartForTimeline);
      const simpleLoaded = loadAutosave(simpleInfo.slug);
      const simpleTl = makeTimeline(simpleLoaded.bpm_changes, simpleLoaded.amplitude);
      expect(simpleTl.bpmAt(0.37)).toBeCloseTo(120, 5);
      clearAllAutosaves();

      // [Step2: Perform] complex off-grid multi-section chart autosave
      const complexChartForTl: Chart = {
        title: 'ComplexTL 0.37',
        artist: '',
        audio: 'c.flac',
        audio_offset: 0,
        amplitude: 0.7,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.7 },
          { beat: 2, bpm: 150, amplitude: 1.3, zoom: 1.3 },
          { beat: 4.37, bpm: 180, amplitude: 2.7, zoom: 2.7 },
        ],
        segments: [{ direction: 'up', beats: 1 }],
        rings: [{ beat: 1.23 }],
      } as unknown as Chart;
      const complexInfo = saveAutosave(complexChartForTl);
      const loadedComplex = loadAutosave(complexInfo.slug);
      const tlComplex = makeTimeline(loadedComplex.bpm_changes, loadedComplex.amplitude);

      // [Step3: Assert] amplitudeAt/zoomAt step and beatToMs correct after round-trip
      expect(tlComplex.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
      expect(tlComplex.zoomAt(0.37)).toBeCloseTo(0.7, 5);
      expect(tlComplex.amplitudeAt(2.37)).toBeCloseTo(1.3, 5);
      expect(tlComplex.zoomAt(2.37)).toBeCloseTo(1.3, 5);
      expect(tlComplex.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);
      expect(tlComplex.zoomAt(4.37)).toBeCloseTo(2.7, 5);
      // off-grid boundary exactly at 4.37
      expect(tlComplex.amplitudeAt(4.36)).toBeCloseTo(1.3, 5);
      expect(tlComplex.zoomAt(4.36)).toBeCloseTo(1.3, 5);
      // beatToMs derived from first section 120 until beat 2, then 150
      const ms120 = 60000 / 120;
      const ms150 = 60000 / 150;
      const ms180 = 60000 / 180;
      expect(tlComplex.beatToMs(1.23)).toBeCloseTo(ms120 * 1.23, 2);
      expect(tlComplex.beatToMs(2.37)).toBeCloseTo(ms120 * 2 + ms150 * 0.37, 2);
      expect(tlComplex.beatToMs(4.37)).toBeCloseTo(ms120 * 2 + ms150 * 2.37, 2);
      expect(tlComplex.beatToMs(5.37)).toBeCloseTo(ms120 * 2 + ms150 * 2.37 + ms180 * 1, 2);
      // scrollSpeed integration
      expect(110 * tlComplex.zoomAt(0.37)).toBeCloseTo(77, 5);
      expect(110 * tlComplex.zoomAt(2.37)).toBeCloseTo(143, 5);
      expect(110 * tlComplex.zoomAt(4.37)).toBeCloseTo(297, 5);
    });

    it('autosave往復で audio_offset / start_position / end_beat 等が維持される (3-step)', () => {
      // [Step1] chart before with audio_offset etc
      const chartWithMeta: Chart = {
        title: 'MetaSong',
        artist: 'MetaArtist',
        audio: '/rhythm_game/audio/test.flac',
        audio_offset: 123,
        amplitude: 1.5,
        start_position: 0.5,
        end_beat: 64,
        bpm_changes: [{ beat: 0, bpm: 120, zoom: 1.5 }],
        segments: [{ direction: 'down', beats: 2 }],
        rings: [{ beat: 4 }],
      } as unknown as Chart;
      const infoMeta = saveAutosave(chartWithMeta);
      const loadedMeta = loadAutosave(infoMeta.slug);

      // [Step2] perform check via loaded
      // [Step3] assert meta preserved
      expect(loadedMeta.audio_offset).toBeCloseTo(123, 5);
      expect(loadedMeta.amplitude).toBeCloseTo(1.5, 5);
      expect(loadedMeta.start_position).toBeCloseTo(0.5, 5);
      expect(loadedMeta.end_beat).toBeCloseTo(64, 5);
      expect(loadedMeta.title).toBe('MetaSong');
      expect(loadedMeta.artist).toBe('MetaArtist');
      expect((loadedMeta as BpmChange as unknown as Chart).bpm_changes[0].zoom).toBeDefined();
    });

    it('削除と再保存でスロットが正しく更新される (3-step)', () => {
      // [Step1: Capture] save two songs
      const chartA: Chart = {
        title: 'Song A',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120, zoom: 1.0 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const chartB: Chart = {
        title: 'Song B',
        artist: '',
        audio: 'b.flac',
        audio_offset: 0,
        amplitude: 2.0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 150, zoom: 2.0 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const infoA = saveAutosave(chartA);
      const infoB = saveAutosave(chartB);
      expect(listAutosaves().length).toBe(2);

      // [Step2: Perform] delete A
      deleteAutosave(infoA.slug);
      const afterDeleteList = listAutosaves();

      // [Step3: Assert]
      expect(afterDeleteList.length).toBe(1);
      expect(afterDeleteList[0].slug).toBe(infoB.slug);
      const loadedB = loadAutosave(infoB.slug);
      expect((loadedB.bpm_changes[0] as BpmChange).zoom).toBeCloseTo(2.0, 5);
      expect(loadedB.bpm_changes[0].bpm).toBeCloseTo(150, 5);
    });
  });
});
