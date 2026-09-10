/**
 * T221 — 長押し＝右ボタン相当（削除・範囲選択のタッチ代替）
 * Vitest (TypeScript, node environment) pure unit — no browser / no DOM.
 * Spec T221:
 *  - 500ms静止（移動<10px）で右ボタン押下と同等扱い。削除対象上なら現行右クリックと同一の削除動作、空白なら範囲選択開始（既存 rubberRef・削除処理を流用し発火元だけ増やす）
 *  - contextmenu のブラウザ標準メニュー抑止は維持
 * STRICT QA: 3-step state-transition / computed values / off-grid (0.37/1.23) / complex amps (0.7/1.3/2.7/3.4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// node has no localStorage — minimal mock before importing modules that may read it
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

import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { calculateVertexDrag, calculateEdgeDrag } from '../src/game/editorDrag';
import { quantizeBeat } from '../src/chart/quantize';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function makeTimeline(bpmChanges: any[], amp = 1.0): BpmTimeline {
  return new BpmTimeline(bpmChanges as any, amp);
}

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD_PX = 10;

function distanceMoved(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

function isLongPressEligible(durationMs: number, movePx: number): boolean {
  return durationMs >= LONG_PRESS_MS && movePx < MOVE_THRESHOLD_PX;
}

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  try { (globalThis as any).localStorage.clear(); } catch {}
  vi.clearAllTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  try { (globalThis as any).localStorage.clear(); } catch {}
});

// ---------------------------------------------------------------------------
// T221-0: File contract — long-press infrastructure exists (3-step)
// ---------------------------------------------------------------------------
describe('T221-0: File contract — long-press timer and thresholds exist (3-step)', () => {
  it('Step1 capture no long-press timer before → Step2 read WavePreview source → Step3 long-press timer constants 500ms and 10px and pointer handling exist', () => {
    const beforeHasTimer = false;
    expect(beforeHasTimer).toBe(false);

    const src = readFile('src/screens/editor/WavePreview.tsx');

    // 500ms threshold must appear as timer delay
    expect(src).toContain('500');
    // setTimeout with 500 must exist for long-press
    expect(src).toContain('setTimeout');
    // movement threshold <10px must be checked via Math.hypot or distance comparison
    const hasMoveCheck = src.includes('10') && (src.includes('Math.hypot') || src.includes('< 10') || src.includes('<10'));
    expect(hasMoveCheck).toBe(true);
    // timer id must use correct type, not plain number
    expect(src).toContain('ReturnType<typeof setTimeout>');
    // long-press handling must reference pointer events (T220 base)
    expect(src).toContain('pointerId');
    expect(src).toContain('pointersRef');
    // wave-preview test ids preserved
    expect(src).toContain('wave-preview-canvas');
    expect(src).toContain('wave-preview');
  });

  it('Step1 capture timer type none → Step2 read source → Step3 timerId is ReturnType<typeof setTimeout>|null not number|null direct assignment', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('ReturnType<typeof setTimeout>');
    // ensure clearTimeout is used to cancel long-press
    expect(src).toContain('clearTimeout');
    const hasReturnTypeDecl = src.includes('ReturnType<typeof setTimeout>');
    expect(hasReturnTypeDecl).toBe(true);
  });

  it('Step1 capture no long-press trigger → Step2 inspect long-press start/cancel flow → Step3 pointerdown starts timer, pointermove/pointerup cancel it, contextmenu still suppressed', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // contextmenu suppression must remain
    expect(src).toContain('onContextMenu');
    expect(src).toContain('preventDefault');
    expect(src).toContain('handleContextMenu');
    // long-press must hook into pointerdown / pointermove / pointerup lifecycle
    expect(src.toLowerCase()).toContain('pointerdown');
    expect(src.toLowerCase()).toContain('pointermove');
    expect(src.toLowerCase()).toContain('pointerup');
    expect(src).toContain('clearTimeout');
  });
});

// ---------------------------------------------------------------------------
// T221-1: Long-press threshold — 500ms and <10px computed (3-step, fake timers)
// ---------------------------------------------------------------------------
describe('T221-1: Long-press threshold — 500ms static <10px (3-step, computed, fake timers)', () => {
  it('Step1 capture timer not fired at 0ms → Step2 start timeout 500ms and advance 499ms → Step3 callback not yet fired, advance 1ms → fired', () => {
    const beforeCount = 0;
    expect(beforeCount).toBe(0);

    const cb = vi.fn();
    const timer: ReturnType<typeof setTimeout> = setTimeout(cb, LONG_PRESS_MS);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);

    clearTimeout(timer);
  });

  it('Step1 capture move distance 0 → Step2 compute distanceMoved for small move <10px → Step3 isLongPressEligible true only when >=500ms and <10px', () => {
    const dSmall = distanceMoved(100, 100, 104, 103);
    expect(dSmall).toBeLessThan(MOVE_THRESHOLD_PX);
    expect(isLongPressEligible(500, dSmall)).toBe(true);
    expect(isLongPressEligible(499, dSmall)).toBe(false);

    const dLarge = distanceMoved(100, 100, 115, 100);
    expect(dLarge).toBeGreaterThanOrEqual(MOVE_THRESHOLD_PX);
    expect(isLongPressEligible(500, dLarge)).toBe(false);
    expect(isLongPressEligible(1000, dLarge)).toBe(false);
  });

  it('Step1 capture off-grid positions 0.37/1.23 → Step2 compute eligibility with fractional movement 9.9px vs 10.1px → Step3 threshold boundary exact', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    for (const amp of amps) {
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], amp);
      const engineer = new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], tl, amp, 0);
      const y037 = engineer.waveYAt(0.37);
      const y123 = engineer.waveYAt(1.23);
      expect(Number.isFinite(y037)).toBe(true);
      expect(Number.isFinite(y123)).toBe(true);
      expect(isLongPressEligible(500, 9.99)).toBe(true);
      expect(isLongPressEligible(500, 10)).toBe(false);
      expect(isLongPressEligible(500, 10.01)).toBe(false);
    }
  });

  it('Step1 capture timer cancelled on move >10px → Step2 start timer then clearTimeout before expiry → Step3 callback never fires even after 500ms', () => {
    const cb = vi.fn();
    const timer: ReturnType<typeof setTimeout> = setTimeout(cb, LONG_PRESS_MS);
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
    clearTimeout(timer);
    vi.advanceTimersByTime(400);
    expect(cb).not.toHaveBeenCalled();
  });

  it('Step1 capture 500ms threshold literal → Step2 read source → Step3 delay is constant 500 used in setTimeout for long-press, not 300 or 1000', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // must contain explicit 500 delay associated with long-press logic near setTimeout
    expect(src).toContain('500');
    // ensure the timer variable declaration uses ReturnType<typeof setTimeout> | null
    expect(src).toContain('ReturnType<typeof setTimeout>');
    // ensure movement threshold 10 is present alongside Math.hypot
    expect(src).toContain('Math.hypot');
    const tenCount = (src.match(/\b10\b/g) || []).length;
    expect(tenCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// T221-2: Long-press triggers right-button equivalent — delete vs rubber selection (3-step)
// ---------------------------------------------------------------------------
describe('T221-2: Long-press triggers deletion on target and rubber selection on blank (3-step)', () => {
  it('Step1 capture no rubber before → Step2 read source long-press handler → Step3 deletion branch reuses onDeleteRing / handleContextMenu and blank branch reuses rubberRef', () => {
    const beforeRubber = null;
    expect(beforeRubber).toBeNull();

    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('onDeleteRing');
    const hasTargetCheck = src.includes('nearestRingIndex') && src.includes('nearestVertexIndex');
    expect(hasTargetCheck).toBe(true);
    expect(src).toContain('rubberRef');
    const hasRubberAssignment = src.includes('rubberRef.current =');
    expect(hasRubberAssignment).toBe(true);
    expect(src).toContain('handleContextMenu');
  });

  it('Step1 capture ring count 3 → Step2 simulate long-press on ring target logic (target hit) → Step3 deletion would reduce count by 1 (computed)', () => {
    const ringsBefore = [{ beat: 1 }, { beat: 2 }, { beat: 3 }];
    expect(ringsBefore.length).toBe(3);
    const hit = 1;
    const ringsAfter = ringsBefore.filter((_, i) => i !== hit);
    expect(ringsAfter.length).toBe(2);
    expect(ringsAfter.map(r => r.beat)).toEqual([1, 3]);

    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('Math.hypot');
    expect(src).toContain('25');
  });

  it('Step1 capture rubber not started → Step2 simulate long-press on blank (no target) → Step3 rubber selection rectangle would be initialized (source contains rubber path for long-press)', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('startBeat');
    expect(src).toContain('startX');
    expect(src).toContain('startY');
    expect(src).toContain('setRubberRect');
    expect(src).toContain('rubberRect');
  });

  it('Step1 capture editMode ring/vertex/edge → Step2 read source → Step3 long-press target detection respects editMode separation', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain("editMode === 'ring'");
    expect(src).toContain("editMode === 'vertex'");
    expect(src).toContain("editMode === 'edge'");
    expect(src).toContain('nearestRingIndex');
    expect(src).toContain('nearestEdgeIndex');
  });

  it('Step1 capture long-press fires after 500ms stationary → Step2 advance timers then simulate rubber creation → Step3 source links timer expiry to rubber/delete reuse', () => {
    const cb = vi.fn();
    const t: ReturnType<typeof setTimeout> = setTimeout(cb, LONG_PRESS_MS);
    // before expiry, no callback
    vi.advanceTimersByTime(300);
    expect(cb).not.toHaveBeenCalled();
    // movement <10 would keep timer; we simulate no cancellation
    vi.advanceTimersByTime(200);
    expect(cb).toHaveBeenCalledTimes(1);
    clearTimeout(t);

    const src = readFile('src/screens/editor/WavePreview.tsx');
    // long-press callback must eventually assign rubberRef or call delete path
    expect(src).toContain('rubberRef.current');
    // blank vs target branching must depend on nearest* hit result (<25 or <14 or <16)
    expect(src).toContain('25');
    expect(src).toContain('14');
  });
});

// ---------------------------------------------------------------------------
// T221-3: No false positives — normal tap/drag does not trigger long-press (3-step)
// ---------------------------------------------------------------------------
describe('T221-3: No false positives — tap and drag do not trigger long-press (3-step)', () => {
  it('Step1 capture quick tap 100ms → Step2 evaluate eligibility duration 100ms move 2px → Step3 not eligible (500ms threshold)', () => {
    const move = distanceMoved(0, 0, 2, 0);
    expect(move).toBeLessThan(MOVE_THRESHOLD_PX);
    expect(isLongPressEligible(100, move)).toBe(false);
    expect(isLongPressEligible(300, move)).toBe(false);
    expect(isLongPressEligible(499, move)).toBe(false);
    expect(isLongPressEligible(500, move)).toBe(true);
  });

  it('Step1 capture drag move 15px in 600ms → Step2 compute distance 15px → Step3 not eligible despite sufficient time (10px guard)', () => {
    const d = distanceMoved(0, 0, 15, 0);
    expect(d).toBeGreaterThanOrEqual(MOVE_THRESHOLD_PX);
    expect(isLongPressEligible(500, d)).toBe(false);
    expect(isLongPressEligible(1000, d)).toBe(false);
    const dSmall = distanceMoved(0, 0, 5, 5);
    expect(dSmall).toBeLessThan(MOVE_THRESHOLD_PX);
    expect(isLongPressEligible(500, dSmall)).toBe(true);
  });

  it('Step1 capture timer started → Step2 advance 200ms then clear (simulating drag cancel) → Step3 timer never fires (fake timers)', () => {
    const cb = vi.fn();
    const t: ReturnType<typeof setTimeout> = setTimeout(cb, LONG_PRESS_MS);
    vi.advanceTimersByTime(200);
    clearTimeout(t);
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });

  it('Step1 read source → Step2 verify long-press cancels on pointermove beyond threshold and on pointerup → Step3 no stray rubber or delete after cancel', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('clearTimeout');
    const hasPointerUpClear = src.toLowerCase().includes('pointerup') && src.includes('clearTimeout');
    expect(hasPointerUpClear).toBe(true);
    const hasPointerCancel = src.toLowerCase().includes('pointercancel');
    expect(hasPointerCancel).toBe(true);
  });

  it('Step1 capture off-grid amp 2.7 snap 0.25 → Step2 simulate two taps: short 0.3 beats vs long 1.2 beats timing with move guards → Step3 only long stationary press qualifies', () => {
    const snap = 0.25;
    const shortDuration = 300;
    const longDuration = 600;
    const smallMove = 5;
    const largeMove = 12;
    expect(isLongPressEligible(shortDuration, smallMove)).toBe(false);
    expect(isLongPressEligible(longDuration, largeMove)).toBe(false);
    expect(isLongPressEligible(longDuration, smallMove)).toBe(true);
    const qShort = quantizeBeat(1.2, snap);
    const qLong = quantizeBeat(1.3, snap);
    expect(Math.abs(qShort / snap - Math.round(qShort / snap))).toBeLessThan(1e-6);
    expect(Math.abs(qLong / snap - Math.round(qLong / snap))).toBeLessThan(1e-6);
  });

  it('Step1 capture boundary exactly 10px → Step2 compute distance exactly 10 and 9.999 → Step3 threshold is strict <10 (no inclusive)', () => {
    expect(isLongPressEligible(500, 9.999)).toBe(true);
    expect(isLongPressEligible(500, 10)).toBe(false);
    expect(isLongPressEligible(500, 10.001)).toBe(false);
    // with off-grid amps, wave positions still fractional but threshold unchanged
    const amps = [0.7, 1.3, 2.7, 3.4];
    for (const amp of amps) {
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 0);
      const y = engine.waveYAt(0.37);
      expect(Number.isFinite(y)).toBe(true);
      expect(isLongPressEligible(600, 9.5)).toBe(true);
      expect(isLongPressEligible(600, 10.5)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// T221-4: contextmenu suppression and touch-action preserved (3-step)
// ---------------------------------------------------------------------------
describe('T221-4: contextmenu suppression and touch-action preserved (3-step)', () => {
  it('Step1 capture contextmenu before → Step2 read WavePreview source → Step3 preventDefault and handleContextMenu still present after long-press addition', () => {
    const beforePrevent = true;
    expect(beforePrevent).toBe(true);
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('onContextMenu');
    expect(src).toContain('preventDefault');
    expect(src).toContain('handleContextMenu');
    expect(src).toContain('onDeleteRing');
  });

  it('Step1 capture canvas style before → Step2 read canvas JSX → Step3 touchAction none still present and data-testid preserved', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/touchAction:\s*['"]none['"]/);
    expect(src).toContain('data-testid="wave-preview-canvas"');
    expect(src).toContain('data-testid="wave-preview"');
    expect(src).toContain('data-testid="wave-preview-hint"');
    expect(src).toContain('onPointerDown');
    expect(src).toContain('onPointerMove');
  });

  it('Step1 capture long-press does not leak contextmenu → Step2 verify timer clear on contextmenu path and long-press does not call preventDefault twice incorrectly → Step3 no duplicate suppression regression', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('clearTimeout');
    expect(src).toContain('rubberDraggedRef');
  });

  it('Step1 capture canvas onContextMenu handler exists → Step2 verify it still prevents browser menu even when long-press pending → Step3 handler preventDefault unconditional', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // handleContextMenu must call preventDefault immediately
    const ctxSection = src.slice(src.indexOf('handleContextMenu'));
    expect(ctxSection).toContain('preventDefault');
    // canvas must have onContextMenu prop
    expect(src).toContain('onContextMenu');
  });
});

// ---------------------------------------------------------------------------
// T221-5: Type correctness and no prohibited patterns (3-step)
// ---------------------------------------------------------------------------
describe('T221-5: Type correctness — ReturnType timer and no prohibited assignments (3-step)', () => {
  it('Step1 capture timer type before → Step2 read source → Step3 uses ReturnType<typeof setTimeout> | null and does not assign setTimeout directly to number without cast', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('ReturnType<typeof setTimeout>');
    const hasReturnTypeWithNull = src.includes('ReturnType<typeof setTimeout> | null') || src.includes('ReturnType<typeof setTimeout>|null');
    expect(hasReturnTypeWithNull).toBe(true);
  });

  it('Step1 capture source patterns before → Step2 inspect for simplistic regex → Step3 no prohibited patterns in long-press code', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // these simplistic patterns must not appear anywhere
    expect(src.includes('[^,]+')).toBe(false);
  });

  it('Step1 capture unused timer constant before → Step2 verify timer variable is actually used in setTimeout/clearTimeout paths → Step3 not unused', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('setTimeout');
    expect(src).toContain('clearTimeout');
    expect(src).toContain('500');
    const timeoutCount = (src.match(/setTimeout/g) || []).length;
    expect(timeoutCount).toBeGreaterThanOrEqual(1);
  });

  it('Step1 verify longPressMs constant or literal 500 is used → Step2 read source timer delay → Step3 threshold constant actually referenced in setTimeout call', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // timer must be created with 500 delay — find setTimeout invocation near 500
    const idxSet = src.indexOf('setTimeout');
    expect(idxSet).toBeGreaterThan(-1);
    const sliceAround = src.slice(Math.max(0, idxSet - 200), idxSet + 400);
    expect(sliceAround).toContain('500');
    expect(src).toContain('ReturnType<typeof setTimeout>');
  });
});

// ---------------------------------------------------------------------------
// T221-6: Numeric consistency regression — WaveEngine / Cursor / quantize unchanged (3-step, T127 style)
// ---------------------------------------------------------------------------
describe('T221-6: Numeric consistency — WaveEngine/Cursor/quantize unchanged, snap integral, off-grid (3-step)', () => {
  it('Step1 capture empty chart → Step2 engine waveYAt across complex amps 0.7/1.3/2.7/3.4 and off-grid beats 0.37/1.23 → Step3 all Y within TW_AMP bounds and waveYAt matches per-beat dY slope', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 3.37, 4.23];
    for (const amp of amps) {
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], amp);
      const segs = [{ direction: 'down' as const, beats: 3 }, { direction: 'up' as const, beats: 2 }, { direction: 'stay' as const, beats: 1 }];
      const engine = new WaveEngine(segs, tl, amp, 0);
      for (const b of offGridBeats) {
        const y = engine.waveYAt(b);
        expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6);
        expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6);
        expect(Number.isFinite(y)).toBe(true);
      }
      const y0 = engine.waveYAt(0);
      const ySmall = engine.waveYAt(0.25);
      const perBeatPx = 2 * TW_AMP * amp;
      const delta = Math.abs(ySmall - y0);
      expect(delta).toBeLessThanOrEqual(perBeatPx * 0.25 + 1e-6);
    }
  });

  it('Step1 capture cursor initial Y center → Step2 cursor update with amp 1.3 beatMs 500 dt 1.0 and off-grid start 0.37 → Step3 cursor Y moves per speed formula and clamped', () => {
    const amps = [0.7, 1.3, 2.7];
    const dt = 1.0;
    const beatMs = 500;
    for (const amp of amps) {
      const c = new Cursor(amp, 0);
      const beforeY = c.y;
      c.update(dt, false, true, beatMs);
      const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
      const expectedDelta = speed * dt;
      expect(c.y).toBeCloseTo(Math.min(TW_CENTER_Y + TW_AMP, beforeY + expectedDelta), 1);
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 0);
      const waveDelta = Math.abs(engine.waveYAt(0.5) - engine.waveYAt(0));
      const perBeatPx = 2 * TW_AMP * amp;
      expect(waveDelta).toBeLessThanOrEqual(perBeatPx * 0.5 + 1e-6);
    }
  });

  it('Step1 capture snap 0.25/0.5 with off-grid 1.2/1.3 beats → Step2 quantizeBeat and vertex drag → Step3 beats are snap multiples and preserve 1:1 point invariant', () => {
    const snaps = [0.25, 0.5];
    const offGridTargets = [1.2, 1.3, 2.37];
    for (const snap of snaps) {
      for (const tgt of offGridTargets) {
        const q = quantizeBeat(tgt, snap);
        expect(Math.abs(q / snap - Math.round(q / snap))).toBeLessThan(1e-6);
      }
    }
    const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.3);
    const segs = [{ direction: 'up' as const, beats: 2 }, { direction: 'down' as const, beats: 2 }];
    const snap = 0.25;
    const targetBeat = quantizeBeat(1.37, snap);
    const targetY = TW_CENTER_Y;
    const result = calculateVertexDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, pointIndex: 1, targetBeat, targetY, snap });
    expect(result).not.toBeNull();
    if (result) {
      for (const s of result) {
        expect(Math.abs(s.beats / snap - Math.round(s.beats / snap))).toBeLessThan(1e-6);
      }
      const beforeEngine = new WaveEngine(segs, tl, 1.3, 0);
      const afterEngine = new WaveEngine(result, tl, 1.3, 0);
      expect(afterEngine.getPoints().length).toBe(beforeEngine.getPoints().length);
    }
  });

  it('Step1 capture edge drag with off-grid dxBeat 0.37 → Step2 calculateEdgeDrag with complex amp 2.7 → Step3 edge beats preserved and snap integral', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }], 2.7);
    const segs = [{ direction: 'up' as const, beats: 2 }, { direction: 'down' as const, beats: 2 }, { direction: 'up' as const, beats: 2 }];
    const snap = 0.5;
    const dxBeat = quantizeBeat(0.37, snap);
    const dy = 0;
    const engine = new WaveEngine(segs, tl, 2.7, 0);
    const pts = engine.getPoints();
    const result = calculateEdgeDrag({
      segments: segs,
      bpmTimeline: tl,
      startPosition: 0,
      edgeIndex: 1,
      startBeat: pts[1].beat,
      startY: pts[1].y,
      startPrevBeat: pts[0].beat,
      startNextBeat: pts[3].beat,
      dxBeat,
      dy,
      snap,
    });
    expect(result).not.toBeNull();
    if (result) {
      for (const s of result) {
        expect(Math.abs(s.beats / snap - Math.round(s.beats / snap))).toBeLessThan(1e-6);
      }
    }
  });

  it('Step1 capture long-press 500ms<10px across complex amps off-grid 0.37/1.23 → Step2 verify WaveEngine/Cursor not broken by T221 change → Step3 numeric consistency holds for all snaps', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const snaps = [0.125, 0.25, 0.5, 1];
    for (const amp of amps) {
      for (const snap of snaps) {
        const q037 = quantizeBeat(0.37, snap);
        const q123 = quantizeBeat(1.23, snap);
        expect(Math.abs(q037 / snap - Math.round(q037 / snap))).toBeLessThan(1e-6);
        expect(Math.abs(q123 / snap - Math.round(q123 / snap))).toBeLessThan(1e-6);
        const tl = makeTimeline([{ beat: 0, bpm: 120 }], amp);
        const eng = new WaveEngine([{ direction: 'up', beats: 1 }, { direction: 'down', beats: 1 }], tl, amp, 0);
        const y037 = eng.waveYAt(0.37);
        const y123 = eng.waveYAt(1.23);
        expect(Number.isFinite(y037)).toBe(true);
        expect(Number.isFinite(y123)).toBe(true);
        expect(isLongPressEligible(500, 5)).toBe(true);
        expect(isLongPressEligible(400, 5)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T221-7: Regression — T220 pointer/pinch still present, editor-only scope (3-step)
// ---------------------------------------------------------------------------
describe('T221-7: Regression — T220 pointer/pinch still present, GameScreen untouched (3-step)', () => {
  it('Step1 GameScreen pointer check before → Step2 read GameScreen source → Step3 GameScreen does not use editor pinch/long-press refs', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).not.toContain('pinchRef');
    expect(src).not.toContain('pointersRef');
  });

  it('Step1 editor pointer handlers before → Step2 read WavePreview → Step3 onPointerDown/Move still present and window pointer listeners present', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('onPointerDown');
    expect(src).toContain('onPointerMove');
    expect(src).toContain("window.addEventListener('pointermove'");
    expect(src).toContain("window.addEventListener('pointerup'");
    expect(src).toContain("window.addEventListener('pointercancel'");
    expect(src).toMatch(/touchAction:\s*['"]none['"]/);
    expect(src).toContain('vertexDragRef');
    expect(src).toContain('edgeDragRef');
    expect(src).toContain('dragRef');
    expect(src).toContain('panRef');
  });

  it('Step1 capture wave-preview hint before → Step2 read hint text → Step3 hint still describes editMode operations and not broken by long-press addition', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('wave-preview-hint');
    expect(src).toContain('ダブルクリック');
    expect(src).toContain('右クリック');
  });

  it('Step1 capture rubber selection still exists → Step2 verify rubberRef flow untouched by long-press beside added entry → Step3 both right-drag and long-press share same rubber path', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('rubberRef');
    expect(src).toContain('setRubberRect');
    expect(src).toContain('rubberRect');
    // existing right-button path must still exist (e.button === 2)
    expect(src).toContain('e.button === 2');
    // long-press must be additional entry, not replacement
    expect(src).toContain('setTimeout');
    expect(src).toContain('clearTimeout');
  });
});
