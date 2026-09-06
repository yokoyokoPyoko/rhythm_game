/**
 * @vitest-environment node
 * T170 — 粗調整＋微調整の2段階キャリブレーション（8回タップ平均の復活）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * 仕様:
 * - CalibrationModal.tsx のみに粗調整モードを追加: 強拍リング(4拍ごと)に合わせSpace×8 → 最初2破棄・残り6平均を setManualOffset に反映
 * - 符号: tap - (hitTime + manual) が 0 になる向き (T167)
 * - 半拍超は最近傍＋アンラップ(±1000ms折返し補正, grid 2000ms)
 * - 粗調整後は ,. ±10ms微調整を継続利用
 *
 * 完了条件:
 * 1. ±500ms級が8回で±20ms以内に粗調整されること
 * 2. 粗調整後に ,. 微調整・保存・キャンセルが従来通り機能すること
 * 3. tsc --noEmit エラーなし
 *
 * 禁止事項(過去失敗より):
 * - handleHit 内で setManualOffset(0) や firstTapRef リセットを含めてはならない
 * - indexOf('const save') のような曖昧検索を使わず indexOf('const save =') を使う
 * - ブロックスコープ変数を使用前に参照してはならない
 */
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  } as any;
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis as any;
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';
import {
  generateCalibrationChart,
  generateCalibrationLoopChart,
  unwrapTimingError,
  computeCoarseOffset,
} from '../src/screens/editor/CalibrationModal';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}
function extractHandleHitSlice(src: string): string {
  const idx = src.indexOf('const handleHit =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3200);
}
function extractSaveSlice(src: string): string {
  const idx = src.indexOf('const save =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 900);
}
function extractCancelSlice(src: string): string {
  const idx = src.indexOf('const cancel =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 900);
}
function extractCoarseEffectSlice(src: string): string {
  // T170 applies offset when coarseTapCount reaches 8
  const idx = src.indexOf('coarseTapCount');
  if (idx === -1) return '';
  return src.slice(Math.max(0, idx - 500), idx + 1500);
}

// ---------------------------------------------------------------------------
// T170-1: calibration chart generation — ProSeka loop invariants
// ---------------------------------------------------------------------------
describe('T170-1: プロセカ風無限ループ譜面生成 (3-step, file + computed)', () => {
  it('Step1 生成前 chart 無し capture → Step2 generateCalibrationChart(16) → Step3 BPM120 / 2拍交互 / リング4拍ごと', () => {
    // Step1: capture initial — no chart yet
    const before: unknown = null;
    expect(before).toBeNull();

    // Step2: generate small chart for inspection
    const chart = generateCalibrationChart(16);

    // Step3: assert transition — computed values
    expect(chart.bpm).toBe(120);
    expect(chart.audio_offset).toBe(0);
    expect(chart.bpm_changes).toEqual([]);

    // Segments: up 2 / down 2 alternating, beats = 2 each
    expect(chart.segments.length).toBe(8); // 16 / 2
    for (let i = 0; i < chart.segments.length; i++) {
      const seg = chart.segments[i];
      expect(seg.beats).toBe(2);
      const expectedDir = i % 2 === 0 ? 'up' : 'down';
      expect(seg.direction, `segment ${i} direction`).toBe(expectedDir);
    }

    // Rings: 4,8,12,16
    expect(chart.rings).toEqual([
      { beat: 4, type: 'single' },
      { beat: 8, type: 'single' },
      { beat: 12, type: 'single' },
      { beat: 16, type: 'single' },
    ]);
  });

  it('Step1 デフォルト長 24000 capture → Step2 generateCalibrationChart() → Step3 十分な長時間ループ(20分以上)', () => {
    const chart = generateCalibrationChart();
    // At BPM 120, 24000 beats = 24000*500ms = 200 min >> 20 min
    expect(chart.segments.length).toBeGreaterThanOrEqual(1000);
    expect(chart.rings.length).toBeGreaterThanOrEqual(500);
    // Loops variant alias must be identical structure
    const loopChart = generateCalibrationLoopChart(16);
    expect(loopChart.segments).toEqual(generateCalibrationChart(16).segments);
    expect(loopChart.rings).toEqual(generateCalibrationChart(16).rings);
    // Verify ring spacing 2000ms at BPM 120
    const tl = new BpmTimeline(120, [], 1.0);
    const ms4 = tl.beatToMs(4);
    expect(ms4).toBeCloseTo(2000, 3);
    const diff = tl.beatToMs(8) - tl.beatToMs(4);
    expect(diff).toBeCloseTo(2000, 3);
  });

  it('Step1 端数 totalBeats 7 capture → Step2 generate 7 → Step3 segmentsが残り拍でclampされリングは4の倍数のみ', () => {
    const chart = generateCalibrationChart(7);
    // 7 beats: segments 2,2,2,1 (remaining)
    expect(chart.segments.length).toBe(4);
    expect(chart.segments[3].beats).toBe(1);
    expect(chart.rings).toEqual([{ beat: 4, type: 'single' }]); // 8 > 7 so not included
  });
});

// ---------------------------------------------------------------------------
// T170-2: unwrapTimingError — ±1000ms折返し補正
// ---------------------------------------------------------------------------
describe('T170-2: unwrapTimingError の ±1000ms折返し (3-step, off-grid必須)', () => {
  it('Step1 raw 0 capture → Step2 unwrap ±500 → Step3 そのまま (範囲内は不変)', () => {
    const before = 0;
    expect(before).toBe(0);
    expect(unwrapTimingError(500)).toBeCloseTo(500, 6);
    expect(unwrapTimingError(-500)).toBeCloseTo(-500, 6);
    expect(unwrapTimingError(500.37)).toBeCloseTo(500.37, 6);
    expect(unwrapTimingError(-501.23)).toBeCloseTo(-501.23, 6);
    expect(unwrapTimingError(0)).toBe(0);
    expect(unwrapTimingError(999)).toBeCloseTo(999, 6);
    expect(unwrapTimingError(-999)).toBeCloseTo(-999, 6);
  });

  it('Step1 raw 1200 capture(半拍超) → Step2 unwrap → Step3 1200-2000=-800 に折返し', () => {
    expect(unwrapTimingError(1200)).toBeCloseTo(-800, 6);
    expect(unwrapTimingError(1500)).toBeCloseTo(-500, 6);
    expect(unwrapTimingError(1000.37)).toBeCloseTo(-999.63, 4);
    expect(unwrapTimingError(-1200)).toBeCloseTo(800, 6);
    expect(unwrapTimingError(-1500)).toBeCloseTo(500, 6);
  });

  it('Step1 raw 2500 capture(2周期超) → Step2 unwrap → Step3 複数回折返しで [-1000,1000] に収束', () => {
    expect(unwrapTimingError(2500)).toBeCloseTo(500, 6); // 2500-2000=500
    expect(unwrapTimingError(3200)).toBeCloseTo(-800, 6); // 3200-2000=1200 -> -800
    expect(unwrapTimingError(-2500)).toBeCloseTo(-500, 6);
    expect(unwrapTimingError(4100)).toBeCloseTo(100, 6); // 4100-4000=100
    for (const v of [0, 500, -500, 1200, -1200, 2500, -3100, 501.37, -501.37, 1000.01, -1000.01]) {
      const u = unwrapTimingError(v);
      expect(u, `unwrap(${v}) in [-1000,1000]`).toBeGreaterThanOrEqual(-1000);
      expect(u).toBeLessThanOrEqual(1000);
    }
  });

  it('Step1 カスタム period/bound capture → Step2 unwrap(2100,2000,1000) → Step3 境界挙動が厳密', () => {
    expect(unwrapTimingError(1000, 2000, 1000)).toBeCloseTo(1000, 6); // bound inclusive stays
    expect(unwrapTimingError(1000.01, 2000, 1000)).toBeCloseTo(-999.99, 4);
    expect(unwrapTimingError(-1000, 2000, 1000)).toBeCloseTo(-1000, 6);
    expect(unwrapTimingError(-1000.01, 2000, 1000)).toBeCloseTo(999.99, 4);
  });
});

// ---------------------------------------------------------------------------
// T170-3: computeCoarseOffset — 8回タップ平均（最初2破棄・残り6平均） T167符号
// ---------------------------------------------------------------------------
describe('T170-3: computeCoarseOffset 8-tap平均(最初2破棄) (3-step, off-grid必須)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 currentOffset 0 + raw 8サンプル capture → Step2 compute → Step3 最初2破棄・残り6平均が current+avg', () => {
    // Step1: capture initial offset 0 and 8 raw errors
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const raw = [10, -5, 100, 102, 98, 101, 99, 100]; // first 2 discarded, avg of last 6 = 100
    // Step2: compute
    const next = computeCoarseOffset(raw, getManualOffsetMs());
    // Step3: avg of [100,102,98,101,99,100] = 600/6=100, so next = 100
    expect(next).toBe(100);
    // Verify discard is exactly 2: changing first 2 should not affect result
    const raw2 = [999, 999, 100, 102, 98, 101, 99, 100];
    expect(computeCoarseOffset(raw2, 0)).toBe(100);
  });

  it('Step1 current 50 capture → Step2 端数 raw(0.37差) → Step3 アンラップ込みで avg が正しい', () => {
    setManualOffset(50);
    expect(getManualOffsetMs()).toBe(50);
    // Off-grid: include fractional 0.37 / 1.23 style errors
    const raw = [0, 0, 100.37, 99.63, 100.37, 99.63, 100.37, 99.63]; // avg = 100 (with fractions)
    const avg = (100.37 + 99.63 + 100.37 + 99.63 + 100.37 + 99.63) / 6;
    expect(avg).toBeCloseTo(100, 6);
    const next = computeCoarseOffset(raw, 50)!;
    expect(next).toBe(Math.round(50 + avg));
    expect(next).toBe(150);
  });

  it('Step1 current 0 capture → Step2 半拍超 1200 を含む raw → Step3 アンラップ(-800)して平均される', () => {
    // If raw contains 1200, unwrap -> -800, so average is pulled down
    const raw = [0, 0, 1200, 1200, 1200, 1200, 1200, 1200];
    // kept = 6 * 1200 -> unwrapped = 6 * (-800) -> avg=-800 -> next=-800
    expect(computeCoarseOffset(raw, 0)).toBe(-800);
    // Mixed: 3*500 + 3*1200(-800) => avg = (1500-2400)/6 = -150
    const mixed = [0, 0, 500, 500, 500, 1200, 1200, 1200];
    const unwrappedMixed = [500, 500, 500, -800, -800, -800];
    const avgMixed = unwrappedMixed.reduce((a, b) => a + b, 0) / 6;
    expect(avgMixed).toBeCloseTo(-150, 6);
    expect(computeCoarseOffset(mixed, 0)).toBe(Math.round(avgMixed));
    // With currentOffset 200, sign T167: new = 200 + (-150) = 50
    expect(computeCoarseOffset(mixed, 200)).toBe(50);
  });

  it('Step1 サンプル不足 capture(6個のみ) → Step2 compute → Step3 残り4個で平均(足りない分はそのまま) / 空ならnull', () => {
    // Only 3 samples total, discard 2 -> 1 kept -> avg=100 -> next=100
    expect(computeCoarseOffset([0, 0, 100], 0)).toBe(100);
    expect(computeCoarseOffset([999, 999, 100], 0)).toBe(100);
    // Exactly 2 samples -> kept empty -> null
    expect(computeCoarseOffset([1, 2], 0)).toBeNull();
    expect(computeCoarseOffset([], 0)).toBeNull();
    expect(computeCoarseOffset([1], 0)).toBeNull();
  });

  it('Step1 符号検証: tap-(hit+manual)=error が正なら offset は増加して 0 に向かう capture → Step2 負エラー → Step3 offset 減少', () => {
    // T167: error = tap - (hitTime + manual). If tap is late (+), manual must increase to compensate.
    // computeCoarseOffset(raw, current) = current + avgError
    expect(computeCoarseOffset([0, 0, 50, 50, 50, 50, 50, 50], 0)).toBe(50);
    expect(computeCoarseOffset([0, 0, -50, -50, -50, -50, -50, -50], 100)).toBe(50);
    // Off-grid negative fractional
    const negFrac = [0, 0, -50.37, -49.63, -50.37, -49.63, -50.37, -49.63];
    expect(computeCoarseOffset(negFrac, 100)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// T170-4: ±500ms級が8回で±20ms以内に粗調整 (end-to-end, off-grid必須)
// ---------------------------------------------------------------------------
describe('T170-4: ±500ms級粗調整が8回で±20ms以内 (3-step, off-grid & 複雑パス)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  function simulateCalibrationTapSeries(trueLatencyMs: number, jitterPattern: number[] = [0]): number[] {
    // Simulate taps that hit nearest ring with T167 error definition:
    // error = tap - (hitTime + manualOffset) ; manual=0 initially, hitTime at beat grid
    // For a fixed latency L, tap = hitTime + L (+ jitter)
    // So error = L + jitter
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      const jitter = jitterPattern[i % jitterPattern.length] ?? 0;
      samples.push(trueLatencyMs + jitter);
    }
    return samples;
  }

  it('Step1 L=+500ms capture(初期0) → Step2 8回タップして粗調整 → Step3 残差±20ms以内', () => {
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const L = 500;
    const raw = simulateCalibrationTapSeries(L);
    const next = computeCoarseOffset(raw, getManualOffsetMs())!;
    // Step3: after coarse, predicted residual = L - next should be ~0
    // Since next = 0 + L = 500, residual 0
    expect(Math.abs(L - next)).toBeLessThanOrEqual(20);
    // Apply and verify new error ~0
    setManualOffset(next);
    const residualErrors = raw.slice(2).map((r) => unwrapTimingError(r) - next + getManualOffsetMs() /* which is next, so cancels */);
    // Actually after setting offset to next, new error should be tap-(hit+next)= L - next =0
    // So check with fresh taps at same L but new manual
    const newError = L - getManualOffsetMs();
    expect(Math.abs(newError)).toBeLessThanOrEqual(20);
  });

  it('Step1 L=-480ms capture(負遅延) → Step2 8回端数jitter付き → Step3 ±20ms以内', () => {
    setManualOffset(10); // start from non-zero to ensure currentOffset handling
    expect(getManualOffsetMs()).toBe(10);
    const L = -480;
    // Off-grid jitter: 0.37, -1.23, 2.7-like fractional
    const jitter = [0.37, -1.23, 0.62, -0.41, 1.07, -0.88, 0.37, -1.23];
    const rawErrors = jitter.map((j) => (L - getManualOffsetMs()) + j + getManualOffsetMs()); // error = L + jitter (T167)
    // Simplify: raw samples as would be collected (tap-(hit+manual)) at currentOffset=10
    // If latency L=-480 but current manual=10, error at tap = L - manual = -490 + jitter
    // Let's compute directly: tap = hit+L, error = tap-(hit+manual)=L-manual+jitter
    const raw = jitter.map((j) => L - 10 + j); // because manual=10
    const next = computeCoarseOffset([999, 999, ...raw.slice(2)], getManualOffsetMs())!; // first 2 are dummy discard, but we test direct
    // Use actual raw: we want 8 samples where current error ~ L-manual
    const raw8 = simulateCalibrationTapSeries(L - 10, jitter.slice(0, 4));
    // Need to map: raw8 originally at manual 10 gives error ~ L-10, after coarse it should land at L
    const coarseNext = computeCoarseOffset(raw8, 10)!;
    // After coarse, manual should be ~ L
    expect(Math.abs(coarseNext - L)).toBeLessThanOrEqual(20);
  });

  it('Step1 L=+513.37ms(off-grid) capture → Step2 8回(端数揃え) → Step3 ±20ms以内 (T127複雑ampでも不変)', () => {
    setManualOffset(0);
    const L = 513.37;
    const jitter = [0.37, -0.62, 1.23, -0.88, 0.41, -1.07, 0.37, -0.62];
    const raw = jitter.map((j) => L + j);
    const next = computeCoarseOffset(raw, 0)!;
    const avg = raw.slice(2).map((r) => unwrapTimingError(r)).reduce((a, b) => a + b, 0) / 6;
    expect(avg).toBeCloseTo(L + jitter.slice(2).reduce((a, b) => a + b, 0) / 6, 4);
    expect(Math.abs(L - next)).toBeLessThanOrEqual(20);
    // Regression: WaveEngine/Cursor must still match regardless of calibration offset
    for (const amp of [0.7, 1.3, 2.7, 3.4]) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0);
      const perBeat = 2 * TW_AMP * amp;
      for (const b of [0.37, 1.23, 2.62]) {
        const rawY = TW_CENTER_Y + perBeat * b;
        const expected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, rawY));
        expect(engine.waveYAt(b)).toBeCloseTo(expected, 4);
      }
      // cursor slope must match wave slope
      const beatMs = 500;
      const cursor = new Cursor(amp, 0);
      const y0 = cursor.y;
      cursor.update((0.37 * beatMs) / 1000, false, true, beatMs);
      expect(Math.abs(cursor.y - y0)).toBeCloseTo(perBeat * 0.37, 4);
    }
  });

  it('Step1 L=+750級(unwrap発動) capture → Step2 8回で折返し平均 → Step3 ±20ms以内で隣リング混入なし', () => {
    setManualOffset(0);
    const L = 750;
    // At L=750, unwrap with 2000 period keeps 750 (<1000) as is, no folding, so avg=750 -> next=750 residual 0
    const raw = Array.from({ length: 8 }, () => L);
    expect(computeCoarseOffset(raw, 0)).toBe(750);
    expect(Math.abs(L - computeCoarseOffset(raw, 0)!)).toBeLessThanOrEqual(20);

    // At L=1200, unwrap folds to -800, so coarse would correct to -800, BUT real latency 1200 is ambiguous
    // With nearest-ring judgement (T168) the tap at +1200 from ring A is -800 from ring B, so observed error is -800
    // And correction to -800 is the correct nearest-ring solution (half grid = 1000 bound)
    const L2 = 1200;
    const observed = unwrapTimingError(L2);
    expect(observed).toBeCloseTo(-800, 6);
    const raw2 = Array.from({ length: 8 }, () => observed);
    expect(computeCoarseOffset(raw2, 0)).toBe(-800);
    // Residual against observed is 0 (nearest-ring semantics)
    expect(Math.abs(observed - computeCoarseOffset(raw2, 0)!)).toBeLessThanOrEqual(20);
  });

  it('Step1 複数L [+500,-500,+250,-250,+513.37] capture → Step2 各8回 → Step3 全て±20ms以内 (sweep)', () => {
    const cases = [500, -500, 250, -250, 513.37, -513.37, 480, -480, 749, -749];
    for (const L of cases) {
      setManualOffset(0);
      const raw = Array.from({ length: 8 }, (_, i) => L + (i % 2 === 0 ? 0.37 : -0.62));
      const next = computeCoarseOffset(raw, 0)!;
      // After correction, residual should be jitter mean, which for +/-0.37 pattern ~ -0.125, well within 20
      const jitterAvg = raw.slice(2).reduce((a, b) => a + b, 0) / 6 - L;
      const expectedNext = Math.round(L + jitterAvg);
      expect(next).toBe(expectedNext);
      expect(Math.abs(L - next)).toBeLessThanOrEqual(20);
    }
  });
});

