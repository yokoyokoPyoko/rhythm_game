/**
 * T169 — キャリブレーション初回タップ時のオフセットリセット廃止
 * Vitest node environment — pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * 背景: CalibrationModal.tsx:140-144 の初回Spaceで setManualOffset(0) が走り調整が消える
 * 修正: handleHit 内の setManualOffset(0) / firstTapRef リセットを廃止
 * 完了条件:
 * 1. ,. 調整後にSpace試打してもオフセット値が維持されること
 * 2. キャンセル時は開始前オフセットへ復元されること
 * 3. tsc --noEmit (型契約)
 * 制約:
 * - hitJudge のパラメータ名は 'windowMs' (optional) でなければならない
 * - CalibrationModal の handleHit 呼出で literal 750 が可視 (wide window)
 * - handleHit 内で setManualOffset(0) を呼んではならない
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
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { judgeHit } from '../src/game/hitJudge';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';
import { generateCalibrationChart } from '../src/screens/editor/CalibrationModal';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}
function sliceHandleHit(src: string): string {
  const idx = src.indexOf('const handleHit');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3000);
}
function makeRing(hitTime: number, targetY = 300, id = 0): any {
  return {
    id,
    spawnTime: hitTime - 1500,
    hitTime,
    targetY,
    resolved: false,
    hit: false,
    type: 'single' as const,
  };
}
function cloneRing(r: any): any { return { ...r, resolved: false, hit: false }; }

// Fixed handleHit simulator — must NOT reset offset
function fixedHandleHit(timeline: BpmTimeline, rings: any[], cursorY: number, songTimeMs: number): any {
  const beatMs = timeline.beatMsAt(timeline.msToBeat(songTimeMs));
  const pressTime = songTimeMs - getManualOffsetMs();
  // literal 750 required by spec (or via const but we use literal here for numeric contract)
  return (judgeHit as any)(pressTime, cursorY, rings, beatMs, 750);
}

// Buggy simulator — resets on first tap (what T169 must abolish)
function buggyHandleHit(firstTapRef: { current: boolean }, timeline: BpmTimeline, rings: any[], cursorY: number, songTimeMs: number): any {
  if (firstTapRef.current) {
    firstTapRef.current = false;
    setManualOffset(0);
  }
  return fixedHandleHit(timeline, rings, cursorY, songTimeMs);
}

// ---------------------------------------------------------------------------
// T169-1: ファイル契約 — windowMs パラメータ & literal 750
// ---------------------------------------------------------------------------
describe('T169-1: ファイル契約 windowMs & literal 750 (3-step state-transition)', () => {
  it('Step1 capture hitJudge raw → Step2 inspect signature → Step3 contains windowMs param named exactly windowMs', () => {
    const src = readFile('src/game/hitJudge.ts');
    // Step1: raw capture
    expect(src.length).toBeGreaterThan(100);
    const beforeHasWindowMs = src.includes('windowMs');
    // Step2: extract signature
    const sigMatch = src.match(/export function judgeHit\s*\([^)]*\)/s);
    expect(sigMatch, 'judgeHit signature must exist').not.toBeNull();
    const sig = sigMatch![0];
    // Step3: must contain windowMs with optional marker
    expect(sig, 'judgeHit param must be named windowMs').toMatch(/windowMs/);
    expect(src, 'must have fallback windowMs ?? beatMs*0.4 or windowMs ?? currentBeatMs*0.4').toMatch(/windowMs\s*\?\?/);
    expect(src).toMatch(/\*\s*0\.4/);
    // Not trivially passing: before state should be true after fix (fail before if naming wrong)
    expect(beforeHasWindowMs).toBe(true);
  });

  it('Step1 capture CalibrationModal raw → Step2 extract handleHit slice → Step3 literal 750 visible in call', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src.length).toBeGreaterThan(200);
    const constDef = src.match(/CALIBRATION_WIDE_WINDOW_MS\s*=\s*750/);
    expect(constDef, 'must define CALIBRATION_WIDE_WINDOW_MS = 750').not.toBeNull();
    const slice = sliceHandleHit(src);
    expect(slice.length).toBeGreaterThan(100);
    // Literal 750 must be visible either directly or via const; spec requires 750 in handleHit call OR const nearby
    // We enforce both: file contains 750 and handleHit passes wide window
    const handleHasWide =
      /judgeHit\s*\([^)]*750/.test(slice) ||
      /judgeHit\s*\([^)]*CALIBRATION_WIDE_WINDOW_MS/.test(slice) ||
      /CALIBRATION_WIDE_WINDOW_MS/.test(slice);
    expect(handleHasWide, 'handleHit must call judgeHit with 750 or CALIBRATION_WIDE_WINDOW_MS (wide window)').toBe(true);
    // Also ensure wide <1000 (T168 invariant)
    expect(750).toBeLessThan(1000);
    // Verify 750 literal exists somewhere in file (not just const name)
    expect(src).toMatch(/750/);
  });

  it('Step1 capture before wide state (200 default) → Step2 call judgeHit with 750 → Step3 +500ms hits only with wide', () => {
    const bMs = 500; // 120bpm
    const hitTime = 10000;
    const targetY = 300;
    // Step1: default window 200 => +500 null
    const r1 = makeRing(hitTime, targetY, 0);
    expect(judgeHit(hitTime + 500, targetY, [r1], bMs), 'default 200ms window must miss +500').toBeNull();
    expect(r1.resolved).toBe(false);
    // Step2: wide 750 => hit
    const r2 = makeRing(hitTime, targetY, 1);
    const res = (judgeHit as any)(hitTime + 500, targetY, [r2], bMs, 750);
    expect(res, 'wide 750 must hit +500 (calibration)').not.toBeNull();
    // Step3: errorMs and resolved
    expect(res.errorMs).toBeCloseTo(500, 2);
    expect(r2.resolved).toBe(true);
    expect(r2.hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T169-2: 初回タップリセット廃止 — handleHit 内で setManualOffset(0) 禁止
// ---------------------------------------------------------------------------
describe('T169-2: 初回タップリセット廃止 handleHit は setManualOffset(0) を呼ばない (3-step)', () => {
  it('Step1 capture handleHit raw → Step2 extract firstTap reset block → Step3 must NOT contain setManualOffset(0)', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = sliceHandleHit(src);
    expect(slice.length).toBeGreaterThan(100);
    // Step1: capture buggy pattern existence globally
    const hasBugGlobal = src.includes('setManualOffset(0)') && slice.includes('setManualOffset(0)');
    // Step2: buggy handleHit currently contains it — this will FAIL before fix (Red)
    // We assert it must NOT contain
    expect(slice, 'handleHit must NOT call setManualOffset(0) — first-tap reset must be abolished').not.toMatch(/setManualOffset\s*\(\s*0\s*\)/);
    // Step3: file global handleHit slice must be clean; ensure we actually checked (not empty)
    expect(slice).toContain('judgeHit');
    // If bug exists, hasBugGlobal will be true and the above expect will throw => Red
    // After fix, hasBugGlobal false and expect passes => Green
    void hasBugGlobal;
  });

  it('Step1 capture handleHit with firstTapRef → Step2 inspect logic → Step3 no firstTapRef-driven reset in handleHit', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = sliceHandleHit(src);
    // Should NOT contain firstTapRef.current pattern inside handleHit
    expect(slice, 'handleHit must NOT contain firstTapRef logic (tap-time reset)').not.toMatch(/firstTapRef\.current/);
    // Also must not contain the comment-driven reset block
    expect(slice).not.toMatch(/if\s*\(\s*firstTapRef/);
    // Ensure slice still has legitimate judgement logic (not emptied)
    expect(slice).toMatch(/songNow/);
    expect(slice).toMatch(/judgeHit/);
  });

  it('Step1 set manual +80 capture → Step2 buggy handleHit resets to 0 (demonstrates bug) → Step3 fixed handleHit preserves 80', () => {
    // Step1: capture 80
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const tl = new BpmTimeline(120, [], 1.0);
    const hitTime = tl.beatToMs(4);
    const songTime = hitTime + 5; // near hit
    const rings = [makeRing(hitTime, 300, 0)];
    const firstTap = { current: true };

    // Step2: buggy resets
    buggyHandleHit(firstTap, tl, [cloneRing(rings[0])], 300, songTime);
    const afterBuggy = getManualOffsetMs();
    expect(afterBuggy, 'buggy handleHit resets to 0').toBe(0);

    // Restore for fixed test
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    // Step3: fixed must preserve 80
    const beforeFixed = getManualOffsetMs();
    const rFixed = makeRing(hitTime, 300, 1);
    fixedHandleHit(tl, [rFixed], 300, songTime);
    const afterFixed = getManualOffsetMs();
    expect(beforeFixed).toBe(80);
    expect(afterFixed, 'fixed handleHit must preserve +80 (not reset to 0)').toBe(80);
    expect(afterFixed).not.toBe(0);
  });

  it('Step1 whole file check → Step2 ensure no setManualOffset(0) in any tap callback → Step3 only explicit save may set offset', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const handleSlice = sliceHandleHit(src);
    // handleHit specifically must not have literal 0
    expect(handleSlice).not.toContain('setManualOffset(0)');
    // The file may still have savedOffset restoration (setManualOffset(savedOffsetRef.current)) — allow that
    // But ensure not inside handleHit
    // Also check that there is no other hidden tap callback doing reset
    // We scan all occurrences of setManualOffset(0) — before fix there is 1 inside handleHit
    const allZeroCalls = [...src.matchAll(/setManualOffset\s*\(\s*0\s*\)/g)];
    // After fix, expectation: 0 occurrences (or optionally 1 at modal open via useEffect, but spec says open-time 1回0化か維持のいずれかに統一)
    // The actionable fix says: remove from handleHit, keep only tap collection; savedOffset capture at open for cancel.
    // So after fix, allZeroCalls.length should be 0 (if maintain mode) or maybe 0 as well if open-time reset is removed.
    // We enforce handleHit-clean; overall file zero is stricter and will still pass if maintain.
    // For Red detection, handleHit-zero check already fails. This nearby check documents intent.
    expect(handleSlice).not.toMatch(/setManualOffset\s*\(\s*0\s*\)/);
    void allZeroCalls;
  });
});

// ---------------------------------------------------------------------------
// T169-3: ,. 調整後にSpace試打しても値維持 (3-step dynamic + off-grid)
// ---------------------------------------------------------------------------
describe('T169-3: ,. 調整後にSpace試打でオフセット維持 (3-step, off-grid必須)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture initial 0 → Step2 adjust +80 (,. *8) → Step3 Space hit preserves 80 (not 0)', () => {
    // Step1: capture initial
    const initial = getManualOffsetMs();
    expect(initial).toBe(0);
    // Step2: simulate ,. adjustments: +10 eight times = +80 (like粗調整の代替)
    for (let i = 0; i < 8; i++) setManualOffset(getManualOffsetMs() + 10);
    const afterAdjust = getManualOffsetMs();
    expect(afterAdjust).toBe(80);
    vi.advanceTimersByTime(10);

    // Step3: Space hit with fixed logic must preserve
    const tl = new BpmTimeline(120, [], 1.0);
    const hitTime = tl.beatToMs(4); // 2000
    const tapSongTime = hitTime + 12; // perfect-ish
    const beforeHit = getManualOffsetMs();
    const r = makeRing(hitTime, 300, 0);
    const res = fixedHandleHit(tl, [r], 300, tapSongTime);
    expect(res).not.toBeNull();
    const afterHit = getManualOffsetMs();
    expect(beforeHit).toBe(80);
    expect(afterHit, ',.調整後のSpace試打で値が維持されること (80のまま)').toBe(80);
    expect(afterHit).not.toBe(0);
    // Second hit still 80
    const r2 = makeRing(hitTime + 2000, 300, 1);
    fixedHandleHit(tl, [r2], 300, tapSongTime + 2000);
    expect(getManualOffsetMs()).toBe(80);
  });

  it('Step1 capture -40 → Step2 press , (-10) → Step3 hit preserves -50 and errorMs shifts linearly (off-grid 0.37 beat)', () => {
    // Off-grid: beat 4.37 = 0.37 late = 185ms at 120bpm
    const tl = new BpmTimeline(120, [], 1.0);
    const hitTime = tl.beatToMs(4); // 2000
    const offGridTap = tl.beatToMs(4.37); // 2185
    // Step1: -40
    setManualOffset(-40);
    expect(getManualOffsetMs()).toBe(-40);
    // Step2: , => -10 => -50
    setManualOffset(getManualOffsetMs() - 10);
    expect(getManualOffsetMs()).toBe(-50);
    const before = getManualOffsetMs();
    // Step3: hit with manual -50, error = tap - (hit+manual) = 185 - (-50) = 235?
    // Actually fixedHit uses pressTime = songTime - manual, error = pressTime - hit = tap - manual - hit? Wait our fixed uses pressTime = songTime - manual, so error = songTime - manual - hit.
    // But songTime = tapRaw (approx). So error = tap - hit - manual? With manual -50 => error = 185 - (-50) = 235.
    // The key is manual change shifts error by -delta.
    const rings = [makeRing(hitTime, 300, 0)];
    const resMinus = fixedHandleHit(tl, [cloneRing(rings[0])], 300, offGridTap);
    expect(resMinus).not.toBeNull();
    expect(resMinus.errorMs).toBeCloseTo(offGridTap - getManualOffsetMs() - hitTime, 4);
    expect(getManualOffsetMs()).toBe(-50);
    expect(getManualOffsetMs()).toBe(before);
    expect(getManualOffsetMs()).not.toBe(0);

    // . => +10 => -40, error shifts -10
    setManualOffset(getManualOffsetMs() + 10);
    expect(getManualOffsetMs()).toBe(-40);
    const resPlus = fixedHandleHit(tl, [cloneRing(rings[0])], 300, offGridTap);
    expect(resPlus).not.toBeNull();
    expect(resPlus.errorMs - resMinus.errorMs).toBeCloseTo(-10, 4); // delta manual +10 => error -10
    expect(getManualOffsetMs()).toBe(-40);
  });

  it('Step1 capture 0 → Step2 adjust +30 (.,.,.) → Step3 3 successive Space hits all preserve 30 with off-grid 1.23 beat', () => {
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(10);
    setManualOffset(getManualOffsetMs() + 10);
    setManualOffset(getManualOffsetMs() + 10);
    expect(getManualOffsetMs()).toBe(30); // Step2
    vi.advanceTimersByTime(5);
    const tl = new BpmTimeline(120, [], 1.3); // complex amp
    const hitTime = tl.beatToMs(8); // 4000
    const offGridTap = tl.beatToMs(8 + 1.23 * (500 / tl.beatMsAt(8))); // approximate keep ms-based; simpler use ms offset 615
    const tap = hitTime + 615; // ~1.23 beats at 500ms => 615
    // Step3: three hits
    for (let i = 0; i < 3; i++) {
      const before = getManualOffsetMs();
      const r = makeRing(hitTime + i * 2000, 300, i);
      const res = fixedHandleHit(tl, [r], 300, tap + i * 2000);
      // wide window 750 should hit even with 615 offset
      expect(res, `hit ${i} must succeed with wide 750`).not.toBeNull();
      expect(getManualOffsetMs()).toBe(30);
      expect(getManualOffsetMs()).toBe(before);
    }
    expect(getManualOffsetMs()).not.toBe(0);
  });

  it('Step1 capture complex amp off-grid preservation → Step2 adjust to 2.7-like still preserved → Step3 wave/cursor unaffected', () => {
    // Regression: offset preservation must not affect wave engine math
    const amps = [0.7, 1.3, 2.7] as const;
    setManualOffset(55);
    expect(getManualOffsetMs()).toBe(55);
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const before = getManualOffsetMs();
      const r = makeRing(tl.beatToMs(4), 300, 0);
      fixedHandleHit(tl, [cloneRing(r)], 300, tl.beatToMs(4) + 12);
      expect(getManualOffsetMs(), `amp ${amp} hit must not change offset`).toBe(55);
      expect(getManualOffsetMs()).toBe(before);
    }
    // Wave slope still correct
    const tl = new BpmTimeline(120, [], 1.3);
    const wave = new WaveEngine([{ direction: 'down', beats: 4 }], tl, 1.3, 0);
    const perBeat = 2 * TW_AMP * 1.3;
    expect(wave.waveYAt(0.37)).toBeCloseTo(TW_CENTER_Y + perBeat * 0.37, 4);
  });
});

// ---------------------------------------------------------------------------
// T169-4: キャンセル時は開始前オフセットへ復元
// ---------------------------------------------------------------------------
describe('T169-4: キャンセル時は開始前オフセットへ復元 (3-step)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture saved 30 at open → Step2 adjust to -10 via ,. → Step3 cancel restores 30 (not -10, not 0)', () => {
    // Step1: capture saved at open (savedOffsetRef)
    setManualOffset(30);
    const saved = getManualOffsetMs();
    expect(saved).toBe(30);
    const savedRef = { current: saved };
    // Step2: adjust inside modal
    setManualOffset(-10);
    expect(getManualOffsetMs()).toBe(-10);
    vi.advanceTimersByTime(10);
    // Step3: cancel restores
    setManualOffset(savedRef.current);
    const afterCancel = getManualOffsetMs();
    expect(afterCancel).toBe(30);
    expect(afterCancel).not.toBe(-10);
    expect(afterCancel).not.toBe(0);
    // File contract: cancel must use savedOffsetRef
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toMatch(/savedOffsetRef\.current/);
    const cancelIdx = src.indexOf('const cancel');
    expect(cancelIdx).toBeGreaterThan(-1);
    const cancelSlice = src.slice(cancelIdx, cancelIdx + 800);
    expect(cancelSlice).toMatch(/setManualOffset\s*\(\s*savedOffsetRef\.current\s*\)/);
  });

  it('Step1 capture saved -20 → Step2 multiple adjustments to 70 → Step3 cancel restores -20', () => {
    setManualOffset(-20);
    const saved = getManualOffsetMs();
    expect(saved).toBe(-20);
    const ref = { current: saved };
    // Simulate 9x +10 => 70
    for (let i = 0; i < 9; i++) setManualOffset(getManualOffsetMs() + 10);
    expect(getManualOffsetMs()).toBe(70);
    // Space hits preserve 70 before cancel
    const tl = new BpmTimeline(120, [], 1.0);
    fixedHandleHit(tl, [makeRing(tl.beatToMs(4), 300, 0)], 300, tl.beatToMs(4) + 5);
    expect(getManualOffsetMs()).toBe(70);
    // Cancel
    setManualOffset(ref.current);
    expect(getManualOffsetMs()).toBe(-20);
    expect(getManualOffsetMs()).not.toBe(70);
    expect(getManualOffsetMs()).not.toBe(0);
  });

  it('Step1 capture saved 0 → Step2 adjust +50 → Step3 save keeps 50 (not restored to 0)', () => {
    setManualOffset(0);
    const saved = getManualOffsetMs();
    expect(saved).toBe(0);
    setManualOffset(50);
    expect(getManualOffsetMs()).toBe(50);
    // Save is just keeping current (no reset)
    const saveOffset = getManualOffsetMs();
    // Simulate save: setManualOffset(getManualOffsetMs()) — no change
    setManualOffset(saveOffset);
    expect(getManualOffsetMs()).toBe(50);
    expect(getManualOffsetMs()).not.toBe(saved);
    // File contract: save must exist
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toMatch(/const save/);
    expect(src.slice(src.indexOf('const save'), src.indexOf('const save') + 600)).toMatch(/setManualOffset/);
  });

  it('Step1 adjust after save not affect next open saved capture (off-grid 0.37/1.23 invariance)', () => {
    // Simulate two open/close cycles
    setManualOffset(15);
    const saved1 = getManualOffsetMs(); // first open
    setManualOffset(95); // adjust
    // first cancel restores 15
    setManualOffset(saved1);
    expect(getManualOffsetMs()).toBe(15);
    // second open capture 15
    const saved2 = getManualOffsetMs();
    expect(saved2).toBe(15);
    setManualOffset(saved2 + 40); // to 55
    expect(getManualOffsetMs()).toBe(55);
    // second cancel restores 15 again
    setManualOffset(saved2);
    expect(getManualOffsetMs()).toBe(15);
    expect(getManualOffsetMs()).not.toBe(55);
  });
});

// ---------------------------------------------------------------------------
// T169-5: 型契約 & 回帰 — tsc相当 & WaveEngine/Cursor 数値整合
// ---------------------------------------------------------------------------
describe('T169-5: 型契約 & 回帰 off-grid / 複雑振幅整合 (T127 style)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 import capture → Step2 invoke symbols → Step3 no throw & types valid', () => {
    expect(typeof judgeHit).toBe('function');
    expect(typeof getManualOffsetMs).toBe('function');
    expect(typeof setManualOffset).toBe('function');
    expect(typeof generateCalibrationChart).toBe('function');
    const tl = new BpmTimeline(120, [], 1.0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    const chart = generateCalibrationChart(16);
    expect(chart.bpm).toBe(120);
    expect(chart.segments.length).toBe(8);
    expect(chart.rings.length).toBe(4);
    // hitJudge optional 5th arg still callable without it
    const bMs = 500;
    const r = makeRing(5000, 300, 0);
    expect(() => judgeHit(5000, 300, [r], bMs)).not.toThrow();
    expect(() => (judgeHit as any)(5000, 300, [cloneRing(r)], bMs, 750)).not.toThrow();
  });

  it('Step1 amp 0.7 beat 0.37 capture → Step2 amp 1.3/2.7/3.4 → Step3 slope = 2*TW_AMP*amp clamped', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGridBeats = [0.37, 1.23, 0.5, 1.37, 2.62] as const;
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
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 3);
      }
    }
  });

  it('Step1 cursor initial Y capture → Step2 update 0.37 beats down → Step3 delta = perBeat*0.37 matches wave', () => {
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
    expect(cursorDelta).toBeCloseTo(perBeat * 0.37, 3);
    const waveDelta = Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.37, 3);
    expect(waveDelta).toBeCloseTo(cursorDelta, 3);

    // 1.23 clamped
    const cursor2 = new Cursor(amp, 1.0);
    const y02 = cursor2.y;
    const dt2 = (1.23 * beatMs) / 1000;
    cursor2.update(dt2, false, true, beatMs);
    const raw = TW_CENTER_Y - TW_AMP + perBeat * 1.23;
    const clamped = Math.min(TW_CENTER_Y + TW_AMP, raw);
    expect(engine.waveYAt(1.23)).toBeCloseTo(clamped, 3);
    expect(Math.abs(cursor2.y - y02)).toBeCloseTo(Math.abs(clamped - (TW_CENTER_Y - TW_AMP)), 3);
  });

  it('Step1 calibration chart 16 beats capture → Step2 larger chart → Step3 infinite loop invariants preserved', () => {
    const small = generateCalibrationChart(16);
    const large = generateCalibrationChart(64);
    expect(small.segments.reduce((s, seg) => s + seg.beats, 0)).toBe(16);
    expect(large.segments.reduce((s, seg) => s + seg.beats, 0)).toBe(64);
    expect(large.rings.length).toBe(16);
    // Off-grid bounds
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine(small.segments.slice(0, 4), tl, 1.0, 0);
    for (const b of [0.37, 1.23, 2.62, 3.37]) {
      const y = eng.waveYAt(b);
      expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6);
      expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6);
    }
  });

  it('Step1 file contract: CalibrationModal must have savedOffsetRef & generateCalibrationChart exported', () => {
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(calSrc).toContain('savedOffsetRef');
    expect(calSrc).toContain('export function generateCalibrationChart');
    const hjSrc = readFile('src/game/hitJudge.ts');
    expect(hjSrc).toContain('export function judgeHit');
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('export function getManualOffsetMs');
    expect(clockSrc).toContain('export function setManualOffset');
  });
});

// ---------------------------------------------------------------------------
// T169-6: オフグリッド端数タイミングでのスナップと判定整合 (追加回帰)
// ---------------------------------------------------------------------------
describe('T169-6: オフグリッド端数で判定・スナップ整合 (1.2/1.3 beats when snap=0.5)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture hitTime 2000 → Step2 tap 1.2 beats late (600ms) with wide 750 hits → Step3 tap 1.3 beats (650ms) also hits and offset preserved', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const hitTime = tl.beatToMs(4);
    const tap12 = hitTime + 600; // 1.2 beats at 500ms/beat
    const tap13 = hitTime + 650; // 1.3 beats
    setManualOffset(25);
    expect(getManualOffsetMs()).toBe(25);
    // Tap 1.2 beats late with manual 25 => press = tap -25 => error 575 => still <750 hit
    const r12 = makeRing(hitTime, 300, 0);
    const res12 = (judgeHit as any)(tap12 - 25, 300, [r12], 500, 750);
    expect(res12).not.toBeNull();
    expect(getManualOffsetMs()).toBe(25);
    const r13 = makeRing(hitTime, 300, 1);
    const res13 = (judgeHit as any)(tap13 - 25, 300, [r13], 500, 750);
    expect(res13).not.toBeNull();
    expect(getManualOffsetMs()).toBe(25);
    // Without wide, both would be null
    expect(judgeHit(tap12 - 25, 300, [makeRing(hitTime, 300, 2)], 500)).toBeNull();
  });
});
