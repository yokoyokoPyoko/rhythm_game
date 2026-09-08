/**
 * T209 — 数値入力の下書き確定化＋イーズアウト3次式化 Vitest pure acceptance
 * node environment — pure engine math + source-pattern checks, no DOM, TDD Red->Green
 * Spec:
 *  1) SegmentEditor beats + BpmEditor beat は中間状態を矯正せず onBlur/Enter確定、有限>0検証+snap量子化、無効は直前値復帰
 *  2) bpmTimeline.ts ease-out を 2次式 1-(1-t)^2 (t=0.5:0.75) から 3次式 1-(1-t)^3 (t=0.5:0.875) へ。linear/ease-in不変
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import type { BpmChange, Chart } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as unknown as new (a: unknown, b: unknown) => BpmTimeline)(sections as unknown, baseAmp as unknown);
}

// Expected easing factors per spec (after fix)
function easedCubic(t: number, kind: 'linear' | 'ease-out' | 'ease-in'): number {
  if (kind === 'linear') return t;
  if (kind === 'ease-out') return 1 - Math.pow(1 - t, 3);
  if (kind === 'ease-in') return t * t;
  return t;
}
// Old quadratic for reference (before fix) — must NOT match after fix
function easedQuadraticOut(t: number): number {
  return 1 - Math.pow(1 - t, 2);
}

describe('T209 数値入力の下書き確定化＋イーズアウト3次式化 — Vitest pure (TDD Red)', () => {
  describe('0. 前提: ソースが3次式であること (RedではFail)', () => {
    it('bpmTimeline.ts の ease-out 実装が 3次式 1-(1-t)^3 である (3-step: before read -> check -> assert cubic)', () => {
      const src = fs.readFileSync('src/audio/bpmTimeline.ts', 'utf-8');
      const hasQuadratic = src.includes('1 - (1 - t) * (1 - t)') || src.includes('Math.pow(1 - t, 2)');
      void hasQuadratic;
      // After fix, cubic must exist
      const hasCubic = src.includes('Math.pow(1 - t, 3)') || src.includes('(1 - t) * (1 - t) * (1 - t)') || src.includes('** 3');
      expect(hasCubic).toBe(true);
      // Quadratic-only impl must not remain as sole ease-out
      // Check the specific ease-out line contains cubic exponent 3
      const easeOutBlock = src.match(/case 'ease-out'[\s\S]*?return[\s\S]*?;/);
      expect(easeOutBlock !== null).toBe(true);
      expect(easeOutBlock![0]).toMatch(/3/);
    });
  });

  describe('1. amplitudeAt ease-out t=0.5 で 0.875 (3次式) — off-grid必須', () => {
    it('beat0 amp0.5 -> beat4 amp1.5 ease-out: mid 0.875, 端数0.37/1.23で3次曲線一致 (3-step)', () => {
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.5 },
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      const beforeMid = tlStep.amplitudeAt(2);
      expect(beforeMid).toBeCloseTo(0.5, 5);

      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.5, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      const start = 0.5, end = 1.5;
      // Core: t=0.5 => 0.875
      const atMid = tl.amplitudeAt(2);
      expect(atMid).toBeCloseTo(start + (end - start) * 0.875, 4);
      // Must NOT be old quadratic 0.75
      const oldMid = start + (end - start) * 0.75;
      expect(Math.abs(atMid - oldMid)).toBeGreaterThan(0.05);
      // Off-grid fractional
      const t037 = (0.37 - 0) / 4;
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(start + (end - start) * easedCubic(t037, 'ease-out'), 4);
      const t123 = (1.23 - 0) / 4;
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(start + (end - start) * easedCubic(t123, 'ease-out'), 4);
      expect(tl.amplitudeAt(1.0)).toBeCloseTo(start + (end - start) * easedCubic(0.25, 'ease-out'), 4);
      expect(tl.amplitudeAt(3.0)).toBeCloseTo(start + (end - start) * easedCubic(0.75, 'ease-out'), 4);
      expect(tl.amplitudeAt(0)).toBeCloseTo(start, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(end, 5);
      // Against quadratic directly
      expect(tl.amplitudeAt(0.37)).not.toBeCloseTo(start + (end - start) * easedQuadraticOut(t037), 3);
    });

    it('複雑振幅 2.7->0.7 ease-out 降順でも 0.875 で数値整合 (3-step off-grid 0.37/1.23)', () => {
      const tl = makeTimeline([
        { beat: 1, bpm: 120, amplitude: 2.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 5, bpm: 120, amplitude: 0.7 },
      ], 1.0);
      const start = 2.7, end = 0.7;
      expect(tl.amplitudeAt(3.0)).toBeCloseTo(start + (end - start) * 0.875, 4);
      const tOff = (2.37 - 1) / 4;
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(start + (end - start) * easedCubic(tOff, 'ease-out'), 4);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(start + (end - start) * easedCubic((3.37 - 1) / 4, 'ease-out'), 4);
      // Verify not quadratic
      expect(tl.amplitudeAt(3.0)).not.toBeCloseTo(start + (end - start) * 0.75, 3);
    });

    it('オフグリッド位相 0.37/1.23 と複雑振幅 0.7/1.3/2.7 で段階的に正確', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 2.7 },
      ], 1.0);
      const start = 0.7, end = 2.7;
      expect(tl.amplitudeAt(2)).toBeCloseTo(start + (end - start) * 0.875, 4);
      for (const beat of [0.37, 1.23, 0.73, 2.37, 3.49]) {
        const t = (beat - 0) / 4;
        if (t < 0 || t > 1) continue;
        expect(tl.amplitudeAt(beat)).toBeCloseTo(start + (end - start) * easedCubic(t, 'ease-out'), 4);
      }
    });
  });

  describe('2. zoomAt ease-out も 3次式で同ロジック (off-grid)', () => {
    it('zoom 1.0->2.0 ease-out t=0.5で1.875、off-grid 0.37/1.23で3次一致 (3-step)', () => {
      const tlStep = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0 } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlStep.zoomAt(2)).toBeCloseTo(1.0, 5);
      const tlOut = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlOut.zoomAt(2)).toBeCloseTo(1.875, 4);
      expect(tlOut.zoomAt(2)).not.toBeCloseTo(1.75, 3);
      expect(tlOut.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * easedCubic(0.0925, 'ease-out'), 4);
      expect(tlOut.zoomAt(1.23)).toBeCloseTo(1.0 + 1.0 * easedCubic(0.3075, 'ease-out'), 4);
    });

    it('zoom 複雑値 0.7->1.3 off-grid でもcubic一致', () => {
      const tl = makeTimeline([
        { beat: 2, bpm: 120, zoom: 0.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 6, bpm: 120, zoom: 1.3 } as unknown as BpmChange,
      ], 1.0);
      expect(tl.zoomAt(4)).toBeCloseTo(0.7 + 0.6 * 0.875, 4);
      expect(tl.zoomAt(3.37)).toBeCloseTo(0.7 + 0.6 * easedCubic((3.37 - 2) / 4, 'ease-out'), 4);
    });
  });

  describe('3. linear / ease-in は不変 (t=0.5で0.5 / 0.25)', () => {
    it('linear は従来通り t=0.5で0.5 — off-grid (3-step)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.7 + 0.8 * 0.5, 4);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.7 + 0.8 * easedCubic(0.0925, 'linear'), 4);
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(0.7 + 0.8 * easedCubic(0.3075, 'linear'), 4);
      const tlZoom = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'linear' } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlZoom.zoomAt(2)).toBeCloseTo(1.5, 4);
    });

    it('ease-in は2次式 t^2 のまま t=0.5で0.25 — off-grid (3-step)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.5, easeToNext: 'ease-in' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.5 + 1.0 * 0.25, 4);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.5 + 1.0 * easedCubic(0.0925, 'ease-in'), 4);
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(0.5 + 1.0 * easedCubic(0.3075, 'ease-in'), 4);
      expect(tl.amplitudeAt(3.0)).toBeCloseTo(0.5 + 1.0 * easedCubic(0.75, 'ease-in'), 4);
      // Must not be cubic ease-out
      expect(tl.amplitudeAt(2)).not.toBeCloseTo(0.5 + 1.0 * 0.875, 3);
    });
  });

  describe('4. マルチ区間混合 + BPM写像はイージング影響なし', () => {
    it('多区間混合: linear区間とease-out区間がそれぞれ3次で正確、zoomも同様 (3-step)', () => {
      const tlSingle = makeTimeline([{ beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'linear' } as unknown as BpmChange, { beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(tlSingle.amplitudeAt(1)).toBeCloseTo(1.5, 4);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, zoom: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 2.37, bpm: 130, amplitude: 1.3, zoom: 1.3, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 140, amplitude: 2.7, zoom: 2.7 } as unknown as BpmChange,
      ], 1.0);
      expect(tl.amplitudeAt(1.185)).toBeCloseTo(0.7 + 0.6 * 0.5, 4);
      const mid2 = 2.37 + (4 - 2.37) / 2;
      expect(tl.amplitudeAt(mid2)).toBeCloseTo(1.3 + 1.4 * 0.875, 4);
      expect(tl.zoomAt(mid2)).toBeCloseTo(1.3 + 1.4 * 0.875, 4);
      const t337 = (3.37 - 2.37) / (4 - 2.37);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.3 + 1.4 * easedCubic(t337, 'ease-out'), 4);
    });

    it('BPM/時刻写像はイージング有無で不変 (3-step)', () => {
      const sectionsNoEase: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7, zoom: 1.0 },
        { beat: 4, bpm: 150, amplitude: 1.5, zoom: 2.0 },
      ];
      const sectionsWithEase: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 150, amplitude: 1.5, zoom: 2.0, easeToNext: 'linear' } as unknown as BpmChange,
      ];
      const tlNo = makeTimeline(sectionsNoEase, 1.0);
      const tlWith = makeTimeline(sectionsWithEase, 1.0);
      expect(tlNo.beatToMs(0.37)).toBeCloseTo(tlWith.beatToMs(0.37), 5);
      expect(tlNo.beatToMs(1.23)).toBeCloseTo(tlWith.beatToMs(1.23), 5);
      expect(tlNo.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(tlWith.bpmAt(4.37)).toBeCloseTo(150, 5);
      expect(tlWith.msToBeat(tlWith.beatToMs(2.37))).toBeCloseTo(2.37, 3);
    });
  });

  describe('5. TOML往復後のease-outも3次式で一致 (3-step)', () => {
    it('chartToToml -> parseChartText 往復後、ease-out中間が0.875で再現 (off-grid)', () => {
      const chartBefore: Chart = {
        title: 'RoundTrip Ease cubic',
        artist: 'Tester',
        audio: 'rt.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.5, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 1.5, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: 8.25, bpm: 140, amplitude: 2.7 } as unknown as BpmChange,
        ],
        segments: [],
        rings: [],
      };
      const toml = chartToToml(chartBefore);
      expect(toml).toContain('ease_to_next = "linear"');
      expect(toml).toContain('ease_to_next = "ease-out"');
      const reparsed = parseChartText(toml);
      const tl = makeTimeline(reparsed.bpm_changes, reparsed.amplitude);
      const midBeat = 4.37 + (8.25 - 4.37) / 2;
      const expectedMid = 1.3 + (2.7 - 1.3) * 0.875;
      expect(tl.amplitudeAt(midBeat)).toBeCloseTo(expectedMid, 3);
      // Verify not old 0.75
      expect(tl.amplitudeAt(midBeat)).not.toBeCloseTo(1.3 + 1.4 * 0.75, 3);
      const tOff = (5.37 - 4.37) / (8.25 - 4.37);
      expect(tl.amplitudeAt(5.37)).toBeCloseTo(1.3 + 1.4 * easedCubic(tOff, 'ease-out'), 3);
    });

    it('AGENTS.md T202のゴールデン値が 0.875 に更新されている (3-step)', () => {
      const agents = fs.readFileSync('AGENTS.md', 'utf-8');
      const t202Block = agents.slice(agents.indexOf('[T202]'), agents.indexOf('[T202]') + 5000);
      // Should contain 0.875 for ease-out, not 0.75
      expect(t202Block).toMatch(/0\.875/);
      // Ensure the t=0.5 line mentions 0.875
      expect(t202Block).toMatch(/t=0\.5[\s\S]*?0\.875|0\.875[\s\S]*?t=0\.5/);
    });
  });

  describe('6. SegmentEditor 下書き確定化 — ソースパターン検証 (3-step)', () => {
    it('beats欄は下書きstateを持ち、表示は下書き優先、確定はonBlur/Enterのみ、無効値は直前値復帰 (3-step)', () => {
      const src = fs.readFileSync('src/screens/editor/SegmentEditor.tsx', 'utf-8');
      // Step1: capture before — currently immediate
      const hasImmediate = /onChange=\{\(e\) => updateBeats\(i,\s*Number\(e\.target\.value\)\)/.test(src);
      void hasImmediate;
      // Step2: assert draft presence
      // Must have draft-related state (draftBeats / draft / useState per row)
      expect(src).toMatch(/draft/i);
      expect(src).toMatch(/useState/);
      // Step3: assert commit only onBlur or Enter, not immediate onChange quantization
      expect(src).toMatch(/onBlur/);
      expect(src).toMatch(/onKeyDown/);
      expect(src).toMatch(/Enter/);
      // Must handle invalid -> revert (finite >0 check and revert)
      expect(src).toMatch(/Number\.isFinite/);
      // Must not have immediate updateBeats onChange for beats (should be draft set)
      expect(src).not.toMatch(/onChange=\{\(e\) => updateBeats\(i,\s*Number\(e\.target\.value\)\)/);
      // Must reference snap quantization on commit (quantizeBeat or snap)
      expect(src).toMatch(/quantize|snap/i);
    });

    it('beats入力の無効値（空欄/0/NaN）が矯正されず確定時に直前値に戻るロジックが含まれる (3-step)', () => {
      const src = fs.readFileSync('src/screens/editor/SegmentEditor.tsx', 'utf-8');
      // Should validate finite and >0 before commit
      expect(src).toMatch(/> ?0/);
      // Should have fallback to previous value (revert) — look for revert/prev or direct conditional
      const hasRevertLogic = /prev|直前|revert|return/i.test(src) || src.includes('seg.beats');
      expect(hasRevertLogic).toBe(true);
      // Should not have immediate `beats >0 ? beats :1` on every keystroke
      const immediateCorrect = src.match(/const v = Number\.isFinite\(beats\) && beats > 0 \? beats : 1/);
      // After fix, that immediate pattern should be gone or moved to onBlur only
      // If file still has updateBeats with that line and no draft, fail
      if (immediateCorrect) {
        // Ensure draft exists to prove it's not immediate
        expect(src).toMatch(/draft/i);
      }
    });
  });

  describe('7. BpmEditor beat欄 下書き確定化 — ソースパターン検証 (3-step)', () => {
    it('beat欄は下書きテキストstateを持ち、確定はonBlur/Enterでソート結合、onChangeでは確定しない (3-step)', () => {
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      // Step1: capture — currently beatValues is number[] with safeBeat immediate
      const hasNumberDraft = /beatValues.*number\[\]/.test(src);
      void hasNumberDraft;
      // Step2: should have string-like draft (text draft) after fix, or draftBeat pattern
      const hasDraft = /draft/i.test(src);
      expect(hasDraft).toBe(true);
      expect(src).toMatch(/onBlur/);
      expect(src).toMatch(/onKeyDown/);
      // Should have sortByBeat on commit (T203)
      expect(src).toMatch(/sortByBeat/);
      // After fix, value should be draft-driven, not safeBeat immediate number
      // onChange should set draft string, not safeBeat(Number(...))
      // Check that onChange does NOT directly call safeBeat for beat commit
      // Instead it should set draft text
      const draftOnChange = src.match(/setBeatValues|setDraft|setBeatDraft/i);
      expect(draftOnChange !== null).toBe(true);
      // Ensure onBlur does the sortByBeat commit
      const blurSection = src.match(/onBlur[\s\S]*?sortByBeat/);
      expect(blurSection !== null).toBe(true);
    });

    it('BpmEditorのonBlur/Enter確定時に有限>0検証と直前値復帰がある (3-step)', () => {
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/Number\.isFinite/);
      // Should contain logic to revert on invalid (empty/NaN) — check for fallback
      expect(src).toMatch(/safeBeat|isFinite/);
      // Must handle Enter key for commit
      expect(src).toMatch(/e\.key === 'Enter'/);
    });
  });

  describe('8. イージング0.875の厳密数値 + 複雑振幅・オフグリッド総合 (3-step)', () => {
    it('t=0.5で linear 0.5 / ease-out 0.875 / ease-in 0.25 が同時成立 (3-step)', () => {
      const base = { beat: 0, bpm: 120, amplitude: 0.0 };
      // Linear
      const tlLin = makeTimeline([{ ...base, amplitude: 0.0, easeToNext: 'linear' } as unknown as BpmChange, { beat: 4, bpm: 120, amplitude: 1.0 }], 0.0);
      expect(tlLin.amplitudeAt(2)).toBeCloseTo(0.5, 5);
      // Ease-out cubic
      const tlOut = makeTimeline([{ ...base, amplitude: 0.0, easeToNext: 'ease-out' } as unknown as BpmChange, { beat: 4, bpm: 120, amplitude: 1.0 }], 0.0);
      expect(tlOut.amplitudeAt(2)).toBeCloseTo(0.875, 5);
      // Ease-in
      const tlIn = makeTimeline([{ ...base, amplitude: 0.0, easeToNext: 'ease-in' } as unknown as BpmChange, { beat: 4, bpm: 120, amplitude: 1.0 }], 0.0);
      expect(tlIn.amplitudeAt(2)).toBeCloseTo(0.25, 5);
      // Cross-check against quadratic
      expect(tlOut.amplitudeAt(2)).not.toBeCloseTo(0.75, 3);
    });

    it('複雑振幅 0.7/1.3/2.7/3.4 とオフグリッド 0.37/1.23/3.37/5.23 で cubic 一貫 (3-step)', () => {
      const pairs: Array<{ s: number; e: number; b0: number; b1: number }> = [
        { s: 0.7, e: 1.3, b0: 0, b1: 4 },
        { s: 1.3, e: 2.7, b0: 2, b1: 6 },
        { s: 2.7, e: 3.4, b0: 4, b1: 8 },
      ];
      for (const { s, e, b0, b1 } of pairs) {
        const tl = makeTimeline([
          { beat: b0, bpm: 120, amplitude: s, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: b1, bpm: 120, amplitude: e },
        ], 1.0);
        const mid = b0 + (b1 - b0) / 2;
        expect(tl.amplitudeAt(mid)).toBeCloseTo(s + (e - s) * 0.875, 4);
        for (const off of [0.37, 1.23, 3.37, 5.23]) {
          if (off < b0 || off > b1) continue;
          const t = (off - b0) / (b1 - b0);
          expect(tl.amplitudeAt(off)).toBeCloseTo(s + (e - s) * easedCubic(t, 'ease-out'), 4);
        }
      }
    });
  });

  describe('9. 回帰: ステップ区間・ゼロ長・継承値 は従来通り', () => {
    it('ease無しはステップ: 途中は開始値、到達で瞬間切替 (off-grid)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.5, 5);
    });

    it('ゼロ長区間は瞬間切替フォールバック (cubicでも)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.8 },
      ], 1.0);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.7 + 0.3 * 0.875, 4);
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.8, 5);
      expect(Number.isFinite(tl.amplitudeAt(3.99))).toBe(true);
    });
  });
});