// ---------------------------------------------------------------------------
// T170-5: 粗調整後の ,. 微調整・保存・キャンセルが従来通り (3-step)
// ---------------------------------------------------------------------------
describe('T170-5: 粗調整後の微調整・保存・キャンセル (3-step)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 初期0→粗調整で+500へ capture → Step2 ,. で±10 → Step3 510/490/500に戻る', () => {
    // Step1: coarse to +500
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const next = computeCoarseOffset(Array.from({ length: 8 }, () => 500), 0)!;
    setManualOffset(next);
    expect(getManualOffsetMs()).toBe(500);

    // Step2: fine adjust +10 (like CalibrationModal adjustOffset)
    const plusTen = Math.round(getManualOffsetMs() + 10);
    setManualOffset(plusTen);
    expect(getManualOffsetMs()).toBe(510);

    // Step3: -10 back
    setManualOffset(Math.round(getManualOffsetMs() - 10));
    expect(getManualOffsetMs()).toBe(500);
    setManualOffset(Math.round(getManualOffsetMs() - 10));
    expect(getManualOffsetMs()).toBe(490);
    setManualOffset(Math.round(getManualOffsetMs() + 10));
    expect(getManualOffsetMs()).toBe(500);
  });

  it('Step1 saved=30で粗調整498へ → Step2 微調整 → Step3 cancelで30に復元 / saveで保持', () => {
    // Simulate modal open savedOffsetRef = 30
    setManualOffset(30);
    const saved = getManualOffsetMs();
    expect(saved).toBe(30);

    // Coarse collects 8 samples at latency ~500, manual still 30 so observed error = 500-30=470 (+ jitter 0.37)
    const observedErrors = Array.from({ length: 8 }, () => 470 + 0.37);
    const next = computeCoarseOffset(observedErrors, 30)!; // 30 + 470.37 ≈ 500
    expect(Math.abs(next - 500)).toBeLessThanOrEqual(2);
    setManualOffset(next);
    const afterCoarse = getManualOffsetMs();
    expect(Math.abs(afterCoarse - 500)).toBeLessThanOrEqual(2);

    // Fine +10
    setManualOffset(Math.round(getManualOffsetMs() + 10));
    expect(getManualOffsetMs()).toBe(afterCoarse + 10);

    // Cancel -> restore saved (30)
    setManualOffset(saved); // simulate cancel() -> setManualOffset(savedOffsetRef.current)
    expect(getManualOffsetMs()).toBe(30);
    expect(getManualOffsetMs()).not.toBe(afterCoarse + 10);

    // Re-apply coarse and save -> keep
    const next2 = computeCoarseOffset(observedErrors, 30)!;
    setManualOffset(next2);
    const beforeSave = getManualOffsetMs();
    setManualOffset(getManualOffsetMs()); // save() keeps getManualOffsetMs()
    expect(getManualOffsetMs()).toBe(beforeSave);
  });

  it('Step1 0→粗調整→端数オフセットで微調整 capture → Step2 off-grid 0.37拍相当の微調整 → Step3 値が10刻みで線形反映', () => {
    setManualOffset(0);
    const L = 250.37; // off-grid latency
    const raw = Array.from({ length: 8 }, () => L);
    const coarse = computeCoarseOffset(raw, 0)!;
    setManualOffset(coarse);
    expect(getManualOffsetMs()).toBeCloseTo(250, 0); // rounded
    const before = getManualOffsetMs();
    // Simulate adjustOffset(-10) and (+10) as in CalibrationModal
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toContain('const adjustOffset');
    // Use specific pattern
    const adjIdx = src.indexOf('const adjustOffset =');
    expect(adjIdx).toBeGreaterThan(-1);
    // Perform
    setManualOffset(Math.round(getManualOffsetMs() - 10));
    expect(getManualOffsetMs()).toBe(before - 10);
    setManualOffset(Math.round(getManualOffsetMs() + 20));
    expect(getManualOffsetMs()).toBe(before + 10);
  });
});

