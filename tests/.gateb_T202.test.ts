/**
 * T202 — セクション間イージングの型・TOML・補間計算 Vitest pure acceptance
 * node environment — pure engine math, no DOM, TDD Red->Green
 * Spec: easeToNext?: 'linear'|'ease-out'|'ease-in' on BpmChange,
 *       BpmTimeline amplitudeAt/zoomAt interpolation,
 *       loader/serialize ease_to_next, t=0.5 0.5/0.875/0.25 off-grid required,
 *       no-ease => step, zero-length fallback.
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

function eased(t: number, kind: 'linear' | 'ease-out' | 'ease-in'): number {
  if (kind === 'linear') return t;
  if (kind === 'ease-out') return 1 - Math.pow(1 - t, 3);
  if (kind === 'ease-in') return Math.pow(t, 2);
  return t;
}

describe('T202 セクション間イージング — Vitest pure engine (TDD Red)', () => {
  describe('0. BpmChange.easeToNext 型定義', () => {
    it('types.ts に easeToNext?: linear|ease-out|ease-in が定義される (3-step)', () => {
      const beforeSrc = fs.readFileSync('src/types.ts', 'utf-8');
      const hasBeforePattern = beforeSrc.includes('easeToNext');
      void hasBeforePattern;
      const src = fs.readFileSync('src/types.ts', 'utf-8');
      expect(src).toMatch(/easeToNext\?\s*:\s*['"]linear['"]\s*\|\s*['"]ease-out['"]\s*\|\s*['"]ease-in['"]/);
      expect(src).toMatch(/interface BpmChange[\s\S]*?easeToNext/);
    });
  });

  describe('1. amplitudeAt linear イージング (t=0.5で0.5) off-grid', () => {
    it('beat 0 amp0.7 -> beat4 amp1.5 linear: 中間2.0で0.5補間, 端数0.37で線形一致 (3-step)', () => {
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      const beforeMid = tlStep.amplitudeAt(2);
      expect(beforeMid).toBeCloseTo(0.7, 5);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      const start = 0.7, end = 1.5;
      const atMid = tl.amplitudeAt(2);
      expect(atMid).toBeCloseTo(start + (end - start) * 0.5, 4);
      const t037 = (0.37 - 0) / 4;
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(start + (end - start) * eased(t037, 'linear'), 4);
      const t123 = (1.23 - 0) / 4;
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(start + (end - start) * eased(t123, 'linear'), 4);
      expect(tl.amplitudeAt(0)).toBeCloseTo(start, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(end, 5);
      expect(tl.amplitudeAt(4.01)).toBeCloseTo(end, 5);
      expect(atMid).not.toBeCloseTo(beforeMid, 4);
    });

    it('複雑振幅 1.3<->2.7 linear off-grid 3.37等で数値整合 (3-step)', () => {
      const tlBefore = makeTimeline([
        { beat: 2, bpm: 130, amplitude: 1.3 },
        { beat: 6, bpm: 130, amplitude: 2.7 },
      ], 1.0);
      expect(tlBefore.amplitudeAt(4)).toBeCloseTo(1.3, 5);
      const tl = makeTimeline([
        { beat: 2, bpm: 130, amplitude: 1.3, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 6, bpm: 130, amplitude: 2.7 },
      ], 1.0);
      const start = 1.3, end = 2.7, span = 4;
      expect(tl.amplitudeAt(2)).toBeCloseTo(start, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(start + (end - start) * 0.5, 4);
      expect(tl.amplitudeAt(6)).toBeCloseTo(end, 5);
      const t337 = (3.37 - 2) / span;
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(start + (end - start) * t337, 4);
      const t523 = (5.23 - 2) / span;
      expect(tl.amplitudeAt(5.23)).toBeCloseTo(start + (end - start) * t523, 4);
    });
  });

  describe('2. amplitudeAt ease-out (t=0.5で0.875) off-grid', () => {
    it('beat0 amp0.5->beat4 amp1.5 ease-out: mid 0.875, 端数0.37/1.23で曲線一致 (3-step)', () => {
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
      expect(tl.amplitudeAt(2)).toBeCloseTo(start + (end - start) * 0.875, 4);
      expect(tl.amplitudeAt(2)).not.toBeCloseTo(beforeMid, 4);
      const t037 = (0.37 - 0) / 4;
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(start + (end - start) * eased(t037, 'ease-out'), 4);
      const t123 = (1.23 - 0) / 4;
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(start + (end - start) * eased(t123, 'ease-out'), 4);
      expect(tl.amplitudeAt(1.0)).toBeCloseTo(start + (end - start) * eased(0.25, 'ease-out'), 4);
      expect(tl.amplitudeAt(3.0)).toBeCloseTo(start + (end - start) * eased(0.75, 'ease-out'), 4);
      expect(tl.amplitudeAt(0)).toBeCloseTo(start, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(end, 5);
    });

    it('複雑amp 2.7 -> 0.7 ease-out でも数値整合 (降順) (3-step)', () => {
      const tl = makeTimeline([
        { beat: 1, bpm: 120, amplitude: 2.7, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 5, bpm: 120, amplitude: 0.7 },
      ], 1.0);
      const start = 2.7, end = 0.7;
      expect(tl.amplitudeAt(3.0)).toBeCloseTo(start + (end - start) * 0.875, 4);
      const tOff = (2.37 - 1) / 4;
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(start + (end - start) * eased(tOff, 'ease-out'), 4);
    });
  });

  describe('3. amplitudeAt ease-in (t=0.5で0.25) off-grid', () => {
    it('beat0 amp0.5->beat4 amp1.5 ease-in: mid 0.25, 端数0.37/1.23で曲線一致 (3-step)', () => {
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.5 },
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      const beforeMid = tlStep.amplitudeAt(2);
      expect(beforeMid).toBeCloseTo(0.5, 5);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.5, easeToNext: 'ease-in' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      const start = 0.5, end = 1.5;
      expect(tl.amplitudeAt(2)).toBeCloseTo(start + (end - start) * 0.25, 4);
      expect(tl.amplitudeAt(2)).not.toBeCloseTo(beforeMid, 4);
      const t037 = (0.37) / 4;
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(start + (end - start) * eased(t037, 'ease-in'), 4);
      const t123 = (1.23) / 4;
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(start + (end - start) * eased(t123, 'ease-in'), 4);
      expect(tl.amplitudeAt(1.0)).toBeCloseTo(start + (end - start) * eased(0.25, 'ease-in'), 4);
      expect(tl.amplitudeAt(3.0)).toBeCloseTo(start + (end - start) * eased(0.75, 'ease-in'), 4);
      expect(tl.amplitudeAt(0)).toBeCloseTo(start, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(end, 5);
    });
  });

  describe('4. zoomAt イージング (amplitudeと同ロジック) off-grid', () => {
    it('zoom linear ease-out ease-in の t=0.5 で 0.5/0.875/0.25 (3-step)', () => {
      const tlStep = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0 } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlStep.zoomAt(2)).toBeCloseTo(1.0, 5);
      const tlLin = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'linear' } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlLin.zoomAt(2)).toBeCloseTo(1.5, 4);
      expect(tlLin.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(0.0925, 'linear'), 4);
      expect(tlLin.zoomAt(1.23)).toBeCloseTo(1.0 + 1.0 * eased(0.3075, 'linear'), 4);
      const tlOut = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlOut.zoomAt(2)).toBeCloseTo(1.875, 4);
      expect(tlOut.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(0.0925, 'ease-out'), 4);
      expect(tlOut.zoomAt(1.23)).toBeCloseTo(1.0 + 1.0 * eased(0.3075, 'ease-out'), 4);
      const tlIn = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-in' } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlIn.zoomAt(2)).toBeCloseTo(1.25, 4);
      expect(tlIn.zoomAt(0.37)).toBeCloseTo(1.0 + 1.0 * eased(0.0925, 'ease-in'), 4);
    });

    it('zoom 複雑値 0.7->1.3 linear と 2.7 off-grid で数値整合 (3-step)', () => {
      const tl = makeTimeline([
        { beat: 2, bpm: 120, zoom: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 6, bpm: 120, zoom: 1.3 } as unknown as BpmChange,
      ], 1.0);
      expect(tl.zoomAt(4)).toBeCloseTo(1.0, 4);
      expect(tl.zoomAt(3.37)).toBeCloseTo(0.7 + 0.6 * eased((3.37 - 2) / 4, 'linear'), 4);
      expect(tl.zoomAt(2.37)).toBeCloseTo(0.7 + 0.6 * eased((2.37 - 2) / 4, 'linear'), 4);
    });
  });

  describe('5. イージング無し区間は従来通りのステップ', () => {
    it('easeToNext無しはステップ: 途中は開始値、beat到達で瞬間切替 (3-step off-grid)', () => {
      const tlEase = makeTimeline([{ beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange, { beat: 4, bpm: 120, amplitude: 1.5 }], 1.0);
      expect(tlEase.amplitudeAt(2)).toBeCloseTo(1.1, 4);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ], 1.0);
      expect(tl.amplitudeAt(0)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(1.23)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(3.99)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.5, 5);
      expect(tl.amplitudeAt(4.23)).toBeCloseTo(1.5, 5);
      const tlZoomStep = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.0 } as unknown as BpmChange, { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange], 1.0);
      expect(tlZoomStep.zoomAt(2)).toBeCloseTo(1.0, 5);
      expect(tlZoomStep.zoomAt(3.99)).toBeCloseTo(1.0, 5);
      expect(tlZoomStep.zoomAt(4)).toBeCloseTo(2.0, 5);
    });

    it('混合: 区間A has ease, 区間B has no ease — それぞれ挙動が分離 (3-step)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
        { beat: 8, bpm: 120, amplitude: 2.5 },
      ], 1.0);
      expect(tl.amplitudeAt(2)).toBeCloseTo(1.1, 4);
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.5, 5);
      expect(tl.amplitudeAt(6)).toBeCloseTo(1.5, 5);
      expect(tl.amplitudeAt(7.99)).toBeCloseTo(1.5, 5);
      expect(tl.amplitudeAt(8)).toBeCloseTo(2.5, 5);
      const tlZ = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange,
        { beat: 8, bpm: 120, zoom: 3.0 } as unknown as BpmChange,
      ], 1.0);
      expect(tlZ.zoomAt(2)).toBeCloseTo(1.875, 4);
      expect(tlZ.zoomAt(6)).toBeCloseTo(2.0, 5);
    });
  });

  describe('6. ゼロ長区間 (A.beat==B.beat) は瞬間切替フォールバック', () => {
    it('同beat 4に2エントリ(collocated)でease linearでも瞬間切替 (3-step)', () => {
      const tlNormal = makeTimeline([{ beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange, { beat: 4, bpm: 120, amplitude: 1.5 }], 1.0);
      expect(tlNormal.amplitudeAt(2)).toBeCloseTo(1.1, 4);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.8 },
      ], 1.0);
      expect(tl.amplitudeAt(0)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.85, 4);
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.8, 5);
      expect(tl.amplitudeAt(3.99)).not.toBeCloseTo(1.8, 1);
      expect(Number.isFinite(tl.amplitudeAt(2))).toBe(true);
      expect(Number.isFinite(tl.amplitudeAt(4))).toBe(true);
    });

    it('ゼロ長 zoom でも stepフォールバック (3-step)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 3.0 } as unknown as BpmChange,
      ], 1.0);
      expect(tl.zoomAt(2)).toBeCloseTo(1.875, 4);
      expect(tl.zoomAt(4)).toBeCloseTo(3.0, 5);
      expect(Number.isFinite(tl.zoomAt(3.99))).toBe(true);
    });
  });

  describe('7. 端点値は既存解決規則 — 未設定なら継承値で補間', () => {
    it('amplitude: start定義・end未定義 => フラット補間 (start->start) (3-step off-grid)', () => {
      const tlStep = makeTimeline([{ beat: 0, bpm: 120, amplitude: 0.8 }, { beat: 4, bpm: 120 }, { beat: 8, bpm: 120, amplitude: 1.6 }], 1.0);
      expect(tlStep.amplitudeAt(2)).toBeCloseTo(0.8, 5);
      expect(tlStep.amplitudeAt(6)).toBeCloseTo(0.8, 5);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.8, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120 },
        { beat: 8, bpm: 120, amplitude: 1.6 },
      ], 1.0);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.8, 4);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.8, 4);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(0.8, 4);
      expect(tl.amplitudeAt(4)).toBeCloseTo(0.8, 5);
      expect(tl.amplitudeAt(6)).toBeCloseTo(0.8, 5);
    });

    it('zoom: baseフォールバック: 未定義start => base(1.0)から開始 (3-step)', () => {
      const tl = makeTimeline([
        { beat: 0, bpm: 120, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0 } as unknown as BpmChange,
      ], 1.0);
      expect(tl.zoomAt(0)).toBeCloseTo(1.0, 5);
      expect(tl.zoomAt(2)).toBeCloseTo(1.5, 4);
      expect(tl.zoomAt(4)).toBeCloseTo(2.0, 5);
    });

    it('baseAmplitudeカスタム(0.7) が始値として引き継がれる (3-step)', () => {
      const tl = makeTimeline([
        { beat: 4, bpm: 120, amplitude: 1.5, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 8, bpm: 120, amplitude: 2.5 },
      ], 0.7);
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(2)).toBeCloseTo(0.7, 5);
      expect(tl.amplitudeAt(4)).toBeCloseTo(1.5, 5);
      expect(tl.amplitudeAt(6)).toBeCloseTo(2.0, 4);
    });
  });

  describe('8. BPM/時刻写像はイージング影響なし（瞬間切替）', () => {
    it('ease有無がbeatToMs/bpmAt/beatMsAtに影響しない (3-step off-grid)', () => {
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
      expect(tlNo.beatToMs(4.37)).toBeCloseTo(tlWith.beatToMs(4.37), 5);
      expect(tlNo.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(tlWith.bpmAt(0.37)).toBeCloseTo(120, 5);
      expect(tlNo.bpmAt(4.37)).toBeCloseTo(150, 5);
      expect(tlWith.bpmAt(4.37)).toBeCloseTo(150, 5);
      expect(tlNo.beatMsAt(0.37)).toBeCloseTo(500, 5);
      expect(tlWith.beatMsAt(4.37)).toBeCloseTo(400, 5);
      expect(tlWith.msToBeat(tlWith.beatToMs(2.37))).toBeCloseTo(2.37, 3);
    });
  });

  describe('9. TOML loader/serialize ease_to_next 入出力と不正値無視', () => {
    it('parseChartTextが [[sections]] ease_to_next 3種を読み込む (3-step)', () => {
      const tomlNoEase = `
title = "NoEase"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 0.7
[[sections]]
beat = 4
bpm = 150
amplitude = 1.5
`;
      const parsedNo = parseChartText(tomlNoEase);
      expect((parsedNo.bpm_changes[0] as any).easeToNext).toBeUndefined();
      expect((parsedNo.bpm_changes[1] as any).easeToNext).toBeUndefined();
      const tomlWithEase = `
title = "WithEase"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
amplitude = 0.7
ease_to_next = "linear"
[[sections]]
beat = 4
bpm = 150
amplitude = 1.5
ease_to_next = "ease-out"
[[sections]]
beat = 8
bpm = 140
amplitude = 2.0
ease_to_next = "ease-in"
`;
      const parsed = parseChartText(tomlWithEase);
      expect((parsed.bpm_changes[0] as any).easeToNext).toBe('linear');
      expect((parsed.bpm_changes[1] as any).easeToNext).toBe('ease-out');
      expect((parsed.bpm_changes[2] as any).easeToNext).toBe('ease-in');
    });

    it('不正なease_to_next値(bogus/empty/number)は無視してundefined扱い (3-step)', () => {
      const tomlInvalid = `
title = "Invalid"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
ease_to_next = "bogus"
[[sections]]
beat = 4
bpm = 130
ease_to_next = ""
[[sections]]
beat = 8
bpm = 140
ease_to_next = "LINEAR"
`;
      const parsed = parseChartText(tomlInvalid);
      expect((parsed.bpm_changes[0] as any).easeToNext).toBeUndefined();
      expect((parsed.bpm_changes[1] as any).easeToNext).toBeUndefined();
      expect((parsed.bpm_changes[2] as any).easeToNext).toBeUndefined();
      const chartObj: Chart = {
        title: 'Garbage',
        artist: '',
        audio: 'g.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, easeToNext: 'bogus' } as unknown as BpmChange,
          { beat: 4, bpm: 120, easeToNext: '' } as unknown as BpmChange,
          { beat: 8, bpm: 120, easeToNext: 'linear' } as unknown as BpmChange,
        ],
        segments: [],
        rings: [],
      };
      const tomlFromGarbage = chartToToml(chartObj as unknown as Chart);
      const reparsed = parseChartText(tomlFromGarbage);
      expect((reparsed.bpm_changes[0] as any).easeToNext).toBeUndefined();
      expect((reparsed.bpm_changes[1] as any).easeToNext).toBeUndefined();
      expect((reparsed.bpm_changes[2] as any).easeToNext).toBe('linear');
    });

    it('chartToTomlが ease_to_next を有効値のみ出力し、読み戻し(TOML往復)で一致 (3-step off-grid)', () => {
      const chartBefore: Chart = {
        title: 'RoundTrip Ease 0.37',
        artist: 'Tester',
        audio: 'rt.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 0.7, zoom: 0.5, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 1.5, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: 8.25, bpm: 140, amplitude: 2.7 } as unknown as BpmChange,
          { beat: 12.125, bpm: 130, zoom: 2.0, easeToNext: 'ease-in' } as unknown as BpmChange,
        ],
        segments: [],
        rings: [],
      };
      const beforeToml = chartToToml(chartBefore);
      const beforeLines = beforeToml.split('\n').filter(l => l.includes('ease_to_next'));
      expect(beforeLines.length).toBe(3);
      expect(beforeToml).toContain('ease_to_next = "linear"');
      expect(beforeToml).toContain('ease_to_next = "ease-out"');
      expect(beforeToml).toContain('ease_to_next = "ease-in"');
      const reparsed = parseChartText(beforeToml);
      expect(reparsed.bpm_changes.length).toBe(4);
      expect((reparsed.bpm_changes[0] as any).easeToNext).toBe('linear');
      expect((reparsed.bpm_changes[1] as any).easeToNext).toBe('ease-out');
      expect((reparsed.bpm_changes[2] as any).easeToNext).toBeUndefined();
      expect((reparsed.bpm_changes[3] as any).easeToNext).toBe('ease-in');
      expect(reparsed.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect(reparsed.bpm_changes[2].beat).toBeCloseTo(8.25, 3);
      expect(reparsed.bpm_changes[3].beat).toBeCloseTo(12.125, 3);
      expect((reparsed.bpm_changes[0] as any).zoom).toBeCloseTo(0.5, 3);
      expect(reparsed.bpm_changes[0].amplitude).toBeCloseTo(0.7, 3);
      const tl = makeTimeline(reparsed.bpm_changes, reparsed.amplitude);
      const midBeat = 4.37 + (8.25 - 4.37) / 2;
      const expectedMid = 1.3 + (2.7 - 1.3) * 0.875;
      expect(tl.amplitudeAt(midBeat)).toBeCloseTo(expectedMid, 3);
    });

    it('旧 [[bpm_changes]] エイリアスでも ease_to_next が読み込まれる (3-step)', () => {
      const oldToml = `
title = "OldAlias"
artist = ""
audio = "a.flac"
[[bpm_changes]]
beat = 0
bpm = 120
amplitude = 0.7
ease_to_next = "linear"
[[bpm_changes]]
beat = 4
bpm = 130
amplitude = 1.5
`;
      const parsed = parseChartText(oldToml);
      expect((parsed.bpm_changes[0] as any).easeToNext).toBe('linear');
      const out = chartToToml(parsed);
      expect(out).toContain('[[sections]]');
      expect(out).not.toContain('[[bpm_changes]]');
      expect(out).toContain('ease_to_next = "linear"');
    });
  });

  describe('10. 総合回帰 — 複雑振幅 + オフグリッド + 複数区間混合', () => {
    it('多区間混合 ease(linear/out/in) + ステップで各区間の mid/off-grid が正確 (3-step)', () => {
      const tlSingle = makeTimeline([{ beat: 0, bpm: 120, amplitude: 1.0, easeToNext: 'linear' } as unknown as BpmChange, { beat: 2, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(tlSingle.amplitudeAt(1)).toBeCloseTo(1.5, 4);
      const tl = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, zoom: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
        { beat: 2.37, bpm: 130, amplitude: 1.3, zoom: 1.3, easeToNext: 'ease-out' } as unknown as BpmChange,
        { beat: 4, bpm: 140, amplitude: 2.7, zoom: 2.7 } as unknown as BpmChange,
        { beat: 8, bpm: 150, amplitude: 2.7, zoom: 2.0, easeToNext: 'ease-in' } as unknown as BpmChange,
      ], 1.0);
      expect(tl.amplitudeAt(1.185)).toBeCloseTo(0.7 + 0.6 * 0.5, 4);
      expect(tl.zoomAt(1.185)).toBeCloseTo(1.0 + 0.3 * 0.5, 4);
      const t0 = 0.37 / 2.37;
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(0.7 + 0.6 * eased(t0, 'linear'), 4);
      const mid2 = 2.37 + (4 - 2.37) / 2;
      expect(tl.amplitudeAt(mid2)).toBeCloseTo(1.3 + 1.4 * 0.875, 4);
      expect(tl.zoomAt(mid2)).toBeCloseTo(1.3 + 1.4 * 0.875, 4);
      const t337 = (3.37 - 2.37) / (4 - 2.37);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.3 + 1.4 * eased(t337, 'ease-out'), 4);
      expect(tl.amplitudeAt(6)).toBeCloseTo(2.7, 5);
      expect(tl.amplitudeAt(7.99)).toBeCloseTo(2.7, 5);
      expect(tl.zoomAt(6)).toBeCloseTo(2.7, 5);
    });

    it('TOML往復後の複合chartでtimeline補間とbeatToMs両立 (3-step)', () => {
      const chartOrig: Chart = {
        title: 'Complex Easing Whole',
        artist: 'QA',
        audio: 'c.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, zoom: 1.0, easeToNext: 'linear' } as unknown as BpmChange,
          { beat: 2, bpm: 150, amplitude: 2.0, zoom: 2.0, easeToNext: 'ease-out' } as unknown as BpmChange,
          { beat: 4.37, bpm: 180, amplitude: 0.5, zoom: 0.5 } as unknown as BpmChange,
        ],
        segments: [],
        rings: [],
      };
      const tomlStr = chartToToml(chartOrig);
      const parsed = parseChartText(tomlStr);
      const tl = makeTimeline(parsed.bpm_changes, parsed.amplitude);
      expect(tl.amplitudeAt(1)).toBeCloseTo(1.5, 4);
      const midOut = 2 + (4.37 - 2) / 2;
      expect(tl.amplitudeAt(midOut)).toBeCloseTo(2.0 + (0.5 - 2.0) * 0.875, 4);
      expect(tl.bpmAt(1)).toBeCloseTo(120, 5);
      expect(tl.bpmAt(3)).toBeCloseTo(150, 5);
      expect(tl.bpmAt(4.37)).toBeCloseTo(180, 5);
      const tlNoEase = makeTimeline([{ beat: 0, bpm: 120 }, { beat: 2, bpm: 150 }, { beat: 4.37, bpm: 180 }], 1.0);
      expect(tl.beatToMs(3.37)).toBeCloseTo(tlNoEase.beatToMs(3.37), 5);
    });
  });
});
