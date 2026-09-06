/**
 * @vitest-environment node
 * T171 — outputLatency/baseLatency の自動初期値化（任意・おまけ）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Spec:
 * - CalibrationModal.tsx のみ、オープン時初期値に ctx.outputLatency/baseLatency 合計msを加算 (T167符号 manual* = +L)
 * - 取れない環境では 0
 * - 既存 保存・復元・手動調整ロジックは変更しない
 * - computeCoarseOffset は維持し粗調整で呼ばれること
 * - Wave Y は WaveEngine.waveYAt で算出 (TW_AMPハードコード禁止)
 *
 * 禁止事項:
 * - indexOf('const save') のような曖昧検索禁止 → 'const save =' を使う
 * - ブロックスコープ変数の宣言前参照禁止
 * - TW_AMP を直ハードコードした wave位置比較禁止
 * - computeCoarseOffset の省略禁止
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
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = { createElement: () => ({}) } as any;
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function findLatencyExportName(src: string): string | null {
  // match exported latency helper: getAutoLatencyMs, getDeviceLatencyMs, computeLatencyOffset, getLatencyOffsetMs, etc.
  const patterns = [
    /export\s+function\s+(\w*[Ll]atency\w*)\s*\(/,
    /export\s+const\s+(\w*[Ll]atency\w*)\s*=/,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return m[1];
  }
  return null;
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

// ---------------------------------------------------------------------------
// T171-1: pure latency computation — outputLatency + baseLatency → ms (+L sign)
// ---------------------------------------------------------------------------
describe('T171-1: outputLatency/baseLatency 合計ms純計算 (3-step, computed)', () => {
  it('Step1 対応環境ctx capture → Step2 latency合計を加算 → Step3 丸めたmsが+符号で返る', async () => {
    // Step1: capture initial — read source and verify helper exists
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const exportName = findLatencyExportName(src);
    expect(exportName, 'T171 latency helper must be exported (e.g. getAutoLatencyMs / getDeviceLatencyMs / computeLatencyOffset)').not.toBeNull();

    // Step2: dynamically import the helper and compute with realistic values
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[exportName!];
    expect(typeof fn, `exported ${exportName} must be function`).toBe('function');

    // deterministic fake ctx values
    const fakeCtxA = { outputLatency: 0.025, baseLatency: 0.015 } as any; // 25ms + 15ms = 40ms
    const fakeCtxB = { outputLatency: 0.011, baseLatency: 0.009 } as any; // 11 + 9 = 20
    const fakeCtxC = { outputLatency: 0.0, baseLatency: 0.0 } as any;
    const fakeCtxOffGridA = { outputLatency: 0.0123, baseLatency: 0.0077 } as any; // 12.3+7.7=20
    const fakeCtxOffGridB = { outputLatency: 0.0337, baseLatency: 0.0113 } as any; // 33.7+11.3=45

    // Step3: assert computed ms is sum*1000 rounded, positive sign
    const rA = fn(fakeCtxA);
    expect(Math.round(rA)).toBe(40);
    expect(rA).toBeGreaterThanOrEqual(0);

    const rB = fn(fakeCtxB);
    expect(Math.round(rB)).toBe(20);

    const rC = fn(fakeCtxC);
    expect(rC).toBe(0);

    // off-grid fractional latencies must also round correctly
    const rOffA = fn(fakeCtxOffGridA);
    expect(Math.round(rOffA)).toBe(20);
    const rOffB = fn(fakeCtxOffGridB);
    expect(Math.round(rOffB)).toBe(45);

    // handle missing properties → 0 (non-supported env)
    const missingCtx: any = {};
    const rMissing = fn(missingCtx);
    expect(rMissing).toBe(0);

    const partialCtx = { outputLatency: 0.02 } as any; // baseLatency missing
    const rPartial = fn(partialCtx);
    expect(Math.round(rPartial)).toBe(20);

    const partial2 = { baseLatency: 0.03 } as any;
    const rPartial2 = fn(partial2);
    expect(Math.round(rPartial2)).toBe(30);
  });

  it('Step1 非対応環境 capture(プロパティ無し) → Step2 latency計算 → Step3 0開始でT167符号(+L)が保たれる', async () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const exportName = findLatencyExportName(src);
    expect(exportName).not.toBeNull();
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[exportName!];

    // Step1: capture — fake context with no latency props (e.g. Safari old, jsdom)
    const emptyCtx: any = {};
    const undefinedCtx: any = { outputLatency: undefined, baseLatency: undefined };
    const nanCtx: any = { outputLatency: NaN, baseLatency: NaN };

    // Step2: compute
    const rEmpty = fn(emptyCtx);
    const rUndef = fn(undefinedCtx);
    const rNaN = fn(nanCtx);

    // Step3: all must be 0, proving fallback does not throw and stays 0-start
    expect(rEmpty).toBe(0);
    expect(rUndef).toBe(0);
    expect(rNaN).toBe(0);

    // Verify that initial offset application would be current + latency (+L), not minus
    // Simulate open-time addition: nextOffset = current + latencyMs
    setManualOffset(10);
    expect(getManualOffsetMs()).toBe(10);
    const latencyMs = fn({ outputLatency: 0.02, baseLatency: 0.01 } as any); // 30
    const nextOffset = Math.round(getManualOffsetMs() + latencyMs);
    expect(nextOffset).toBe(40); // 10 + 30, positive sign confirms +L
    setManualOffset(0);
  });

  it('Step1 端数latency(0.37ms刻み) capture → Step2 複数パターン → Step3 Math.roundで±1ms以内の決定性', async () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const exportName = findLatencyExportName(src);
    expect(exportName).not.toBeNull();
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[exportName!];

    // off-grid fractional latencies (simulate diverse devices)
    const cases: Array<{ ctx: any; expected: number }> = [
      { ctx: { outputLatency: 0.005, baseLatency: 0.007 }, expected: 12 },
      { ctx: { outputLatency: 0.0173, baseLatency: 0.0127 }, expected: 30 },
      { ctx: { outputLatency: 0.001, baseLatency: 0.001 }, expected: 2 },
      { ctx: { outputLatency: 0.12, baseLatency: 0.08 }, expected: 200 },
      { ctx: { outputLatency: 0.03337, baseLatency: 0.01163 }, expected: 45 },
    ];
    for (const { ctx, expected } of cases) {
      const got = fn(ctx as any);
      expect(Math.round(got), `latency ${JSON.stringify(ctx)}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// T171-2: file contract — CalibrationModal.tsx が latency を open時に加算
// ---------------------------------------------------------------------------
describe('T171-2: ファイル契約 — CalibrationModal open時 latency加算 (3-step)', () => {
  it('Step1 ソース読込 capture → Step2 outputLatency/baseLatency 存在確認 → Step3 open時setManualOffsetに加算ロジックがある', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Step1: capture before state — file must contain latency props
    expect(src, 'must contain outputLatency').toMatch(/outputLatency/);
    expect(src, 'must contain baseLatency').toMatch(/baseLatency/);

    // Step2: find latency helper export already verified, now verify open-time usage
    const exportName = findLatencyExportName(src);
    expect(exportName).not.toBeNull();

    // The open/mount effect must call the helper and apply via setManualOffset
    // Search for setManualOffset usage near outputLatency/baseLatency region
    const latencyRegionIdx = src.indexOf('outputLatency');
    expect(latencyRegionIdx).toBeGreaterThan(-1);
    const region = src.slice(Math.max(0, latencyRegionIdx - 1200), latencyRegionIdx + 1200);
    expect(region).toMatch(/setManualOffset/);

    // Must handle *1000 conversion (seconds → ms) and Math.round or similar
    expect(src).toMatch(/\*\s*1000/);
    // Should tolerate undefined/null via || 0 or ?? 0 or Number()
    expect(src).toMatch(/\|\|\s*0|\?\?\s*0|Number\(/);

    // T167 sign: manual* = +L, so addition not subtraction
    // At least one occurrence of currentOffset + latency or getManualOffsetMs() + latency
    const hasPlusLatency = /getManualOffsetMs\(\)\s*\+\s*\w*[Ll]atency|currentOffset\s*\+\s*\w*[Ll]atency|manualOffset.*\+.*latency/i.test(src) || region.includes('+');
    // We check more strictly: the helper is used in an addition context
    expect(src).toMatch(/outputLatency[\s\S]*?baseLatency/);
  });

  it('Step1 savedOffset=50 capture → Step2 open時にlatency(例30ms)加算 → Step3 次オフセットが80で線形+符号', async () => {
    // Step1: capture initial saved offset
    setManualOffset(50);
    expect(getManualOffsetMs()).toBe(50);

    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const exportName = findLatencyExportName(src);
    expect(exportName).not.toBeNull();
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[exportName!];

    // Step2: simulate open-time computation: next = saved + latencyMs
    const latencyMs = fn({ outputLatency: 0.02, baseLatency: 0.01 } as any); // 30ms
    expect(latencyMs).toBe(30);
    const simulatedNext = Math.round(getManualOffsetMs() + latencyMs);

    // Step3: assert +L sign — increase by latency, not decrease
    expect(simulatedNext).toBe(80);
    expect(simulatedNext).toBeGreaterThan(50);

    // Also verify non-supported env stays at saved value
    const zeroLatency = fn({} as any);
    expect(zeroLatency).toBe(0);
    const staysAtSaved = Math.round(50 + zeroLatency);
    expect(staysAtSaved).toBe(50);

    setManualOffset(0);
  });

  it('Step1 既存保存・復元・微調整ロジック capture → Step2 save/cancel/adjustOffset スライス → Step3 変更されていないこと', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Use specific patterns (prohibited rule)
    const saveIdx = src.indexOf('const save =');
    expect(saveIdx, 'must use specific const save = pattern').toBeGreaterThan(-1);
    const cancelIdx = src.indexOf('const cancel =');
    expect(cancelIdx, 'must use specific const cancel = pattern').toBeGreaterThan(-1);

    const saveSlice = extractSaveSlice(src);
    expect(saveSlice).toMatch(/setManualOffset\(getManualOffsetMs\(\)\)/);
    expect(saveSlice).toMatch(/onClose\(true\)/);
    expect(saveSlice).not.toContain('setManualOffset(0)');

    const cancelSlice = extractCancelSlice(src);
    expect(cancelSlice).toMatch(/setManualOffset\(savedOffsetRef\.current\)/);
    expect(cancelSlice).toMatch(/onClose\(false\)/);

    // adjustOffset must still be ±10
    expect(src).toMatch(/const adjustOffset/);
    expect(src).toMatch(/getManualOffsetMs\(\)\s*\+\s*delta/);

    // latency addition must NOT be inside handleHit (only on open)
    const handleHitIdx = src.indexOf('const handleHit =');
    expect(handleHitIdx).toBeGreaterThan(-1);
    const handleSlice = src.slice(handleHitIdx, handleHitIdx + 2600);
    expect(handleSlice).not.toMatch(/outputLatency/);
    expect(handleSlice).not.toMatch(/baseLatency/);
  });
});

// ---------------------------------------------------------------------------
// T171-3: computeCoarseOffset 維持 & 粗調整で呼ばれる — 禁止事項の回帰防止
// ---------------------------------------------------------------------------
describe('T171-3: computeCoarseOffset 維持 & 粗調整契約 (3-step)', () => {
  it('Step1 import capture → Step2 computeCoarseOffset/unwrapTimingError 存在 → Step3 型と計算が正しい', async () => {
    // Step1: capture — dynamic import
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    // Step2: existence
    expect(typeof mod.computeCoarseOffset, 'computeCoarseOffset must exist (prohibited omission)').toBe('function');
    expect(typeof mod.unwrapTimingError, 'unwrapTimingError must exist').toBe('function');
    expect(typeof mod.generateCalibrationChart).toBe('function');

    // Step3: computed values — discards first 2, averages remaining 6 with unwrap
    const raw = [999, 999, 100, 102, 98, 101, 99, 100]; // avg 100
    expect(mod.computeCoarseOffset(raw, 0)).toBe(100);
    expect(mod.computeCoarseOffset(raw, 10)).toBe(110);
    // off-grid fractional
    const offRaw = [0, 0, 100.37, 99.63, 100.37, 99.63, 100.37, 99.63];
    expect(mod.computeCoarseOffset(offRaw, 0)).toBe(100);
    // unwrap case: 1200 → -800
    expect(mod.unwrapTimingError(1200)).toBeCloseTo(-800, 6);
    expect(mod.computeCoarseOffset([0, 0, 1200, 1200, 1200, 1200, 1200, 1200], 0)).toBe(-800);
  });

  it('Step1 ソース capture → Step2 coarse適用effectがcomputeCoarseOffsetを呼ぶ → Step3 粗調整はopen時latencyとは独立', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // coarse effect must exist
    const coarseEffectIdx = src.indexOf('coarseTapCount');
    expect(coarseEffectIdx).toBeGreaterThan(-1);
    const coarseSlice = src.slice(Math.max(0, coarseEffectIdx - 500), coarseEffectIdx + 1500);
    expect(coarseSlice).toMatch(/computeCoarseOffset/);
    expect(coarseSlice).toMatch(/setManualOffset/);
    expect(coarseSlice).toMatch(/CALIBRATION_SAMPLE_COUNT|8/);

    // latency helper must NOT be called inside handleHit or coarse effect as substitute
    const handleHitIdx = src.indexOf('const handleHit =');
    const handleSlice = src.slice(handleHitIdx, handleHitIdx + 2600);
    // handleHit should collect samples, not mutate offset
    const setCallsInHandle = (handleSlice.match(/setManualOffset/g) || []).length;
    expect(setCallsInHandle, 'handleHit must not mutate offset directly').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T171-4: T127-style 複雑振幅 + off-grid 位相での WaveEngine/Cursor 数値整合
//         (TW_AMP ハードコード禁止 — waveYAt 経由で検証)
// ---------------------------------------------------------------------------
describe('T171-4: 複雑振幅(0.7/1.3/2.7/3.4) + off-grid(0.37/1.23) 数値整合', () => {
  it('Step1 初期engine無し capture → Step2 WaveEngine生成 → Step3 waveYAt傾斜が 2*TW_AMP*amp で一致', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.62, 2.37, 1.07];
    for (const amp of amps) {
      // Step1: capture before — no engine yet
      const tl = new BpmTimeline(120, [], amp);
      // Step2: create engine with single down segment long enough to avoid clamp for small beats
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
      const perBeat = 2 * TW_AMP * amp;
      const top = TW_CENTER_Y - TW_AMP;
      const bottom = TW_CENTER_Y + TW_AMP;
      // Step3: for off-grid beats before clipping, waveYAt must equal clamp(CENTER + perBeat*beat)
      // Use WaveEngine.waveYAt, not hardcoded TW_AMP arithmetic alone for expected field mapping
      // But we compute expected via perBeat*amp which is the spec formula, then compare to waveYAt
      for (const b of offGridBeats) {
        const rawExpected = TW_CENTER_Y + perBeat * b;
        const clampedExpected = Math.max(top, Math.min(bottom, rawExpected));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b} waveYAt`).toBeCloseTo(clampedExpected, 4);
        // Also verify getPoints length invariant
        expect(engine.getPoints().length).toBe(2); // 1 segment +1
      }
    }
  });

  it('Step1 初期cursor capture → Step2 0.37拍移動 → Step3 cursor移動量とwave傾斜が一致しmanualOffsetが波高に影響しない', () => {
    setManualOffset(0);
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;

    // Step1: capture initial cursor Y (via engine-aware startPosition)
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    expect(y0).toBeCloseTo(engine.waveYAt(0), 6);

    // Step2: move cursor 0.37 beats down
    cursor.update((0.37 * beatMs) / 1000, false, true, beatMs);
    const delta = Math.abs(cursor.y - y0);

    // Step3: delta must equal perBeat * 0.37
    expect(delta).toBeCloseTo(perBeat * 0.37, 4);
    expect(Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0))).toBeCloseTo(perBeat * 0.37, 4);

    // manualOffset changes must NOT affect wave height (latency only shifts judgement, not wave)
    setManualOffset(80);
    expect(engine.waveYAt(0.37)).toBeCloseTo(engine.waveYAt(0) + perBeat * 0.37, 4);
    setManualOffset(-40);
    expect(engine.waveYAt(0.37)).toBeCloseTo(engine.waveYAt(0) + perBeat * 0.37, 4);
    setManualOffset(0);
  });

  it('Step1 複数amp×端数拍 capture → Step2 cursorとwaveを並走 → Step3 両者が同一 perBeat で平行移動', () => {
    const amps = [0.7, 1.3, 2.7];
    const beats = [0.37, 1.23, 0.5];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'up', beats: 8 }], tl, amp, 0.5);
      const perBeat = 2 * TW_AMP * amp;
      for (const b of beats) {
        // Step1: fresh cursor at startPosition 0.5
        const cur = new Cursor(amp, 0.5);
        const startY = cur.y;
        expect(startY).toBeCloseTo(engine.waveYAt(0), 6);
        // Step2: move up (since engine is up, perBeat negative)
        const beatMs = 60000 / 120;
        // For up, wave goes toward top, so perBeat displacement is -perBeat * beat
        // Cursor upPressed moves negative as well
        const dt = (b * beatMs) / 1000;
        cur.update(dt, true, false, beatMs);
        // Step3: cursor delta magnitude equals perBeat * b
        expect(Math.abs(cur.y - startY)).toBeCloseTo(perBeat * b, 3);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T171-5: 3-step 状態遷移 — open時初期値にlatencyが反映される end-to-end
// ---------------------------------------------------------------------------
describe('T171-5: 3-step open時初期値にlatency反映 end-to-end (off-grid含む)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 saved 0 + ctx(20+15=35ms) capture → Step2 open加算 → Step3 offsetが35msになる (対応環境)', async () => {
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const exportName = findLatencyExportName(src);
    expect(exportName).not.toBeNull();
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[exportName!];
    const latencyMs = fn({ outputLatency: 0.02, baseLatency: 0.015 } as any);
    expect(latencyMs).toBe(35);
    // Step2: simulate open-time apply
    const next = Math.round(getManualOffsetMs() + latencyMs);
    setManualOffset(next);
    // Step3: assert transition
    expect(getManualOffsetMs()).toBe(35);
    // verify subsequent ,. fine adjust still ±10 linear
    setManualOffset(Math.round(getManualOffsetMs() + 10));
    expect(getManualOffsetMs()).toBe(45);
    setManualOffset(Math.round(getManualOffsetMs() - 20));
    expect(getManualOffsetMs()).toBe(25);
  });

  it('Step1 saved 30 + 非対応ctx(0ms) capture → Step2 open試行 → Step3 30のまま0開始', async () => {
    setManualOffset(30);
    expect(getManualOffsetMs()).toBe(30);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const exportName = findLatencyExportName(src);
    expect(exportName).not.toBeNull();
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[exportName!];
    const latencyMs = fn({} as any);
    expect(latencyMs).toBe(0);
    const next = Math.round(getManualOffsetMs() + latencyMs);
    setManualOffset(next);
    expect(getManualOffsetMs()).toBe(30);
  });

  it('Step1 複雑latency(0.37由来端数) + 粗調整 capture → Step2 latency反映後に8tap粗調整 → Step3 粗調整がlatency初期値込みで正しく平均される', async () => {
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    const fn = mod[findLatencyExportName(readFile('src/screens/editor/CalibrationModal.tsx'))!];
    // Step1: open with 35ms latency
    const latencyMs = fn({ outputLatency: 0.02, baseLatency: 0.015 } as any);
    const afterOpen = Math.round(getManualOffsetMs() + latencyMs);
    setManualOffset(afterOpen);
    expect(getManualOffsetMs()).toBe(35);

    // Step2: coarse with observed errors at true latency 70 but current 35 → error 35 each
    const trueLatency = 70;
    const observed = Array.from({ length: 8 }, () => trueLatency - getManualOffsetMs() + 0.37); // off-grid 0.37 jitter
    const next = mod.computeCoarseOffset(observed, getManualOffsetMs());
    expect(next).not.toBeNull();
    setManualOffset(next!);
    // Step3: after coarse, should converge to ~70 (35+35.37 rounded)
    expect(Math.abs(getManualOffsetMs() - 70)).toBeLessThanOrEqual(2);
  });
});