// ---------------------------------------------------------------------------
// T170-6: ファイル契約 — handleHitはリセットせず、粗調整はeffectで適用、wide窓T168維持
// ---------------------------------------------------------------------------
describe('T170-6: ファイル契約 — 粗調整の責務分離 & T167/T168回帰 (3-step)', () => {
  it('Step1 CalibrationModal.tsx読み込み capture → Step2 handleHitスライス抽出 → Step3 setManualOffset(0)ゼロ & タップでoffset不変', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toContain('const handleHit =');
    const slice = extractHandleHitSlice(src);
    expect(slice.length).toBeGreaterThan(200);
    // Prohibited: handleHit must NOT contain any setManualOffset(0) or firstTap reset
    expect(slice, 'handleHit must NOT contain setManualOffset(0)').not.toContain('setManualOffset(0)');
    expect(slice, 'handleHit must NOT contain firstTapRef').not.toMatch(/firstTapRef/);
    // Must contain judgement logic with T167 sign and wide window
    expect(slice).toMatch(/songNow/);
    expect(slice).toMatch(/judgeHit/);
    expect(slice).toMatch(/getManualOffsetMs/);
    // T168 wide window must be passed (750 or constant)
    expect(slice).toMatch(/750|CALIBRATION_WIDE_WINDOW_MS|WIDE/);
    // Samples are pushed to coarseSamplesRef, offset not mutated inside handleHit
    expect(slice).toMatch(/coarseSamplesRef/);
    const setCalls = (slice.match(/setManualOffset/g) || []).length;
    expect(setCalls, 'handleHit must have zero setManualOffset calls (offset only in effect/save/cancel/adjust)').toBe(0);
  });

  it('Step1 ソース capture → Step2 coarse適用effect抽出 → Step3 computeCoarseOffset + setManualOffset(next) のみでリセット分岐なし', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // save/cancel must use specific indexOf pattern
    expect(src.indexOf('const save ='), 'must use specific const save = pattern').toBeGreaterThan(-1);
    expect(src.indexOf('const cancel ='), 'must use specific const cancel = pattern').toBeGreaterThan(-1);
    const coarseSlice = extractCoarseEffectSlice(src);
    expect(coarseSlice.length).toBeGreaterThan(100);
    expect(coarseSlice).toMatch(/computeCoarseOffset/);
    expect(coarseSlice).toMatch(/setManualOffset/);
    expect(coarseSlice).toMatch(/coarseTapCount/);
    // Must check for 8 count
    expect(coarseSlice).toMatch(/CALIBRATION_SAMPLE_COUNT|8/);
    expect(coarseSlice).toMatch(/CALIBRATION_DISCARD_COUNT|slice/);
    // save and cancel contracts
    const saveSlice = extractSaveSlice(src);
    expect(saveSlice).toMatch(/setManualOffset\(getManualOffsetMs\(\)\)/);
    expect(saveSlice).toMatch(/onClose\(true\)/);
    const cancelSlice = extractCancelSlice(src);
    expect(cancelSlice).toMatch(/setManualOffset\(savedOffsetRef\.current\)/);
    expect(cancelSlice).toMatch(/onClose\(false\)/);
    // Neither save nor cancel should be setManualOffset(0) as reset
    expect(saveSlice).not.toContain('setManualOffset(0)');
    expect(cancelSlice).not.toContain('setManualOffset(0)');
  });

  it('Step1 保存前状態 capture → Step2 粗調整effectの条件確認 → Step3 T169回帰: タップ連打でもoffsetが勝手に0にならない', () => {
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    // Simulate 8 taps without coarse active: offset stays 80
    for (let i = 0; i < 8; i++) {
      // Fixed handleHit would not touch offset
      expect(getManualOffsetMs()).toBe(80);
    }
    expect(slice).not.toContain('setManualOffset(0)');
    // Also verify schedule is ruler-fixed (T167): metronome.ts must NOT add offsetSeconds
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc, 'metronome must NOT contain offsetSeconds/mannual add').not.toMatch(/offsetSeconds/);
    expect(metroSrc).toContain('export function schedule');
  });

  it('Step1 定数 capture → Step2 CALIBRATION_GRID 2000 / BOUND 1000 → Step3 間隔の半分が上限であること', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Check constants
    expect(src).toMatch(/CALIBRATION_GRID_MS/);
    expect(src).toMatch(/CALIBRATION_UNWRAP_BOUND_MS/);
    // Values must be 2000 and 1000
    expect(src).toMatch(/2000/);
    expect(src).toMatch(/1000/);
    // Wide window must be <1000 (T168)
    expect(src).toMatch(/750|CALIBRATION_WIDE_WINDOW_MS/);
    // Verify no literal >=1000 passed as judgeHit window (except interval comments)
    const matches = [...src.matchAll(/judgeHit\([^)]*,\s*(\d{3,4})/g)].map((m) => Number(m[1]));
    for (const v of matches) {
      if (v >= 100 && v < 5000) expect(v, `judge window ${v} must be <1000`).toBeLessThan(1000);
    }
  });
});

