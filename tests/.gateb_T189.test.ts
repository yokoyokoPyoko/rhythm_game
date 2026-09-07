/**
 * T189 — エディタ状態のbpm/scrollSpeed除去＋初期セクション Vitest pure acceptance
 * node environment — pure engine/math + static source verification, TDD Red->Green
 *
 * 完了条件:
 *  (1) 編集・復元・クリア・TOML入出力で bpm・scroll_speed が出現しない
 *  (2) 新規譜面が先頭セクション1行 [{beat:0,bpm:120}] から始まる
 *  (3) tsc --noEmit (implicit via import)
 *
 * 方針: Actionable Fix Prescriptions に従い sections 1-3 は
 *  currentファイルの直接assertのみ（before/after captureパターン禁止）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { TW_CENTER_Y } from '../src/game/waveEngine';
import { WaveEngine } from '../src/game/waveEngine';
import type { BpmChange, Chart } from '../src/types';
import * as fs from 'fs';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helpers — distinct names, no shadowing
function makeTimelineFromChanges(changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as unknown as { new(changes: BpmChange[], baseAmp: number): BpmTimeline })(changes, baseAmp);
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

describe('T189 エディタ状態のbpm/scrollSpeed除去＋初期セクション — Vitest pure', () => {
  // ======================================================================
  // 1) EditorScreen.tsx: useState for bpm/scrollSpeed が存在しない
  //    (direct assertion on current file, no before/after capture)
  // ======================================================================
  describe('1. EditorScreen.tsx から bpm/scrollSpeed の useState 除去', () => {
    it('EditorScreen.tsx に base bpm / scrollSpeed の useState が存在しない', () => {
      const src = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      // base bpm: const [bpm, setBpm] / useState<number>(120) etc — but bpmChanges is allowed
      // Must not have standalone base bpm state: search for useState with bpm name not bpmChanges
      const hasBaseBpmState = /const\s*\[\s*bpm\s*,/.test(src);
      const hasSetBpmState = /const\s*\[\s*setBpm/.test(src);
      // scrollSpeed state
      const hasScrollSpeedState = /const\s*\[\s*scrollSpeed\s*,/.test(src);
      const hasSetScrollSpeed = /setScrollSpeed/.test(src);
      // more generic: useState with scroll_speed string
      const hasScrollSpeedString = src.includes('scrollSpeed') && /useState/.test(src) && /scrollSpeed/.test(src);
      // Verify no standalone base bpm variable besides bpmChanges
      // Allow bpmChanges, but not "const [bpm" without "bpmChanges"
      expect(hasBaseBpmState).toBe(false);
      expect(hasSetBpmState).toBe(false);
      expect(hasScrollSpeedState).toBe(false);
      // setScrollSpeed should not appear at all (commit history shows it was removed)
      expect(hasSetScrollSpeed).toBe(false);
      // Ensure no legacy string "scroll_speed" in EditorScreen (except comments about ignore)
      // The file may mention scroll_speed in comments about legacy ignore, but not as state/prop
      // We check for scroll_speed as a state/prop key: "scroll_speed" assignment
      // Allow comment mentions but not code: check not in useState/set
      const scrollSpeedUseStatePattern = /useState[^;]*scroll/i;
      expect(scrollSpeedUseStatePattern.test(src)).toBe(false);
    });

    it('EditorScreen.tsx の buildChart が bpm / scroll_speed を含まない', () => {
      const src = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      const buildChartSection = src.slice(src.indexOf('const buildChart'), src.indexOf('const buildChart') + 2000);
      // buildChart return object should not contain bpm: or scroll_speed:
      expect(buildChartSection).not.toMatch(/^\s*bpm\s*:/m);
      expect(buildChartSection).not.toMatch(/scroll_speed/);
      // Should contain bpm_changes, amplitude, audio_offset, start_position etc.
      expect(buildChartSection).toContain('bpm_changes');
      expect(buildChartSection).toContain('amplitude');
    });

    it('EditorScreen.tsx の importChart が bpm / scroll_speed を扱わない', () => {
      const src = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      const importIdx = src.indexOf('const importChart');
      const importSection = src.slice(importIdx, importIdx + 2000);
      expect(importSection).not.toMatch(/setBpm\s*\(/);
      expect(importSection).not.toMatch(/setScrollSpeed/);
      expect(importSection).not.toContain('scroll_speed');
      // Should set bpmChanges via setBpmChanges(chart.bpm_changes)
      expect(importSection).toContain('setBpmChanges');
      expect(importSection).toContain('chart.bpm_changes');
    });
  });

  // ======================================================================
  // 2) bpmChanges 初期値が [{beat:0,bpm:120}] の1行
  // ======================================================================
  describe('2. 新規譜面初期セクション [{beat:0,bpm:120}] 1行', () => {
    it('bpmChanges の useState 初期値が [{beat:0,bpm:120}]', () => {
      const src = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      // Direct assertion: must contain exact initial
      const hasInitial = src.includes('useState<BpmChange[]>([{ beat: 0, bpm: 120 }]') || src.includes("useState<BpmChange[]>([{beat:0,bpm:120}]") || src.includes('[{ beat: 0, bpm: 120 }]');
      expect(hasInitial).toBe(true);
      // Ensure not empty array or different value
      expect(src).not.toMatch(/useState<BpmChange\[]>\(\[\]\)/);
      // Must not be bpm-based initial like [{beat:0,bpm: bpm}]
      expect(src).toContain('[{ beat: 0, bpm: 120 }]');
    });

    it('clearAll が bpmChanges を [{beat:0,bpm:120}] にリセット', () => {
      const src = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      const clearIdx = src.indexOf('const clearAll');
      const clearSection = src.slice(clearIdx, clearIdx + 2000);
      expect(clearSection).toContain('setBpmChanges([{ beat: 0, bpm: 120 }]');
      // Must clear rings/segments as well
      expect(clearSection).toContain('setRings([])');
      expect(clearSection).toContain('setSegments([])');
    });

    it('BpmTimeline が初期セクション 120 BPM で beatToMs/msToBeat が正しい off-grid', () => {
      const initialChanges: BpmChange[] = [{ beat: 0, bpm: 120 }];
      const timelineInstance = makeTimelineFromChanges(initialChanges, 1.0);
      const beatMs120 = 60000 / 120; // 500
      expect(timelineInstance.bpmAt(0)).toBeCloseTo(120, 5);
      expect(timelineInstance.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(timelineInstance.bpmAt(1.23)).toBeCloseTo(120, 5);
      expect(timelineInstance.beatToMs(1)).toBeCloseTo(beatMs120, 2);
      expect(timelineInstance.beatToMs(0.37)).toBeCloseTo(beatMs120 * 0.37, 2);
      expect(timelineInstance.beatToMs(1.23)).toBeCloseTo(beatMs120 * 1.23, 2);
      expect(timelineInstance.msToBeat(beatMs120 * 0.37)).toBeCloseTo(0.37, 4);
      expect(timelineInstance.msToBeat(beatMs120 * 1.23)).toBeCloseTo(1.23, 4);
    });

    it('WaveEngine が初期セクションで正しく動作し getPoints 長さが segments+1', () => {
      const initialChanges: BpmChange[] = [{ beat: 0, bpm: 120 }];
      const timelineForWave = makeTimelineFromChanges(initialChanges, 1.0);
      const engineInstance = new WaveEngine([{ direction: 'up', beats: 2 }], timelineForWave, 1.0, 0.0);
      const pts = engineInstance.getPoints();
      expect(pts.length).toBe(2); // 1 segment + 1
      // waveYAt at beat 0 is center (start_position 0)
      expect(engineInstance.waveYAt(0)).toBeCloseTo(TW_CENTER_Y as number, 2);
    });
  });

  // ======================================================================
  // 3) BpmEditor props interface に bpm / scrollSpeed が無い
  // ======================================================================
  describe('3. BpmEditor props から bpm/scrollSpeed 除去', () => {
    it('BpmEditor.tsx の Props interface が bpm/scrollSpeed/onBpmChange/onScrollSpeedChange を含まない', () => {
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      const propsIdx = src.indexOf('interface BpmEditorProps');
      const propsSection = src.slice(propsIdx, propsIdx + 800);
      expect(propsSection).not.toMatch(/\bbpm\s*:/);
      expect(propsSection).not.toMatch(/scrollSpeed/);
      expect(propsSection).not.toMatch(/scroll_speed/);
      expect(propsSection).not.toMatch(/onBpmChange/);
      expect(propsSection).not.toMatch(/onScrollSpeedChange/);
      // Must have correct props: bpmChanges, onSectionsChange, amplitude, onAmplitudeChange
      expect(propsSection).toContain('bpmChanges');
      expect(propsSection).toContain('onSectionsChange');
      expect(propsSection).toContain('amplitude');
      expect(propsSection).toContain('onAmplitudeChange');
      // startPosition / endBeat are still present
      expect(propsSection).toContain('startPosition');
      expect(propsSection).toContain('endBeat');
    });

    it('EditorScreen が BpmEditor に bpmChanges/onSectionsChange を渡し legacy props を渡さない', () => {
      const src = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      const bpmEditorUsageIdx = src.indexOf('<BpmEditor');
      const usage = src.slice(bpmEditorUsageIdx, bpmEditorUsageIdx + 1000);
      expect(usage).toContain('bpmChanges={bpmChanges}');
      expect(usage).toContain('onSectionsChange={setBpmChanges}');
      expect(usage).not.toContain('bpm={');
      expect(usage).not.toContain('scrollSpeed');
      expect(usage).not.toContain('onBpmChange');
      expect(usage).not.toContain('onScrollSpeedChange');
      // amplitude injection is still passed
      expect(usage).toContain('amplitude={amplitude}');
    });

    it('BpmEditor の入力欄に bpm 単体入力や scrollSpeed 入力が存在しない', () => {
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      // Should not have standalone bpm input outside bpmChanges list, nor scroll_speed input
      // Count amplitude inputs: there is main amplitude + per-entry amplitude, but no base bpm input
      const hasBaseBpmInput = /id\s*=\s*["']bpm["']/.test(src);
      const hasScrollSpeedInput = /scroll/i.test(src) && /scroll_speed|scrollSpeed/.test(src);
      expect(hasBaseBpmInput).toBe(false);
      expect(hasScrollSpeedInput).toBe(false);
      // Must have amplitude injection field
      expect(src).toContain('id="amplitude"');
    });
  });

  // ======================================================================
  // 4) TOML入出力で bpm・scroll_speed が出現しない (完了条件1)
  // ======================================================================
  describe('4. TOML入出力で bpm / scroll_speed 単一行が出ない (完了条件1)', () => {
    it('chartToToml が bpm= / scroll_speed= 単一行を出力しない', () => {
      const chartData: Chart = {
        title: 'NoLegacy',
        artist: '',
        audio: 'test.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const tomlOut = chartToToml(chartData as unknown as Chart);
      expect(hasSingleBpmLine(tomlOut)).toBe(false);
      expect(hasScrollSpeedLine(tomlOut)).toBe(false);
      expect(tomlOut).toContain('[[sections]]');
      expect(tomlOut).not.toContain('[[bpm_changes]]');
      // Ensure single-line bpm not before sections
      const lines = tomlOut.split('\n');
      const beforeSections = lines.slice(0, lines.findIndex(l => l.trim() === '[[sections]]'));
      expect(beforeSections.some(l => l.trim().startsWith('bpm'))).toBe(false);
      expect(beforeSections.some(l => l.trim().startsWith('scroll_speed'))).toBe(false);
    });

    it('複雑 zoom/amplitude 混在でも単一行 bpm/scroll_speed が出ない off-grid', () => {
      const complexChart: Chart = {
        title: 'Complex',
        artist: 'T',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.5,
        start_position: 0.5,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, zoom: 1.0 },
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 2.0 },
          { beat: 8.25, bpm: 140, zoom: 0.5 },
        ],
        segments: [{ direction: 'down', beats: 2 }],
        rings: [{ beat: 4.37 }],
      } as unknown as Chart;
      const tomlComplex = chartToToml(complexChart as unknown as Chart);
      expect(hasSingleBpmLine(tomlComplex)).toBe(false);
      expect(hasScrollSpeedLine(tomlComplex)).toBe(false);
      // zoom and amplitude lines must appear for entries that have them
      expect(tomlComplex).toContain('zoom = 1');
      expect(tomlComplex).toContain('zoom = 2');
      expect(tomlComplex).toContain('amplitude = 1');
      // round-trip preserves
      const parsedBack = parseChartText(tomlComplex);
      expect(parsedBack.bpm_changes.length).toBe(3);
      expect(parsedBack.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect((parsedBack.bpm_changes[1] as unknown as { zoom: number }).zoom).toBeCloseTo(2.0, 3);
    });

    it('parseChartText が旧 bpm 単一行 + scroll_speed を無視し sections にマイグレーション', () => {
      const oldToml = `
title = "Old"
artist = ""
bpm = 135
audio = "a.flac"
scroll_speed = 999
audio_offset = 0
amplitude = 1.0
[[bpm_changes]]
beat = 64
bpm = 150
`;
      const parsedOld = parseChartText(oldToml);
      expect((parsedOld as unknown as { bpm: unknown }).bpm).toBeUndefined();
      expect((parsedOld as unknown as { scroll_speed: unknown }).scroll_speed).toBeUndefined();
      // legacy bpm 135 should become section at beat 0 if no beat0 exists
      expect(parsedOld.bpm_changes.some(c => c.beat === 0 && c.bpm === 135)).toBe(true);
      expect(parsedOld.bpm_changes.some(c => c.beat === 64 && c.bpm === 150)).toBe(true);
      // re-serialize must not contain legacy lines
      const reserialized = chartToToml(parsedOld as unknown as Chart);
      expect(hasSingleBpmLine(reserialized)).toBe(false);
      expect(hasScrollSpeedLine(reserialized)).toBe(false);
    });

    it('TOML往復 off-grid beat 0.37/1.23 で bpm_changes が保持される', () => {
      const offGridChart: Chart = {
        title: 'OffGrid',
        artist: '',
        audio: 's.flac',
        audio_offset: 10,
        amplitude: 1.2,
        start_position: 0.0,
        bpm_changes: [
          { beat: 0.37, bpm: 123.456, amplitude: 0.7, zoom: 0.75 },
          { beat: 1.23, bpm: 178.9, amplitude: 3.4, zoom: 1.33 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const tomlOff = chartToToml(offGridChart as unknown as Chart);
      expect(hasSingleBpmLine(tomlOff)).toBe(false);
      const parsedOff = parseChartText(tomlOff);
      expect(parsedOff.bpm_changes[0].beat).toBeCloseTo(0.37, 3);
      expect(parsedOff.bpm_changes[1].beat).toBeCloseTo(1.23, 3);
      expect(parsedOff.bpm_changes[0].bpm).toBeCloseTo(123.456, 3);
      expect((parsedOff.bpm_changes[0] as unknown as { zoom: number }).zoom).toBeCloseTo(0.75, 3);
    });
  });

  // ======================================================================
  // 5) セクション0件時のマイグレーション
  // ======================================================================
  describe('5. セクション0件時のマイグレーション', () => {
    it('TOML に sections/bpm_changes が無い場合 [{beat:0,bpm:120}] にフォールバック', () => {
      const emptyToml = `
title = "Empty"
artist = ""
audio = "e.flac"
`;
      const parsedEmpty = parseChartText(emptyToml);
      expect(parsedEmpty.bpm_changes.length).toBe(1);
      expect(parsedEmpty.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedEmpty.bpm_changes[0].bpm).toBeCloseTo(120, 5);
      expect((parsedEmpty as unknown as { bpm: unknown }).bpm).toBeUndefined();
    });

    it('legacy bpm 単一行のみの場合、それが beat0 セクションに移行', () => {
      const legacyToml = `
title = "LegacyBpm"
artist = ""
bpm = 142
audio = "e.flac"
`;
      const parsedLegacy = parseChartText(legacyToml);
      expect(parsedLegacy.bpm_changes.length).toBe(1);
      expect(parsedLegacy.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedLegacy.bpm_changes[0].bpm).toBeCloseTo(142, 5);
    });

    it('既に sections がある場合、余分な beat0 120 が挿入されない', () => {
      const withSectionToml = `
title = "With"
artist = ""
audio = "e.flac"
[[sections]]
beat = 0
bpm = 150
[[sections]]
beat = 8
bpm = 180
zoom = 2
`;
      const parsedWith = parseChartText(withSectionToml);
      expect(parsedWith.bpm_changes.length).toBe(2);
      expect(parsedWith.bpm_changes[0].bpm).toBeCloseTo(150, 5);
      expect(parsedWith.bpm_changes[1].beat).toBeCloseTo(8, 5);
    });
  });

  // ======================================================================
  // 6) Chart 型から bpm / scroll_speed 削除確認
  // ======================================================================
  describe('6. Chart 型から bpm / scroll_speed 廃止', () => {
    it('parseChartText が返す Chart に bpm / scroll_speed プロパティが存在しない', () => {
      const tomlSample = `
title = "NoSingle"
artist = ""
audio = "n.flac"
[[sections]]
beat = 0
bpm = 135
zoom = 1.2
`;
      const chartSample = parseChartText(tomlSample);
      expect((chartSample as unknown as { bpm: unknown }).bpm).toBeUndefined();
      expect((chartSample as unknown as { scroll_speed: unknown }).scroll_speed).toBeUndefined();
      expect('bpm' in chartSample ? (chartSample as unknown as { bpm: unknown }).bpm : undefined).toBeUndefined();
    });

    it('src/types.ts の Chart interface が bpm / scroll_speed を定義しない', () => {
      const typesSrc = fs.readFileSync('src/types.ts', 'utf-8');
      const chartInterfaceIdx = typesSrc.indexOf('export interface Chart');
      const chartSection = typesSrc.slice(chartInterfaceIdx, chartInterfaceIdx + 600);
      // Must not contain "bpm:" as property (but bpm_changes is allowed)
      // Check for standalone "bpm:" not followed by "_changes"
      expect(/^\s*bpm\s*:/m.test(chartSection) || chartSection.includes('bpm: number') && !chartSection.includes('bpm_changes')).toBe(false);
      // More precise: ensure no "bpm?:", "bpm :", "scroll_speed"
      expect(chartSection).not.toMatch(/\n\s*bpm\s*\??:/);
      expect(chartSection).not.toContain('scroll_speed');
      expect(chartSection).not.toContain('scrollSpeed');
      expect(chartSection).toContain('bpm_changes');
      expect(chartSection).toContain('amplitude');
    });
  });

  // ======================================================================
  // 7) BpmTimeline が初期セクションから正しく 120 を導出 — off-grid & numeric
  // ======================================================================
  describe('7. BpmTimeline 初期セクション整合 off-grid 数値検証', () => {
    it('初期 [{beat:0,bpm:120}] で zoomAt 未設定は 1.0, scrollSpeed 110', () => {
      const initChanges: BpmChange[] = [{ beat: 0, bpm: 120 }];
      const initTimeline = makeTimelineFromChanges(initChanges, 1.0);
      expect(initTimeline.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(initTimeline.zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect(initTimeline.zoomAt(1.23)).toBeCloseTo(1.0, 5);
      const scrollAt037 = 110 * initTimeline.zoomAt(0.37);
      const scrollAt123 = 110 * initTimeline.zoomAt(1.23);
      expect(scrollAt037).toBeCloseTo(110, 5);
      expect(scrollAt123).toBeCloseTo(110, 5);
    });

    it('複雑 amplitude 0.7/1.3/2.7 と off-grid 0.37/1.23 で timeline が正確', () => {
      const complexChanges: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 2, bpm: 150, amplitude: 1.3 },
        { beat: 4.37, bpm: 180, amplitude: 2.7 },
      ];
      const timelineComplex = makeTimelineFromChanges(complexChanges, 1.0);
      // bpmAt off-grid
      expect(timelineComplex.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(timelineComplex.bpmAt(2.37)).toBeCloseTo(150, 5);
      expect(timelineComplex.bpmAt(4.37)).toBeCloseTo(180, 5);
      expect(timelineComplex.bpmAt(4.73)).toBeCloseTo(180, 5);
      // amplitudeAt step
      expect(timelineComplex.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
      expect(timelineComplex.amplitudeAt(1.23)).toBeCloseTo(0.7, 5);
      expect(timelineComplex.amplitudeAt(2.37)).toBeCloseTo(1.3, 5);
      expect(timelineComplex.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);
      // beatToMs numeric
      const ms120 = 500;
      const ms150 = 400;
      expect(timelineComplex.beatToMs(1.23)).toBeCloseTo(ms120 * 1.23, 2);
      expect(timelineComplex.beatToMs(2.37)).toBeCloseTo(ms120 * 2 + ms150 * 0.37, 2);
    });
  });

  // ======================================================================
  // 8) 回帰: T186/T187/T188 の重要不変量が維持されている
  // ======================================================================
  describe('8. 回帰 — T186/T187/T188 不変量維持', () => {
    it('旧 [[bpm_changes]] エイリアスが読める', () => {
      const oldBpmChangesToml = `
title = "OldAlias"
artist = ""
audio = "test.flac"
[[bpm_changes]]
beat = 4
bpm = 150
amplitude = 1.3
`;
      const parsedAlias = parseChartText(oldBpmChangesToml);
      expect(parsedAlias.bpm_changes.length).toBe(1);
      expect(parsedAlias.bpm_changes[0].beat).toBeCloseTo(4, 5);
      expect(parsedAlias.bpm_changes[0].bpm).toBeCloseTo(150, 5);
      expect(parsedAlias.bpm_changes[0].amplitude).toBeCloseTo(1.3, 5);
    });

    it('autosave 由来の TOML 往復でも bpm/scroll_speed が出ない', () => {
      // Simulate autosave chart via buildChart shape
      const autosaveChart: Chart = {
        title: 'AutosaveTest',
        artist: 'A',
        audio: 'a.flac',
        audio_offset: 5,
        amplitude: 1.0,
        start_position: 0.0,
        bpm_changes: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 150, zoom: 2.0 }],
        segments: [{ direction: 'up', beats: 2 }],
        rings: [{ beat: 2 }],
      } as unknown as Chart;
      const tomlAutosave = chartToToml(autosaveChart as unknown as Chart);
      expect(hasSingleBpmLine(tomlAutosave)).toBe(false);
      expect(hasScrollSpeedLine(tomlAutosave)).toBe(false);
      const reparsedAutosave = parseChartText(tomlAutosave);
      expect(reparsedAutosave.bpm_changes.length).toBe(2);
      expect((reparsedAutosave.bpm_changes[1] as unknown as { zoom: number }).zoom).toBeCloseTo(2.0, 5);
    });
  });
});
