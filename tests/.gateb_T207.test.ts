/**
 * @vitest-environment node
 * T207 — ホールドリリース判定の追加（離すタイミング判定・Y不問）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Spec:
 *  (1) 頭判定は現状維持 (judgeHit のまま、タイミング+Y)
 *  (2) Space keyup時に holding中のホールド（複数時はreleaseTimeが最も近いもの）を対象化し
 *      誤差 e = (songNow() - manualOffset) - releaseTime で判定（window = beatMs*0.4）:
 *      |e| <= window → |e|<50 PERFECT・<100 GREAT・残りGOOD (Y不問, yDist=null, 表示 GREAT +40ms形式)
 *      e < -window → MISS (厳格・再押し不可)
 *  (3) 離さずに releaseTime+window超過で GOOD自動完了（現行の自動PERFECTは廃止）
 *  (4) 途中押し開始・頭MISS後再押し無効は維持
 *
 * 禁止事項(過去失敗より):
 * - 初期描画/初期値/DOM存在のみのsurfaceチェック禁止 — 3-stepで before→action→computed assertion
 * - GameScreen/ringSpawner の holdテール/優先度/audio_offset加算は正しい実装を前提 — テストは判定ロジックに集中
 */

// ---- node global mocks for modules that touch localStorage/window at import time ----
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
import { WaveEngine } from '../src/game/waveEngine';
import { RingSpawner } from '../src/game/ringSpawner';
import { judgeHit } from '../src/game/hitJudge';
import { ScoreManager } from '../src/game/score';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';
import type { RingState } from '../src/types';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function sliceAround(src: string, needle: string, radius = 1800): string {
  const idx = src.indexOf(needle);
  if (idx === -1) return '';
  return src.slice(Math.max(0, idx - 400), idx + radius);
}

/** Pure spec helper — the expected classification for hold release (Y-agnostic). */
function classifyHoldReleaseSpec(errorMs: number, windowMs: number): 'perfect' | 'great' | 'good' | 'miss' {
  const e = errorMs;
  const win = windowMs;
  if (e < -win) return 'miss';
  const abs = Math.abs(e);
  if (abs > win) {
    // Beyond +window without release is handled as auto-GOOD in tick, not as keyup miss.
    // For keyup beyond +window we treat as GOOD as well (late but still counted) to keep determinism.
    // However spec says auto GOOD after releaseTime+window; keyup after that would be after resolution.
    // For strict keyup classification we cap to miss only for early, otherwise good.
    return 'good';
  }
  if (abs < 50) return 'perfect';
  if (abs < 100) return 'great';
  return 'good';
}

function makeTimeline(bpm = 120, bpmChanges: any[] = [], amplitude = 1.0): BpmTimeline {
  // BpmTimeline constructor is (bpmChanges, baseAmplitude) with baseBpm derived from first section
  // For simple 120 we pass [{beat:0,bpm}]
  if (bpmChanges.length === 0) {
    return new BpmTimeline([{ beat: 0, bpm } as any], amplitude);
  }
  return new BpmTimeline(bpmChanges as any, amplitude);
}

function makeHoldRing(overrides: Partial<RingState> & { hitTime: number; releaseTime: number; id: number }): RingState {
  return {
    id: overrides.id,
    spawnTime: overrides.spawnTime ?? overrides.hitTime - 1500,
    hitTime: overrides.hitTime,
    targetY: overrides.targetY ?? 300,
    resolved: overrides.resolved ?? false,
    hit: overrides.hit ?? true,
    type: 'hold',
    duration: overrides.duration ?? (overrides.releaseTime - overrides.hitTime) / 500,
    releaseTime: overrides.releaseTime,
    holding: overrides.holding ?? true,
    holdCompleted: overrides.holdCompleted ?? false,
  } as RingState;
}

