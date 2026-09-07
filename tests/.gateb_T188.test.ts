/**
 * T188 — ゲーム側のchart.bpm参照除去＋時変スクロール反映 Vitest pure acceptance
 * node environment — pure engine math, no DOM, TDD Red->Green
 * Verifies: (1) zoomAt driven scrollSpeed =110*zoomAt(currentBeat) off-grid
 *           (2) GameScreen/CalibrationModal no chart.bpm / scroll_speed refs
 *           (3) tsc compilation (implicit via import)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { BpmChange } from '../src/types';
import * as fs from 'fs';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helpers — distinct names from variables to avoid shadowing (postmortem fix)
function createTimeline(changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(changes, baseAmp) as BpmTimeline;
}
function createLegacyTimeline(baseBpm: number, changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(baseBpm, changes, baseAmp) as BpmTimeline;
}

const SCROLL_BASE = 110;
function computeScrollSpeed(timeline: BpmTimeline, beat: number): number {
  return SCROLL_BASE * timeline.zoomAt(beat);
}

describe('T188 ゲーム側chart.bpm参照除去＋時変スクロール反映 — Vitest pure engine', () => {
  // ======================================================================
  // 1) BpmTimeline 基準BPM導出が sections 由来であること (T187回帰)
  //    hardcode 120 でないことを off-grid で検証
  // ======================================================================
  describe('1. BpmTimeline base BPM derived from first section (not hardcoded 120)', () => {
    it('空sectionsは120フォールバックだが sections存在時は先頭bpmが権威 (3-step)', () => {
      // [Step1: Capture Initial State] — empty fallback
      const emptyTimeline = createTimeline([], 1.0);
      const emptyMs = emptyTimeline.beatToMs(1);
      expect(emptyMs).toBeCloseTo(500, 2); // 120 BPM
      expect(emptyTimeline.bpmAt(0.37)).toBeCloseTo(120, 5);

      // [Step2: Perform] — derived timeline with beat0 180
      const derived180 = createTimeline([{ beat: 0, bpm: 180 }], 1.0);
      const ms180 = 60000 / 180;

      // [Step3: Assert Resulting Transition] — authoritative base 180, off-grid
      expect(derived180.bpmAt(0)).toBeCloseTo(180, 5);
      expect(derived180.bpmAt(0.37)).toBeCloseTo(180, 5);
      expect(derived180.bpmAt(1.23)).toBeCloseTo(180, 5);
      expect(derived180.beatToMs(1)).toBeCloseTo(ms180, 2);
      expect(derived180.beatToMs(0.37)).toBeCloseTo(ms180 * 0.37, 2);
      expect(derived180.beatToMs(1.23)).toBeCloseTo(ms180 * 1.23, 2);
      expect(derived180.msToBeat(ms180 * 0.37)).toBeCloseTo(0.37, 4);
    });

    it('複雑BPM 150/90 で beatToMs が先頭bpm基準になる off-grid 0.37/1.23 (3-step)', () => {
      // [Step1] 120 fallback capture
      const fallbackTimeline = createTimeline([], 1.0);
      expect(fallbackTimeline.beatToMs(1)).toBeCloseTo(500, 2);

      // [Step2] 150 derived
      const timeline150 = createTimeline([{ beat: 0, bpm: 150 }], 1.0);
      const ms150 = 60000 / 150;

      // [Step3] assert 150 authoritative
      expect(timeline150.beatToMs(0.37)).toBeCloseTo(ms150 * 0.37, 2);
      expect(timeline150.beatToMs(1.23)).toBeCloseTo(ms150 * 1.23, 2);
      expect(timeline150.msToBeat(ms150 * 2.37)).toBeCloseTo(2.37, 4);

      // additional 90
      const timeline90 = createTimeline([{ beat: 0, bpm: 90 }], 1.0);
      const ms90 = 60000 / 90;
      expect(timeline90.beatToMs(1.23)).toBeCloseTo(ms90 * 1.23, 2);
      expect(timeline90.bpmAt(1.23)).toBeCloseTo(90, 5);
    });

    it('legacy overload (number, changes) は明示baseを無視し sectionsから導出 (3-step)', () => {
      // [Step1] capture legacy with mismatched explicit base 120 but section 150
      const legacyMismatch = createLegacyTimeline(120, [{ beat: 2, bpm: 150 }], 1.0);

      // [Step2] unsorted legacy
      const legacyUnsorted = createLegacyTimeline(999, [{ beat: 4, bpm: 180 }, { beat: 0, bpm: 90 }], 1.0);

      // [Step3] assert derived overrides explicit
      expect(legacyMismatch.bpmAt(0)).toBeCloseTo(150, 5);
      expect(legacyMismatch.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect(legacyMismatch.beatToMs(1)).toBeCloseTo(400, 2);
      expect(legacyUnsorted.bpmAt(0)).toBeCloseTo(90, 5);
      expect(legacyUnsorted.beatToMs(1)).toBeCloseTo(60000 / 90, 2);
    });
  });

  // ======================================================================
  // 2) zoomAt ステップ関数 — off-grid境界で正確に切替 (完了条件1の前提)
  // ======================================================================
  describe('2. zoomAt(beat) step function off-grid correctness', () => {
    it('zoom未設定は1.0を返す、設定後はstepで切替 (3-step off-grid)', () => {
      // [Step1] empty no zoom
      const emptyTl = createTimeline([], 1.0);
      expect((emptyTl as any).zoomAt).toBeDefined();
      expect(emptyTl.zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect(emptyTl.zoomAt(1.23)).toBeCloseTo(1.0, 5);

      // [Step2] single zoom at beat 4
      const singleZoom = createTimeline([{ beat: 4, bpm: 120, zoom: 2.0 }], 1.0);

      // [Step3] step inclusive at boundary, off-grid
      expect(singleZoom.zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect(singleZoom.zoomAt(3.99)).toBeCloseTo(1.0, 5);
      expect(singleZoom.zoomAt(4.0)).toBeCloseTo(2.0, 5);
      expect(singleZoom.zoomAt(4.23)).toBeCloseTo(2.0, 5);
      expect(singleZoom.zoomAt(4.37)).toBeCloseTo(2.0, 5);
    });

    it('複雑 zoom 0.7/1.3/2.7 で off-grid 0.37/1.23 step一致 (3-step)', () => {
      // [Step1] base
      const base = createTimeline([], 1.0);
      expect(base.zoomAt(1.23)).toBeCloseTo(1.0, 5);

      // [Step2] multiple entries complex values
      const complexChanges: BpmChange[] = [
        { beat: 2, bpm: 120, zoom: 0.7 },
        { beat: 4, bpm: 130, zoom: 1.3 },
        { beat: 7.5, bpm: 140, zoom: 2.7 },
      ];
      const complexTl = createTimeline(complexChanges, 1.0);

      // [Step3] off-grid asserts
      expect(complexTl.zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect(complexTl.zoomAt(2.37)).toBeCloseTo(0.7, 5);
      expect(complexTl.zoomAt(3.37)).toBeCloseTo(0.7, 5);
      expect(complexTl.zoomAt(4.0)).toBeCloseTo(1.3, 5);
      expect(complexTl.zoomAt(4.23)).toBeCloseTo(1.3, 5);
      expect(complexTl.zoomAt(7.37)).toBeCloseTo(1.3, 5);
      expect(complexTl.zoomAt(7.5)).toBeCloseTo(2.7, 5);
      expect(complexTl.zoomAt(7.63)).toBeCloseTo(2.7, 5);
      expect(complexTl.zoomAt(100)).toBeCloseTo(2.7, 5);
    });

    it('beat 0 の zoom エントリが即時有効 (T186由来)', () => {
      const zeroZoom = createTimeline([{ beat: 0, bpm: 120, zoom: 1.5 }], 1.0);
      expect(zeroZoom.zoomAt(0)).toBeCloseTo(1.5, 5);
      expect(zeroZoom.zoomAt(0.37)).toBeCloseTo(1.5, 5);
      expect(zeroZoom.zoomAt(1.23)).toBeCloseTo(1.5, 5);
    });

    it('zoom と amplitude は独立 — 片方変更が他方に影響しない (3-step)', () => {
      // [Step1] zoom only
      const zoomOnlyTl = createTimeline([{ beat: 2, bpm: 120, zoom: 2.0 }], 1.0);
      expect(zoomOnlyTl.zoomAt(2.37)).toBeCloseTo(2.0, 5);
      expect(zoomOnlyTl.amplitudeAt(2.37)).toBeCloseTo(1.0, 5);

      // [Step2] amplitude only
      const ampOnlyTl = createTimeline([{ beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(ampOnlyTl.amplitudeAt(2.37)).toBeCloseTo(2.0, 5);
      expect(ampOnlyTl.zoomAt(2.37)).toBeCloseTo(1.0, 5);

      // [Step3] both set simultaneously at same beat
      const bothTl = createTimeline([
        { beat: 2, bpm: 120, amplitude: 1.7, zoom: 0.5 },
        { beat: 4, bpm: 120, amplitude: 2.7, zoom: 2.5 },
      ], 1.0);
      expect(bothTl.amplitudeAt(2.37)).toBeCloseTo(1.7, 5);
      expect(bothTl.zoomAt(2.37)).toBeCloseTo(0.5, 5);
      expect(bothTl.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);
      expect(bothTl.zoomAt(4.37)).toBeCloseTo(2.5, 5);
    });
  });

  // ======================================================================
  // 3) 時変スクロール速度: scrollSpeed = 110 * zoomAt(currentBeat)
  //    完了条件1 — zoom値で流速が変わる＋定数110維持
  // ======================================================================
  describe('3. scrollSpeed = 110 * zoomAt(currentBeat) 時変反映 (完了条件1)', () => {
    it('zoom 1.0/2.0 で scrollSpeed が 110/220 になる (3-step + off-grid)', () => {
      // [Step1: Capture Initial State] zoom 1.0 baseline
      const baseTimeline = createTimeline([{ beat: 0, bpm: 120, zoom: 1.0 }], 1.0);
      const beforeSpeed = computeScrollSpeed(baseTimeline, 0.37);
      expect(beforeSpeed).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(baseTimeline, 1.23)).toBeCloseTo(110, 5);

      // [Step2: Perform] timeline with zoom 2.0 at beat 4
      const zoomedTimeline = createTimeline([{ beat: 4, bpm: 120, zoom: 2.0 }], 1.0);
      const speedBefore = computeScrollSpeed(zoomedTimeline, 3.37);
      const speedAt = computeScrollSpeed(zoomedTimeline, 4.0);
      const speedAfter = computeScrollSpeed(zoomedTimeline, 4.23);
      const speedFar = computeScrollSpeed(zoomedTimeline, 100);

      // [Step3: Assert Resulting Transition] step reflects exactly
      expect(speedBefore).toBeCloseTo(110 * 1.0, 5);
      expect(speedAt).toBeCloseTo(110 * 2.0, 5);
      expect(speedAfter).toBeCloseTo(220, 5);
      expect(speedFar).toBeCloseTo(220, 5);
      // off-grid 0.37 after step still 220
      expect(computeScrollSpeed(zoomedTimeline, 4.37)).toBeCloseTo(220, 5);
    });

    it('複雑 zoom 0.7/1.3/2.7/3.4 で scrollSpeed が 77/143/297/374 になる off-grid 0.37/1.23 (3-step)', () => {
      // [Step1] baseline 1.0
      const baseline = createTimeline([], 1.0);
      expect(computeScrollSpeed(baseline, 0.37)).toBeCloseTo(110, 5);

      // [Step2] complex time-varying zoom
      const complexTimeline = createTimeline([
        { beat: 0, bpm: 120, zoom: 0.7 },
        { beat: 2, bpm: 120, zoom: 1.3 },
        { beat: 4, bpm: 120, zoom: 2.7 },
        { beat: 6, bpm: 120, zoom: 3.4 },
      ], 1.0);

      // [Step3] assert each zone with off-grid phases
      expect(computeScrollSpeed(complexTimeline, 0.37)).toBeCloseTo(110 * 0.7, 5);
      expect(computeScrollSpeed(complexTimeline, 1.23)).toBeCloseTo(110 * 0.7, 5);
      expect(computeScrollSpeed(complexTimeline, 1.99)).toBeCloseTo(110 * 0.7, 5);
      expect(computeScrollSpeed(complexTimeline, 2.0)).toBeCloseTo(110 * 1.3, 5);
      expect(computeScrollSpeed(complexTimeline, 2.37)).toBeCloseTo(110 * 1.3, 5);
      expect(computeScrollSpeed(complexTimeline, 3.37)).toBeCloseTo(110 * 1.3, 5);
      expect(computeScrollSpeed(complexTimeline, 4.0)).toBeCloseTo(110 * 2.7, 5);
      expect(computeScrollSpeed(complexTimeline, 4.37)).toBeCloseTo(110 * 2.7, 5);
      expect(computeScrollSpeed(complexTimeline, 5.23)).toBeCloseTo(110 * 2.7, 5);
      expect(computeScrollSpeed(complexTimeline, 6.0)).toBeCloseTo(110 * 3.4, 5);
      expect(computeScrollSpeed(complexTimeline, 6.37)).toBeCloseTo(110 * 3.4, 5);
      expect(computeScrollSpeed(complexTimeline, 100)).toBeCloseTo(110 * 3.4, 5);
      // exact numeric values
      expect(computeScrollSpeed(complexTimeline, 0.37)).toBeCloseTo(77, 5);
      expect(computeScrollSpeed(complexTimeline, 2.37)).toBeCloseTo(143, 5);
      expect(computeScrollSpeed(complexTimeline, 4.37)).toBeCloseTo(297, 5);
      expect(computeScrollSpeed(complexTimeline, 6.37)).toBeCloseTo(374, 5);
    });

    it('scrollSpeed は BPM と無関係 — zoomのみで決まる (3-step)', () => {
      // [Step1] capture without zoom but different BPM
      const noZoom150 = createTimeline([{ beat: 0, bpm: 150 }], 1.0);
      expect(computeScrollSpeed(noZoom150, 1.23)).toBeCloseTo(110, 5);
      expect(noZoom150.beatToMs(1)).toBeCloseTo(400, 2);

      // [Step2] with zoom but same BPM
      const withZoom150 = createTimeline([{ beat: 0, bpm: 150, zoom: 2.5 }], 1.0);
      expect(computeScrollSpeed(withZoom150, 0.37)).toBeCloseTo(275, 5);

      // [Step3] beatToMs identical regardless of zoom (zoom does not affect time)
      expect(withZoom150.beatToMs(1)).toBeCloseTo(noZoom150.beatToMs(1), 5);
      expect(withZoom150.beatToMs(0.37)).toBeCloseTo(noZoom150.beatToMs(0.37), 5);
      expect(withZoom150.beatToMs(1.23)).toBeCloseTo(noZoom150.beatToMs(1.23), 5);
      // but scrollSpeed differs
      expect(computeScrollSpeed(withZoom150, 1.23)).not.toBeCloseTo(computeScrollSpeed(noZoom150, 1.23), 2);
    });

    it('off-grid 分数拍 0.37/1.23 での scrollSpeed ステップが正確 — 毎フレーム現在値近似 (3-step)', () => {
      // [Step1] timeline with zoom at non-integer beat
      const offGridTimeline = createTimeline([
        { beat: 0.37, bpm: 120, zoom: 0.8 },
        { beat: 1.23, bpm: 120, zoom: 1.2 },
        { beat: 4.37, bpm: 120, zoom: 2.0 },
      ], 1.0);
      // before transition
      expect(computeScrollSpeed(offGridTimeline, 0.36)).toBeCloseTo(110 * 1.0, 5);
      // [Step2] at exact off-grid beats
      const s037 = computeScrollSpeed(offGridTimeline, 0.37);
      const s05 = computeScrollSpeed(offGridTimeline, 0.5);
      const s122 = computeScrollSpeed(offGridTimeline, 1.22);
      const s123 = computeScrollSpeed(offGridTimeline, 1.23);
      const s124 = computeScrollSpeed(offGridTimeline, 1.24);
      const s436 = computeScrollSpeed(offGridTimeline, 4.36);
      const s437 = computeScrollSpeed(offGridTimeline, 4.37);

      // [Step3] assert step inclusive semantics
      expect(s037).toBeCloseTo(110 * 0.8, 5);
      expect(s05).toBeCloseTo(110 * 0.8, 5);
      expect(s122).toBeCloseTo(110 * 0.8, 5);
      expect(s123).toBeCloseTo(110 * 1.2, 5);
      expect(s124).toBeCloseTo(110 * 1.2, 5);
      expect(s436).toBeCloseTo(110 * 1.2, 5);
      expect(s437).toBeCloseTo(110 * 2.0, 5);
    });

    it('定数110が維持されていること — 110以外は不許可 (3-step)', () => {
      // [Step1] read current scrollSpeed for zoom 1.0
      const unitTl = createTimeline([{ beat: 0, bpm: 120, zoom: 1.0 }], 1.0);
      const unitSpeed = computeScrollSpeed(unitTl, 0.37);
      expect(unitSpeed).toBeCloseTo(110, 5);

      // [Step2] zoom 2.0 should be exactly double the base constant
      const doubleTl = createTimeline([{ beat: 0, bpm: 120, zoom: 2.0 }], 1.0);
      const doubleSpeed = computeScrollSpeed(doubleTl, 1.23);

      // [Step3] ratio must be exactly 2.0, implying base 110 is unchanged
      expect(doubleSpeed / unitSpeed).toBeCloseTo(2.0, 5);
      expect(doubleSpeed).toBeCloseTo(220, 5);

      // also verify fractional zoom 0.5 = half
      const halfTl = createTimeline([{ beat: 0, bpm: 120, zoom: 0.5 }], 1.0);
      expect(computeScrollSpeed(halfTl, 0.37)).toBeCloseTo(55, 5);
      expect(computeScrollSpeed(halfTl, 0.37) / unitSpeed).toBeCloseTo(0.5, 5);
    });

    it('無効zoom (NaN/<=0) は 1.0 フォールバックで scrollSpeed 110 を維持 (3-step)', () => {
      // [Step1] valid baseline
      const validTl = createTimeline([{ beat: 0, bpm: 120, zoom: 1.5 }], 1.0);
      expect(computeScrollSpeed(validTl, 0.37)).toBeCloseTo(165, 5);

      // [Step2] invalid entries should be ignored -> fallback 1.0
      const invalidTl = createTimeline([
        { beat: 2, bpm: 120, zoom: NaN as unknown as number },
        { beat: 4, bpm: 120, zoom: -1 as unknown as number },
        { beat: 6, bpm: 120, zoom: 0 as unknown as number },
        { beat: 8, bpm: 120, zoom: Infinity as unknown as number },
      ], 1.0);

      // [Step3] all invalid zones remain 110
      expect(computeScrollSpeed(invalidTl, 2.37)).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(invalidTl, 4.37)).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(invalidTl, 6.37)).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(invalidTl, 8.37)).toBeCloseTo(110, 5);
    });
  });

  // ======================================================================
  // 4) ソースコード静的検証: chart.bpm / scroll_speed 参照除去＋zoom適用
  //    完了条件2 — GameScreen/CalibrationModal で旧参照が残っていない
  // ======================================================================
  describe('4. ソース静的検証 — chart.bpm / scroll_speed 参照除去と scrollSpeed=110*zoomAt 適用', () => {
    it('GameScreen.tsx が chart.bpm_changes 由来で BpmTimeline を生成し chart.bpm を参照しない (3-step)', () => {
      // [Step1: Capture Initial State] read file
      const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
      const hasBpmChanges = src.includes('chart.bpm_changes');
      const hasNewCtor = src.includes('new BpmTimeline(chart.bpm_changes');

      // [Step2: Perform] detect forbidden patterns
      // chart.bpm as standalone property (not chart.bpm_changes) — regex with negative lookahead
      const hasChartBpmLegacy = /chart\.bpm(?!_changes)/.test(src);
      const hasScrollSpeed = /scroll_speed/.test(src);
      const hasChartDotBpmDirect = src.includes('chart.bpm,') || src.includes('chart.bpm ') || /new BpmTimeline\(chart\.bpm(?!_changes)/.test(src);

      // [Step3: Assert Resulting Transition]
      expect(hasBpmChanges).toBe(true);
      expect(hasNewCtor).toBe(true);
      expect(hasChartBpmLegacy).toBe(false);
      expect(hasChartDotBpmDirect).toBe(false);
      expect(hasScrollSpeed).toBe(false);
    });

    it('GameScreen.tsx ゲームループ内で scrollSpeed = 110 * timeline.zoomAt(currentBeat) を算出し renderer に渡す (3-step)', () => {
      // [Step1] read file
      const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');

      // [Step2] check for zoomAt usage and scrollSpeed param
      const hasZoomAt = src.includes('timeline.zoomAt');
      const has110Zoom = src.includes('110 * timeline.zoomAt') || src.includes('110*timeline.zoomAt');
      const hasScrollSpeedProp = src.includes('scrollSpeed:') && src.includes('timeline.zoomAt');

      // renderer call should have scrollSpeed property
      const renderScrollSpeed = /scrollSpeed\s*:\s*110\s*\*\s*timeline\.zoomAt\(currentBeat\)/.test(src);

      // [Step3] assert
      expect(hasZoomAt).toBe(true);
      expect(has110Zoom).toBe(true);
      expect(hasScrollSpeedProp).toBe(true);
      expect(renderScrollSpeed).toBe(true);
    });

    it('CalibrationModal.tsx が chart.bpm を参照せず zoomAt で scrollSpeed を算出 (3-step)', () => {
      // [Step1] read calibration file
      const src = fs.readFileSync('src/screens/editor/CalibrationModal.tsx', 'utf-8');
      const hasChartBpmLegacy = /chart\.bpm(?!_changes)/.test(src);
      const hasScrollSpeedLiteral = /scroll_speed/.test(src);

      // Calibration uses fixed CAL_BPM but must still use BpmTimeline([{beat:0,bpm:CAL_BPM}],1.0) not legacy number first
      const hasFixedBpmTimeline = src.includes('CAL_BPM') && src.includes('new BpmTimeline') && /new BpmTimeline\(\s*\[\s*\{\s*beat:\s*0/.test(src);

      // [Step2] zoomAt and scrollSpeed
      const hasZoomAt = src.includes('timeline.zoomAt');
      const has110Zoom = src.includes('110 * timeline.zoomAt');

      // [Step3] assert
      expect(hasChartBpmLegacy).toBe(false);
      expect(hasScrollSpeedLiteral).toBe(false);
      expect(hasFixedBpmTimeline).toBe(true);
      expect(hasZoomAt).toBe(true);
      expect(has110Zoom).toBe(true);
      // calibration render call also must have scrollSpeed param
      expect(/scrollSpeed\s*:\s*110\s*\*\s*timeline\.zoomAt\(currentBeat\)/.test(src)).toBe(true);
    });

    it('BpmTimeline が zoomEntries を持ち zoomAt が public で ratio 計算に使える (3-step)', () => {
      // [Step1] verify class has zoomAt via instance check
      const tl = createTimeline([{ beat: 0, bpm: 120, zoom: 1.5 }], 1.0);
      const hasMethod = typeof (tl as any).zoomAt === 'function';

      // [Step2] check source file contains zoomEntries and zoomAt definitions
      const bpmSrc = fs.readFileSync('src/audio/bpmTimeline.ts', 'utf-8');
      const hasZoomEntries = bpmSrc.includes('zoomEntries');
      const hasZoomAtDef = bpmSrc.includes('zoomAt(beat');

      // [Step3] assert
      expect(hasMethod).toBe(true);
      expect(hasZoomEntries).toBe(true);
      expect(hasZoomAtDef).toBe(true);
      expect(tl.zoomAt(0.37)).toBeCloseTo(1.5, 5);
      expect(tl.zoomAt(100)).toBeCloseTo(1.5, 5);
    });

    it('BpmTimeline コンストラクタがlegacy number-first呼び出しを無視し sectionsから導出 (3-step)', () => {
      // [Step1] legacy call with explicit base 999 should be ignored
      const legacyTl = createLegacyTimeline(999, [{ beat: 0, bpm: 135 }], 1.0);
      const derivedTl = createTimeline([{ beat: 0, bpm: 135 }], 1.0);

      // [Step2] compare bpmAt — both should be 135, not 999
      const legacyBpm = legacyTl.bpmAt(0.37);
      const derivedBpm = derivedTl.bpmAt(0.37);

      // [Step3] assert both 135 and identical beatToMs
      expect(legacyBpm).toBeCloseTo(135, 5);
      expect(derivedBpm).toBeCloseTo(135, 5);
      expect(legacyBpm).toBeCloseTo(derivedBpm, 5);
      expect(legacyTl.beatToMs(1)).toBeCloseTo(derivedTl.beatToMs(1), 5);
      expect(legacyTl.beatToMs(1.23)).toBeCloseTo(derivedTl.beatToMs(1.23), 5);
    });
  });

  // ======================================================================
  // 5) レンダラー式不変 & scrollSpeed 時変のフレーム近似検証
  // ======================================================================
  describe('5. Renderer 式不変 & zoom時変が毎フレーム現在値近似であること', () => {
    it('scrollSpeed が beat 毎に再計算され、未設定区間は110フォールバック (3-step)', () => {
      // [Step1] timeline without zoom
      const noZoomTl = createTimeline([{ beat: 0, bpm: 120 }], 1.0);
      expect(computeScrollSpeed(noZoomTl, 0.37)).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(noZoomTl, 4.37)).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(noZoomTl, 100)).toBeCloseTo(110, 5);

      // [Step2] timeline with zoom only at beat 4
      const partialTl = createTimeline([{ beat: 4, bpm: 120, zoom: 2.0 }], 1.0);
      const speeds = [
        computeScrollSpeed(partialTl, 0.37),
        computeScrollSpeed(partialTl, 3.99),
        computeScrollSpeed(partialTl, 4.0),
        computeScrollSpeed(partialTl, 4.37),
      ];

      // [Step3] before=110, after=220, step semantics
      expect(speeds[0]).toBeCloseTo(110, 5);
      expect(speeds[1]).toBeCloseTo(110, 5);
      expect(speeds[2]).toBeCloseTo(220, 5);
      expect(speeds[3]).toBeCloseTo(220, 5);
    });

    it('BpmTimeline beatToMs/msToBeat が zoom に影響されず、zoom変更は描画速度のみに影響 (3-step)', () => {
      // [Step1] baseline without zoom
      const base = createTimeline([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 150 }], 1.0);
      const baseMs = base.beatToMs(4.37);

      // [Step2] same BPM sections but with zoom values
      const withZoom = createTimeline([
        { beat: 0, bpm: 120, zoom: 0.7 },
        { beat: 4, bpm: 150, zoom: 2.7 },
      ], 1.0);
      const zoomedMs = withZoom.beatToMs(4.37);

      // [Step3] time conversion identical, scrollSpeed differs
      expect(zoomedMs).toBeCloseTo(baseMs, 5);
      expect(computeScrollSpeed(base, 0.37)).toBeCloseTo(110, 5);
      expect(computeScrollSpeed(withZoom, 0.37)).toBeCloseTo(77, 5);
      expect(computeScrollSpeed(withZoom, 4.37)).toBeCloseTo(297, 5);
    });
  });
});
