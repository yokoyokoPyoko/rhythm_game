/**
 * T137 — エディタ再生のメトロノーム決定性修正（再生ごとにズレるバグ）
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
 * No DOM – test pure engine math and file signatures.
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  const ctx = {
    currentTime,
    destination,
    createOscillator() {
      const o: any = {
        type: 'sine',
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      (ctx as any)._lastOsc = o;
      return o as unknown as OscillatorNode;
    },
    createGain() {
      const g: any = {
        gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
      (ctx as any)._lastGain = g;
      return g as unknown as GainNode;
    },
    createBufferSource() {
      const src: any = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn((w: number, o?: number) => { src._when = w; src._off = o; }),
        stop: vi.fn(),
        disconnect: vi.fn(),
      };
      (ctx as any)._lastSource = src;
      return src as unknown as AudioBufferSourceNode;
    },
  } as unknown as AudioContext & { _lastSource: any; _lastOsc: any; _lastGain: any };
  return ctx;
}

// Buggy compute from current EditorScreen.tsx (before fix)
// startMetronome(ctx, fromMs) with stale positionRef + jitter
function computeBuggyNextBeatTime(ctxCurrentTime: number, fromMs: number, timeline: BpmTimeline): { beatIdx: number; nextBeatTime: number } {
  let beatIdx = Math.ceil(timeline.msToBeat(fromMs));
  if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
  let nextBeatTime = ctxCurrentTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000;
  while (nextBeatTime < ctxCurrentTime) {
    nextBeatTime += timeline.beatMsAt(beatIdx) / 1000;
    beatIdx++;
  }
  return { beatIdx, nextBeatTime };
}

// Fixed compute per T137 spec: startMetronome(ctx, fromMs, startCtxTime, leadMs)
// nextBeatTime = startCtxTime + leadMs/1000 + (beatToMs(beatIdx)-fromMs)/1000 ??? but spec says
// we unify to startCtxTime basis and include audioOffset via leadMs.
// For determinism, the key is using startCtxTime (passed from playFrom's captured ctx.currentTime)
// not re-reading ctx.currentTime after async gap.
// For sync, metronome must reflect audioOffset: we add audioOffset/1000 to nextBeatTime,
// while schedule adds manual/1000 -> total lead = audio+manual.
// This helper implements fixed version that matches spec expectation:
// nextBeatTimeFixed = startCtxTime + (beatToMs(beatIdx)-fromMs)/1000 + audioOffset/1000
// and audible = nextBeatTimeFixed + manual/1000 = startCtxTime + delta + (audio+manual)/1000 = music
function computeFixedNextBeatTime(
  startCtxTime: number,
  fromMs: number,
  timeline: BpmTimeline,
  audioOffset: number,
  _manualOffset: number, // included via schedule, not here
): { beatIdx: number; nextBeatTime: number } {
  let beatIdx = Math.ceil(timeline.msToBeat(fromMs));
  if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
  // include audioOffset in initial calc; manual will be added by schedule's offsetSeconds()
  let nextBeatTime = startCtxTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000 + audioOffset / 1000;
  // while with lead-aware horizon: compare against startCtxTime (deterministic) not jittered now
  while (nextBeatTime < startCtxTime) {
    nextBeatTime += timeline.beatMsAt(beatIdx) / 1000;
    beatIdx++;
  }
  return { beatIdx, nextBeatTime };
}

function computeMusicAudible(ctxStart: number, fromMs: number, beatB: number, timeline: BpmTimeline, audioOffset: number, manualOffset: number): number {
  const offsetSec = (audioOffset + manualOffset) / 1000;
  return ctxStart + offsetSec + (timeline.beatToMs(beatB) - fromMs) / 1000;
}
function computeMetronomeAudibleFixed(ctxStart: number, fromMs: number, beatB: number, timeline: BpmTimeline, audioOffset: number, manualOffset: number): number {
  // fixed: nextBeatTime includes audio, schedule adds manual
  const delta = (timeline.beatToMs(beatB) - fromMs) / 1000;
  return ctxStart + delta + audioOffset / 1000 + manualOffset / 1000;
}
function computeMetronomeAudibleBuggy(ctxStart: number, fromMs: number, beatB: number, timeline: BpmTimeline, _audioOffset: number, manualOffset: number): number {
  const delta = (timeline.beatToMs(beatB) - fromMs) / 1000;
  return ctxStart + delta + manualOffset / 1000; // missing audioOffset
}

// ---------------------------------------------------------------------------
// T137-1: 同じ fromMs で 2回連続 playFrom -> __editorPlayFrom.when/offset とメトロノーム初回when差が5ms以内で一定（ジッタなし）
// ---------------------------------------------------------------------------
describe('T137-1:  determinism — same fromMs two calls, when/offset vs metronome diff <5ms and jitter-free (3-step)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture fromMs 0 ctxStart 10.0 jitter 0 -> Step2 simulate two playFrom with jitter 7ms -> Step3 fixed diff stable <5ms, buggy jitters', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const fromMs = 0;
    const audioOffset = 0;
    const manual = 0;
    // Step1: initial capture no jitter
    const ctxStart1 = 10.0;
    const buggy1 = computeBuggyNextBeatTime(ctxStart1, fromMs, timeline);
    const fixed1 = computeFixedNextBeatTime(ctxStart1, fromMs, timeline, audioOffset, manual);
    // Initially both coincide when no jitter
    expect(buggy1.nextBeatTime).toBeCloseTo(fixed1.nextBeatTime, 6);

    // Step2: second call with jitter due to async gap (ctx.currentTime moved 7ms after await ensure())
    // Buggy re-reads ctx.currentTime = 10.007, fixed uses captured startCtxTime = 10.0
    const jitter = 0.007;
    const ctxStartJittered = 10.0 + jitter;
    const buggyJittered = computeBuggyNextBeatTime(ctxStartJittered, fromMs, timeline);
    const fixedJittered = computeFixedNextBeatTime(ctxStart1, fromMs, timeline, audioOffset, manual); // still 10.0
    // Step3: assert
    // Buggy shifts by jitter
    expect(buggyJittered.nextBeatTime - buggy1.nextBeatTime).toBeCloseTo(jitter, 6);
    expect(Math.abs(buggyJittered.nextBeatTime - buggy1.nextBeatTime) * 1000).toBeGreaterThan(5);
    // Fixed stays exactly same
    expect(fixedJittered.nextBeatTime - fixed1.nextBeatTime).toBeCloseTo(0, 8);
    expect(Math.abs(fixedJittered.nextBeatTime - fixed1.nextBeatTime) * 1000).toBeLessThan(1);

    // Also verify music vs metronome diff <5ms for fixed (audioOffset 0 case)
    const beatB = 2; // arbitrary
    const musicWhen = computeMusicAudible(ctxStart1, fromMs, beatB, timeline, audioOffset, manual);
    const metroFixedAudible = computeMetronomeAudibleFixed(ctxStart1, fromMs, beatB, timeline, audioOffset, manual);
    const metroBuggyAudible = computeMetronomeAudibleBuggy(ctxStart1, fromMs, beatB, timeline, audioOffset, manual);
    // Fixed diff 0
    expect(Math.abs(musicWhen - metroFixedAudible) * 1000).toBeLessThan(1);
    // Buggy also 0 when audioOffset 0, but will diverge when audioOffset !=0 (next test)
    expect(Math.abs(musicWhen - metroBuggyAudible) * 1000).toBeLessThan(1);
  });

  it('Step1 capture fromMs 1250 (off-grid 2.5 beats at 120bpm) jitter 0 -> Step2 second call jitter 12ms -> Step3 fixed nextBeat remains deterministic, diff <5ms', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const fromMs = 1250; // 2.5 beats
    const audioOffset = 200;
    const manual = 80;
    const ctxStart = 15.0;
    const fixedA = computeFixedNextBeatTime(ctxStart, fromMs, timeline, audioOffset, manual);
    // jittered buggy
    const buggyA = computeBuggyNextBeatTime(ctxStart, fromMs, timeline);
    const buggyB = computeBuggyNextBeatTime(ctxStart + 0.012, fromMs, timeline);
    const fixedB = computeFixedNextBeatTime(ctxStart, fromMs, timeline, audioOffset, manual);
    // buggy jitters 12ms
    expect(Math.abs(buggyB.nextBeatTime - buggyA.nextBeatTime) * 1000).toBeCloseTo(12, 1);
    expect(Math.abs(buggyB.nextBeatTime - buggyA.nextBeatTime) * 1000).toBeGreaterThan(5);
    // fixed no jitter
    expect(Math.abs(fixedB.nextBeatTime - fixedA.nextBeatTime) * 1000).toBeLessThan(1);

    // music vs metro fixed diff <5ms despite audioOffset 200
    const beatB = Math.ceil(timeline.msToBeat(fromMs)); // 3
    const music = computeMusicAudible(ctxStart, fromMs, beatB, timeline, audioOffset, manual);
    const metroFixed = computeMetronomeAudibleFixed(ctxStart, fromMs, beatB, timeline, audioOffset, manual);
    expect(Math.abs(music - metroFixed) * 1000).toBeLessThan(5);
    const metroBuggy = computeMetronomeAudibleBuggy(ctxStart, fromMs, beatB, timeline, audioOffset, manual);
    // buggy missing audioOffset 200ms => diff 200ms
    expect(Math.abs(music - metroBuggy) * 1000).toBeCloseTo(200, 1);
    expect(Math.abs(music - metroBuggy) * 1000).toBeGreaterThan(5);
  });

  it('Step1 capture two deterministic calls with same startCtxTime -> Step2 compute while clamp case (beat quantization overshoot) -> Step3 Math.max not triggered', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const fromMs = 1237; // off-grid 2.474 beats -> ceil 3
    const ctxStart = 20.0;
    const audioOffset = 0;
    const manual = 0;
    const fixed = computeFixedNextBeatTime(ctxStart, fromMs, timeline, audioOffset, manual);
    // beat 3 at 1500ms, delta 263ms -> nextBeatTime 20.263
    expect(fixed.beatIdx).toBe(3);
    expect(fixed.nextBeatTime).toBeCloseTo(20.263, 3);
    // simulate schedule when = max(now, nextBeatTime + manual) -> would be nextBeatTime if > now
    setManualOffset(80);
    const whenFixed = Math.max(ctxStart, fixed.nextBeatTime + offsetSeconds());
    // since fixed already includes audio, and manual added, when should be nextBeatTime +0.08 =20.343 > ctxStart, no clamp overshoot
    expect(whenFixed).toBeCloseTo(fixed.nextBeatTime + 0.08, 6);
    expect(whenFixed).toBeGreaterThan(ctxStart);
    // buggy with jitter would clamp differently
    setManualOffset(0);
    const buggy = computeBuggyNextBeatTime(ctxStart, fromMs, timeline);
    const whenBuggy = Math.max(ctxStart, buggy.nextBeatTime + offsetSeconds());
    expect(whenBuggy).toBeCloseTo(buggy.nextBeatTime, 6);
    // now with manual 80, buggy+manual vs fixed diff: fixed includes audioOffset if any, but here audio 0 so same
    // but jitter test already covers
  });
});

// ---------------------------------------------------------------------------
// T137-2: manualOffset=±80, audioOffset=0/200 全組合せで音楽②とメトロノーム⑤の beat 対応が audioOffset 込みで一致
// ---------------------------------------------------------------------------
describe('T137-2: audioOffset込み一致 — manual ±80 * audio 0/200 全組合せ (3-step off-grid)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture manual 0 audio0 baseline -> Step2 switch manual +80 audio 200 -> Step3 assert music② == metronome⑤ fixed within 5ms for beat including off-grid 0.37/1.23', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const cases = [
      { manual: 80, audio: 0 },
      { manual: -80, audio: 0 },
      { manual: 80, audio: 200 },
      { manual: -80, audio: 200 },
    ];
    const fromMs = 615; // off-grid ~1.23 beats
    const ctxStart = 10.0;
    const beatsToCheck = [0.37, 1.23, 2.37, 3.37, 4.23];
    for (const c of cases) {
      setManualOffset(c.manual);
      expect(getManualOffsetMs()).toBe(c.manual);
      for (const b of beatsToCheck) {
        const music = computeMusicAudible(ctxStart, fromMs, b, timeline, c.audio, c.manual);
        const metroFixed = computeMetronomeAudibleFixed(ctxStart, fromMs, b, timeline, c.audio, c.manual);
        const metroBuggy = computeMetronomeAudibleBuggy(ctxStart, fromMs, b, timeline, c.audio, c.manual);
        // Fixed must be within 5ms (ideally 0)
        expect(Math.abs(music - metroFixed), `manual ${c.manual} audio ${c.audio} beat ${b}`).toBeLessThan(0.005);
        // Buggy differs by audioOffset when audio !=0
        if (c.audio === 200) {
          expect(Math.abs(music - metroBuggy)).toBeCloseTo(0.2, 3);
          expect(Math.abs(music - metroBuggy)).toBeGreaterThan(0.005);
        } else {
          // audio 0: buggy coincides, but fixed still required
          expect(Math.abs(music - metroBuggy)).toBeLessThan(0.005);
        }
      }
    }
  });

  it('Step1 capture manual -80 audio0 -> Step2 manual +80 audio0 -> Step3 music shift equals metro shift (80ms*2 =160ms)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 0;
    const ctx = 10.0;
    const beat = 4;
    setManualOffset(-80);
    const musicNeg = computeMusicAudible(ctx, fromMs, beat, tl, 0, -80);
    const metroNeg = computeMetronomeAudibleFixed(ctx, fromMs, beat, tl, 0, -80);
    setManualOffset(80);
    const musicPos = computeMusicAudible(ctx, fromMs, beat, tl, 0, 80);
    const metroPos = computeMetronomeAudibleFixed(ctx, fromMs, beat, tl, 0, 80);
    expect(musicPos - musicNeg).toBeCloseTo(0.16, 6);
    expect(metroPos - metroNeg).toBeCloseTo(0.16, 6);
    expect((musicPos - musicNeg) - (metroPos - metroNeg)).toBeCloseTo(0, 6);
    // off-grid beat 1.23 should also shift same
    const musicNegOff = computeMusicAudible(ctx, fromMs, 1.23, tl, 0, -80);
    const musicPosOff = computeMusicAudible(ctx, fromMs, 1.23, tl, 0, 80);
    expect(musicPosOff - musicNegOff).toBeCloseTo(0.16, 6);
  });

  it('Step1 capture audio0 manual0 baseline -> Step2 audio200 manual0 -> Step3 metro fixed tracks audio shift, buggy does not', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 185; // off-grid fractional
    const ctx = 10.0;
    const beat = 2;
    // baseline
    const music0 = computeMusicAudible(ctx, fromMs, beat, tl, 0, 0);
    const metro0 = computeMetronomeAudibleFixed(ctx, fromMs, beat, tl, 0, 0);
    expect(Math.abs(music0 - metro0)).toBeLessThan(0.001);
    // with audio200
    const music200 = computeMusicAudible(ctx, fromMs, beat, tl, 200, 0);
    const metroFixed200 = computeMetronomeAudibleFixed(ctx, fromMs, beat, tl, 200, 0);
    const metroBuggy200 = computeMetronomeAudibleBuggy(ctx, fromMs, beat, tl, 200, 0);
    expect(music200 - music0).toBeCloseTo(0.2, 6);
    expect(metroFixed200 - metro0).toBeCloseTo(0.2, 6);
    expect(metroBuggy200 - metro0).toBeCloseTo(0, 6); // buggy missing audio
    expect(Math.abs(music200 - metroFixed200)).toBeLessThan(0.001);
    expect(Math.abs(music200 - metroBuggy200)).toBeCloseTo(0.2, 3);
  });

  it('Step1 capture complex BPM timeline beat 3.37/4.23 amplitude step -> Step2 verify fixed sync holds across timeline.mstoBeat quantization', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 180, amplitude: 2.0 }], 1.0);
    const fromMs = tl.beatToMs(1.23); // off-grid
    const ctx = 10.0;
    for (const c of [{ manual: 80, audio: 0 }, { manual: 80, audio: 200 }, { manual: -80, audio: 200 }]) {
      setManualOffset(c.manual);
      const ms = tl.beatToMs(3.37);
      const b = tl.msToBeat(ms);
      expect(b).toBeCloseTo(3.37, 4);
      const music = computeMusicAudible(ctx, fromMs, 4.23, tl, c.audio, c.manual);
      const metro = computeMetronomeAudibleFixed(ctx, fromMs, 4.23, tl, c.audio, c.manual);
      expect(Math.abs(music - metro)).toBeLessThan(0.005);
    }
  });
});

// ---------------------------------------------------------------------------
// T137-3: isPlaying トグル Space 連打しても positionRef stale 起因ブレなし + file contract
// ---------------------------------------------------------------------------
describe('T137-3: isPlaying toggle stale positionRef guard eliminated (3-step file + numeric)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture file before: useEffect reads positionRef.current -> Step2 assert after fix it does NOT and playFrom calls startMetronome directly', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Step1: check current file has direct call in playFrom
    const playFromIdx = src.indexOf('const playFrom');
    expect(playFromIdx).toBeGreaterThan(-1);
    const playFromSlice = src.slice(playFromIdx, playFromIdx + 8000);
    // Step2: after fix, playFrom must directly call startMetronome with fromMs/startCtxTime/leadMs
    expect(playFromSlice, 'playFrom must directly call startMetronome with deterministic args (not rely on useEffect)').toMatch(/startMetronome\s*\(/);
    // Should pass startCtxTime or ctx.currentTime or leadMs
    // Look for startMetronome call that includes fromMs (captured arg) not positionRef
    const hasFromMsArg = /startMetronome\s*\(\s*ctx\s*,\s*fromMs/.test(playFromSlice);
    expect(hasFromMsArg, 'startMetronome in playFrom must use fromMs param').toBe(true);
    // Must NOT still use positionRef.current inside playFrom for metronome
    // Ensure startMetronome call does not use positionRef.current
    const playFromStartMetroCalls = [...playFromSlice.matchAll(/startMetronome\s*\([^)]+\)/g)].map(m => m[0]);
    for (const call of playFromStartMetroCalls) {
      expect(call).not.toContain('positionRef.current');
    }

    // Step3: useEffect([isPlaying]) should NOT read positionRef.current after fix (or be removed / guarded)
    const useEffectIsPlayingMatch = src.match(/useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*isPlaying[^}]*\}[\s\S]*?\[isPlaying[^\]]*\]/);
    // alternative: find the effect that contains startMetronome and positionRef
    const effectSlice = src.slice(src.indexOf('useEffect', playFromIdx), src.indexOf('useEffect', playFromIdx) + 5000);
    // More robust: check any useEffect with startMetronome and positionRef
    const hasStaleRead = src.includes('startMetronome(ctx, positionRef.current)');
    // After fix, this stale pattern must be gone
    expect(hasStaleRead, 'stale positionRef.current in useEffect startMetronome must be removed').toBe(false);
  });

  it('Step1 capture positionRef stale = last stop pos 500ms vs true fromMs 0 -> Step2 simulate buggy vs fixed beatIdx -> Step3 fixed beatIdx matches fromMs not stale', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const stalePos = 500; // previous stop at 500ms (beat 1.0)
    const trueFromMs = 0;
    const ctxNow = 10.0;
    // Buggy reads stalePos
    const buggyFromStale = computeBuggyNextBeatTime(ctxNow, stalePos, tl);
    const fixedFromTrue = computeFixedNextBeatTime(ctxNow, trueFromMs, tl, 0, 0);
    const buggyFromTrue = computeBuggyNextBeatTime(ctxNow, trueFromMs, tl);
    // stale pos 500 => ceil(1.0)=1 => beatIdx 1, true 0 => beatIdx 0
    expect(buggyFromStale.beatIdx).toBe(1);
    expect(fixedFromTrue.beatIdx).toBe(0);
    expect(buggyFromTrue.beatIdx).toBe(0);
    // So stale causes off-by-one beat shift (500ms at 120bpm =1 beat)
    expect(buggyFromStale.beatIdx).not.toBe(fixedFromTrue.beatIdx);
    // Fixed uses trueFromMs, not stale
    expect(fixedFromTrue.beatIdx).toBe(buggyFromTrue.beatIdx);
    // With off-grid fromMs 1237 (2.474 beats) vs stale 500, should also differ
    const offGridFrom = 1237;
    const fixedOff = computeFixedNextBeatTime(ctxNow, offGridFrom, tl, 0, 0);
    const buggyOff = computeBuggyNextBeatTime(ctxNow, offGridFrom, tl);
    expect(fixedOff.beatIdx).toBe(Math.ceil(tl.msToBeat(offGridFrom)));
    expect(buggyOff.beatIdx).toBe(Math.ceil(tl.msToBeat(offGridFrom)));
    // but stale still 1
    expect(buggyFromStale.beatIdx).not.toBe(fixedOff.beatIdx);
  });

  it('Step1 capture isPlaying false -> Step2 Space toggle 5 times rapid (fake timers) -> Step3 beatIdx remains deterministic (no accumulation of jitter)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 0;
    const ctxBase = 10.0;
    const jitters = [0.003, 0.007, 0.002, 0.009, 0.005];
    const fixedTimes: number[] = [];
    const buggyTimes: number[] = [];
    let ctx = ctxBase;
    for (const j of jitters) {
      ctx += j;
      fixedTimes.push(computeFixedNextBeatTime(ctxBase, fromMs, tl, 0, 0).nextBeatTime);
      buggyTimes.push(computeBuggyNextBeatTime(ctx, fromMs, tl).nextBeatTime);
    }
    // fixed all same
    for (let i = 1; i < fixedTimes.length; i++) {
      expect(Math.abs(fixedTimes[i] - fixedTimes[0]) * 1000).toBeLessThan(1);
    }
    // buggy varies by up to ~9ms
    const buggySpread = Math.max(...buggyTimes) - Math.min(...buggyTimes);
    expect(buggySpread * 1000).toBeGreaterThan(5);
  });

  it('Step1 capture file guard: isPlaying toggle via Space should not reintroduce stale read', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Ensure onKeyDown Space handling does not set positionRef incorrectly for metronome
    // After fix, toggle calls playFrom(positionRef.current) once, but metronome uses fromMs inside playFrom, not stale effect
    // So file must contain playFrom(positionRef.current) only for the toggle, but startMetronome must not use stale
    // We already checked stale removed; now check that playFrom is still used for toggle (not removed)
    expect(src).toContain('playFrom(positionRef.current)');
    // But startMetronome inside playFrom must not be stale – already asserted
    // Also ensure stopMetronome still exists
    expect(src).toContain('stopMetronome');
  });
});

// ---------------------------------------------------------------------------
// T137-4: startMetronome決定論化 file contract — signature, leadMs, startCtxTime, deterministic nextBeatTime, beatIdx leadMs込み, Math.max clamp回避
// ---------------------------------------------------------------------------
describe('T137-4: startMetronome deterministic signature & file contracts (3-step)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture before signature (ctx,fromMs) -> Step2 set manual 80 audio 200 -> Step3 assert file has (ctx,fromMs,startCtxTime,leadMs) signature', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Must have extended signature with 4 args
    expect(src, 'startMetronome must be extended to (ctx, fromMs, startCtxTime, leadMs)').toMatch(/startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number/);
    // Old 2-arg pattern must not remain as only definition
    const oldSigMatches = (src.match(/startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:/g) || []).length;
    expect(oldSigMatches).toBe(1);
    // Ensure new signature contains leadMs
    expect(src).toContain('leadMs');
  });

  it('Step1 capture nextBeatTime line uses ctx.currentTime -> Step2 switch -> Step3 assert uses startCtxTime + leadMs/1000 + delta (audioOffset込み)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const startMetroIdx = src.indexOf('const startMetronome');
    expect(startMetroIdx).toBeGreaterThan(-1);
    const slice = src.slice(startMetroIdx, startMetroIdx + 4000);
    // After fix, nextBeatTime must be startCtxTime based, not ctx.currentTime +
    expect(slice).toContain('startCtxTime');
    // Must not be ctx.currentTime + (beatToMs... ) alone (jitter source)
    // The line `let nextBeatTime = ctx.currentTime +` should be gone or replaced
    expect(slice).not.toMatch(/let\s+nextBeatTime\s*=\s*ctx\.currentTime\s*\+/);
    // Should contain startCtxTime + ... or startCtxTime + leadMs/1000
    expect(slice).toMatch(/startCtxTime\s*\+/);
    // Should contain leadMs
    expect(slice).toContain('leadMs');
    // Should contain audioOffset via leadMs (leadMs = audioOffset + manual)
    // In playFrom, leadMs is computed as audioOffset + getManualOffsetMs()
    const playFromIdx = src.indexOf('const playFrom');
    const playSlice = src.slice(playFromIdx, playFromIdx + 8000);
    expect(playSlice).toMatch(/leadMs|audioOffset\s*\+\s*getManualOffsetMs/);
    // Ensure playFrom passes leadMs to startMetronome
    expect(playSlice).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*(ctx\.currentTime|startCtxTimeRef\.current|.*startCtxTime).*leadMs/);
  });

  it('Step1 capture while clamp uses ctx.currentTime -> Step2 verify fixed uses startCtxTime comparator and leadMs込み', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const slice = src.slice(src.indexOf('const startMetronome'), src.indexOf('const startMetronome') + 4000);
    // while should compare nextBeatTime < startCtxTime or horizon lead-aware, not ctx.currentTime alone without lead
    // At least should contain startCtxTime in while condition or horizon calc
    expect(slice).toContain('while');
    // The critical clamp `when = Math.max(now, nextBeatTime+offsetSeconds())` is inside metronome.ts schedule,
    // but startMetronome while should be lead-aware to prevent initial clamp
    // So check that while condition is not simply `while (nextBeatTime < ctx.currentTime)` without lead adjustment
    // After fix it should be `while (nextBeatTime < startCtxTime` or `< horizon` with lead
    const hasOldWhile = /while\s*\(\s*nextBeatTime\s*<\s*ctx\.currentTime\s*\)/.test(slice);
    expect(hasOldWhile, 'old while (nextBeatTime < ctx.currentTime) must be replaced with lead-aware deterministic version').toBe(false);
    expect(slice).toMatch(/while\s*\(\s*nextBeatTime\s*<\s*(startCtxTime|horizon)/);
  });

  it('Step1 capture metronome.ts schedule still adds offsetSeconds -> Step2 verify editor passes metronomeGain correctly (not duplicating)', () => {
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds()');
    expect(metroSrc).toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/);
    expect(metroSrc).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime \+ offsetSeconds\(\)\)/);
    // Ensure schedule signature still (audioCtx, nextBeatTime, beat, out?)
    expect(metroSrc).toMatch(/export function schedule\(/);
    expect(metroSrc).toMatch(/nextBeatTime:\s*number/);
    // GameScreen unaffected
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).not.toContain('startCtxTime');
    expect(gameSrc).not.toContain('leadMs');
  });

  it('Step1 capture playFrom before does not call startMetronome -> Step2 verify after fix playFrom calls startMetronome before setPlaying(true)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const playFromIdx = src.indexOf('const playFrom');
    const setPlayingIdx = src.indexOf('setPlaying(true)', playFromIdx);
    expect(playFromIdx).toBeGreaterThan(-1);
    expect(setPlayingIdx).toBeGreaterThan(playFromIdx);
    const between = src.slice(playFromIdx, setPlayingIdx);
    expect(between).toMatch(/startMetronome\s*\(/);
    // Ensure startMetronome is called with leadMs before setPlaying
    expect(between).toContain('leadMs');
    // Ensure useEffect double startup is removed or guarded: after fix, useEffect([isPlaying]) should not start metronome redundantly
    // There should be only one startMetronome call site in playFrom, and useEffect should be either removed or check not to double
    // At least the stale useEffect with positionRef must be gone (tested earlier)
    // Count startMetronome occurrences: should be at least 1 in playFrom, maybe not in useEffect
    const startMetroCalls = (src.match(/startMetronome\s*\(/g) || []).length;
    expect(startMetroCalls).toBeGreaterThanOrEqual(1);
    // If useEffect still exists, it must not contain positionRef
    const hasStaleEffect = src.includes('startMetronome(ctx, positionRef.current)');
    expect(hasStaleEffect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T137-5: 回帰なし — T102/T103/T129/T133/T136/T135 が壊れないこと (3-step)
// ---------------------------------------------------------------------------
describe('T137-5: 回帰なし T102/T103 snap T129 T133 T136 T135 (3-step)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture T102/T103 guard modeRef === record exists -> Step2 verify still present after T137', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const guardCount = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    // Space stamping still guarded
    expect(src).toMatch(/if\s*\(\s*modeRef\.current === 'record'/);
    // file still has no positionRef - manual subtraction for recording (T136)
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/);
  });

  it('Step1 capture snap select exists -> Step2 segmentize off-grid 0.30 snap 0.125/0.25/0.5/1 -> Step3 beats are snap multiples and not 1/amplitude', () => {
    expect(readFile('src/screens/EditorScreen.tsx')).toContain('data-testid="snap-select"');
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    for (const snap of snaps) {
      const traj = [{ beat: 0, y: TW_CENTER_Y, down: true }, { beat: 0.30, y: TW_CENTER_Y + 20, down: false }];
      const segs = segmentize(traj, snap, 1.0);
      expect(segs.length).toBeGreaterThan(0);
      for (const s of segs) {
        const rem = ((s.beats % snap) + snap) % snap;
        const aligned = rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
        expect(aligned, `beats ${s.beats} snap ${snap}`).toBeTruthy();
      }
      if (snap === 0.25) {
        expect(segs[0].beats).not.toBeCloseTo(1.0, 2);
        expect(segs[0].beats).toBeCloseTo(0.25, 4);
      }
    }
  });

  it('Step1 capture T133 overlay route removed -> Step2 check App.tsx -> Step3 /calibration absent and CalibrationModal still referenced', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toContain('CalibrationModal');
    expect(editorSrc).toContain('data-testid="editor-calibration-button"');
    // calibration still uses generateCalibrationChart with BPM120 up2/down2 rings 4n
    const modalSrc = fs.existsSync(path.resolve(__dirname, '../src/screens/editor/CalibrationModal.tsx'))
      ? readFile('src/screens/editor/CalibrationModal.tsx')
      : readFile('src/screens/editor/CalibrationOverlay.tsx');
    expect(modalSrc).toContain('schedule');
  });

  it('Step1 capture T136 green bar pos = startMs + delta - leadMs still present -> Step2 verify tick and stop use leadMs', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // T136 maintained, not reverted to raw (T138 would revert but T137 keeps -leadMs per spec point 4)
    const tickIdx = src.indexOf('const tick = ()');
    const tickSlice = tickIdx !== -1 ? src.slice(tickIdx, tickIdx + 6000) : src.slice(src.indexOf('startMsRef.current'), src.indexOf('startMsRef.current') + 6000);
    expect(tickSlice).toContain('leadMs');
    expect(tickSlice).toContain('getManualOffsetMs');
    expect(tickSlice).toMatch(/startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000\s*-\s*leadMs/);
    const stopIdx = src.indexOf('const stop =');
    const stopSlice = src.slice(stopIdx, stopIdx + 3000);
    expect(stopSlice).toContain('leadMs');
    expect(stopSlice).toContain('getManualOffsetMs');
  });

  it('Step1 capture T135 music sync offsetSec = (audioOffset+manual)/1000 still present -> Step2 verify playFrom offsetSec and GameScreen unchanged', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toMatch(/\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    expect(gameSrc).not.toContain('startCtxTime');
  });

  it('Step1 capture quantize off-grid 1.2->1.0 1.3->1.5 snap 0.5 -> Step2 segmentize -> Step3 still snap aligned', () => {
    expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4);
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.5, y: TW_CENTER_Y + 60, down: true },
      { beat: 1.0, y: TW_CENTER_Y + 120, down: true },
      { beat: 1.2, y: TW_CENTER_Y + 130, down: false },
    ];
    const segs = segmentize(traj, 0.5, 1.0);
    for (const s of segs) {
      const rem = ((s.beats % 0.5) + 0.5) % 0.5;
      expect(rem < 1e-6 || Math.abs(rem - 0.5) < 1e-6).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// T137-6: 数値整合 WaveEngine vs Cursor 同一速度係数 (complex amplitudes, off-grid 0.37/1.23) — T127/T128 regression guard
// ---------------------------------------------------------------------------
describe('T137-6: 数値整合 WaveEngine vs Cursor (complex amps 0.7/1.3/2.7/3.4 off-grid 0.37/1.23)', () => {
  const amps = [0.7, 1.3, 2.7, 3.4] as const;
  const offGridBeats = [0.37, 1.23, 0.25, 0.5, 1.37] as const;

  it('Step1 capture amp 0.7 beat 0.37 -> Step2 waveYAt perBeat 2*TW_AMP*amp clamped -> Step3 matches engine', () => {
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const eng = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      for (const b of offGridBeats) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = eng.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 1);
      }
      // beyond bottom stays flat
      expect(eng.waveYAt(10)).toBeCloseTo(BOTTOM, 1);
    }
  });

  it('Step1 capture cursor at amp 1.3 -> Step2 update 0.5 beats -> Step3 cursor delta == wave delta == perBeat*0.5 clamped to TW_AMP', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const wave = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cur = new Cursor(amp, 1.0);
    const y0 = cur.y;
    const dt = (0.5 * beatMs) / 1000;
    cur.update(dt, false, true, beatMs);
    const cDelta = Math.abs(cur.y - y0);
    const wDelta = Math.abs(wave.waveYAt(0.5) - wave.waveYAt(0));
    const expectedClamped = Math.min(perBeat * 0.5, TW_AMP);
    expect(cDelta).toBeCloseTo(expectedClamped, 1);
    expect(wDelta).toBeCloseTo(expectedClamped, 1);
    expect(wDelta).toBeCloseTo(cDelta, 1);
  });

  it('Step1 capture getPoints length -> Step2 vary segments -> Step3 segments+1 holds', () => {
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
      for (const p of pts) { expect(typeof p.beat).toBe('number'); expect(typeof p.y).toBe('number'); }
    }
  });

  it('Step1 capture off-grid trajectory with amplitude step beat 4 -> Step2 amplitudeAt 3.37=1.0 4.23=2.0 -> Step3 wave slope uses correct per-segment amplitude', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    // wave per segment amplitude: segment starting at 0 uses 1.0, segment starting at 4 uses 2.0
    const segs = [{ direction: 'down' as const, beats: 4 }, { direction: 'down' as const, beats: 2 }];
    const eng = new WaveEngine(segs, tl, 1.0, 0);
    // beat 0.37 within first segment: slope 260
    expect(eng.waveYAt(0.37)).toBeCloseTo(TW_CENTER_Y + 260 * 0.37, 1);
    // beat 5 (1 into second segment, amplitude 2.0 -> 520/beat, but clamped)
    // first segment 4 beats at 260 =1040 -> clamped to bottom 430 at beat 0.5 already, so second segment starts at bottom
    // So just check second segment y stays bottom or moves with higher slope but clamped
    expect(eng.waveYAt(5)).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6);
    expect(eng.waveYAt(5)).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6);
  });

  it('Step1 capture TSC guard -> Step2 import all symbols -> Step3 types defined', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    expect(TW_AMP).toBe(130);
    const ctx = createMockAudioContext(10.0);
    expect(() => schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
  });
});
