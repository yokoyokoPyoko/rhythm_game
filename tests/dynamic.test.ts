/**
 * T188 — ゲーム側のchart.bpm参照除去＋時変スクロール反映 Vitest pure acceptance
 * node environment — no DOM, pure engine math, off-grid verification
 * TDD Red: must FAIL before fix (GameScreen/CalibrationModal still hardcode scrollSpeed:110)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { BpmChange } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helpers: new signature (bpmChanges, baseAmplitude)
function tlDerived(changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(changes, baseAmp) as BpmTimeline;
}
function tlLegacy(baseBpm: number, changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(baseBpm, changes, baseAmp) as BpmTimeline;
}

const TW_JUDGE_X = Math.round(800 * 0.26);
const DEFAULT_SCROLL = 110;

describe('T188 ゲーム側chart.bpm参照除去＋時変スクロール反映 — Vitest pure engine', () => {
  // ======================================================================
  // 1) zoom値で流速が変わる (完了条件1) — 3-step state-transition
  // ======================================================================
  describe('1. zoom値で流速が変わる — scrollSpeed = 110 * zoomAt(currentBeat)', () => {
    it('zoom未設定は1.0→scrollSpeed 110、zoom=2.0で220、0.5で55 (3-step off-grid)', () => {
      // [Step1: Capture Initial State] empty timeline default
      const before = tlDerived([], 1.0);
      const beforeZoom = (before as any).zoomAt(0.37);
      const beforeSpeed = DEFAULT_SCROLL * beforeZoom;
      expect(beforeZoom).toBeCloseTo(1.0, 5);
      expect(beforeSpeed).toBeCloseTo(110, 5);

      // [Step2: Perform] zoom 2.0 at beat 4
      const tl = tlDerived([{ beat: 4, bpm: 120, zoom: 2.0 }], 1.0);
      const zoomBefore = (tl as any).zoomAt(3.37);
      const speedBefore = DEFAULT_SCROLL * zoomBefore;
      const zoomAfter = (tl as any).zoomAt(4.23);
      const speedAfter = DEFAULT_SCROLL * zoomAfter;

      // [Step3: Assert] step at boundary
      expect(zoomBefore).toBeCloseTo(1.0, 5);
      expect(speedBefore).toBeCloseTo(110, 5);
      expect(zoomAfter).toBeCloseTo(2.0, 5);
      expect(speedAfter).toBeCloseTo(220, 5);
      // 0.5 case
      const tlHalf = tlDerived([{ beat: 2, bpm: 120, zoom: 0.5 }], 1.0);
      expect((tlHalf as any).zoomAt(2.37)).toBeCloseTo(0.5, 5);
      expect(DEFAULT_SCROLL * (tlHalf as any).zoomAt(2.37)).toBeCloseTo(55, 5);
    });

    it('複雑zoom 0.7/1.3/2.7で時変scrollSpeedがoff-gridで正しく切替 (3-step)', () => {
      // [Step1] base
      const base = tlDerived([], 1.0);
      expect(DEFAULT_SCROLL * (base as any).zoomAt(1.23)).toBeCloseTo(110, 5);

      // [Step2] multiple entries
      const changes: BpmChange[] = [
        { beat: 2, bpm: 120, zoom: 0.7 },
        { beat: 4, bpm: 130, zoom: 1.3 },
        { beat: 7.5, bpm: 140, zoom: 2.7 },
      ];
      const tl = tlDerived(changes, 1.0);

      // [Step3] off-grid checks with scrollSpeed calc
      expect((tl as any).zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(0.37)).toBeCloseTo(110, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(2.37)).toBeCloseTo(110 * 0.7, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(3.37)).toBeCloseTo(110 * 0.7, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(4.23)).toBeCloseTo(110 * 1.3, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(7.5)).toBeCloseTo(110 * 2.7, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(7.63)).toBeCloseTo(110 * 2.7, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(100)).toBeCloseTo(110 * 2.7, 5);
    });

    it('scrollSpeedの差がリングX位置に線形に反映される (3-step numeric)', () => {
      // [Step1] capture initial without zoom
      const tlBase = tlDerived([{ beat: 0, bpm: 120 }], 1.0);
      const beat = 4;
      const hitTime = tlBase.beatToMs(beat);
      const songTimeMs = tlBase.beatToMs(2); // 2 beats before hit
      const baseZoom = (tlBase as any).zoomAt(2.37);
      const baseSpeed = DEFAULT_SCROLL * baseZoom;
      const xBase = TW_JUDGE_X + ((hitTime - songTimeMs) / 1000) * baseSpeed;

      // [Step2] perform with zoom 2.0
      const tlZoom = tlDerived([{ beat: 0, bpm: 120, zoom: 2.0 }], 1.0);
      const zoom = (tlZoom as any).zoomAt(2.37);
      const speedZoom = DEFAULT_SCROLL * zoom;
      const xZoom = TW_JUDGE_X + ((hitTime - songTimeMs) / 1000) * speedZoom;

      // [Step3] assert linear scaling
      expect(zoom).toBeCloseTo(2.0, 5);
      expect(speedZoom).toBeCloseTo(220, 5);
      expect(xZoom - TW_JUDGE_X).toBeCloseTo(2 * (xBase - TW_JUDGE_X), 5);
      // half speed
      const tlHalf = tlDerived([{ beat: 0, bpm: 120, zoom: 0.5 }], 1.0);
      const halfSpeed = DEFAULT_SCROLL * (tlHalf as any).zoomAt(0.37);
      const xHalf = TW_JUDGE_X + ((hitTime - songTimeMs) / 1000) * halfSpeed;
      expect(halfSpeed).toBeCloseTo(55, 5);
      expect(xHalf - TW_JUDGE_X).toBeCloseTo(0.5 * (xBase - TW_JUDGE_X), 5);
    });

    it('毎フレーム currentBeatでzoomAtする近似がoff-grid 0.37/1.23で正しい (3-step)', () => {
      // [Step1] before no zoom
      const before = tlDerived([], 1.0);
      expect(DEFAULT_SCROLL * (before as any).zoomAt(0.37)).toBeCloseTo(110, 5);

      // [Step2] with time-varying amplitude+zoom (ensure independence)
      const changes: BpmChange[] = [
        { beat: 0, bpm: 120, zoom: 0.5, amplitude: 0.7 },
        { beat: 3, bpm: 130, zoom: 1.5, amplitude: 1.3 },
      ];
      const tl = tlDerived(changes, 1.0);
      // Simulate game loop: currentBeat = msToBeat(renderTimeMs), scrollSpeed = 110*zoomAt(currentBeat)
      const beatOffGrid1 = 0.37;
      const ms1 = tl.beatToMs(beatOffGrid1);
      const curBeat1 = tl.msToBeat(ms1);
      const speed1 = DEFAULT_SCROLL * (tl as any).zoomAt(curBeat1);
      const beatOffGrid2 = 3.37;
      const ms2 = tl.beatToMs(beatOffGrid2);
      const curBeat2 = tl.msToBeat(ms2);
      const speed2 = DEFAULT_SCROLL * (tl as any).zoomAt(curBeat2);

      // [Step3] assert
      expect(curBeat1).toBeCloseTo(0.37, 4);
      expect(speed1).toBeCloseTo(55, 5);
      expect(curBeat2).toBeCloseTo(3.37, 4);
      expect(speed2).toBeCloseTo(165, 5); // 110*1.5
      // zoom independent of amplitude
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.3, 5);
    });

    it('beat=0のzoomが即時にscrollSpeedへ反映される (3-step)', () => {
      const tl = tlDerived([{ beat: 0, bpm: 120, zoom: 1.5 }], 1.0);
      expect((tl as any).zoomAt(0)).toBeCloseTo(1.5, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(0)).toBeCloseTo(165, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(0.37)).toBeCloseTo(165, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(1.23)).toBeCloseTo(165, 5);
    });
  });

  // ======================================================================
  // 2) BpmTimeline基準BPM導出がchart.bpm無しで正しい (T187回帰, 禁止ルール)
  // ======================================================================
  describe('2. BpmTimelineは先頭セクションからbaseBpmを導出 — chart.bpm不使用', () => {
    it('空セクションは120フォールバック、beat0=180は180基準 off-grid (3-step)', () => {
      // [Step1] empty
      const empty = tlDerived([], 1.0);
      expect(empty.beatToMs(1)).toBeCloseTo(500, 2);
      expect(empty.bpmAt(0.37)).toBeCloseTo(120, 5);

      // [Step2] derived 180
      const tl180 = tlDerived([{ beat: 0, bpm: 180 }], 1.0);
      const ms180 = 60000 / 180;
      // [Step3] assert 180 not 120
      expect(tl180.bpmAt(0.37)).toBeCloseTo(180, 5);
      expect(tl180.beatToMs(1)).toBeCloseTo(ms180, 2);
      expect(tl180.beatToMs(0.37)).toBeCloseTo(ms180 * 0.37, 2);
      expect(tl180.beatToMs(1.23)).toBeCloseTo(ms180 * 1.23, 2);
      expect(tl180.msToBeat(ms180 * 0.37)).toBeCloseTo(0.37, 4);
    });

    it('未ソートsectionsでもbeat最小が基準 — [{beat4:180},{beat0:150}]=>150 (3-step)', () => {
      const sorted = tlDerived([{ beat: 0, bpm: 150 }, { beat: 4, bpm: 180 }], 1.0);
      expect(sorted.bpmAt(0)).toBeCloseTo(150, 5);
      const unsorted = tlDerived([{ beat: 4, bpm: 180 }, { beat: 0, bpm: 150 }], 1.0);
      expect(unsorted.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect(unsorted.beatToMs(0.37)).toBeCloseTo(400 * 0.37, 2);
      expect(unsorted.beatToMs(1)).toBeCloseTo(400, 2);
    });

    it('legacy overload (baseBpm, changes) は明示baseを無視しsectionsから導出 (3-step)', () => {
      const legacy = tlLegacy(120, [{ beat: 2, bpm: 150 }], 1.0);
      expect(legacy.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect(legacy.beatToMs(1)).toBeCloseTo(400, 2);
      const unsortedLegacy = tlLegacy(999, [{ beat: 4, bpm: 180 }, { beat: 0, bpm: 90 }], 1.0);
      expect(unsortedLegacy.bpmAt(0)).toBeCloseTo(90, 5);
      expect(unsortedLegacy.beatToMs(1)).toBeCloseTo(60000 / 90, 2);
    });

    it('beatToMsはセクション毎に正しいBPMで積算—off-grid 0.37/1.23混合', () => {
      const changes: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 2, bpm: 150 },
        { beat: 4.37, bpm: 180 },
      ];
      const tl = tlDerived(changes, 1.0);
      const ms120 = 500, ms150 = 400, ms180 = 60000 / 180;
      expect(tl.beatToMs(1.23)).toBeCloseTo(ms120 * 1.23, 2);
      expect(tl.beatToMs(2.37)).toBeCloseTo(ms120 * 2 + ms150 * 0.37, 2);
      expect(tl.beatToMs(4.37)).toBeCloseTo(ms120 * 2 + ms150 * 2.37, 2);
      expect(tl.beatToMs(5.37)).toBeCloseTo(ms120 * 2 + ms150 * 2.37 + ms180 * 1, 2);
      expect(tl.msToBeat(tl.beatToMs(2.37))).toBeCloseTo(2.37, 3);
    });

    it('先頭BPMが120以外でもhardcode 120が使われない — 111/137等の端数BPM (3-step)', () => {
      const tl111 = tlDerived([{ beat: 0, bpm: 111 }], 1.0);
      const ms111 = 60000 / 111;
      expect(tl111.beatToMs(0.37)).toBeCloseTo(ms111 * 0.37, 2);
      expect(tl111.beatToMs(1.23)).toBeCloseTo(ms111 * 1.23, 2);
      expect(tl111.bpmAt(0)).toBeCloseTo(111, 5);
      const tl137 = tlDerived([{ beat: 0, bpm: 137 }], 1.0);
      const ms137 = 60000 / 137;
      expect(tl137.beatToMs(2.37)).toBeCloseTo(ms137 * 2.37, 2);
    });
  });

  // ======================================================================
  // 3) ゲーム側 chart.bpm / scroll_speed 参照除去 + 時変scroll反映のソース検証
  // ======================================================================
  describe('3. GameScreen/CalibrationModalのchart.bpm参照除去＋時変scroll反映 (ソース検証)', () => {
    const gamePath = path.join(process.cwd(), 'src/screens/GameScreen.tsx');
    const calibPath = path.join(process.cwd(), 'src/screens/editor/CalibrationModal.tsx');
    const typesPath = path.join(process.cwd(), 'src/types.ts');
    const bpmTimelinePath = path.join(process.cwd(), 'src/audio/bpmTimeline.ts');

    it('GameScreen.tsxがchart.bpm / chart.scroll_speedを参照しない (3-step)', () => {
      // [Step1: Capture Before] read file
      const src = fs.readFileSync(gamePath, 'utf-8');
      const hasChartBpm = /chart\.bpm\b/.test(src) && !/chart\.bpm_changes/.test(src.replace(/chart\.bpm_changes/g, '')) ? true : /chart\.bpm(?!\s*_changes)/.test(src);
      // more precise: search for "chart.bpm" not followed by "_changes"
      const chartBpmMatches = (src.match(/chart\.bpm(?!_changes)/g) || []).length;
      const scrollSpeedMatches = (src.match(/chart\.scroll_speed/g) || []).length;
      // Also check generic scroll_speed property access
      const hasScrollSpeedProp = /scroll_speed/.test(src);

      // [Step2: Perform] — filtered counts already computed
      // [Step3: Assert] no legacy references
      expect(chartBpmMatches, `GameScreen should not contain chart.bpm (found ${chartBpmMatches}): ${src.match(/chart\.bpm(?!_changes)/g)}`).toBe(0);
      // scroll_speed should appear zero times (or only in comments about removal); we allow comments but not code: check code lines not starting with //
      const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      const code = codeLines.join('\n');
      expect((code.match(/scroll_speed/g) || []).length, 'GameScreen code should not reference scroll_speed').toBe(0);
      void hasChartBpm; void scrollSpeedMatches; void hasScrollSpeedProp;
    });

    it('GameScreen.tsxが毎フレーム scrollSpeed = 110 * timeline.zoomAt(currentBeat) を算出しrendererへ渡す (3-step)', () => {
      const src = fs.readFileSync(gamePath, 'utf-8');
      // [Step1] before: hardcoded scrollSpeed: 110 without zoomAt
      const hasHardcodedOnly = /scrollSpeed:\s*110\s*,/.test(src) && !/zoomAt/.test(src);
      // [Step2] perform: check for zoomAt pattern
      const hasZoomAt = /zoomAt\s*\(/.test(src);
      const has110TimesZoom = /110\s*\*\s*.*zoomAt|zoomAt.*\*\s*110/.test(src) || /scrollSpeed\s*=\s*110\s*\*\s*timeline\.zoomAt/.test(src) || /scrollSpeed\s*=\s*110\s*\*\s*.*zoomAt/.test(src);
      // also allow const scrollSpeed = 110 * timeline.zoomAt(currentBeat)
      const hasScrollSpeedCalc = /scrollSpeed.*110.*zoomAt/.test(src);

      // [Step3] assert correct implementation, fail if still hardcoded only
      expect(hasZoomAt, 'GameScreen must call timeline.zoomAt for scrollSpeed').toBe(true);
      expect(hasScrollSpeedCalc, `GameScreen must compute scrollSpeed = 110 * timeline.zoomAt(...), got: ${src.slice(src.indexOf('scrollSpeed') - 200, src.indexOf('scrollSpeed') + 500)}`).toBe(true);
      // Ensure renderer gets scrollSpeed variable, not literal 110 alone
      expect(hasHardcodedOnly, 'GameScreen should not hardcode scrollSpeed:110 without zoomAt').toBe(false);
      void has110TimesZoom;
    });

    it('CalibrationModal.tsxがchart.bpm参照除去＋時変scroll反映 (3-step)', () => {
      const src = fs.readFileSync(calibPath, 'utf-8');
      const chartBpmMatches = (src.match(/chart\.bpm(?!_changes)/g) || []).length;
      expect(chartBpmMatches, `CalibrationModal should not contain chart.bpm (found ${chartBpmMatches})`).toBe(0);
      const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      const code = codeLines.join('\n');
      // CalibrationModal uses generateCalibrationChart with fixed CAL_BPM, not chart.bpm — ensure no chart.bpm
      expect(chartBpmMatches).toBe(0);
      // scrollSpeed must be computed via zoomAt as well (or at least not hardcoded alone without zoomAt)
      const hasZoomAt = /zoomAt/.test(src);
      const hasScrollSpeedZoom = /scrollSpeed.*110.*zoomAt|110\s*\*\s*.*zoomAt/.test(src);
      // CalibrationModal has fixed chart but still should compute scrollSpeed = 110 * timeline.zoomAt(currentBeat) for consistency
      expect(hasZoomAt, 'CalibrationModal must use zoomAt for scrollSpeed').toBe(true);
      expect(hasScrollSpeedZoom, 'CalibrationModal must compute scrollSpeed = 110 * timeline.zoomAt(...)').toBe(true);
      // Ensure not just scrollSpeed: 110 alone
      const hasOnlyHardcoded = /scrollSpeed:\s*110\s*,/.test(src) && !/zoomAt/.test(src);
      expect(hasOnlyHardcoded).toBe(false);
      void code;
    });

    it('Chart型がbpm / scroll_speed単一値を持たない (3-step)', () => {
      const src = fs.readFileSync(typesPath, 'utf-8');
      const chartBlockMatch = src.match(/interface Chart\s*\{[^}]*\}/s);
      expect(chartBlockMatch, 'Chart interface must exist').not.toBeNull();
      const chartBlock = chartBlockMatch![0];
      // [Step1] before: Chart had bpm: number
      const hasBpmSingle = /^\s*bpm\s*:/m.test(chartBlock) || /bpm:\s*number/.test(chartBlock) && !/bpm_changes/.test(chartBlock.replace('bpm_changes',''));
      // More precise: chart block should not have line "bpm:" that is not bpm_changes
      const bpmLines = chartBlock.split('\n').filter(l => /^\s*bpm\s*:/.test(l) || /\bbpm\s*:\s*number/.test(l));
      const nonChangesBpm = bpmLines.filter(l => !l.includes('bpm_changes'));
      const hasScrollSpeed = /scroll_speed/.test(chartBlock);
      expect(nonChangesBpm.length, `Chart should not have bpm single value, found: ${nonChangesBpm.join(', ')}`).toBe(0);
      expect(hasScrollSpeed, 'Chart should not have scroll_speed').toBe(false);
    });

    it('BpmTimelineがzoomAtを持つかつbaseBpmをsectionsから導出 (3-step)', () => {
      const src = fs.readFileSync(bpmTimelinePath, 'utf-8');
      expect(/zoomAt\s*\(/.test(src), 'BpmTimeline must have zoomAt method').toBe(true);
      expect(/zoomEntries/.test(src), 'BpmTimeline must have zoomEntries').toBe(true);
      // Ensure not hardcoding 120 when sections exist — check that baseBpm derived from first section
      expect(/firstSection/.test(src) || /changes\[0\]/.test(src), 'BpmTimeline should derive baseBpm from first section').toBe(true);
      // Ensure not just "baseBpm = 120" without conditional
      const hasDerived = /sanitizeBpm\(firstSection/.test(src) || /firstSection \? firstSection\.bpm/.test(src);
      expect(hasDerived, 'BpmTimeline baseBpm must be derived from first section bpm, not hardcoded 120').toBe(true);
    });

    it('BpmTimelineコンストラクタがbpmChanges配列を第一引数に取る (禁止ルール: baseBpm先頭を廃止)', () => {
      // [Step1] try new signature — should work
      const tlNew = tlDerived([{ beat: 0, bpm: 180 }], 1.0);
      expect(tlNew.bpmAt(0)).toBeCloseTo(180, 5);
      expect(tlNew.beatToMs(1)).toBeCloseTo(60000/180, 2);
      // [Step2] legacy signature with explicit base 120 but sections 150 — must ignore base and use 150
      const tlLegacy = tlLegacy(120, [{ beat: 0, bpm: 150 }], 1.0);
      expect(tlLegacy.bpmAt(0)).toBeCloseTo(150, 5);
      expect(tlLegacy.beatToMs(0.37)).toBeCloseTo(400*0.37, 2);
      // [Step3] verify not falling back to 1 BPM (which old ctor would if first arg array misinterpreted)
      const tl = tlDerived([{ beat: 0, bpm: 90 }], 1.0);
      expect(tl.beatToMs(1)).not.toBeCloseTo(60000, -1); // not 60000 (MIN_BPM=1 fallback would be 60000)
      expect(tl.beatToMs(1)).toBeCloseTo(60000/90, 2);
    });
  });

  // ======================================================================
  // 4) zoomAtとBPMの相互非干渉 + scrollSpeedの積算がBPMに影響しない
  // ======================================================================
  describe('4. zoomとBPMの相互非干渉 — scrollSpeedは表示のみ、BPM計算不変', () => {
    it('zoom変更がbeatToMs/msToBeatに影響しない (3-step)', () => {
      const withoutZoom = tlDerived([{ beat: 0, bpm: 150 }], 1.0);
      const withZoom = tlDerived([{ beat: 0, bpm: 150, zoom: 2.5 }], 1.0);
      expect(withZoom.beatToMs(1)).toBeCloseTo(withoutZoom.beatToMs(1), 5);
      expect(withZoom.beatToMs(0.37)).toBeCloseTo(withoutZoom.beatToMs(0.37), 5);
      expect(withZoom.beatToMs(1.23)).toBeCloseTo(withoutZoom.beatToMs(1.23), 5);
      expect(withZoom.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect((withZoom as any).zoomAt(0.37)).toBeCloseTo(2.5, 5);
      expect((withoutZoom as any).zoomAt(0.37)).toBeCloseTo(1.0, 5);
    });

    it('BPMとzoomが同一beatで同時ステップしても両方正しく切替 (3-step)', () => {
      const tl = tlDerived([{ beat: 0, bpm: 120, zoom: 1.0 }, { beat: 4, bpm: 150, zoom: 2.0 }], 1.0);
      expect(tl.bpmAt(3.99)).toBeCloseTo(120, 5);
      expect((tl as any).zoomAt(3.99)).toBeCloseTo(1.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(3.99)).toBeCloseTo(110, 5);
      expect(tl.bpmAt(4.23)).toBeCloseTo(150, 5);
      expect((tl as any).zoomAt(4.23)).toBeCloseTo(2.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(4.23)).toBeCloseTo(220, 5);
    });

    it('amplitudeとzoomは独立 — 片方の変更が他方に影響しない (3-step)', () => {
      const zoomOnly = tlDerived([{ beat: 2, bpm: 120, zoom: 2.0 }], 1.0);
      expect((zoomOnly as any).zoomAt(2.37)).toBeCloseTo(2.0, 5);
      expect(zoomOnly.amplitudeAt(2.37)).toBeCloseTo(1.0, 5);
      const ampOnly = tlDerived([{ beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(ampOnly.amplitudeAt(2.37)).toBeCloseTo(2.0, 5);
      expect((ampOnly as any).zoomAt(2.37)).toBeCloseTo(1.0, 5);
    });
  });

  // ======================================================================
  // 5) Off-grid検証原則 — 端数タイミングでのzoomステップ正確性
  // ======================================================================
  describe('5. Off-grid検証原則 — 端数拍での正確性', () => {
    it('zoom境界を端数(0.37/1.23)で正しく跨ぐ — 1.0→2.0の吸着 (3-step)', () => {
      const tl = tlDerived([{ beat: 4, bpm: 120, zoom: 2.0 }], 1.0);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(3.37)).toBeCloseTo(110, 5);
      expect((tl as any).zoomAt(3.99)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(4.0)).toBeCloseTo(2.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(4.0)).toBeCloseTo(220, 5);
      expect((tl as any).zoomAt(4.23)).toBeCloseTo(2.0, 5);
    });

    it('beat=0.37のzoomエントリが即時に有効 — 端数境界 (3-step)', () => {
      const tl = tlDerived([
        { beat: 0.37, bpm: 120, zoom: 0.8 },
        { beat: 1.23, bpm: 120, zoom: 1.2 },
      ], 1.0);
      expect((tl as any).zoomAt(0.36)).toBeCloseTo(1.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(0.36)).toBeCloseTo(110, 5);
      expect((tl as any).zoomAt(0.37)).toBeCloseTo(0.8, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(0.37)).toBeCloseTo(88, 5);
      expect((tl as any).zoomAt(1.22)).toBeCloseTo(0.8, 5);
      expect((tl as any).zoomAt(1.23)).toBeCloseTo(1.2, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(1.23)).toBeCloseTo(132, 5);
    });

    it('invalid zoom値は無視され1.0扱い — NaN/0/Infinity (3-step)', () => {
      const tl = tlDerived([
        { beat: 2, bpm: 120, zoom: NaN as unknown as number },
        { beat: 4, bpm: 120, zoom: -1 as unknown as number },
        { beat: 6, bpm: 120, zoom: Infinity as unknown as number },
        { beat: 8, bpm: 120, zoom: 0 as unknown as number },
        { beat: 10, bpm: 120, zoom: 2.0 },
      ], 1.0);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(5.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(10)).toBeCloseTo(2.0, 5);
      expect(DEFAULT_SCROLL * (tl as any).zoomAt(10.37)).toBeCloseTo(220, 5);
    });
  });
});
