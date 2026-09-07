/**
 * T187 — BpmTimelineの基準BPM導出変更＋zoomAt追加 Vitest pure acceptance
 * node environment — no DOM, pure engine math, off-grid verification
 * TDD Red: must FAIL before implementation (missing zoomAt / derived base)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { BpmChange } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helper to invoke the NEW constructor signature (bpmChanges, baseAmplitude)
// Implemented code after T187 derives baseBpm from beat-min bpm. Before T187
// the first arg is a number, so passing an array yields garbage (MIN_BPM=1)
// and makes assertions fail — exactly the Red we need.
function tlDerived(changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(changes, baseAmp) as BpmTimeline;
}
// helper that invokes legacy (baseBpm, bpmChanges, baseAmp) but expects
// post-T187 to IGNORE the explicit base and derive from changes instead
function tlLegacy(baseBpm: number, changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(baseBpm, changes, baseAmp) as BpmTimeline;
}

describe('T187 BpmTimeline基準BPM導出変更＋zoomAt追加 — Vitest pure engine', () => {
  // ========================================================================
  // 1) 先頭セクションbpmがbeatToMs/msToBeatに反映 (完了条件1)
  // ========================================================================
  describe('1. 先頭セクションbpmが基準BPMとしてbeatToMs/msToBeatに反映', () => {
    it('空セクションは120BPMフォールバック — beatToMs(1)=500ms (3-step)', () => {
      // [Step1: Capture Initial] empty derived fallback should be 120
      const before = tlDerived([], 1.0);
      const beforeMs = before.beatToMs(1);
      // before implementation this is garbage (MIN_BPM=1 => 60000ms) not 500
      // we capture it but will assert correct value below

      // [Step2: Perform] — reinitialize to ensure determinism
      const tl = tlDerived([], 1.0);

      // [Step3: Assert] derived fallback 120 => 60000/120=500 per beat
      expect(tl.beatToMs(1)).toBeCloseTo(500, 2);
      expect(tl.beatToMs(0.37)).toBeCloseTo(500 * 0.37, 2);
      expect(tl.beatToMs(2)).toBeCloseTo(1000, 2);
      expect(tl.bpmAt(0)).toBeCloseTo(120, 5);
      expect(tl.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(tl.beatMsAt(0.37)).toBeCloseTo(500, 5);
      // msToBeat round-trip off-grid
      expect(tl.msToBeat(500 * 1.23)).toBeCloseTo(1.23, 4);
      expect(tl.msToBeat(500 * 0.37)).toBeCloseTo(0.37, 4);
      void beforeMs;
    });

    it('beat0=180の単一セクションでbeatToMs/msToBeatが180基準になる (3-step off-grid)', () => {
      // [Step1: Capture Before] empty fallback 120 vs derived 180
      const before = tlDerived([], 1.0);
      expect(before.beatToMs(1)).toBeCloseTo(500, 2); // 120

      // [Step2: Perform] derived from sections beat0=180
      const tl = tlDerived([{ beat: 0, bpm: 180 }], 1.0);

      // [Step3: Assert] 180 => 333.333... per beat, off-grid
      const beatMs180 = 60000 / 180;
      expect(tl.bpmAt(0)).toBeCloseTo(180, 5);
      expect(tl.bpmAt(0.37)).toBeCloseTo(180, 5);
      expect(tl.bpmAt(1.23)).toBeCloseTo(180, 5);
      expect(tl.beatMsAt(0.37)).toBeCloseTo(beatMs180, 5);
      expect(tl.beatToMs(1)).toBeCloseTo(beatMs180, 2);
      expect(tl.beatToMs(0.37)).toBeCloseTo(beatMs180 * 0.37, 2);
      expect(tl.beatToMs(1.23)).toBeCloseTo(beatMs180 * 1.23, 2);
      expect(tl.msToBeat(beatMs180 * 0.37)).toBeCloseTo(0.37, 4);
      expect(tl.msToBeat(beatMs180 * 1.23)).toBeCloseTo(1.23, 4);
      // multi-beat
      expect(tl.beatToMs(4)).toBeCloseTo(beatMs180 * 4, 2);
    });

    it('複雑BPM 150/90 等でbeatToMsオフグリッド一致 (3-step)', () => {
      // [Step1] 120 fallback
      const fallback = tlDerived([], 1.0);
      expect(fallback.beatToMs(1)).toBeCloseTo(500, 2);

      // [Step2] derived 150
      const tl150 = tlDerived([{ beat: 0, bpm: 150 }], 1.0);
      const ms150 = 60000 / 150; // 400
      expect(tl150.beatToMs(0.37)).toBeCloseTo(ms150 * 0.37, 2);
      expect(tl150.beatToMs(1.23)).toBeCloseTo(ms150 * 1.23, 2);
      expect(tl150.msToBeat(ms150 * 2.37)).toBeCloseTo(2.37, 4);

      // [Step3] derived 90
      const tl90 = tlDerived([{ beat: 0, bpm: 90 }], 1.0);
      const ms90 = 60000 / 90;
      expect(tl90.beatToMs(0.37)).toBeCloseTo(ms90 * 0.37, 2);
      expect(tl90.beatToMs(1.23)).toBeCloseTo(ms90 * 1.23, 2);
      expect(tl90.msToBeat(ms90 * 3.7)).toBeCloseTo(3.7, 4);
    });

    it('beat-minが0以外(beat=2)でも先頭bpmが基準として0〜2に適用される (3-step)', () => {
      // [Step1] Capture empty
      const empty = tlDerived([], 1.0);
      expect(empty.bpmAt(1)).toBeCloseTo(120, 5);
      // [Step2] Perform derived where smallest beat is 2, bpm 150
      // Post-T187, baseBpm = 150, so even beats <2 should be 150 (not the 120 fallback)
      const tl = tlDerived([{ beat: 2, bpm: 150 }, { beat: 4, bpm: 180 }], 1.0);
      // [Step3] Assert base derived = 150, not 120
      expect(tl.bpmAt(0)).toBeCloseTo(150, 5);
      expect(tl.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect(tl.bpmAt(1.23)).toBeCloseTo(150, 5);
      expect(tl.bpmAt(2)).toBeCloseTo(150, 5);
      expect(tl.bpmAt(2.37)).toBeCloseTo(150, 5);
      // 150 => 400ms
      expect(tl.beatToMs(1)).toBeCloseTo(400, 2);
      expect(tl.beatToMs(0.37)).toBeCloseTo(400 * 0.37, 2);
      expect(tl.beatToMs(2)).toBeCloseTo(800, 2);
      // after beat 4, 180 => 333.33
      const ms180 = 60000 / 180;
      expect(tl.bpmAt(4.23)).toBeCloseTo(180, 5);
      expect(tl.beatToMs(5)).toBeCloseTo(800 + ms180 * 1, 2);
      expect(tl.beatToMs(4.37)).toBeCloseTo(800 + ms180 * 0.37, 2);
    });

    it('未ソートのsectionsでもbeat最小が基準 — [{beat4:180},{beat0:150}] => base 150 (3-step)', () => {
      // [Step1] sorted case
      const sorted = tlDerived([{ beat: 0, bpm: 150 }, { beat: 4, bpm: 180 }], 1.0);
      expect(sorted.bpmAt(0)).toBeCloseTo(150, 5);

      // [Step2] unsorted input, same logical set
      const unsorted = tlDerived([{ beat: 4, bpm: 180 }, { beat: 0, bpm: 150 }], 1.0);

      // [Step3] must derive same base 150 regardless of order
      expect(unsorted.bpmAt(0)).toBeCloseTo(150, 5);
      expect(unsorted.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect(unsorted.beatToMs(1)).toBeCloseTo(400, 2);
      expect(unsorted.beatToMs(0.37)).toBeCloseTo(400 * 0.37, 2);
      // and ordering should not affect computed ms for later section
      const ms180 = 60000 / 180;
      expect(unsorted.beatToMs(4.37)).toBeCloseTo(400 * 4 + ms180 * 0.37, 2);
      expect(sorted.beatToMs(4.37)).toBeCloseTo(unsorted.beatToMs(4.37), 2);
    });

    it('legacy overload (baseBpm, changes) は明示baseを無視しsectionsから導出 (3-step)', () => {
      // [Step1] Capture legacy with mismatched base
      // Pre-T187, bpmAt(0) would be the explicit base (e.g. 120) until beat 2, post-T187 must be 150
      const beforeLegacy = tlLegacy(120, [{ beat: 2, bpm: 150 }], 1.0);
      // Red: beforeLegacy.bpmAt(0) === 120 (pre) but expected post is 150
      // We assert post expectation so test fails pre

      // [Step2/3] Assert derived overrides explicit
      expect(beforeLegacy.bpmAt(0)).toBeCloseTo(150, 5);
      expect(beforeLegacy.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect(beforeLegacy.bpmAt(1.23)).toBeCloseTo(150, 5);
      expect(beforeLegacy.beatToMs(1)).toBeCloseTo(400, 2);

      // also unsorted legacy
      const unsortedLegacy = tlLegacy(999, [{ beat: 4, bpm: 180 }, { beat: 0, bpm: 90 }], 1.0);
      expect(unsortedLegacy.bpmAt(0)).toBeCloseTo(90, 5);
      expect(unsortedLegacy.beatToMs(1)).toBeCloseTo(60000 / 90, 2);
    });

    it('multi-section BPM timeline beatToMs/msToBeat 数値整合 off-grid 0.37/1.23', () => {
      const changes: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 2, bpm: 150 },
        { beat: 4.37, bpm: 180 },
      ];
      const tl = tlDerived(changes, 1.0);
      // seg 0-2: 500ms, seg 2-4.37: 400ms, seg 4.37+: 333.33ms
      const ms120 = 500;
      const ms150 = 400;
      const ms180 = 60000 / 180;
      expect(tl.beatToMs(1.23)).toBeCloseTo(ms120 * 1.23, 2);
      expect(tl.beatToMs(2.37)).toBeCloseTo(ms120 * 2 + ms150 * 0.37, 2);
      expect(tl.beatToMs(4)).toBeCloseTo(ms120 * 2 + ms150 * 2, 2);
      expect(tl.beatToMs(4.37)).toBeCloseTo(ms120 * 2 + ms150 * 2.37, 2);
      expect(tl.beatToMs(5.37)).toBeCloseTo(ms120 * 2 + ms150 * 2.37 + ms180 * 1, 2);
      // msToBeat inverse off-grid
      expect(tl.msToBeat(tl.beatToMs(2.37))).toBeCloseTo(2.37, 3);
      expect(tl.msToBeat(tl.beatToMs(4.37 + 0.37))).toBeCloseTo(4.74, 3);
      expect(tl.msToBeat(tl.beatToMs(1.23))).toBeCloseTo(1.23, 3);
    });
  });

  // ========================================================================
  // 2) zoomAt がセクション境界で切り替わり・未設定区間は1.0 (完了条件2)
  // ========================================================================
  describe('2. zoomAt(beat) ステップ関数 — 境界切替・既定1.0', () => {
    it('zoom未設定区間は1.0を返す (3-step)', () => {
      // [Step1] empty no zoom
      const empty = tlDerived([], 1.0);
      expect((empty as any).zoomAt).toBeDefined();
      expect((empty as any).zoomAt(0)).toBeCloseTo(1.0, 5);
      expect((empty as any).zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect((empty as any).zoomAt(1.23)).toBeCloseTo(1.0, 5);
      expect((empty as any).zoomAt(100)).toBeCloseTo(1.0, 5);

      // [Step2] only bpm changes without zoom
      const noZoom = tlDerived([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 150 }], 1.0);
      expect((noZoom as any).zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect((noZoom as any).zoomAt(4.23)).toBeCloseTo(1.0, 5);
      expect((noZoom as any).zoomAt(8)).toBeCloseTo(1.0, 5);

      // [Step3] with amplitude only, zoom still 1.0
      const ampOnly = tlDerived([{ beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect((ampOnly as any).zoomAt(1.23)).toBeCloseTo(1.0, 5);
      expect((ampOnly as any).zoomAt(2.37)).toBeCloseTo(1.0, 5);
    });

    it('single zoom entry beat=4 1.0→2.0: off-grid 3.37 vs 4.23 step (3-step)', () => {
      // [Step1] before no zoom
      const before = tlDerived([], 1.0);
      expect((before as any).zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect((before as any).zoomAt(4.23)).toBeCloseTo(1.0, 5);

      // [Step2] add zoom at beat 4
      const tl = tlDerived([{ beat: 4, bpm: 120, zoom: 2.0 }], 1.0);

      // [Step3] step at boundary inclusive
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(3.99)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(4.0)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(4.23)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(4.37)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(100)).toBeCloseTo(2.0, 5);
    });

    it('複数 time-varying zoom off-grid step正確性 — 0.7/1.3/2.7等複雑値 (3-step)', () => {
      // [Step1] base empty
      const base = tlDerived([], 1.0);
      expect((base as any).zoomAt(1.23)).toBeCloseTo(1.0, 5);

      // [Step2] multiple entries unsorted complex
      const changes: BpmChange[] = [
        { beat: 2, bpm: 120, zoom: 0.7 },
        { beat: 4, bpm: 130, zoom: 1.3 },
        { beat: 7.5, bpm: 140, zoom: 2.7 },
      ];
      const tl = tlDerived(changes, 1.0);

      // [Step3] off-grid checks
      expect((tl as any).zoomAt(0.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(1.23)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(2.0)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(2.37)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(3.99)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(4.0)).toBeCloseTo(1.3, 5);
      expect((tl as any).zoomAt(4.23)).toBeCloseTo(1.3, 5);
      expect((tl as any).zoomAt(5.37)).toBeCloseTo(1.3, 5);
      expect((tl as any).zoomAt(7.37)).toBeCloseTo(1.3, 5);
      expect((tl as any).zoomAt(7.5)).toBeCloseTo(2.7, 5);
      expect((tl as any).zoomAt(7.63)).toBeCloseTo(2.7, 5);
      expect((tl as any).zoomAt(8.23)).toBeCloseTo(2.7, 5);
      expect((tl as any).zoomAt(100)).toBeCloseTo(2.7, 5);
    });

    it('unsorted bpm_changes でもzoomAtはソート後に正しく切替 (3-step)', () => {
      const unsorted: BpmChange[] = [
        { beat: 6, bpm: 120, zoom: 2.7 },
        { beat: 2, bpm: 120, zoom: 0.7 },
        { beat: 4, bpm: 120, zoom: 1.3 },
      ];
      const tl = tlDerived(unsorted, 1.0);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(4.37)).toBeCloseTo(1.3, 5);
      expect((tl as any).zoomAt(6.37)).toBeCloseTo(2.7, 5);
    });

    it('zoomとamplitudeは独立 — amplitude変更がzoomに影響しない (3-step)', () => {
      // [Step1] zoom only
      const zoomOnly = tlDerived([{ beat: 2, bpm: 120, zoom: 2.0 }], 1.0);
      expect((zoomOnly as any).zoomAt(2.37)).toBeCloseTo(2.0, 5);
      expect(zoomOnly.amplitudeAt(2.37)).toBeCloseTo(1.0, 5);

      // [Step2] amplitude only — zoom stays 1.0
      const ampOnly = tlDerived([{ beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(ampOnly.amplitudeAt(2.37)).toBeCloseTo(2.0, 5);
      expect((ampOnly as any).zoomAt(2.37)).toBeCloseTo(1.0, 5);

      // [Step3] both set on same beat — each steps independently
      const both = tlDerived([
        { beat: 2, bpm: 120, amplitude: 1.7, zoom: 0.5 },
        { beat: 4, bpm: 120, amplitude: 2.7, zoom: 2.5 },
      ], 1.0);
      expect(both.amplitudeAt(1.23)).toBeCloseTo(1.0, 5);
      expect((both as any).zoomAt(1.23)).toBeCloseTo(1.0, 5);
      expect(both.amplitudeAt(2.37)).toBeCloseTo(1.7, 5);
      expect((both as any).zoomAt(2.37)).toBeCloseTo(0.5, 5);
      expect(both.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);
      expect((both as any).zoomAt(4.37)).toBeCloseTo(2.5, 5);
    });

    it('zoomAt境界のoff-grid端数(0.37/1.23)で正確にスナップ (T186互換)', () => {
      const changes: BpmChange[] = [
        { beat: 0.37, bpm: 120, zoom: 0.8 },
        { beat: 1.23, bpm: 120, zoom: 1.2 },
        { beat: 4.37, bpm: 120, zoom: 2.0 },
      ];
      const tl = tlDerived(changes, 1.0);
      expect((tl as any).zoomAt(0.36)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(0.37)).toBeCloseTo(0.8, 5);
      expect((tl as any).zoomAt(0.5)).toBeCloseTo(0.8, 5);
      expect((tl as any).zoomAt(1.22)).toBeCloseTo(0.8, 5);
      expect((tl as any).zoomAt(1.23)).toBeCloseTo(1.2, 5);
      expect((tl as any).zoomAt(1.24)).toBeCloseTo(1.2, 5);
      expect((tl as any).zoomAt(4.36)).toBeCloseTo(1.2, 5);
      expect((tl as any).zoomAt(4.37)).toBeCloseTo(2.0, 5);
    });

    it('invalid zoom値(NaN/<=0/Infinity)は無視され1.0扱い (3-step)', () => {
      const tl = tlDerived([
        { beat: 2, bpm: 120, zoom: NaN as unknown as number },
        { beat: 4, bpm: 120, zoom: -1 as unknown as number },
        { beat: 6, bpm: 120, zoom: Infinity as unknown as number },
        { beat: 8, bpm: 120, zoom: 0 as unknown as number },
        { beat: 10, bpm: 120, zoom: 2.0 },
      ], 1.0);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(5.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(7.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(9.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(10)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(10.37)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(11)).toBeCloseTo(2.0, 5);
    });

    it('entries without zoom do not affect zoomAt — fallback to last zoom or 1.0 (3-step)', () => {
      const tl = tlDerived([
        { beat: 2, bpm: 140 }, // no zoom
        { beat: 4, bpm: 150, zoom: 2.0 },
        { beat: 6, bpm: 160 }, // no zoom
      ], 1.0);
      expect((tl as any).zoomAt(1.23)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(2.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(1.0, 5);
      expect((tl as any).zoomAt(4.23)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(6.23)).toBeCloseTo(2.0, 5);
      expect((tl as any).zoomAt(8)).toBeCloseTo(2.0, 5);
    });

    it('beat=0のzoomエントリが即時に有効 (3-step)', () => {
      // Pre-T186, beat 0 was filtered; post-T186/187 it must be kept
      const tl = tlDerived([{ beat: 0, bpm: 120, zoom: 1.5 }], 1.0);
      expect((tl as any).zoomAt(0)).toBeCloseTo(1.5, 5);
      expect((tl as any).zoomAt(0.37)).toBeCloseTo(1.5, 5);
      expect((tl as any).zoomAt(1.23)).toBeCloseTo(1.5, 5);
    });

    it('zoomEntriesはamplitudeEntriesと同型 — 両方のstepが同時並行で正しい (3-step)', () => {
      const changes: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.5 },
        { beat: 3, bpm: 130, amplitude: 1.3, zoom: 1.5 },
        { beat: 6, bpm: 140, amplitude: 2.7, zoom: 2.0 },
      ];
      const tl = tlDerived(changes, 1.0);
      // before any
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(0.37)).toBeCloseTo(0.5, 5);
      // middle
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(0.7, 5);
      expect((tl as any).zoomAt(2.37)).toBeCloseTo(0.5, 5);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.3, 5);
      expect((tl as any).zoomAt(3.37)).toBeCloseTo(1.5, 5);
      // after
      expect(tl.amplitudeAt(6.37)).toBeCloseTo(2.7, 5);
      expect((tl as any).zoomAt(6.37)).toBeCloseTo(2.0, 5);
    });
  });

  // ========================================================================
  // 3) 回帰: bpm/zoom相互非干渉 + off-grid BPM/timeline整合
  // ========================================================================
  describe('3. 回帰 — BPM導出とzoomの相互非干渉', () => {
    it('zoomAtはBPM計算(beatToMs/msToBeat)に影響しない (3-step)', () => {
      const withoutZoom = tlDerived([{ beat: 0, bpm: 150 }], 1.0);
      const withZoom = tlDerived([{ beat: 0, bpm: 150, zoom: 2.5 }], 1.0);
      // BPM timeline identical regardless of zoom
      expect(withZoom.beatToMs(1)).toBeCloseTo(withoutZoom.beatToMs(1), 5);
      expect(withZoom.beatToMs(0.37)).toBeCloseTo(withoutZoom.beatToMs(0.37), 5);
      expect(withZoom.beatToMs(1.23)).toBeCloseTo(withoutZoom.beatToMs(1.23), 5);
      expect(withZoom.bpmAt(0.37)).toBeCloseTo(150, 5);
      expect((withZoom as any).zoomAt(0.37)).toBeCloseTo(2.5, 5);
      expect((withoutZoom as any).zoomAt(0.37)).toBeCloseTo(1.0, 5);
    });

    it('BPM変更とzoom変更が同じbeatで同時ステップしても両方正しい', () => {
      const tl = tlDerived([
        { beat: 0, bpm: 120, zoom: 1.0 },
        { beat: 4, bpm: 150, zoom: 2.0 },
      ], 1.0);
      expect(tl.bpmAt(3.99)).toBeCloseTo(120, 5);
      expect((tl as any).zoomAt(3.99)).toBeCloseTo(1.0, 5);
      expect(tl.bpmAt(4.0)).toBeCloseTo(150, 5);
      expect((tl as any).zoomAt(4.0)).toBeCloseTo(2.0, 5);
      expect(tl.bpmAt(4.37)).toBeCloseTo(150, 5);
      expect((tl as any).zoomAt(4.37)).toBeCloseTo(2.0, 5);
      // beatToMs uses BPM only, not zoom
      const ms120 = 500;
      const ms150 = 400;
      expect(tl.beatToMs(4.37)).toBeCloseTo(ms120 * 4 + ms150 * 0.37, 2);
    });
  });
});
