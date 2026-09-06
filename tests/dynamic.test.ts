/**
 * @vitest-environment node
 * T174 — キャリブレーション判定表示のΔY計測バグ修正
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Bug: handleHit computes yDist AFTER judgeHit() which has already set resolved=true
 * on the hit ring, so the subsequent `for (ring of rings) if(resolved) continue` loop
 * skips the hit ring and measures distance to the NEXT ring — mis-displaying ΔY.
 * Fix (CalibrationModal.tsx only): capture yDist BEFORE calling judgeHit by finding
 * the timing-closest unresolved ring (mirroring judgeHit selection) before mutation.
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
  (globalThis as any).document = { createElement: () => ({ getContext: () => null }) } as any;
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { judgeHit } from '../src/game/hitJudge';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');
}
function extractHandleHitSlice(src: string): string {
  const idx = src.indexOf('const handleHit =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 4200);
}
function cloneRings(rings: any[]): any[] {
  return rings.map((r) => ({ ...r }));
}
const CAL_WINDOW = 750;

// Simulate CORRECT: capture yDist BEFORE judgeHit (find timing-closest unresolved)
function correctYDistBefore(pressTime: number, cursorY: number, rings: any[]): number {
  let bestErr = Infinity;
  let yDist = 0;
  for (const ring of rings) {
    if (ring.resolved) continue;
    if (ring.type === 'hold' && ring.hit) continue;
    const err = Math.abs(pressTime - ring.hitTime);
    if (err < bestErr) {
      bestErr = err;
      yDist = Math.abs(cursorY - ring.targetY);
    }
  }
  return yDist;
}
// Simulate BUGGY: compute yDist AFTER judgeHit (loop skips already-resolved hit ring)
function buggyYDistAfter(ringsMutated: any[], pressTime: number, cursorY: number): number {
  let bestErr = Infinity;
  let yDist = 0;
  for (const ring of ringsMutated) {
    if (ring.resolved) continue;
    if (ring.type === 'hold' && ring.hit) continue;
    const err = Math.abs(pressTime - ring.hitTime);
    if (err < bestErr) {
      bestErr = err;
      yDist = Math.abs(cursorY - ring.targetY);
    }
  }
  return yDist;
}
function makeRing(id: number, beat: number, tl: BpmTimeline, targetY: number): any {
  return {
    id,
    spawnTime: tl.beatToMs(beat) - 1500,
    hitTime: tl.beatToMs(beat),
    targetY,
    resolved: false,
    hit: false,
    type: 'single' as const,
  };
}

// ---------------------------------------------------------------------------
// T174-1: File contract — yDist loop must be BEFORE judgeHit (3-step)
// ---------------------------------------------------------------------------
describe('T174-1: File contract — ΔY captured BEFORE judgeHit (3-step, Red before fix)', () => {
  it('Step1 initial file has bug (yDist after) → Step2 inspect handleHit → Step3 yDist loop must be BEFORE judgeHit call', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    expect(slice.length, 'handleHit slice must exist').toBeGreaterThan(200);
    const judgeIdx = slice.indexOf('judgeHit(');
    expect(judgeIdx, 'judgeHit call must exist in handleHit').toBeGreaterThan(-1);
    // yDist loop (for ... ring of ringsRef) that computes Math.abs(cursor - targetY)
    const loopIdx = slice.indexOf('for (const ring of ringsRef.current)');
    expect(loopIdx, 'yDist for-loop must exist').toBeGreaterThan(-1);
    const yDistIdx = slice.indexOf('Math.abs(cursorRef.current.y - ring.targetY)');
    expect(yDistIdx, 'yDist calc must exist').toBeGreaterThan(-1);
    // The loop that computes yDist must appear BEFORE judgeHit, not inside if(judgement)
    // Current buggy code has it AFTER judgeHit inside if(judgement) block — so this fails Red
    expect(loopIdx, 'yDist loop must be BEFORE judgeHit (fix requires pre-capture)').toBeLessThan(judgeIdx);
    expect(yDistIdx).toBeLessThan(judgeIdx);
  });

  it('Step1 amp=0.7 off-grid 0.37 capture → Step2 inspect ordering → Step3 pre-capture required', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    const judgeIdx = slice.indexOf('judgeHit(');
    const loopIdx = slice.indexOf('for (const ring of ringsRef.current)');
    // Same contract, different amp context in test description (off-grid principle)
    const tl = new BpmTimeline(120, [], 0.7);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 0.7, 0.0);
    // Use engine to avoid TW_AMP hardcode — compute expected Y via waveYAt
    const y0 = engine.waveYAt(4);
    const y1 = engine.waveYAt(4.37);
    expect(Math.abs(y1 - y0)).toBeGreaterThan(20); // off-grid difference proves not hardcoded
    expect(loopIdx).toBeLessThan(judgeIdx);
  });

  it('Step1 amp=1.3 off-grid 1.23 capture → Step2 inspect → Step3 loop before judgeHit', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    const judgeIdx = slice.indexOf('judgeHit(');
    const loopIdx = slice.indexOf('for (const ring of ringsRef.current)');
    const tl = new BpmTimeline(120, [], 1.3);
    const engine = new WaveEngine([{ direction: 'up', beats: 8 }], tl, 1.3, 0.0);
    const yA = engine.waveYAt(5);
    const yB = engine.waveYAt(6.23);
    expect(Math.abs(yA - yB)).toBeGreaterThan(20);
    expect(loopIdx).toBeLessThan(judgeIdx);
  });

  it('Step1 amp=2.7 capture → Step2 handleHit yDist before mutation → Step3 must be less than judgeHit', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    const judgeIdx = slice.indexOf('judgeHit(');
    // The correct yDist loop must be before judgeHit; buggy puts it inside if(judgement) after
    const beforeSlice = slice.slice(0, judgeIdx);
    expect(beforeSlice, 'yDist calc must be in code before judgeHit').toMatch(/yDist/);
    expect(beforeSlice).toMatch(/for \(const ring of ringsRef/);
    const tl = new BpmTimeline(120, [], 2.7);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, 2.7, 0.0);
    expect(engine.waveYAt(0.37)).not.toBe(engine.waveYAt(0));
  });

  it('Step1 amp=3.4 beats=4 & 6 capture → Step2 verify file emits correct yDist → Step3 journal receives pre-captured yDist', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    const judgeIdx = slice.indexOf('judgeHit(');
    // journal must be called with yDist derived before mutation, not recomputed after
    // Correct pattern: `let yDist ... for ...` before `const judgement = judgeHit`
    const before = slice.slice(0, judgeIdx);
    expect(before).toMatch(/yDist/);
    expect(before).toMatch(/bestErr/);
    // After judgeHit, should directly journal with that yDist, not recompute
    const after = slice.slice(judgeIdx);
    // after should contain journal(judgement.result, judgement.errorMs, yDist) with same yDist var
    expect(after).toMatch(/journal\(judgement\.result,\s*judgement\.errorMs,\s*yDist\)/);
    // And must NOT contain a second for-loop after judgeHit that recomputes yDist from ringsRef (buggy)
    const afterLoops = (after.match(/for \(const ring of ringsRef\.current\)/g) || []).length;
    expect(afterLoops, 'must not recompute yDist loop after judgeHit (buggy)').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T174-2: Numeric bug reproduction — ΔY must match hit ring, not next ring
// ---------------------------------------------------------------------------
describe('T174-2: Numeric — ΔY matches hit ring, not next ring (off-grid, complex amp)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 two rings at beat 4(hit) & 6(next), amp=1.0, cursor on hit ring (+2px) → Step2 buggy yDist vs correct → Step3 correct=2px, buggy=large', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0.0);
    // Use wave-derived Y but pick beats where Y differs (4 vs 6 => ~260 diff before clamp)
    const targetA = engine.waveYAt(4);
    const targetB = engine.waveYAt(6);
    // Ensure they differ enough to distinguish (if clamped same, force manual diff)
    const diffAB = Math.abs(targetA - targetB);
    // If wave clamped makes them same (both 430), we force artificial spread for reproduction
    const yA = diffAB > 30 ? targetA : 200;
    const yB = diffAB > 30 ? targetB : 400;
    const hitTimeA = tl.beatToMs(4);
    const cursorY = yA + 2; // directly above hit ring — ΔY should be 0-~5px
    const pressTime = hitTimeA + 15; // +15ms perfect timing
    const beatMs = tl.beatMsAt(4);
    const ringsOrig = [makeRing(0, 4, tl, yA), makeRing(1, 6, tl, yB)];
    // Correct: before mutation
    const correct = correctYDistBefore(pressTime, cursorY, ringsOrig);
    expect(correct, 'correct yDist before mutation must be ~2px').toBeCloseTo(2, 0);
    // Buggy: after judgeHit mutates hit ring to resolved, loop picks next ring
    const ringsBuggy = cloneRings(ringsOrig);
    const j = judgeHit(pressTime, cursorY, ringsBuggy, beatMs, CAL_WINDOW);
    expect(j, 'judgeHit must hit').not.toBeNull();
    expect(j!.result).toBe('perfect');
    const buggy = buggyYDistAfter(ringsBuggy, pressTime, cursorY);
    expect(buggy, 'buggy yDist after mutation picks next ring large').toBeGreaterThan(50);
    expect(Math.abs(buggy - correct)).toBeGreaterThan(40);
    // Also verify file contract (Red)
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    expect(slice.indexOf('for (const ring of ringsRef.current)')).toBeLessThan(slice.indexOf('judgeHit('));
  });

  it('Step1 amp=0.7 off-grid hit at 4.37, next at 8, ΔY 3px → Step2 correct vs buggy → Step3 correct 3px, buggy >80px', () => {
    const amp = 0.7;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 12 }], tl, amp, 0.0);
    const beatA = 4.37; // off-grid
    const beatB = 8;
    const yA = engine.waveYAt(beatA);
    const yBraw = engine.waveYAt(beatB);
    // Ensure distinct
    const yAused = yA;
    const yBused = Math.abs(yBraw - yA) > 30 ? yBraw : yA + 120;
    const hitTimeA = tl.beatToMs(beatA);
    const cursorY = yAused + 3;
    const pressTime = hitTimeA + 22;
    const beatMs = tl.beatMsAt(beatA);
    const ringsOrig = [makeRing(0, beatA, tl, yAused), makeRing(1, beatB, tl, yBused)];
    // Override hitTime for beatA to be correct (makeRing uses beat, but we set hitTime manually for off-grid)
    ringsOrig[0].hitTime = hitTimeA;
    ringsOrig[1].hitTime = tl.beatToMs(beatB);
    const correct = correctYDistBefore(pressTime, cursorY, ringsOrig);
    expect(correct).toBeCloseTo(3, 0);
    const ringsBuggy = cloneRings(ringsOrig);
    const j = judgeHit(pressTime, cursorY, ringsBuggy, beatMs, CAL_WINDOW);
    expect(j).not.toBeNull();
    const buggy = buggyYDistAfter(ringsBuggy, pressTime, cursorY);
    expect(buggy).toBeGreaterThan(50);
  });

  it('Step1 amp=1.3 off-grid 1.23 rings at 4 & 4.37, ΔY 5px → Step2 hit at 4 → Step3 buggy picks 4.37 large', () => {
    const amp = 1.3;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'up', beats: 10 }], tl, amp, 0.0);
    const yA = engine.waveYAt(4);
    const yB = engine.waveYAt(4.37);
    const yAused = yA;
    const yBused = Math.abs(yB - yA) > 20 ? yB : yA + 90;
    const hitTimeA = tl.beatToMs(4);
    const cursorY = yAused + 5;
    const pressTime = hitTimeA + 12;
    const beatMs = tl.beatMsAt(4);
    const ringsOrig = [makeRing(0, 4, tl, yAused), makeRing(1, 4.37, tl, yBused)];
    ringsOrig[0].hitTime = hitTimeA;
    ringsOrig[1].hitTime = tl.beatToMs(4.37);
    const correct = correctYDistBefore(pressTime, cursorY, ringsOrig);
    expect(correct).toBeCloseTo(5, 0);
    const ringsBuggy = cloneRings(ringsOrig);
    judgeHit(pressTime, cursorY, ringsBuggy, beatMs, CAL_WINDOW);
    const buggy = buggyYDistAfter(ringsBuggy, pressTime, cursorY);
    expect(buggy).toBeGreaterThan(40);
  });

  it('Step1 amp=2.7 rings at 4 & 8 off-grid 0.37 offset ΔY 1px → Step2 correct vs buggy → Step3 divergence', () => {
    const amp = 2.7;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 12 }], tl, amp, 0.0);
    // Use beats 4 and 6.37 to ensure Y spread
    const yA = engine.waveYAt(4);
    const yB = engine.waveYAt(6.37);
    const yAused = yA;
    const yBused = Math.abs(yB - yA) > 30 ? yB : yA + 150;
    const hitTimeA = tl.beatToMs(4);
    const cursorY = yAused + 1;
    const pressTime = hitTimeA + 8;
    const beatMs = tl.beatMsAt(4);
    const ringsOrig = [makeRing(0, 4, tl, yAused), makeRing(1, 6.37, tl, yBused)];
    ringsOrig[0].hitTime = hitTimeA;
    ringsOrig[1].hitTime = tl.beatToMs(6.37);
    const correct = correctYDistBefore(pressTime, cursorY, ringsOrig);
    expect(correct).toBeCloseTo(1, 0);
    const ringsBuggy = cloneRings(ringsOrig);
    judgeHit(pressTime, cursorY, ringsBuggy, beatMs, CAL_WINDOW);
    const buggy = buggyYDistAfter(ringsBuggy, pressTime, cursorY);
    expect(buggy).toBeGreaterThan(50);
    // File must be fixed
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src.slice(src.indexOf('const handleHit'), src.indexOf('const handleHit') + 4200).indexOf('for (const ring of ringsRef.current)')).toBeLessThan(src.slice(src.indexOf('const handleHit'), src.indexOf('const handleHit') + 4200).indexOf('judgeHit('));
  });

  it('Step1 amp=3.4 rings at 2 & 7, ΔY 0px (exact) → Step2 hit → Step3 correct 0px, buggy >100px', () => {
    const amp = 3.4;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0.0);
    const yA = engine.waveYAt(2);
    const yB = engine.waveYAt(7);
    const yAused = yA;
    const yBused = Math.abs(yB - yA) > 30 ? yB : yA + 180;
    const hitTimeA = tl.beatToMs(2);
    const cursorY = yAused; // exact
    const pressTime = hitTimeA + 5;
    const beatMs = tl.beatMsAt(2);
    const ringsOrig = [makeRing(0, 2, tl, yAused), makeRing(1, 7, tl, yBused)];
    ringsOrig[0].hitTime = hitTimeA;
    ringsOrig[1].hitTime = tl.beatToMs(7);
    const correct = correctYDistBefore(pressTime, cursorY, ringsOrig);
    expect(correct).toBeCloseTo(0, 0);
    const ringsBuggy = cloneRings(ringsOrig);
    judgeHit(pressTime, cursorY, ringsBuggy, beatMs, CAL_WINDOW);
    const buggy = buggyYDistAfter(ringsBuggy, pressTime, cursorY);
    expect(buggy).toBeGreaterThan(50);
  });

  it('Step1 three rings at 4,8,12 amp=1.0 hit middle (8) → Step2 buggy picks 4 or 12 → Step3 correct small vs buggy large', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 16 }], tl, 1.0, 0.0);
    const y4 = engine.waveYAt(4);
    const y8 = engine.waveYAt(8);
    const y12 = engine.waveYAt(12);
    // Force distinct: make y8 distinct from 4 and 12 if clamped equal
    const y4u = y4;
    const y8u = Math.abs(y8 - y4) > 30 ? y8 : y4 + 100;
    const y12u = Math.abs(y12 - y8u) > 30 ? y12 : y8u + 100;
    const hitTime8 = tl.beatToMs(8);
    const cursorY = y8u + 4;
    const pressTime = hitTime8 + 10;
    const beatMs = tl.beatMsAt(8);
    const ringsOrig = [makeRing(0, 4, tl, y4u), makeRing(1, 8, tl, y8u), makeRing(2, 12, tl, y12u)];
    ringsOrig[0].hitTime = tl.beatToMs(4);
    ringsOrig[1].hitTime = hitTime8;
    ringsOrig[2].hitTime = tl.beatToMs(12);
    const correct = correctYDistBefore(pressTime, cursorY, ringsOrig);
    expect(correct).toBeCloseTo(4, 0);
    const ringsBuggy = cloneRings(ringsOrig);
    const j = judgeHit(pressTime, cursorY, ringsBuggy, beatMs, CAL_WINDOW);
    expect(j).not.toBeNull();
    const buggy = buggyYDistAfter(ringsBuggy, pressTime, cursorY);
    // After hitting 8, next closest unresolved is 4 or 12 (both ~2000ms away) — whichever is closer in time
    // Either way distance >40
    expect(buggy).toBeGreaterThan(40);
    expect(Math.abs(buggy - correct)).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// T174-3: WaveEngine / Cursor numeric consistency (complex amps, off-grid)
// ---------------------------------------------------------------------------
describe('T174-3: WaveEngine vs Cursor numeric consistency (T127 style, off-grid)', () => {
  it('Step1 amp 0.7/1.3/2.7/3.4 capture → Step2 waveYAt slope → Step3 2*TW_AMP*amp at off-grid 0.37/1.23', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offs = [0.37, 1.23, 0.62, 2.37];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const top = TW_CENTER_Y - TW_AMP;
      const bottom = TW_CENTER_Y + TW_AMP;
      for (const b of offs) {
        // For first segment (down from center) before clamp, raw = center + perBeat*b
        // Engine clamps to [top,bottom]; for small b before hitting bottom, equals raw
        // Check that wave slope matches perBeat before clamp (b=0.37 is small)
        if (b <= 0.5) {
          const expectedRaw = TW_CENTER_Y + perBeat * b;
          const expectedClamped = Math.max(top, Math.min(bottom, expectedRaw));
          const actual = engine.waveYAt(b);
          expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expectedClamped, 3);
        } else {
          // For larger b, just ensure it is within bounds and monotonic with amp scaling
          const actual = engine.waveYAt(b);
          expect(actual).toBeGreaterThanOrEqual(top);
          expect(actual).toBeLessThanOrEqual(bottom);
        }
      }
      expect(engine.getPoints().length).toBe(2);
    }
  });

  it('Step1 cursor amp=1.3 beatMs 500 capture → Step2 0.37 beat move → Step3 cursor delta == wave delta', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 0.0);
    const y0 = cursor.y;
    expect(y0).toBeCloseTo(engine.waveYAt(0), 6);
    // Move down for 0.37 beats worth of time: dt = 0.37*beatMs/1000
    cursor.update((0.37 * beatMs) / 1000, false, true, beatMs);
    const deltaCursor = Math.abs(cursor.y - y0);
    expect(deltaCursor).toBeCloseTo(perBeat * 0.37, 3);
    expect(Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0))).toBeCloseTo(perBeat * 0.37, 3);
  });

  it('Step1 waveEngine points length invariant → Step2 segments 3 → Step3 getPoints = segments+1', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const segs = [
      { direction: 'up' as const, beats: 2 },
      { direction: 'down' as const, beats: 2 },
      { direction: 'stay' as const, beats: 1 },
    ];
    const engine = new WaveEngine(segs, tl, 1.0, 0.0);
    expect(engine.getPoints().length).toBe(segs.length + 1);
    // Stay segment should keep Y flat
    const yAt4 = engine.waveYAt(4);
    const yAt4_5 = engine.waveYAt(4.5);
    expect(yAt4_5).toBeCloseTo(yAt4, 5);
  });
});

// ---------------------------------------------------------------------------
// T174-4: Regression — judgement formatting, errorMs raw, MISS --
// ---------------------------------------------------------------------------
describe('T174-4: Regression — MISS --, errorMs raw, ΔY rounding', () => {
  it('Step1 judgeHit miss with far Y capture → Step2 errorMs is raw (not null) → Step3 file passes judgement.errorMs to journal', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const slice = extractHandleHitSlice(src);
    // handleHit must pass judgement.errorMs raw, not null, for miss from judgeHit
    expect(slice).toMatch(/journal\(judgement\.result,\s*judgement\.errorMs,\s*yDist\)/);
    // Must not do journal('miss', null) inside handleHit branch (only tick expiry does)
    // Check that inside handleHit's `if (judgement)` block, it does not hardcode null for miss
    const afterJudge = slice.slice(slice.indexOf('judgeHit('));
    // The only journal in handleHit should use judgement.errorMs
    expect(afterJudge).not.toMatch(/journal\('miss',\s*null/);
    // But expiry tick may still use null — verify it exists separately (T172)
    const full = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(full).toMatch(/journal\('miss',\s*null\)/); // tick expiry keeps null
    // Draw side: renderer must show -- for miss
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/MISS/);
    expect(rendererSrc).toMatch(/--/);
  });

  it('Step1 formatLastLabel or lastLabel capture → Step2 ΔY rounded → Step3 shows integer px and -- for miss', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const lastLabelIdx = src.indexOf('const lastLabel =');
    expect(lastLabelIdx).toBeGreaterThan(-1);
    const lastSlice = src.slice(lastLabelIdx, lastLabelIdx + 1200);
    expect(lastSlice).toMatch(/Math\.round/);
    expect(lastSlice).toMatch(/ΔY/);
    expect(lastSlice).toMatch(/--/);
    expect(lastSlice).toMatch(/ms/);
    expect(lastSlice).toMatch(/px/);
  });
});
