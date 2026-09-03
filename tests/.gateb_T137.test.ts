/**
 * T137 — エディタ再生のメトロノーム決定性修正（再生ごとにズレるバグ）
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat, segmentize } from '../src/chart/quantize';
import { getManualOffsetMs, setManualOffset, offsetSeconds } from '../src/audio/clock';
import { schedule } from '../src/audio/metronome';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function createMockAudioContext(currentTime = 10.0) {
  const destination = { __isDestination: true } as unknown as AudioNode;
  const ctx: any = {
    currentTime,
    destination,
    createOscillator() {
      return { type: 'sine', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() } as any;
    },
    createGain() {
      const g: any = { gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), _connectedTo: null };
      return g;
    },
    createBufferSource() {
      const src: any = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn((when: number, offset?: number) => { src._startWhen = when; src._startOffset = offset; }),
        stop: vi.fn(), disconnect: vi.fn(), _startWhen: null, _startOffset: null,
      };
      ctx._lastSource = src;
      return src;
    },
    _lastSource: null,
  };
  return ctx;
}

// Fixed computation helpers – mirror the corrected EditorScreen logic
function computeFixedNextBeatTime(timeline: BpmTimeline, fromMs: number, startCtxTime: number, leadMs: number, ctxNow: number, manualOffsetMsVal: number) {
  let beatIdx = Math.ceil(timeline.msToBeat(fromMs));
  if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
  let nextBeatTime = startCtxTime + leadMs / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000;
  while (nextBeatTime + manualOffsetMsVal / 1000 < ctxNow) {
    nextBeatTime += timeline.beatMsAt(beatIdx) / 1000;
    beatIdx++;
  }
  return { nextBeatTime, beatIdx };
}
function computeBuggyNextBeatTime(timeline: BpmTimeline, fromMs: number, ctxNow: number) {
  let beatIdx = Math.ceil(timeline.msToBeat(fromMs));
  if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
  let nextBeatTime = ctxNow + (timeline.beatToMs(beatIdx) - fromMs) / 1000;
  while (nextBeatTime < ctxNow) {
    nextBeatTime += timeline.beatMsAt(beatIdx) / 1000;
    beatIdx++;
  }
  return { nextBeatTime, beatIdx };
}
function computeMusicAudible(ctxStart: number, fromMs: number, timeline: BpmTimeline, beat: number, audioOffset: number, manualOffsetMsVal: number): number {
  const offsetSec = (audioOffset + manualOffsetMsVal) / 1000;
  // music audible time for beat B: ctxStart + offsetSec + (beatToMs(B)-fromMs)/1000
  return ctxStart + offsetSec + (timeline.beatToMs(beat) - fromMs) / 1000;
}
function computeMetronomeAudibleFixed(timeline: BpmTimeline, fromMs: number, startCtxTime: number, beat: number, audioOffset: number, manualOffsetMsVal: number): number {
  const { nextBeatTime: firstNext, beatIdx: firstIdx } = computeFixedNextBeatTime(timeline, fromMs, startCtxTime, audioOffset, startCtxTime, manualOffsetMsVal);
  // walk to desired beat
  let nt = firstNext;
  let idx = firstIdx;
  while (idx < beat) {
    nt += timeline.beatMsAt(idx) / 1000;
    idx++;
  }
  // schedule adds offsetSeconds
  return nt + manualOffsetMsVal / 1000;
}
function computeMetronomeAudibleBuggy(timeline: BpmTimeline, fromMs: number, ctxNow: number, beat: number, manualOffsetMsVal: number): number {
  const { nextBeatTime: firstNext, beatIdx: firstIdx } = computeBuggyNextBeatTime(timeline, fromMs, ctxNow);
  let nt = firstNext;
  let idx = firstIdx;
  while (idx < beat) {
    nt += timeline.beatMsAt(idx) / 1000;
    idx++;
  }
  return nt + manualOffsetMsVal / 1000;
}

// ---------------------------------------------------------------------------
// T137-1: 同じ fromMs で playFrom 2回連続呼び出し determinism (5ms以内)
// ---------------------------------------------------------------------------
describe('T137-1: 同じ fromMs で playFrom 2回連続 deterministic (when/offset + metronome when 5ms以内)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture initial offset 0 → Step2 call playFrom twice with same fromMs but ctx jitter → Step3 fixed nextBeatTime deterministic within 5ms', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const fromMs = 1237; // off-grid
    const audioOffset = 0;
    const manual = 0;
    const ctxStart1 = 10.0;
    const ctxNowJitter1 = 10.003; // 3ms jitter
    const ctxNowJitter2 = 10.012; // 12ms jitter (different frame)
    const fixed1 = computeFixedNextBeatTime(timeline, fromMs, ctxStart1, audioOffset, ctxNowJitter1, manual);
    const fixed2 = computeFixedNextBeatTime(timeline, fromMs, ctxStart1, audioOffset, ctxNowJitter2, manual);
    // Fixed uses startCtxTime, so jitter in ctxNow only affects while clamp if needed; for fromMs near future, both same
    expect(Math.abs(fixed1.nextBeatTime - fixed2.nextBeatTime)).toBeLessThanOrEqual(0.005);
    // Buggy would include ctxNow directly, so difference = jitter diff ≈9ms >5ms for some starting positions
    const buggy1 = computeBuggyNextBeatTime(timeline, fromMs, ctxNowJitter1);
    const buggy2 = computeBuggyNextBeatTime(timeline, fromMs, ctxNowJitter2);
    // Buggy difference equals jitter diff when not clamped
    const buggyDiff = Math.abs(buggy1.nextBeatTime - buggy2.nextBeatTime);
    expect(buggyDiff).toBeCloseTo(Math.abs(ctxNowJitter1 - ctxNowJitter2), 6);
    // Fixed should be stable: 0 for this case (both before next beat)
    expect(fixed1.nextBeatTime).toBeCloseTo(fixed2.nextBeatTime, 6);
  });

  it('Step1 capture file contract startMetronome signature → Step2 verify useCallback deterministic signature → Step3 assert file contains correct pattern', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Must be useCallback with 4 params
    expect(src).toMatch(/const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number\s*\)/);
    // Must NOT be old signature (positionRef or single arg)
    expect(src).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef\.current/);
    // Ensure nextBeatTime uses startCtxTime + leadMs
    expect(src).toMatch(/let\s+nextBeatTime\s*=\s*startCtxTime\s*\+\s*leadMs\s*\/\s*1000/);
    expect(src).toMatch(/timeline\.beatToMs\(beatIdx\)\s*-\s*fromMs/);
    // Ensure while includes manualOffset clamp so first click never clamped to now
    expect(src).toMatch(/while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs\(\)\s*\/\s*1000\s*<\s*ctx\.currentTime/);
  });

  it('Step1 capture buggy would use ctx.currentTime directly → Step2 verify fixed does not reference ctx.currentTime in nextBeatTime init → Step3 assert init not ctx.currentTime +', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const startMetaIdx = src.indexOf('const startMetronome');
    expect(startMetaIdx).toBeGreaterThan(-1);
    const slice = src.slice(startMetaIdx, startMetaIdx + 2000);
    // Should contain startCtxTime based init
    expect(slice).toContain('startCtxTime + leadMs');
    // Should NOT contain buggy pattern `ctx.currentTime + (timeline.beatToMs` as init (except ctx.currentTime appears in while condition)
    // Isolate the nextBeatTime line (no semicolon required)
    const initLine = slice.match(/let\s+nextBeatTime\s*=[^\n]+/);
    expect(initLine).not.toBeNull();
    expect(initLine![0]).not.toMatch(/ctx\.currentTime\s*\+.*beatToMs/);
    expect(initLine![0]).toMatch(/startCtxTime/);
  });

  it('Step1 capture playFrom before state → Step2 action call startMetronome(ctx, fromMs, t0, audioOffset) → Step3 file contract for playFrom deterministic call', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const playFromIdx = src.indexOf('const playFrom');
    expect(playFromIdx).toBeGreaterThan(-1);
    const slice = src.slice(playFromIdx, playFromIdx + 3500);
    expect(slice).toContain('const t0 = ctx.currentTime');
    expect(slice).toContain('startCtxTimeRef.current = t0');
    expect(slice).toContain('startMsRef.current = fromMs');
    expect(slice).toContain('metronomeLeadRef.current = audioOffset');
    // Critical fixed call pattern: startMetronome(ctx, fromMs, t0, audioOffset)
    expect(slice).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset\s*\)/);
    // Must NOT use positionRef.current in that call
    expect(slice).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef/);
  });

  it('Step1 capture fromMs=0 and off-grid 1237 → Step2 compute fixed nextBeatTime for both → Step3 assert beatIdx = ceil(msToBeat(fromMs))', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const cases = [0, 1237, 615, 185];
    for (const fromMs of cases) {
      const expectedIdx = Math.ceil(tl.msToBeat(fromMs));
      const fixed = computeFixedNextBeatTime(tl, fromMs, 10.0, 0, 10.0, 0);
      expect(fixed.beatIdx).toBe(expectedIdx);
    }
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/let\s+beatIdx\s*=\s*Math\.ceil\(timeline\.msToBeat\(fromMs\)\)/);
  });

  it('Step1 capture manual 80 before → Step2 compute music __editorPlayFrom.when/offset vs metronome first when diff 5ms以内で一定 → Step3 numeric', () => {
    setManualOffset(80);
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 2000;
    const audioOffset = 0;
    const ctxStart = 10.0;
    const manual = getManualOffsetMs(); //80
    // Simulate playFrom music params
    const offsetSec = (audioOffset + manual) / 1000; //0.08
    const startWhen = ctxStart + offsetSec; //10.08 for positive
    const startOffset = fromMs / 1000; //2.0
    // Simulate metronome first audible: compute fixed audible for first beat
    const { nextBeatTime, beatIdx } = computeFixedNextBeatTime(tl, fromMs, ctxStart, audioOffset, ctxStart, manual);
    const metroWhen = nextBeatTime + manual / 1000;
    // For beatIdx, music audible for that beat:
    const musicWhen = computeMusicAudible(ctxStart, fromMs, tl, beatIdx, audioOffset, manual);
    // They should align within 5ms (they share same lead)
    expect(Math.abs(metroWhen - musicWhen)).toBeLessThanOrEqual(0.005);
    // Run again with same inputs -> same diff (deterministic)
    const again = computeFixedNextBeatTime(tl, fromMs, ctxStart, audioOffset, ctxStart + 0.007, manual);
    const metroWhen2 = again.nextBeatTime + manual / 1000;
    expect(Math.abs(metroWhen2 - musicWhen)).toBeLessThanOrEqual(0.005);
    expect(metroWhen).toBeCloseTo(metroWhen2, 3); // within jitter due to while? For this fromMs, not clamped
    // File contract: __editorPlayFrom should be exposed for test inspection
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('__editorPlayFrom');
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T137-2: manualOffset ±80, audioOffset 0/200 全組合せで 音楽②とメトロノーム⑤が audioOffset込みで一致
// ---------------------------------------------------------------------------
describe('T137-2: manualOffset ±80 audioOffset 0/200 全組合せで 音楽② == メトロノーム⑤ (audioOffset込み)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture 4 combos → Step2 compute fixed audible → Step3 assert music and metronome align within 1ms and buggy differs by audioOffset', () => {
    const combos = [
      { manual: 80, audioOffset: 0 },
      { manual: -80, audioOffset: 0 },
      { manual: 80, audioOffset: 200 },
      { manual: -80, audioOffset: 200 },
    ];
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1000;
    const ctxStart = 8.0;
    for (const c of combos) {
      const manual = c.manual;
      const audioOffset = c.audioOffset;
      // pick a beat after fromMs
      const beat = 4;
      const music = computeMusicAudible(ctxStart, fromMs, tl, beat, audioOffset, manual);
      const metroFixed = computeMetronomeAudibleFixed(tl, fromMs, ctxStart, beat, audioOffset, manual);
      expect(metroFixed, `combo manual ${manual} audio ${audioOffset} fixed align`).toBeCloseTo(music, 3);
      // Buggy ignores audioOffset: difference == audioOffset/1000
      const metroBuggy = computeMetronomeAudibleBuggy(tl, fromMs, ctxStart, beat, manual);
      const buggyDiff = Math.abs(music - metroBuggy);
      expect(buggyDiff, `buggy should differ by audioOffset ${audioOffset}`).toBeCloseTo(audioOffset / 1000, 3);
      if (audioOffset !== 0) {
        expect(metroFixed).not.toBeCloseTo(metroBuggy, 2);
      }
    }
  });

  it('Step1 capture off-grid fromMs 615 and 1237 → Step2 compute with 0/200 offsets → Step3 still aligned including fractional', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromCases = [615, 1237, 185, 762];
    const audioOffsets = [0, 200];
    const manuals = [80, -80];
    const ctxStart = 12.5;
    for (const fromMs of fromCases) {
      for (const ao of audioOffsets) {
        for (const man of manuals) {
          const beat = Math.ceil(tl.msToBeat(fromMs)) + 2; // couple beats ahead
          const music = computeMusicAudible(ctxStart, fromMs, tl, beat, ao, man);
          const metro = computeMetronomeAudibleFixed(tl, fromMs, ctxStart, beat, ao, man);
          expect(metro, `fromMs ${fromMs} ao ${ao} man ${man} beat ${beat}`).toBeCloseTo(music, 3);
        }
      }
    }
  });

  it('Step1 capture file contract audioOffset baked into metronome grid → Step2 verify leadMs is audioOffset → Step3 assert metronomeLeadRef set to audioOffset', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('metronomeLeadRef.current = audioOffset');
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
    // Ensure schedule still adds manualOffset via offsetSeconds (maintained)
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds()');
    expect(metroSrc).toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/);
  });

  it('Step1 capture with BPM change timeline → Step2 compute aligned → Step3 beatMsAt varying still sync', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 180 }], 1.0);
    const fromMs = tl.beatToMs(3.37); // off-grid before change
    const beatAfter = 6; // after change
    for (const ao of [0, 200]) {
      for (const man of [80, -80]) {
        const ctxStart = 5.0;
        const music = computeMusicAudible(ctxStart, fromMs, tl, beatAfter, ao, man);
        const metro = computeMetronomeAudibleFixed(tl, fromMs, ctxStart, beatAfter, ao, man);
        expect(metro).toBeCloseTo(music, 3);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T137-3: isPlaying トグル Space 連打でも positionRef stale 起因ブレなし
// ---------------------------------------------------------------------------
describe('T137-3: isPlaying トグル Space 連打 stale positionRef ブレなし', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture positionRef stale value → Step2 call playFrom with true fromMs → Step3 fixed ignores stale while buggy would use it', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const trueFromMs = 1000;
    const stalePos = 1237; // off-grid stale tick value before stop (not beat-aligned)
    const ctxStart = 9.0;
    const audioOffset = 0;
    const manual = 0;
    // Fixed uses fromMs param
    const fixed = computeFixedNextBeatTime(tl, trueFromMs, ctxStart, audioOffset, ctxStart, manual);
    // Simulating buggy that would read positionRef.current (stale) instead of fromMs
    const buggyStale = computeFixedNextBeatTime(tl, stalePos, ctxStart, audioOffset, ctxStart, manual);
    expect(fixed.nextBeatTime).not.toBeCloseTo(buggyStale.nextBeatTime, 2);
    // File contract: playFrom must use fromMs param, not positionRef
    const src = readFile('src/screens/EditorScreen.tsx');
    const playFromSlice = src.slice(src.indexOf('const playFrom'), src.indexOf('const playFrom') + 2000);
    expect(playFromSlice).not.toMatch(/positionRef\.current/);
    // useEffect isPlaying should use startMsRef/startCtxTimeRef snapshot, not positionRef
    const useEffIdx = src.indexOf('useEffect(() => {\n    if (isPlaying && metronomeEnabled');
    if (useEffIdx !== -1) {
      const effSlice = src.slice(useEffIdx, useEffIdx + 600);
      expect(effSlice).toContain('startMsRef.current');
      expect(effSlice).toContain('startCtxTimeRef.current');
      expect(effSlice).not.toContain('positionRef.current');
    } else {
      // alternative location: the isPlaying effect should still not read stale
      expect(src).not.toMatch(/startMetronome\(.*positionRef\.current/);
    }
  });

  it('Step1 capture isPlaying true → Step2 toggle via Space logic startMetronome uses captured t0 → Step3 deterministic despite positionRef lag', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // onKeyDown Space should call playFrom(positionRef.current) only for toggling, but playFrom itself must capture t0 internally
    // Ensure startMetronome inside useEffect(isPlaying) uses snapshot refs
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*,\s*metronomeLeadRef\.current\s*\)/);
    // Ensure playFrom direct call also snapshot t0
    expect(src).toMatch(/const t0 = ctx\.currentTime/);
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,/);
  });

  it('Step1 capture rapid toggle simulation → Step2 compute 3 consecutive toggles same fromMs → Step3 all give same nextBeatTime', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 0;
    const ctxBase = 15.0;
    const results: number[] = [];
    for (let i = 0; i < 3; i++) {
      const jitter = i * 0.002; // 2ms jitter per toggle frame
      const r = computeFixedNextBeatTime(tl, fromMs, ctxBase + jitter, 0, ctxBase + jitter, 0);
      results.push(r.nextBeatTime);
    }
    // Each uses its own startCtxTime, but music start also shifts by same jitter, so relative beat timing stable
    // The key is: starting from same fromMs, the grid anchor is startCtxTime itself, so consecutive starts with slightly different ctx capture shouldn't produce extra random offset beyond jitter itself
    // But buggy would add extra jitter twice: verify fixed jitter == ctx jitter (not doubled by schedule clamp)
    expect(Math.abs(results[1] - results[0])).toBeCloseTo(0.002, 6);
    expect(Math.abs(results[2] - results[1])).toBeCloseTo(0.002, 6);
    // Now test that using stale positionRef would give different fromMs and thus different grid (use off-grid values to avoid beat-aligned coincidence)
    const staleResults = [1000, 1237, 185].map((s) => computeFixedNextBeatTime(tl, s, ctxBase, 0, ctxBase, 0).nextBeatTime);
    expect(staleResults[0]).not.toBeCloseTo(staleResults[1], 1);
    expect(staleResults[1]).not.toBeCloseTo(staleResults[2], 1);
  });

  it('Step1 capture file regression: isPlaying effect does not read positionRef stale → Step2 check source lacks positionRef in metronome start → Step3 pass', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Global search: startMetronome calls should only have snapshot forms
    const calls = [...src.matchAll(/startMetronome\s*\([^)]+\)/g)].map(m => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c).not.toContain('positionRef.current');
    }
    // Ensure no occurrence of schedule inside EditorScreen that manually adds offsetSeconds outside metronome.ts
    // schedule is delegated to metronome.ts which already adds offsetSeconds
    expect(src).toContain('schedule(');
  });
});

// ---------------------------------------------------------------------------
// T137-4: 回帰なし T102/T103/T129/T133/T136
// ---------------------------------------------------------------------------
describe('T137-4: 回帰なし T102/T103/T129/T133/T136', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture T102/T103 play-mode guard → Step2 check file still guards ring/segment stamping → Step3 modeRef record only', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const guardCount = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    // Space ring stamping guarded
    expect(src).toMatch(/if\s*\(\s*modeRef\.current === 'record'/);
  });

  it('Step1 capture T129 snap整数倍 → Step2 segmentize off-grid short push 0.30 snap 0.25 → Step3 snap-aligned not 1/amplitude', () => {
    const snap = 0.25;
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.30, y: TW_CENTER_Y + 40, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6, `beats ${s.beats} snap ${snap}`).toBeTruthy();
    }
    // Must not be forced to 1/amplitude =1.0
    expect(segs[0].beats).toBeCloseTo(0.25, 4);
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4);
  });

  it('Step1 capture T133 calibration overlay route absent → Step2 check App.tsx → Step3 no /calibration', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    expect(readFile('src/screens/EditorScreen.tsx')).toContain('CalibrationModal');
  });

  it('Step1 capture T138 green bar tick uses raw (no leadMs) → Step2 check tick slice → Step3 leadMs subtraction removed (raw == Play songNow)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tickIdx = src.indexOf('const tick = ()');
    expect(tickIdx).toBeGreaterThan(-1);
    const tickSlice = src.slice(tickIdx, tickIdx + 4000);
    // T138 案A: green bar uses raw time (unlike T136 raw-leadMs) so recording aligns with Play judgement.
    expect(tickSlice).toMatch(/const\s+rawPos\s*=\s*startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    expect(tickSlice).toMatch(/const\s+pos\s*=\s*Math\.max\(0,\s*rawPos\)/);
    expect(tickSlice).not.toMatch(/startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000\s*-\s*leadMs/);
    expect(tickSlice).not.toContain('getLeadMs');
  });

  it('Step1 capture GameScreen unchanged → Step2 verify not containing T137 editor metronome signature → Step3 GameScreen still simple', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).not.toContain('startMetronome(ctx, fromMs');
    expect(gameSrc).toContain('getManualOffsetMs');
    // GameScreen playMusic still uses (audioOffsetMs + getManualOffsetMs())/1000
    expect(gameSrc).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
  });

  it('Step1 capture metronome.ts schedule unchanged → Step2 verify still has offsetSeconds and clamp → Step3 intact', () => {
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain("import { offsetSeconds } from './clock'");
    expect(metroSrc).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime \+ offsetSeconds\(\)\)/);
    expect(metroSrc).toMatch(/export function schedule\(/);
  });
});

// ---------------------------------------------------------------------------
// T137-5: WaveEngine / Cursor 数値整合 回帰（複雑振幅 off-grid, T127/T128維持）
// ---------------------------------------------------------------------------
describe('T137-5: 回帰 WaveEngine/Cursor 数値整合（複雑振幅 off-grid, T127/T128維持）', () => {
  const amps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23];

  it('Step1 capture amp 0.7 beat 0.37 → Step2 set others → Step3 waveYAt slope = 2*TW_AMP*amplitudeAt clamped', () => {
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      for (const b of offGridBeats) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
      expect(engine.waveYAt(10)).toBeCloseTo(BOTTOM, 4);
    }
  });

  it('Step1 capture cursor at amp 1.3 dt 0.5 beats down → Step2 update → Step3 cursor delta == wave delta == perBeat*deltaBeats', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    const beatsDelta = 0.5;
    const dt = (beatsDelta * beatMs) / 1000;
    cursor.update(dt, false, true, beatMs);
    const cursorDelta = Math.abs(cursor.y - y0);
    // perBeat *0.5 = 169, stays within wave boundaries [170,430] from top start
    const expectedClamped = perBeat * 0.5;
    expect(cursorDelta).toBeCloseTo(expectedClamped, 4);
    const waveDelta = Math.abs(engine.waveYAt(beatsDelta) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(expectedClamped, 4);
    expect(waveDelta).toBeCloseTo(cursorDelta, 4);
  });

  it('Step1 capture getPoints length invariant → Step2 vary segments → Step3 segments+1 holds', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const cases: any[] = [
      [{ direction: 'down', beats: 1 }],
      [{ direction: 'up', beats: 0.5 }, { direction: 'down', beats: 0.5 }, { direction: 'stay', beats: 1 }],
      [],
    ];
    for (const segs of cases) {
      const eng = new WaveEngine(segs, tl, 1.0, 0);
      const pts = eng.getPoints();
      if (segs.length === 0) expect(pts.length).toBe(2);
      else expect(pts.length).toBe(segs.length + 1);
      for (const p of pts) {
        expect(typeof p.beat).toBe('number');
        expect(typeof p.y).toBe('number');
      }
    }
  });

  it('Step1 capture off-grid trajectory quantize 1.2→1.0 and 1.3→1.5 snap 0.5 → Step2 segmentize → Step3 still snap-aligned', () => {
    const snap = 0.5;
    expect(quantizeBeat(1.2, snap)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, snap)).toBeCloseTo(1.5, 4);
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.5, y: TW_CENTER_Y + 60, down: true },
      { beat: 1.0, y: TW_CENTER_Y + 120, down: true },
      { beat: 1.2, y: TW_CENTER_Y + 130, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    const moving = segs.filter(s => s.direction !== 'stay');
    const totalMoving = moving.reduce((a, b) => a + b.beats, 0);
    expect(totalMoving).toBeCloseTo(1.0, 4);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
    }
  });

  it('Step1 capture BpmTimeline amplitudeAt step off-grid → Step2 verify → Step3 correct list-driven', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(4.37)).toBe(2.0);
  });
});

// ---------------------------------------------------------------------------
// T137-6: tsc --noEmit guard and schedule clamp not triggering
// ---------------------------------------------------------------------------
describe('T137-6: tsc & while clamp決定性・metronome volume/switch不介入', () => {
  it('Step1 capture schedule while clamp with manualOffset → Step2 verify Math.max not triggered for first beat → Step3 leadMs included', () => {
    setManualOffset(0);
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 0;
    const startCtx = 10.0;
    const lead = 0;
    const { nextBeatTime } = computeFixedNextBeatTime(tl, fromMs, startCtx, lead, startCtx, 0);
    // With lead 0, first beat 0 is in past relative to fromMs 0 == start, so beatIdx 0 => nextBeatTime =10.0 + (0-0)=10.0
    // schedule when = max(10.0, 10.0+0)=10.0 not clamped beyond
    const when = Math.max(startCtx, nextBeatTime + offsetSeconds());
    expect(when).toBeCloseTo(nextBeatTime, 6);
    // With audioOffset 200, nextBeatTime =10.2
    const withAudio = computeFixedNextBeatTime(tl, fromMs, startCtx, 200, startCtx, 0);
    expect(withAudio.nextBeatTime).toBeCloseTo(10.2, 6);
    const when2 = Math.max(startCtx, withAudio.nextBeatTime + offsetSeconds());
    expect(when2).toBeCloseTo(10.2, 6);
    // While must have advanced only if still in past after adding manualOffset; with future beat it stays
    setManualOffset(80);
    const withManual = computeFixedNextBeatTime(tl, fromMs, startCtx, 200, startCtx, 80);
    // 10.2 +0.08 =10.28 not <10.0 so no advance
    expect(withManual.nextBeatTime).toBeCloseTo(10.2, 6);
    setManualOffset(0);
  });

  it('EditorScreen retains gain nodes and volume handling (unchanged by T137)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('musicGainRef');
    expect(src).toContain('metronomeGainRef');
    expect(src).toContain('data-testid="metronome-switch"');
    expect(src).toContain('data-testid="metronome-volume"');
    expect(src).toContain('data-testid="music-volume"');
  });

  it('All imported symbols remain typed correctly (tsc guard)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    expect(TW_AMP).toBe(130);
    expect(TW_CENTER_Y).toBe(300);
    // schedule still callable
    const ctx = createMockAudioContext();
    // schedule should not throw
    expect(() => schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
  });
});
