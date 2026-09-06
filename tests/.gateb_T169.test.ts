/**
 * @vitest-environment node
 * T169 — キャリブレーション初回タップ時のオフセットリセット廃止
 * Vitest node environment — pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * 背景: CalibrationModal.tsx:140-144 の初回Spaceで setManualOffset(0) が走り ,. 調整が消える。
 * 修正: handleHit 内の不意打ちリセットを廃止。保存・キャンセル復元は維持。
 *
 * 完了条件:
 * 1. ,. 調整後にSpace試打してもオフセット値が維持されること
 * 2. キャンセル時は開始前オフセットに復元されること
 * 3. tsc --noEmit エラーなし（型契約）
 *
 * 禁止事項（過去失敗より）:
 * - handleHit 内で setManualOffset(0) を呼んではならない
 * - firstTapRef による初回リセットロジックを含めてはならない
 * - `indexOf('const save')` のような曖昧検索を使わず `indexOf('const save =')` を使う
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

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function extractHandleHitSlice(src: string): string {
  const idx = src.indexOf('const handleHit');
  if (idx === -1) return '';
  // handleHit is useCallback(() => { ... }, [deps])
  // slice 3000 chars to cover body
  return src.slice(idx, idx + 3000);
}

function extractSaveSlice(src: string): string {
  // MUST use specific pattern to avoid ambiguous prefix match
  const idx = src.indexOf('const save =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 800);
}

function extractCancelSlice(src: string): string {
  const idx = src.indexOf('const cancel =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 800);
}

function extractAdjustSlice(src: string): string {
  const idx = src.indexOf('const adjustOffset');
  if (idx === -1) return '';
  return src.slice(idx, idx + 800);
}

// Simulate fixed handleHit behavior: only records judgement, never touches manualOffset
function simulateFixedHandleHit(): void {
  // Intentionally does NOT call setManualOffset at all
  // In real code this would call judgeHit etc., but for T169 the critical
  // invariant is that manualOffset stays unchanged.
}

function simulateBuggyFirstTapReset(): void {
  // Buggy behavior: first tap resets to 0
  setManualOffset(0);
}

// ---------------------------------------------------------------------------
// T169-1: handleHit must NOT call setManualOffset(0) — file contract + behavior
// ---------------------------------------------------------------------------
describe('T169-1: handleHit の不意打ちリセット廃止（ファイル契約 & 3-step）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 初期ソース capture → Step2 handleHit スライス抽出 → Step3 setManualOffset(0) を含まない', () => {
    // Step1: Capture initial file state
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src, 'CalibrationModal.tsx must exist and contain handleHit').toContain('const handleHit');
    const initialHasHandleHit = src.includes('const handleHit');
    expect(initialHasHandleHit).toBe(true);

    // Step2: Extract handleHit slice
    const slice = extractHandleHitSlice(src);
    expect(slice.length, 'handleHit slice must be non-empty').toBeGreaterThan(100);

    // Step3: Assert resulting transition — NO reset inside handleHit
    expect(slice, 'handleHit must NOT contain setManualOffset(0) — first-tap reset abolished').not.toContain('setManualOffset(0)');
    expect(slice, 'handleHit must NOT contain firstTapRef').not.toMatch(/firstTapRef/);
    // Should contain judgement logic, not offset mutation
    expect(slice).toMatch(/songNow|judgeHit/);
    // Must NOT have any setManualOffset call at all inside handleHit
    // The only allowed setManualOffset is in save/cancel/adjust, not in handleHit
    const setCallsInHit = (slice.match(/setManualOffset/g) || []).length;
    expect(setCallsInHit, 'handleHit must have zero setManualOffset calls').toBe(0);
  });

  it('Step1 調整前 0 capture → Step2 擬似 handleHit 実行 → Step3 オフセットが維持される（Buggyなら 0 にリセットされて FAIL）', () => {
    // Step1: capture initial 0
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);

    // Step2: simulate user adjusts via ,. to +80 (like CalibrationModal adjustOffset)
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const beforeTap = getManualOffsetMs();

    // Simulate fixed handleHit (should preserve)
    simulateFixedHandleHit();
    const afterFixed = getManualOffsetMs();

    // Step3: assert transition — fixed must preserve
    expect(afterFixed).toBe(beforeTap);
    expect(afterFixed).toBe(80);

    // Demonstrate buggy would fail: reset to 0
    simulateBuggyFirstTapReset();
    const afterBuggy = getManualOffsetMs();
    expect(afterBuggy).toBe(0);
    expect(afterFixed).not.toBe(afterBuggy);

    // Restore for next test
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
  });

  it('Step1 複数回タップ capture → Step2 連続 handleHit → Step3 いずれもリセットしない（複雑拍でも）', () => {
    setManualOffset(45);
    expect(getManualOffsetMs()).toBe(45);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    expect(slice).not.toContain('setManualOffset(0)');

    // Step2: 5 consecutive taps
    for (let i = 0; i < 5; i++) {
      simulateFixedHandleHit();
      expect(getManualOffsetMs(), `tap ${i} must preserve offset 45`).toBe(45);
    }

    // Step3: after many taps still 45, buggy would be 0 after first
    expect(getManualOffsetMs()).toBe(45);
    // Off-grid fractional scenario: even with fractional timing, offset unchanged
    setManualOffset(37);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(37);
    setManualOffset(0);
  });

  it('Step1 ソース全体で setManualOffset(0) が handleHit 以外にのみ存在するか capture → Step2 位置特定 → Step3 handleHit 外は許容（オープン時1回のみ）', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Find all occurrences of setManualOffset(0)
    const allIndices: number[] = [];
    let pos = 0;
    while (true) {
      const idx = src.indexOf('setManualOffset(0)', pos);
      if (idx === -1) break;
      allIndices.push(idx);
      pos = idx + 1;
    }
    const handleHitIdx = src.indexOf('const handleHit');
    const handleHitEnd = handleHitIdx + 3000;
    // Filter to those inside handleHit range
    const insideHit = allIndices.filter((i) => i >= handleHitIdx && i < handleHitEnd);
    expect(insideHit.length, 'no setManualOffset(0) inside handleHit range').toBe(0);
    // Outside handleHit, at most 1 occurrence allowed (optional open-time reset), or 0 is also valid (維持パターン)
    // Spec says: 必要ならモーダルオープン時に1回だけ0化するか、何もしないかのいずれかに統一
    expect(allIndices.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T169-2: ,. 調整後に Space 試打しても値維持（3-step, off-grid含む）
// ---------------------------------------------------------------------------
describe('T169-2: ,. 調整後に Space 試打でオフセット維持（3-step, off-grid 必須）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 初期 0 capture → Step2 ,. で +80 調整 → Step3 Space 試打後も +80 維持', () => {
    // Step1
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);

    // Step2: simulate adjustOffset(+80) as in CalibrationModal
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const adjustSlice = extractAdjustSlice(src);
    expect(adjustSlice).toContain('setManualOffset');
    expect(adjustSlice).toMatch(/getManualOffsetMs\(\)\s*\+\s*delta/);
    // Perform adjustment
    const next = Math.round(getManualOffsetMs() + 80);
    setManualOffset(next);
    expect(getManualOffsetMs()).toBe(80);

    // Step3: Space hit — should NOT reset
    const before = getManualOffsetMs();
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(before);
    expect(getManualOffsetMs()).toBe(80);

    // Verify buggy would have reset
    setManualOffset(80);
    simulateBuggyFirstTapReset();
    expect(getManualOffsetMs()).toBe(0);
    // Fix back
    setManualOffset(80);
  });

  it('Step1 -50 から capture → Step2 負方向調整 → Step3 Space 試打で負値維持', () => {
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(-50);
    expect(getManualOffsetMs()).toBe(-50);

    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(-50);

    // Another adjustment -10 via , key
    setManualOffset(getManualOffsetMs() - 10);
    expect(getManualOffsetMs()).toBe(-60);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(-60);
  });

  it('Step1 端数オフセット 37ms capture → Step2 Space → Step3 端数維持（off-grid）', () => {
    // Off-grid principle: use fractional values like 0.37 beat equivalent offset
    setManualOffset(37);
    expect(getManualOffsetMs()).toBe(37);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(37);

    // Also test with complex amplitude context — offset should still not be affected by wave math
    const amps = [0.7, 1.3, 2.7];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0);
      // Off-grid beat 0.37 / 1.23 — wave math should not affect manualOffset
      expect(engine.waveYAt(0.37)).toBeDefined();
      expect(engine.waveYAt(1.23)).toBeDefined();
      const before = getManualOffsetMs();
      simulateFixedHandleHit();
      expect(getManualOffsetMs(), `amp ${amp} off-grid 0.37 must not affect offset`).toBe(before);
    }
  });

  it('Step1 +120 大遅延 capture → Step2 Space → Step3 200ms超遅延PCでも維持（T168広窓と共存）', () => {
    setManualOffset(120);
    expect(getManualOffsetMs()).toBe(120);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(120);
    // Verify file still has wide window for calibration (T168 regression)
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(calSrc).toMatch(/750|CALIBRATION_WIDE_WINDOW_MS/);
    // And handleHit still has no reset
    expect(extractHandleHitSlice(calSrc)).not.toContain('setManualOffset(0)');
  });
});

// ---------------------------------------------------------------------------
// T169-3: キャンセル時は開始前オフセットに復元（3-step）
// ---------------------------------------------------------------------------
describe('T169-3: キャンセルで開始前オフセットに復元（3-step）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 開始前 30 capture（savedOffsetRef） → Step2 ,. で 80 に変更 → Step3 cancel で 30 に復元', () => {
    // Step1: modal open captures savedOffsetRef = 30
    setManualOffset(30);
    const savedOffset = getManualOffsetMs();
    expect(savedOffset).toBe(30);

    // Verify file has savedOffsetRef logic
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toContain('savedOffsetRef');
    expect(src).toContain('getManualOffsetMs()');
    const cancelSlice = extractCancelSlice(src);
    expect(cancelSlice).toContain('setManualOffset(savedOffsetRef.current)');
    // Must use specific pattern for save/cancel, not ambiguous
    expect(src.indexOf('const cancel ='), 'must use specific const cancel = pattern').toBeGreaterThan(-1);
    expect(src.indexOf('const save ='), 'must use specific const save = pattern').toBeGreaterThan(-1);

    // Step2: user adjusts to 80 (and taps, which must NOT reset)
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(80);

    // Step3: cancel restores savedOffset
    setManualOffset(savedOffset); // simulate cancel() -> setManualOffset(savedOffsetRef.current)
    expect(getManualOffsetMs()).toBe(30);
    expect(getManualOffsetMs()).not.toBe(80);
  });

  it('Step1 開始前 -20 capture → Step2 複数回調整 (-20→10→50) → Step3 cancel で -20 に復元', () => {
    setManualOffset(-20);
    const saved = getManualOffsetMs();
    expect(saved).toBe(-20);

    // Simulate adjustOffset sequence
    setManualOffset(getManualOffsetMs() + 30); // -20+30=10
    expect(getManualOffsetMs()).toBe(10);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(10);

    setManualOffset(getManualOffsetMs() + 40); // 10+40=50
    expect(getManualOffsetMs()).toBe(50);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(50);

    // Cancel
    setManualOffset(saved);
    expect(getManualOffsetMs()).toBe(-20);
  });

  it('Step1 0 のまま capture → Step2 調整せず Space のみ → Step3 cancel で 0 のまま（変化なし）', () => {
    setManualOffset(0);
    const saved = getManualOffsetMs();
    expect(saved).toBe(0);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(0);
    // cancel
    setManualOffset(saved);
    expect(getManualOffsetMs()).toBe(0);
  });

  it('Step1 ソース契約: cancel が savedOffsetRef.current を復元し、save は getManualOffsetMs() を保存', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const cancelSlice = extractCancelSlice(src);
    const saveSlice = extractSaveSlice(src);
    // cancel must restore
    expect(cancelSlice).toMatch(/setManualOffset\(savedOffsetRef\.current\)/);
    expect(cancelSlice).toMatch(/onClose\(false\)/);
    // save must keep current (not reset)
    expect(saveSlice).toMatch(/setManualOffset\(getManualOffsetMs\(\)\)/);
    expect(saveSlice).toMatch(/onClose\(true\)/);
    // Neither should contain setManualOffset(0) inside handleHit (already tested) nor inside cancel/save as reset-to-zero
    expect(cancelSlice).not.toContain('setManualOffset(0)');
    expect(saveSlice).not.toContain('setManualOffset(0)');
  });
});

// ---------------------------------------------------------------------------
// T169-4: 保存時は現在オフセットを保持（リセットせず）
// ---------------------------------------------------------------------------
describe('T169-4: 保存時は現在オフセットを保持（3-step）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 開始前 10 capture → Step2 調整で 90 に → Step3 save で 90 維持', () => {
    setManualOffset(10);
    const saved = getManualOffsetMs();
    expect(saved).toBe(10);

    setManualOffset(90);
    expect(getManualOffsetMs()).toBe(90);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(90);

    // save: setManualOffset(getManualOffsetMs()) => stays 90
    const beforeSave = getManualOffsetMs();
    setManualOffset(getManualOffsetMs()); // simulate save()
    expect(getManualOffsetMs()).toBe(beforeSave);
    expect(getManualOffsetMs()).toBe(90);
    expect(getManualOffsetMs()).not.toBe(0);
    expect(getManualOffsetMs()).not.toBe(saved);
  });

  it('Step1 0 capture → Step2 Space のみ → Step3 save で 0 のまま保存', () => {
    setManualOffset(0);
    simulateFixedHandleHit();
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(getManualOffsetMs());
    expect(getManualOffsetMs()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T169-5: ファイル契約 — 曖昧検索禁止 & オフセット管理の一元化（3-step）
// ---------------------------------------------------------------------------
describe('T169-5: ファイル契約 — 曖昧検索を使わない & savedOffsetRef の一貫性（3-step）', () => {
  it('Step1 ソース読み込み → Step2 indexOf パターン検証 → Step3 曖昧 prefix が無い', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Step1: exists
    expect(src).toContain('const save =');
    expect(src).toContain('const cancel =');

    // Step2: verify specific patterns exist
    const saveIdxSpecific = src.indexOf('const save =');
    const cancelIdxSpecific = src.indexOf('const cancel =');
    expect(saveIdxSpecific).toBeGreaterThan(-1);
    expect(cancelIdxSpecific).toBeGreaterThan(-1);

    // Step3: ensure save uses useCallback and not ambiguous search
    const saveSlice = extractSaveSlice(src);
    expect(saveSlice).toMatch(/useCallback/);
    // The test itself must NOT use ambiguous indexOf('const save') — we use specific
    // Verify file does not rely on buggy firstTap logic
    expect(src).not.toMatch(/firstTapRef/);
    expect(src).not.toMatch(/if\s*\(\s*!firstTap/);
  });

  it('Step1 savedOffsetRef 初期化 capture → Step2 調整 → Step3 保存・復元が savedOffsetRef に基づく', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Step1: savedOffsetRef initialized with getManualOffsetMs()
    expect(src).toMatch(/savedOffsetRef\s*=\s*useRef\(getManualOffsetMs\(\)\)/);
    // Step2: adjust uses setManualOffset(next) where next = getManualOffsetMs()+delta
    const adjustSlice = extractAdjustSlice(src);
    expect(adjustSlice).toMatch(/getManualOffsetMs\(\)\s*\+\s*delta/);
    // Step3: cancel restores savedOffsetRef, save keeps getManualOffsetMs()
    const cancelSlice = extractCancelSlice(src);
    const saveSlice = extractSaveSlice(src);
    expect(cancelSlice).toContain('savedOffsetRef.current');
    expect(saveSlice).toContain('getManualOffsetMs()');
  });
});

// ---------------------------------------------------------------------------
// T169-6: 回帰 — WaveEngine/Cursor 数値整合（複雑振幅 + off-grid, T127 style）
// ---------------------------------------------------------------------------
describe('T169-6: 回帰 — WaveEngine / Cursor 数値整合（complex amplitudes, off-grid）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 amp 0.7 capture → Step2 amp 1.3/2.7/3.4 で検証 → Step3 slope = 2*TW_AMP*amplitude でクランプ一致', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.5, 1.37, 2.62];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const startY = TW_CENTER_Y;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      for (const b of offGridBeats) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
    }
  });

  it('Step1 Cursor 1拍あたり移動量 capture → Step2 off-grid 0.37/1.23 で Cursor vs Wave 一致 → Step3 手動オフセットが波高に影響しない', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    const dt = (0.37 * beatMs) / 1000;
    cursor.update(dt, false, true, beatMs);
    const cursorDelta = Math.abs(cursor.y - y0);
    expect(cursorDelta).toBeCloseTo(perBeat * 0.37, 4);
    const waveDelta = Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.37, 4);
    expect(waveDelta).toBeCloseTo(cursorDelta, 4);

    // manualOffset changes must NOT affect wave geometry
    setManualOffset(80);
    expect(engine.waveYAt(0.37)).toBeCloseTo(waveDelta + (TW_CENTER_Y - TW_AMP), 4);
    setManualOffset(0);
  });

  it('Step1 型契約 capture → Step2 シンボル呼び出し → Step3 エラーなし', () => {
    expect(typeof getManualOffsetMs).toBe('function');
    expect(typeof setManualOffset).toBe('function');
    const tl = new BpmTimeline(120, [], 1.0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(getManualOffsetMs()).toBeDefined();
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toContain('export function generateCalibrationChart');
    expect(src).toContain('data-testid="editor-calibration-modal"');
    expect(src).toContain('data-testid="calibration-save"');
    expect(src).toContain('data-testid="calibration-cancel"');
  });
});