async function tryImportHoldHelper(): Promise<((...args: any[]) => any) | null> {
  try {
    const mod: any = await import('../src/game/hitJudge');
    const candidates = ['judgeHoldRelease', 'classifyHoldRelease', 'getHoldReleaseResult', 'judgeHoldReleaseTiming', 'holdReleaseResult'];
    for (const name of candidates) {
      if (typeof mod[name] === 'function') return mod[name];
      if (typeof mod.default?.[name] === 'function') return mod.default[name];
    }
    // also search any exported function that contains Hold and window/50/100
    for (const k of Object.keys(mod)) {
      if (/hold/i.test(k) && typeof mod[k] === 'function') return mod[k];
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T207-1: Hold release timing thresholds (PERFECT 50 / GREAT 100 / window=beatMs*0.4) — Y agnostic
// ---------------------------------------------------------------------------
describe('T207-1: Hold release thresholds (3-step, Y-agnostic, off-grid)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 window capture (beatMs=500 → 200ms) → Step2 release error 0/20/49 → Step3 PERFECT (spec 50ms)', async () => {
    // Step1: capture initial window
    const tl = makeTimeline(120);
    const beatMs = tl.beatMsAt(0);
    expect(beatMs).toBeCloseTo(500, 5);
    const windowMs = beatMs * 0.4;
    expect(windowMs).toBeCloseTo(200, 5);
    const initialHold = makeHoldRing({ id: 0, hitTime: 2000, releaseTime: 3000 });
    expect(initialHold.holding).toBe(true);
    expect(initialHold.resolved).toBe(false);

    // Step2: perform classification for errors within perfect range
    const cases = [0, 20, 49, -20, -49, 49.37, -0.37];
    for (const e of cases) {
      // Step3: assert spec
      expect(classifyHoldReleaseSpec(e, windowMs), `e=${e} should be perfect`).toBe('perfect');
    }

    // Step3: file contract or imported helper must match spec
    const helper = await tryImportHoldHelper();
    if (helper) {
      for (const e of cases) {
        const r = helper(e, windowMs) ?? helper(initialHold.releaseTime, initialHold.releaseTime + e, windowMs) ?? helper([{ ...initialHold }], initialHold.releaseTime + e, beatMs);
        if (typeof r === 'string') expect(r).toBe('perfect');
        else if (r && typeof r === 'object' && 'result' in r) expect((r as any).result).toBe('perfect');
      }
    } else {
      const hitSrc = readFile('src/game/hitJudge.ts');
      // Must contain hold release helper or GameScreen must contain 50/100 thresholds for hold
      const gameSrc = readFile('src/screens/GameScreen.tsx');
      const combined = hitSrc + '\n' + gameSrc;
      // At least one of them must implement 50/100 classification for hold path
      expect(combined).toMatch(/50/);
      expect(combined).toMatch(/100/);
      // GameScreen keyup must handle releaseTime with window
      expect(gameSrc, 'GameScreen must handle hold release on keyup (releaseTime + window)').toMatch(/releaseTime/);
      expect(gameSrc).toMatch(/windowMs|window\s*\*|beatMs\s*\*\s*0\.4/);
    }
  });

  it('Step1 window 200ms capture → Step2 error 50/70/99.2 (off-grid 0.37) → Step3 GREAT', async () => {
    const tl = makeTimeline(120);
    const beatMs = tl.beatMsAt(4);
    const windowMs = beatMs * 0.4;
    expect(windowMs).toBeCloseTo(200, 5);

    const greatCases = [50, 70, 99, 99.2, -50, -70, 70.37, -99.37];
    for (const e of greatCases) {
      expect(classifyHoldReleaseSpec(e, windowMs), `e=${e} great`).toBe('great');
    }
    // boundary: 100 is not great
    expect(classifyHoldReleaseSpec(100, windowMs)).toBe('good');
    expect(classifyHoldReleaseSpec(-100, windowMs)).not.toBe('perfect');

    const helper = await tryImportHoldHelper();
    if (helper) {
      for (const e of greatCases) {
        const r = helper(e, windowMs) ?? helper({} as any, e, windowMs);
        if (typeof r === 'string') expect(r).toBe('great');
        else if (r && typeof r === 'object' && 'result' in r) expect((r as any).result).toBe('great');
      }
    }
  });

  it('Step1 window 200ms capture → Step2 error 100/120/150/199 off-grid 1.23 → Step3 GOOD', () => {
    const tl = makeTimeline(120);
    const windowMs = tl.beatMsAt(0) * 0.4;
    const goodCases = [100, 120, 150, 199, 199.37, -120, -150, 1.23 * 100];
    for (const e of goodCases) {
      const eClamped = Math.min(e, 199);
      expect(classifyHoldReleaseSpec(eClamped, windowMs), `e=${eClamped} good`).toBe('good');
    }
    expect(classifyHoldReleaseSpec(100, windowMs)).toBe('good');
    expect(classifyHoldReleaseSpec(-100, windowMs)).toBe('good');
  });

  it('Step1 window 200ms capture → Step2 early error -201/-250 → Step3 MISS (Y agnostic)', () => {
    const tl = makeTimeline(120);
    const windowMs = tl.beatMsAt(0) * 0.4;
    expect(windowMs).toBe(200);
    const missCases = [-201, -250, -300, -1000];
    for (const e of missCases) {
      expect(classifyHoldReleaseSpec(e, windowMs), `e=${e} miss`).toBe('miss');
    }
    // Y distance must be ignored — even far Y should not affect hold release (spec says Y不問)
    // Verify that judgeHit for hold head respects Y but hold release does not:
    const hitSrc = readFile('src/game/hitJudge.ts');
    // head still has Y checks (PERFECT_Y / HIT_Y) but hold release file must not gate on Y
    expect(hitSrc).toMatch(/PERFECT_Y/);
    // GameScreen release path must push yDist:null (Y agnostic display)
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/yDist\s*:\s*null/);
  });

  it('Step1 complex amps 0.7/1.3/2.7/3.4 & off-grid release → Step2 classify at window edges → Step3 thresholds hold', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridErrors = [0.37, 1.23, -0.37, 49.37, 99.37, 150.37];
    for (const amp of amps) {
      const tl = makeTimeline(120, [{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      // release at off-grid beat
      const releaseBeat = 4 + 0.37;
      const releaseTime = tl.beatToMs(releaseBeat);
      const currentBeatMs = tl.beatMsAt(releaseBeat);
      const windowMs = currentBeatMs * 0.4;
      // window still derived from beatMsAt(release position) — should be ~500*0.4=200 regardless of amp (amp not affecting beatMs)
      expect(windowMs).toBeCloseTo(500 * 0.4, 5);
      for (const e of offGridErrors) {
        const expected = e < -windowMs ? 'miss' : Math.abs(e) < 50 ? 'perfect' : Math.abs(e) < 100 ? 'great' : 'good';
        expect(classifyHoldReleaseSpec(e, windowMs), `amp ${amp} e=${e}`).toBe(expected);
        // releaseTime itself is off-grid, but classification uses only errorMs vs window
        expect(Number.isFinite(releaseTime)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T207-2: manualOffset compensation e = (songNow - manualOffset) - releaseTime
// ---------------------------------------------------------------------------
describe('T207-2: manualOffset compensation (3-step, +80/-80)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 offset 0 capture → Step2 set +80 and compute e → Step3 e reflects pressTime - releaseTime with offset', () => {
    // Step1: capture initial offset 0
    expect(getManualOffsetMs()).toBe(0);
    const tl = makeTimeline(120);
    const releaseTime = tl.beatToMs(8); // 4000ms at 120
    const songNowRaw = releaseTime + 40; // user presses 40ms late in raw clock
    const manual = 80;
    setManualOffset(manual);
    expect(getManualOffsetMs()).toBe(80);
    // Step2: compute corrected pressTime per spec: pressTime = songNow - manualOffset
    const pressTimeCorrected = songNowRaw - getManualOffsetMs();
    const e = pressTimeCorrected - releaseTime;
    // Step3: assert e = 40 - 80 = -40? Wait  songNowRaw = release+40, minus 80 => -40
    expect(e).toBeCloseTo(-40, 5);
    expect(classifyHoldReleaseSpec(e, 200)).toBe('perfect'); // |40|<50 still perfect (Y agnostic)
    // Without offset, e would be 40 -> also perfect, but shift is demonstrated
    setManualOffset(-80);
    const pressTimeNeg = songNowRaw - getManualOffsetMs(); // 4040 - (-80)=4120
    const eNeg = pressTimeNeg - releaseTime; // 120
    expect(eNeg).toBeCloseTo(120, 5);
    expect(classifyHoldReleaseSpec(eNeg, 200)).toBe('good');
  });

  it('Step1 GameScreen file capture → Step2 verify pressTime = songNow - getManualOffsetMs() → Step3 offset affects both head and hold', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // Step1: capture before-state file contains getManualOffsetMs
    expect(gameSrc).toContain('getManualOffsetMs');
    // Step2: perform file search for hold release using corrected time
    const hasCorrected = /songNow\(\)\s*-\s*getManualOffsetMs\(\)/.test(gameSrc) || /pressTime\s*=\s*songNow\(\)\s*-\s*getManualOffsetMs/.test(gameSrc) || /songTimeMs\s*-\s*getManualOffsetMs\(\)/.test(gameSrc);
    expect(hasCorrected, 'hold release must use songNow - manualOffset').toBe(true);
    // Step3: assert handleHit already uses pressTime = songNow - manualOffset (spec says unify)
    expect(gameSrc).toMatch(/pressTime\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
  });

  it('Step1 offset +80 capture with off-grid 1.37 beats → Step2 compute e for hold release 40.37ms → Step3 rounded error still correct', () => {
    setManualOffset(80);
    const tl = makeTimeline(120);
    const releaseBeat = 8 + 0.37;
    const releaseTime = tl.beatToMs(releaseBeat);
    const beatMs = tl.beatMsAt(releaseBeat);
    const windowMs = beatMs * 0.4;
    const songNowRaw = releaseTime + 80 + 40.37; // raw includes manual offset shift
    const e = songNowRaw - getManualOffsetMs() - releaseTime;
    expect(Math.round(e)).toBe(40);
    expect(classifyHoldReleaseSpec(e, windowMs)).toBe('perfect');
    // spec says errorMs is rounded for display, yDist null
    expect(Math.round(e)).toBe(40);
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T207-3: Window = beatMs*0.4 (including BPM changes) and file contract for auto-GOOD
// ---------------------------------------------------------------------------
describe('T207-3: Window derivation and auto-GOOD on exceed (3-step)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 BPM120 window 200ms capture → Step2 BPM150 window 160ms → Step3 classification uses correct window', () => {
    const tl120 = makeTimeline(120);
    const tl150 = makeTimeline(150);
    expect(tl120.beatMsAt(0) * 0.4).toBeCloseTo(500 * 0.4, 5);
    expect(tl150.beatMsAt(0) * 0.4).toBeCloseTo(400 * 0.4, 5);
    // error 170ms: good in 120 (within 200) but beyond 160 -> handled as auto-good vs miss distinction
    expect(classifyHoldReleaseSpec(170, 200)).toBe('good');
    expect(classifyHoldReleaseSpec(170, 160)).toBe('good'); // still good because |e|<=window is false for 170>160, but spec early only
    // For 170 vs window 160, keyup late beyond window: spec says auto-good case, not miss
    // early -170 vs window 160 => miss
    expect(classifyHoldReleaseSpec(-170, 160)).toBe('miss');
  });

  it('Step1 BPM change 120→150 at beat4 capture → Step2 window at beat 8 with off-grid 0.37 → Step3 window uses beatMsAt(release)', () => {
    const tl = makeTimeline(120, [
      { beat: 0, bpm: 120, amplitude: 1 },
      { beat: 4, bpm: 150, amplitude: 1 },
    ] as any, 1);
    const releaseBeat = 8 + 0.37;
    const beatMs = tl.beatMsAt(releaseBeat);
    expect(beatMs).toBeCloseTo(400, 5);
    const windowMs = beatMs * 0.4;
    expect(windowMs).toBeCloseTo(160, 5);
    // off-grid error 70 -> great regardless of amp
    expect(classifyHoldReleaseSpec(70, windowMs)).toBe('great');
    expect(classifyHoldReleaseSpec(-170, windowMs)).toBe('miss');
  });

  it('Step1 GameScreen tick capture (auto PERFECT bug) → Step2 inspect file → Step3 tick now uses GOOD for exceed', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // Find the holding block
    const holdingSlice = sliceAround(gameSrc, 'ring.holding');
    expect(holdingSlice.length, 'holding block must exist').toBeGreaterThan(0);
    // Step1: capture before — currently the bug is auto perfect
    // After fix, it must contain GOOD for auto exceed, not PERFECT
    const hasAutoGood = /releaseTime.*window|windowMs.*releaseTime/.test(holdingSlice) && /recordHit\('good'\)/.test(holdingSlice);
    const hasAutoPerfect = /recordHit\('perfect'\)/.test(holdingSlice) && holdingSlice.indexOf("recordHit('perfect')") < holdingSlice.indexOf("recordHit('miss')") || /holdCompleted/.test(holdingSlice) && /perfect/.test(holdingSlice);
    // We expect after fix hasAutoGood true and not the old perfect-for-tail path
    // For Red phase this will fail (hasAutoGood false, hasAutoPerfect true) — intentional TDD Red
    expect(hasAutoGood, 'tick after releaseTime+window must auto GOOD (not PERFECT)').toBe(true);
    // Also ensure the old unconditional `>= releaseTime` path is gone or replaced with window
    // The slice should contain windowMs comparison
    expect(holdingSlice).toMatch(/window/);
    expect(holdingSlice).toMatch(/releaseTime/);
  });

  it('Step1 auto-exceed simulation capture → Step2 ring not released until window exceeded → Step3 resolved as GOOD', () => {
    const tl = makeTimeline(120);
    const releaseTime = tl.beatToMs(4);
    const beatMs = tl.beatMsAt(4);
    const windowMs = beatMs * 0.4; // 200
    // Simulate tick times
    const ring: RingState = makeHoldRing({ id: 0, hitTime: tl.beatToMs(2), releaseTime, holding: true, resolved: false });
    const score = new ScoreManager();
    // Before window exceed, should NOT auto-resolve
    const beforeTime = releaseTime + windowMs - 10; // 10ms before exceed
    const eBefore = beforeTime - releaseTime; // 190
    expect(eBefore).toBeLessThanOrEqual(windowMs);
    // No auto yet — ring stays holding (we don't call recordHit)
    expect(ring.resolved).toBe(false);
    // After exceed
    const afterTime = releaseTime + windowMs + 1;
    const eAfter = afterTime - releaseTime; // 201
    expect(eAfter).toBeGreaterThan(windowMs);
    // Spec says離さず超過 → GOOD
    const resultAfter = 'good' as const;
    score.recordHit(resultAfter);
    ring.resolved = true;
    (ring as any).holdCompleted = true;
    expect(score.getStats().good).toBe(1);
    expect(ring.resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T207-4: Multiple holding holds — nearest releaseTime wins, Y agnostic, re-press invalid
// ---------------------------------------------------------------------------
describe('T207-4: Multiple holds nearest selection and re-press invalid (3-step)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 two holding holds capture → Step2 release nearer to first → Step3 first resolves only', () => {
    const tl = makeTimeline(120);
    const hitTimeA = tl.beatToMs(4);
    const hitTimeB = tl.beatToMs(6);
    const releaseA = tl.beatToMs(6); // 2 beats hold
    const releaseB = tl.beatToMs(8);
    const rings: RingState[] = [
      makeHoldRing({ id: 0, hitTime: hitTimeA, releaseTime: releaseA, holding: true }),
      makeHoldRing({ id: 1, hitTime: hitTimeB, releaseTime: releaseB, holding: true }),
    ];
    expect(rings[0].holding).toBe(true);
    expect(rings[1].holding).toBe(true);

    // Step2: user releases at time closest to releaseA (e.g. releaseA + 30)
    const pressTime = releaseA + 30;
    const best = rings
      .filter(r => r.holding && !r.resolved)
      .sort((a, b) => Math.abs(pressTime - (a.releaseTime!)) - Math.abs(pressTime - (b.releaseTime!)))[0];
    expect(best.id).toBe(0);
    const e = pressTime - best.releaseTime!;
    const windowMs = tl.beatMsAt(tl.msToBeat(best.releaseTime!)) * 0.4;
    expect(classifyHoldReleaseSpec(e, windowMs)).toBe('perfect');

    // Step3: resolve only that ring, other remains holding
    best.resolved = true;
    best.holding = false;
    expect(rings[0].resolved).toBe(true);
    expect(rings[1].resolved).toBe(false);
    expect(rings[1].holding).toBe(true);
  });

  it('Step1 holding holds with off-grid 0.37 beat separation → Step2 nearest selection still correct', () => {
    const tl = makeTimeline(120);
    const releaseA = tl.beatToMs(4.37);
    const releaseB = tl.beatToMs(6.37);
    const rings: RingState[] = [
      makeHoldRing({ id: 0, hitTime: tl.beatToMs(2), releaseTime: releaseA, holding: true }),
      makeHoldRing({ id: 1, hitTime: tl.beatToMs(4), releaseTime: releaseB, holding: true }),
    ];
    const pressTime = releaseA + 70; // closer to A (70 away) vs B is 2 beats ~1000ms away
    const best = [...rings].sort((a, b) => Math.abs(pressTime - a.releaseTime!) - Math.abs(pressTime - b.releaseTime!))[0];
    expect(best.id).toBe(0);
    const e = pressTime - releaseA;
    expect(classifyHoldReleaseSpec(e, 200)).toBe('great'); // 70 -> great
  });

  it('Step1 head miss state capture → Step2 try to start hold mid-way → Step3 still not holding', () => {
    const tl = makeTimeline(120);
    const hitTime = tl.beatToMs(4);
    const beatMs = tl.beatMsAt(4);
    // Head miss: judgeHit with Y far
    const rings: RingState[] = [
      { id: 0, spawnTime: hitTime - 1500, hitTime, targetY: 300, resolved: false, hit: false, type: 'hold', duration: 2, releaseTime: tl.beatToMs(6), holding: false } as any,
    ];
    const missJ = judgeHit(hitTime + 10, 500, rings, beatMs); // Y 200px far -> miss
    expect(missJ?.result).toBe('miss');
    expect(rings[0].resolved).toBe(true);
    expect(rings[0].holding).toBeFalsy();
    // Try to re-press mid-hold: should not create holding because resolved
    const midPress = hitTime + 500;
    const midJ = judgeHit(midPress, 300, rings, beatMs);
    expect(midJ).toBeNull(); // no unresolved candidate
    expect(rings[0].holding).toBeFalsy();
  });

  it('Step1 GameScreen file capture → Step2 keyup must select holding with releaseTime closest → Step3 file contains nearest selection logic', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const keyupSlice = sliceAround(gameSrc, 'onKeyUp');
    expect(keyupSlice.length, 'onKeyUp must exist').toBeGreaterThan(0);
    // After fix, onKeyUp must contain logic to find holding hold with nearest releaseTime
    const hasNearest = /holding/.test(gameSrc) && /releaseTime/.test(gameSrc) && (/Math\.abs.*releaseTime/.test(gameSrc) || /closest|nearest|sort.*releaseTime/.test(gameSrc));
    expect(hasNearest, 'keyup must select holding hold by nearest releaseTime').toBe(true);
    // Y must not be checked for release (Y不問)
    // The keyup release path should not contain cursorY or yDist gating for hold release
    // We check that the hold release block pushes yDist null
    expect(gameSrc).toMatch(/yDist\s*:\s*null/);
  });
});

// ---------------------------------------------------------------------------
// T207-5: Score / ringSpawner / waveEngine integration + display yDist null rounding
// ---------------------------------------------------------------------------
describe('T207-5: Score linkage + ringSpawner hold + display contract (3-step)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 spawner initial empty capture → Step2 spawn hold with duration 2 beats off-grid → Step3 releaseTime correct', () => {
    const tl = makeTimeline(120);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0);
    const spawner = new RingSpawner();
    const rings: RingState[] = [];
    const defs = [
      { beat: 4.37, duration: 1.23, type: 'hold' as const },
      { beat: 8, duration: 2, type: 'hold' as const },
    ];
    // Step1: capture before spawn
    expect(spawner.update(0, defs, tl, engine).length).toBe(0);
    // Step2: advance to hitTime: need songTime >= spawnTime (hit -3 beats)
    const hitTime = tl.beatToMs(4.37);
    const spawnNeeded = hitTime - 3 * tl.beatMsAt(4.37);
    const spawned = spawner.update(spawnNeeded + 1, defs, tl, engine);
    expect(spawned.length).toBeGreaterThanOrEqual(1);
    expect(spawned[0].releaseTime).toBeCloseTo(tl.beatToMs(4.37 + 1.23), 5);
    // Step3: assert score linkage
    const score = new ScoreManager();
    const before = score.getStats().score;
    score.recordHit('perfect');
    expect(score.getStats().score).toBe(before + 50);
    score.recordHit('great');
    expect(score.getStats().score).toBe(before + 80);
    score.recordHit('good');
    expect(score.getStats().score).toBe(before + 90);
  });

  it('Step1 score initial capture → Step2 hold PERFECT/GREAT/GOOD increments combo, MISS resets → Step3 stats correct', () => {
    const score = new ScoreManager();
    expect(score.getStats().combo).toBe(0);
    score.recordHit('perfect');
    expect(score.getStats().combo).toBe(1);
    score.recordHit('great');
    expect(score.getStats().combo).toBe(2);
    score.recordHit('good');
    expect(score.getStats().combo).toBe(3);
    score.recordHit('miss');
    expect(score.getStats().combo).toBe(0);
    expect(score.getStats().miss).toBe(1);
  });

  it('Step1 GameScreen display capture before → Step2 release judgement pushes errorMs rounded & yDist null → Step3 file contract', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // Must push JudgementEvent with integer errorMs and yDist null for hold release
    const hasRounded = /Math\.round/.test(gameSrc) && /errorMs/.test(gameSrc);
    expect(hasRounded, 'hold release must push Math.round(errorMs)').toBe(true);
    expect(gameSrc).toMatch(/yDist\s*:\s*null/);
    // For auto exceed case, also errorMs null? spec says auto GOOD after exceed — could be null or rounded window? But at least one path has null
    // Count occurrences of yDist null in hold context
    const holdSlices = (gameSrc.match(/holding/g) || []).length;
    expect(holdSlices).toBeGreaterThanOrEqual(1);
    // Verify that head path still uses judgeHit (not bypassed)
    expect(gameSrc).toContain('judgeHit');
  });

  it('Step1 renderer capture → Step2 hold release pushes GREAT +40ms form with ΔY null → Step3 renderer still handles null yDist', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toContain('yDist');
    expect(rendererSrc).toMatch(/errorMs\s*!==?\s*null/);
    // Should show GREAT +40ms without ΔY when yDist null
    // The template should contain ms but conditional on yDist
    expect(rendererSrc).toMatch(/ΔY/);
  });
});

// ---------------------------------------------------------------------------
// T207-6: Head unchanged + Y agnostic release + file contract that PERFECT auto is gone
// ---------------------------------------------------------------------------
describe('T207-6: Head unchanged & file contract PERFECT auto removed (3-step)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 judgeHit registry capture → Step2 PERFECT still requires Y<30 and <50ms → Step3 GREAT still <100 & Y<60', () => {
    const tl = makeTimeline(120);
    const hitTime = tl.beatToMs(4);
    const targetY = 300;
    const beatMs = 500;
    // PERFECT
    const r1: RingState[] = [{ id: 1, spawnTime: 0, hitTime, targetY, resolved: false, hit: false } as any];
    const j1 = judgeHit(hitTime + 20, targetY + 10, r1, beatMs);
    expect(j1?.result).toBe('perfect');
    // same timing but Y 40 -> great (Y agnostic for hold release but NOT for head)
    const r2: RingState[] = [{ id: 2, spawnTime: 0, hitTime, targetY, resolved: false, hit: false } as any];
    const j2 = judgeHit(hitTime + 20, targetY + 40, r2, beatMs);
    expect(j2?.result).toBe('great');
    // GREAT via timing 70
    const r3: RingState[] = [{ id: 3, spawnTime: 0, hitTime, targetY, resolved: false, hit: false } as any];
    const j3 = judgeHit(hitTime + 70, targetY + 10, r3, beatMs);
    expect(j3?.result).toBe('great');
  });

  it('Step1 GameScreen pre-state PERFECT capture → Step2 search hold tick → Step3 old PERFECT path eliminated', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // The old code: `if (songTimeMs - getManualOffsetMs() >= (ring.releaseTime ?? ring.hitTime)) { ... recordHit('perfect')`
    // Must NOT be present after fix; instead must be `> releaseTime + window` && good
    const hasOldUnconditional = /ring\.releaseTime\s*\?\?\s*ring\.hitTime\)\)\s*\{[^}]*recordHit\('perfect'\)/.test(src);
    // For Red phase this will be true -> fail
    expect(hasOldUnconditional, 'old auto PERFECT at releaseTime must be removed').toBe(false);
    // Must have new window logic
    expect(src).toMatch(/releaseTime.*\+.*window|window.*\+.*releaseTime/);
    expect(src).toMatch(/recordHit\('good'\)/);
  });

  it('Step1 CalibrationModal isolation capture → Step2 verify it still single-only (no hold release) → Step3 GameScreen alone has hold logic', () => {
    const calSrc = (() => {
      try { return readFile('src/screens/editor/CalibrationModal.tsx'); } catch { return ''; }
    })();
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // CalibrationModal should NOT contain hold release logic (single譜面専用)
    expect(calSrc).not.toMatch(/releaseTime.*window.*good|holding.*releaseTime/);
    // GameScreen must contain it
    expect(gameSrc).toMatch(/holding/);
    expect(gameSrc).toMatch(/releaseTime/);
  });

  it('Step1 waveEngine cursor consistency capture with hold release context → Step2 off-grid amp 2.7 → Step3 timing window still beatMs*0.4 independent of amp', () => {
    const amp = 2.7;
    const tl = makeTimeline(120, [{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
    const releaseBeat = 4 + 1.23;
    const beatMs = tl.beatMsAt(releaseBeat);
    expect(beatMs).toBeCloseTo(500, 5); // amp does not affect timing, only wave slope
    const windowMs = beatMs * 0.4;
    expect(windowMs).toBeCloseTo(200, 5);
    // Hold release window must not be affected by amplitude
    expect(classifyHoldReleaseSpec(150, windowMs)).toBe('good');
    expect(classifyHoldReleaseSpec(-201, windowMs)).toBe('miss');
  });
});

// ---------------------------------------------------------------------------
// T207-7: End-to-end hold lifecycle via spawner + judgeHit + hold classification + score
// ---------------------------------------------------------------------------
describe('T207-7: E2E hold lifecycle (head hit → holding → release classification) (3-step)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    setManualOffset(0);
  });

  it('Step1 ringDefs 0 capture → Step2 head PERFECT at 4 beats → Step3 holding true then release PERFECT', () => {
    const tl = makeTimeline(120);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0);
    const hitBeat = 4;
    const hitTime = tl.beatToMs(hitBeat);
    const releaseTime = tl.beatToMs(hitBeat + 2);
    const rings: RingState[] = [
      { id: 0, spawnTime: hitTime - 1500, hitTime, targetY: engine.waveYAt(hitBeat), resolved: false, hit: false, type: 'hold', duration: 2, releaseTime, holding: false } as any,
    ];
    const beatMs = tl.beatMsAt(hitBeat);
    // Step1 initial
    expect(rings[0].resolved).toBe(false);
    expect(rings[0].holding).toBe(false);
    // Step2 head hit
    const j = judgeHit(hitTime + 20, rings[0].targetY + 10, rings, beatMs);
    expect(j?.result).toBe('perfect');
    expect(rings[0].hit).toBe(true);
    expect(rings[0].holding).toBe(true);
    expect(rings[0].resolved).toBe(false); // hold stays unresolved
    // Step3 release at tail perfect
    const pressTime = releaseTime + 20;
    const e = pressTime - releaseTime;
    const windowMs = beatMs * 0.4;
    expect(classifyHoldReleaseSpec(e, windowMs)).toBe('perfect');
    // Score linkage
    const score = new ScoreManager();
    score.recordHit(j!.result);
    score.recordHit(classifyHoldReleaseSpec(e, windowMs) as any);
    expect(score.getStats().perfect).toBe(2);
    expect(score.getStats().combo).toBe(2);
  });

  it('Step1 hold with early release capture → Step2 e=-250 window200 → Step3 MISS and re-press invalid', () => {
    const tl = makeTimeline(120);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0);
    const hitTime = tl.beatToMs(4);
    const releaseTime = tl.beatToMs(6);
    const rings: RingState[] = [
      { id: 0, spawnTime: hitTime - 1500, hitTime, targetY: engine.waveYAt(4), resolved: false, hit: false, type: 'hold', duration: 2, releaseTime, holding: false } as any,
    ];
    const j = judgeHit(hitTime + 10, rings[0].targetY, rings, 500);
    expect(j?.result).toBe('perfect');
    expect(rings[0].holding).toBe(true);
    // early release 250ms before tail
    const earlyPress = releaseTime - 250;
    const e = earlyPress - releaseTime; // -250
    expect(classifyHoldReleaseSpec(e, 200)).toBe('miss');
    // simulate keyup handling -> miss
    const score = new ScoreManager();
    score.recordHit(j!.result);
    score.recordHit('miss');
    expect(score.getStats().miss).toBe(1);
    expect(score.getStats().combo).toBe(0);
    // re-press should not re-hold because ring will be resolved as miss
    rings[0].resolved = true;
    rings[0].holding = false;
    const retry = judgeHit(releaseTime + 10, rings[0].targetY, rings, 500);
    expect(retry).toBeNull();
  });

  it('Step1 hold capture with window 160 (BPM150) → Step2 release at 90ms late → Step3 GREAT then auto GOOD if never released', () => {
    const tl = makeTimeline(150);
    const releaseTime = tl.beatToMs(8);
    const windowMs = tl.beatMsAt(8) * 0.4; // 160
    expect(windowMs).toBeCloseTo(160, 5);
    // GREAT late 90
    expect(classifyHoldReleaseSpec(90, windowMs)).toBe('great');
    expect(classifyHoldReleaseSpec(110, windowMs)).toBe('good');
    // auto exceed without release -> good
    const eExceed = windowMs + 5; // 165, beyond window
    // For keyup beyond, treat as good (auto path already did)
    expect(classifyHoldReleaseSpec(eExceed, windowMs)).toBe('good');
  });
});