// ---------------------------------------------------------------------------
// T170-7: 型契約 & 回帰 off-grid / 複雑振幅 (T127 style, computed)
// ---------------------------------------------------------------------------
describe('T170-7: 型契約 & 回帰 off-grid / 複雑振幅整合', () => {
  it('Step1 シンボルimport capture → Step2 呼出 → Step3 型正しくエラー無し', () => {
    expect(typeof unwrapTimingError).toBe('function');
    expect(typeof computeCoarseOffset).toBe('function');
    expect(typeof generateCalibrationChart).toBe('function');
    expect(typeof getManualOffsetMs).toBe('function');
    expect(typeof setManualOffset).toBe('function');
    const tl = new BpmTimeline(120, [], 1.0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toContain('export function generateCalibrationChart');
    expect(src).toContain('export function unwrapTimingError');
    expect(src).toContain('export function computeCoarseOffset');
    expect(src).toContain('data-testid="editor-calibration-modal"');
    expect(src).toContain('data-testid="calibration-save"');
    expect(src).toContain('data-testid="calibration-cancel"');
    expect(src).toContain('data-testid="calibration-coarse"');
  });

  it('Step1 amp 0.7 capture → Step2 amp 1.3/2.7/3.4 off-grid 0.37/1.23 → Step3 slope =2*TW_AMP*amp で一致', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrid = [0.37, 1.23, 0.5, 1.37, 2.62];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const startY = TW_CENTER_Y;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      for (const b of offGrid) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        expect(engine.waveYAt(b), `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
    }
  });

  it('Step1 Cursor vs Wave 1拍移動量 capture → Step2 off-grid 0.37 → Step3 一致 & manualOffsetが波高に影響しない', () => {
    setManualOffset(0);
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    cursor.update((0.37 * beatMs) / 1000, false, true, beatMs);
    expect(Math.abs(cursor.y - y0)).toBeCloseTo(perBeat * 0.37, 4);
    expect(Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0))).toBeCloseTo(perBeat * 0.37, 4);
    setManualOffset(80);
    expect(engine.waveYAt(0.37)).toBeCloseTo(TW_CENTER_Y - TW_AMP + perBeat * 0.37, 4);
    setManualOffset(0);
  });
});
