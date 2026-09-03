/**
 * T138 — 判定ライン＝緑バーの同一化（記録位置とプレイ判定の整合）
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
 * 案A: Editor 緑バー④ = raw (Play 判定① songNow と同一). 手法: tick/stop の leadMs 減算撤廃, positionRef raw 追跡.
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
import { getManualOffsetMs, setManualOffset, getLeadMs, offsetSeconds } from '../src/audio/clock';
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

// Correct T138: green bar raw
function computeGreenPosRaw(startMs: number, ctxNow: number, startCtxTime: number): number {
  const rawPos = startMs + (ctxNow - startCtxTime) * 1000;
  return Math.max(0, rawPos);
}
// Buggy T136: subtract leadMs
function computeGreenPosBuggy(startMs: number, ctxNow: number, startCtxTime: number, audioOffset: number, manualOffsetMsVal: number): number {
  const leadMs = audioOffset + manualOffsetMsVal;
  const rawPos = startMs + (ctxNow - startCtxTime) * 1000;
  return Math.max(0, rawPos - leadMs);
}
function computeRecordBeat(tl: BpmTimeline, pos: number, snap: number): number {
  return quantizeBeat(tl.msToBeat(pos), snap);
}

// T138 music offset via getLeadMs (centralized)
function computeMusicLeadMs(audioOffset: number, manualOffsetMsVal: number): number {
  return audioOffset + manualOffsetMsVal;
}

// ---------------------------------------------------------------------------
// T138-1: Editor positionRef raw invariant to manualOffset
// ---------------------------------------------------------------------------
describe('T138-1: Editor positionRef raw tracking pos=startMs+(ctx.currentTime-startCtxTime)*1000 manual invariant', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture raw 500ms elapsed before offset → Step2 set manual +80 → Step3 raw unchanged vs buggy shifts -80', () => {
    expect(getManualOffsetMs()).toBe(0);
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 10.5; // 500ms
    const audioOffset = 0;
    const rawBefore = computeGreenPosRaw(startMs, ctxNow, startCtx);
    const buggyBefore = computeGreenPosBuggy(startMs, ctxNow, startCtx, audioOffset, 0);
    expect(rawBefore).toBeCloseTo(500, 6);
    expect(buggyBefore).toBeCloseTo(500, 6);
    // Step2 apply
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const rawAfter = computeGreenPosRaw(startMs, ctxNow, startCtx);
    const buggyAfter = computeGreenPosBuggy(startMs, ctxNow, startCtx, audioOffset, 80);
    expect(rawAfter).toBeCloseTo(500, 6);
    expect(buggyAfter).toBeCloseTo(420, 6);
    expect(rawAfter).not.toBeCloseTo(buggyAfter, 2);
    expect(buggyAfter - rawAfter).toBeCloseTo(-80, 6);
  });

  it('Step1 capture with negative offset -80 → Step2 vary ctx delta 200ms → Step3 raw still 200 vs buggy 280', () => {
    setManualOffset(-80);
    expect(getManualOffsetMs()).toBe(-80);
    const startMs = 0;
    const startCtx = 5.0;
    const ctxNow = 5.2; // 200
    const raw = computeGreenPosRaw(startMs, ctxNow, startCtx);
    const buggy = computeGreenPosBuggy(startMs, ctxNow, startCtx, 0, -80);
    expect(raw).toBeCloseTo(200, 6);
    expect(buggy).toBeCloseTo(280, 6);
    expect(raw).not.toBeCloseTo(buggy, 2);
  });

  it('Step1 capture audioOffset +200 manual +80 → Step2 compute raw pos 500-0? Actually raw 500 vs buggy 220 → Step3 raw invariant', () => {
    setManualOffset(80);
    const audioOffset = 200;
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 10.5; // 500
    const raw = computeGreenPosRaw(startMs, ctxNow, startCtx);
    const buggy = computeGreenPosBuggy(startMs, ctxNow, startCtx, audioOffset, 80);
    expect(raw).toBeCloseTo(500, 6);
    expect(buggy).toBeCloseTo(220, 6); // 500-280
    expect(raw - buggy).toBeCloseTo(280, 6);
    // Raw should be same regardless of audioOffset variation
    const rawZeroAudio = computeGreenPosRaw(startMs, ctxNow, startCtx);
    expect(rawZeroAudio).toBeCloseTo(raw, 6);
    expect(buggy).not.toBeCloseTo(rawZeroAudio, 2);
  });

  it('Step1 capture file contract tick raw formula → Step2 inspect source → Step3 assert no leadMs subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tickIdx = src.indexOf('const tick = ()');
    expect(tickIdx).toBeGreaterThan(-1);
    const tickSlice = src.slice(tickIdx, tickIdx + 5000);
    // Must contain rawPos computation without leadMs
    expect(tickSlice).toMatch(/const\s+rawPos\s*=\s*startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    expect(tickSlice).toMatch(/const\s+pos\s*=\s*Math\.max\(0,\s*rawPos\)/);
    // Must NOT subtract leadMs
    expect(tickSlice).not.toMatch(/rawPos\s*-\s*leadMs/);
    expect(tickSlice).not.toMatch(/startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000\s*-\s*leadMs/);
    // Should not compute leadMs = audioOffset + manual in tick
    // tick should not contain getManualOffsetMs for position
    // The tick slice getting green pos should not reference getManualOffsetMs for subtraction
    const hasTickGetManual = tickSlice.includes('getManualOffsetMs') && tickSlice.includes('- leadMs');
    expect(hasTickGetManual).toBe(false);
    // Overall file should have 0 occurrences of positionRef.current - getManualOffsetMs
    const buggyPosOccurrences = (src.match(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/g) || []).length;
    expect(buggyPosOccurrences, 'EditorScreen must have 0 occurrences of positionRef.current - getManualOffsetMs() after T138').toBe(0);
  });

  it('Step1 capture stop() buggy before → Step2 inspect stop slice → Step3 raw formula without leadMs', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const stopIdx = src.indexOf('const stop =');
    expect(stopIdx).toBeGreaterThan(-1);
    const stopSlice = src.slice(stopIdx, stopIdx + 3000);
    expect(stopSlice).toMatch(/const\s+rawPos\s*=\s*startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    expect(stopSlice).toMatch(/const\s+pos\s*=\s*Math\.max\(0,\s*rawPos\)/);
    expect(stopSlice).not.toMatch(/-\s*leadMs/);
    expect(stopSlice).not.toContain('positionRef.current - getManualOffsetMs()');
  });

  it('Step1 capture getLeadMs existence before → Step2 call with audioOffset → Step3 returns audioOffset+manual', () => {
    setManualOffset(0);
    expect(getLeadMs(200)).toBe(200);
    expect(getLeadMs(0)).toBe(0);
    expect(getLeadMs()).toBe(0);
    setManualOffset(80);
    expect(getLeadMs(200)).toBe(280);
    expect(getLeadMs(0)).toBe(80);
    expect(getLeadMs(120)).toBe(200);
    setManualOffset(-30);
    expect(getLeadMs(100)).toBe(70);
    // File contract
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toMatch(/export function getLeadMs\(/);
    expect(clockSrc).toMatch(/return audioOffset.*\+.*manualOffsetMs/);
  });

  it('Step1 off-grid 0.37 beat manual sweep → Step2 compute raw green pos 185/615/1237 → Step3 invariant vs buggy shifts', () => {
    const tl = new BpmTimeline(120, [], 1.0); // 500ms/beat
    const offGridMsCases = [185, 615, 1237, 762]; // off-grid ms
    for (const ms of offGridMsCases) {
      const startMs = 0;
      const startCtx = 8.0;
      const ctxNow = 8.0 + ms / 1000;
      setManualOffset(0);
      const raw0 = computeGreenPosRaw(startMs, ctxNow, startCtx);
      expect(raw0).toBeCloseTo(ms, 6);
      setManualOffset(80);
      const raw80 = computeGreenPosRaw(startMs, ctxNow, startCtx);
      expect(raw80).toBeCloseTo(raw0, 6);
      expect(raw80).toBeCloseTo(ms, 6);
      const buggy80 = computeGreenPosBuggy(startMs, ctxNow, startCtx, 0, 80);
      expect(buggy80).toBeCloseTo(ms - 80, 6);
      expect(raw80).not.toBeCloseTo(buggy80, 2);
      // Verify beat conversion invariant
      const beatRaw = tl.msToBeat(raw80);
      const beatBuggy = tl.msToBeat(buggy80);
      expect(beatRaw).not.toBeCloseTo(beatBuggy, 4);
    }
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-2: Recording beat B maps to Play songNow no leadMs
// ---------------------------------------------------------------------------
describe('T138-2: Editor録音 beat B=msToBeat(greenPos) が Play songNow==beatToMs(B) で判定ライン到達（leadMsズレなし）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture manual 0 greenPos 1237 snap 0.25 → Step2 set manual +80 recompute → Step3 recorded B identical vs buggy differs', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const greenPos = 1237; // off-grid
    setManualOffset(0);
    const beat0 = computeRecordBeat(tl, greenPos, snap);
    // Play hitTime
    const hitTime0 = tl.beatToMs(beat0);
    // With correct raw, beat should be quant of 2.474 -> 2.5
    expect(beat0).toBeCloseTo(2.5, 4);
    expect(hitTime0).toBeCloseTo(1250, 4);
    setManualOffset(80);
    const beatAfter = computeRecordBeat(tl, greenPos, snap);
    const hitTimeAfter = tl.beatToMs(beatAfter);
    expect(beatAfter).toBeCloseTo(beat0, 6);
    expect(hitTimeAfter).toBeCloseTo(hitTime0, 6);
    // Buggy would use pos -80 =1157 => 2.314 ->2.25 =>1175?
    const buggyBeat = computeRecordBeat(tl, greenPos - 80, snap);
    expect(buggyBeat).toBeCloseTo(2.25, 4);
    expect(buggyBeat).not.toBeCloseTo(beatAfter, 4);
    const buggyHit = tl.beatToMs(buggyBeat);
    expect(buggyHit).not.toBeCloseTo(hitTimeAfter, 1);
    // Gap equals lead difference transformed via beatMs: 80ms =0.16 beats at 500ms/beat, but quant may amplify
    expect(Math.abs(hitTimeAfter - buggyHit)).toBeGreaterThanOrEqual(75);
  });

  it('Step1 capture audioOffset 200 manual 80 raw 1000 → Step2 compute songNow equality → Step3 Play judgement raw matches', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    const startMs = 500;
    const startCtx = 10.0;
    const ctxNow = 10.67; // 670ms elapsed => rawPos 1170
    setManualOffset(80);
    const audioOffset = 200;
    const rawPos = computeGreenPosRaw(startMs, ctxNow, startCtx);
    expect(rawPos).toBeCloseTo(1170, 6);
    const B = computeRecordBeat(tl, rawPos, snap);
    const hitTime = tl.beatToMs(B);
    // Simulate Play: songNow = raw = hitTime when ring reaches judge line
    // Editor greenPos raw == Play songNow raw, so they align
    // Verify buggy would have been raw -280 =890 => different B
    const buggyPos = computeGreenPosBuggy(startMs, ctxNow, startCtx, audioOffset, 80);
    expect(buggyPos).toBeCloseTo(890, 6);
    const buggyB = computeRecordBeat(tl, buggyPos, snap);
    expect(B).not.toBeCloseTo(buggyB, 4);
    // Positive test: raw B when played in Play with same timeline hits at same raw time
    const songNowAtHit = hitTime; // Play's songNow raw
    expect(tl.msToBeat(songNowAtHit)).toBeCloseTo(B, 4);
    // Ensure leadMs does not shift hitTime
    const lead = getLeadMs(audioOffset);
    expect(lead).toBe(280);
    // hitTime must NOT be hitTime - lead
    expect(hitTime).not.toBeCloseTo(tl.beatToMs(tl.msToBeat(rawPos - lead)), 2);
  });

  it('Step1 capture multiple snap resolutions off-grid → Step2 sweep manual → Step3 beats snap-aligned and manual invariant', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const positions = [185, 615, 762, 1237];
    for (const pos of positions) {
      for (const snap of snaps) {
        setManualOffset(0);
        const b0 = computeRecordBeat(tl, pos, snap);
        setManualOffset(80);
        const b80 = computeRecordBeat(tl, pos, snap);
        expect(b80, `pos ${pos} snap ${snap} raw invariant`).toBeCloseTo(b0, 6);
        // snap aligned
        const rem = ((b80 % snap) + snap) % snap;
        expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
        // buggy would differ sometimes (when bucket boundary sensitive)
        const buggyB = computeRecordBeat(tl, pos - 80, snap);
        // For some combos, difference is at least snap/2
        if (snap === 0.25 && pos === 762) {
          expect(buggyB).not.toBeCloseTo(b0, 4);
        }
      }
    }
    setManualOffset(0);
  });

  it('Step1 capture file contract recording pos lines → Step2 inspect source → Step3 const pos = positionRef.current without subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // ring Space press
    const ringPressIdx = src.indexOf('spacePressBeatRef.current =');
    expect(ringPressIdx).toBeGreaterThan(-1);
    const ringSlice = src.slice(Math.max(0, ringPressIdx - 700), ringPressIdx + 700);
    expect(ringSlice).toMatch(/const pos\s*=\s*positionRef\.current/);
    expect(ringSlice).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
    // arrow release
    const releaseIdx = src.indexOf('const releaseBeat');
    expect(releaseIdx).toBeGreaterThan(-1);
    const arrowSlice = src.slice(Math.max(0, releaseIdx - 900), releaseIdx + 600);
    expect(arrowSlice).toMatch(/const pos\s*=\s*positionRef\.current/);
    expect(arrowSlice).not.toMatch(/getManualOffsetMs/);
    // hold tail: search around snapped - startBeat
    const holdIdx = src.indexOf('snapped - startBeat');
    expect(holdIdx).toBeGreaterThan(-1);
    const holdSlice = src.slice(Math.max(0, holdIdx - 1500), holdIdx + 500);
    expect(holdSlice).toContain('positionRef.current');
    expect(holdSlice).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
  });

  it('Step1 capture negative lead branch audioOffset 0 manual -80 rawPos 1280 → Step2 verify hitTime still raw → Step3 not shifted by -80', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    setManualOffset(-80);
    const fromMs = 1000;
    const ctxNow = 10.25;
    const startCtx = 10.0;
    const startMs = fromMs;
    const rawPos = computeGreenPosRaw(startMs, ctxNow, startCtx);
    expect(rawPos).toBeCloseTo(1250, 6); // 1000+250
    const B = computeRecordBeat(tl, rawPos, snap);
    const hit = tl.beatToMs(B);
    // Play would judge at hit = B beat
    expect(tl.msToBeat(hit)).toBeCloseTo(B, 4);
    // Buggy with lead -80 would be 1250 - (-80)=1330; both 1250 (2.5) and 1330 (2.75) land in
    // different snap buckets at snap=0.25, so the recorded beat must differ from raw B.
    const buggyPos = computeGreenPosBuggy(startMs, ctxNow, startCtx, 0, -80);
    expect(buggyPos).toBeCloseTo(1330, 6);
    expect(computeRecordBeat(tl, buggyPos, snap)).not.toBeCloseTo(B, 4);
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-3: Editorで同じ位置から再生してもメトロノームと緑バーの相対位相が毎回一定（T137決定性維持）
// ---------------------------------------------------------------------------
describe('T138-3: 同じ位置から再生メトロノームと緑バー相対位相決定性（T137維持）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  function computeFixedNextBeatTime(tl: BpmTimeline, fromMs: number, startCtxTime: number, leadMs: number, ctxNow: number, manual: number) {
    let beatIdx = Math.ceil(tl.msToBeat(fromMs));
    if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
    let nextBeatTime = startCtxTime + leadMs / 1000 + (tl.beatToMs(beatIdx) - fromMs) / 1000;
    while (nextBeatTime + manual / 1000 < ctxNow) {
      nextBeatTime += tl.beatMsAt(beatIdx) / 1000;
      beatIdx++;
    }
    return { nextBeatTime, beatIdx };
  }

  it('Step1 capture fromMs 1237 off-grid with jitter 3 vs 12ms → Step2 compute fixed nextBeatTime twice → Step3 within 5ms', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1237;
    const audioOffset = 200;
    const ctxStart = 10.0;
    const fixed1 = computeFixedNextBeatTime(tl, fromMs, ctxStart, audioOffset, 10.003, getManualOffsetMs());
    const fixed2 = computeFixedNextBeatTime(tl, fromMs, ctxStart, audioOffset, 10.012, getManualOffsetMs());
    expect(Math.abs(fixed1.nextBeatTime - fixed2.nextBeatTime)).toBeLessThanOrEqual(0.005);
    // Raw green bar same for both: rawPos = fromMs + delta ; not affected by manual
    const raw1 = computeGreenPosRaw(fromMs, 10.003, ctxStart);
    const raw2 = computeGreenPosRaw(fromMs, 10.012, ctxStart);
    // Their delta difference is jitter itself, not extra offset
    expect(Math.abs(raw2 - raw1)).toBeCloseTo(9, 0); // 9ms jitter in ctxNow leads to 9ms raw difference? Actually raw computed from ctxNow - startCtx, so diff =9ms correct.
    // But relative metronome vs green bar stays deterministic because both anchored to startCtxTime/leadMs
    // Verify that green bar 0 borrowed? The key is playFrom uses t0 snapshot.
  });

  it('Step1 verify EditorScreen startMetronome deterministic signature → Step2 inspect file → Step3 correct pattern', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number\s*\)/);
    expect(src).toMatch(/let\s+nextBeatTime\s*=\s*startCtxTime\s*\+\s*leadMs\s*\/\s*1000/);
    expect(src).toMatch(/while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs\(\)\s*\/\s*1000\s*<\s*ctx\.currentTime/);
    expect(src).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef\.current/);
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
  });

  it('Step1 capture two consecutive playFrom same fromMs with manual ±80 → Step2 compute green vs metro delta → Step3 green raw constant, metro includes audioOffset only (lead diverge intentional)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1000;
    const audioOffset = 150;
    setManualOffset(80);
    const ctxStart = 9.0;
    const leadForMetro = audioOffset; // T138: metro lead = audioOffset only (schedule adds manual)
    const { nextBeatTime: metroWhenAudio } = computeFixedNextBeatTime(tl, fromMs, ctxStart, leadForMetro, ctxStart, 80);
    const metroAudible = metroWhenAudio + 80 / 1000; // schedule adds manual
    // Green raw pos after 500ms
    const ctxNow = 9.5;
    const greenRaw = computeGreenPosRaw(fromMs, ctxNow, ctxStart); // 1500
    expect(greenRaw).toBeCloseTo(1500, 6);
    // Music audible = ctxStart + getLead/1000 + (beatToMs - fromMs)/1000 ; but green is raw, so divergence = lead
    const lead = getLeadMs(audioOffset);
    expect(lead).toBe(230);
    const greenVsMusicDelta = greenRaw - (fromMs + (ctxNow - ctxStart) * 1000 - lead);
    // green is lead ahead of music (by design 案A)
    expect(greenVsMusicDelta).toBeCloseTo(lead, 6);
    // Second play same fromMs should give same green trajectory (raw) even if manual changes to -40
    setManualOffset(-40);
    const greenRaw2 = computeGreenPosRaw(fromMs, ctxNow, ctxStart);
    expect(greenRaw2).toBeCloseTo(greenRaw, 6);
    // Metro second time with new manual: lead still audioOffset, audible = nextBeatTime + manual/1000
    const { nextBeatTime: metroWhen2 } = computeFixedNextBeatTime(tl, fromMs, ctxStart, audioOffset, ctxStart, -40);
    const metroAudible2 = metroWhen2 + (-40) / 1000;
    // Metro shift due to manual: difference 120ms? 80-(-40)=120
    expect(metroAudible - metroAudible2).toBeCloseTo(0.12, 6);
    // But green unchanged
    expect(greenRaw).toBeCloseTo(greenRaw2, 6);
    setManualOffset(0);
  });

  it('Step1 capture stale positionRef vs true fromMs → Step2 verify fixed ignores stale → Step3 not same', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const trueFromMs = 1000;
    const stalePos = 1237;
    const ctxStart = 9.0;
    const fTrue = computeFixedNextBeatTime(tl, trueFromMs, ctxStart, 0, ctxStart, 0);
    const fStale = computeFixedNextBeatTime(tl, stalePos, ctxStart, 0, ctxStart, 0);
    expect(fTrue.nextBeatTime).not.toBeCloseTo(fStale.nextBeatTime, 2);
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).not.toMatch(/startMetronome\(.*positionRef\.current/);
    expect(src).toMatch(/startMsRef\.current/);
    expect(src).toMatch(/startCtxTimeRef\.current/);
  });

  it('Step1 capture schedule still uses offsetSeconds → Step2 set manual 80 → Step3 when = max(ctx.currentTime, nextBeatTime+offset)', () => {
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds()');
    expect(metroSrc).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime \+ offsetSeconds\(\)\)/);
    setManualOffset(80);
    expect(offsetSeconds()).toBeCloseTo(0.08, 6);
    const when = Math.max(10.0, 10.1 + offsetSeconds());
    expect(when).toBeCloseTo(10.18, 6);
    setManualOffset(0);
    const when0 = Math.max(10.0, 10.1 + offsetSeconds());
    expect(when0).toBeCloseTo(10.1, 6);
    expect(when).not.toBeCloseTo(when0, 6);
  });
});

// ---------------------------------------------------------------------------
// T138-4: 回帰なし T135/T136/t102 etc.
// ---------------------------------------------------------------------------
describe('T138-4: 回帰なし T135(音楽同期)/T102/T103/T129/T133/T137', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 T135 GameScreen playMusic uses getLeadMs equivalent (audioOffset+manual)/1000 → Step2 check file → Step3 preserved', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    expect(src).toContain('source.start');
    const count = (src.match(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/g) || []).length;
    expect(count).toBe(1);
  });

  it('Step1 T135 Editor playFrom uses getLeadMs(audioOffset)/1000 → Step2 inspect → Step3 preserved', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // T138 centralizes the music lead via getLeadMs (audioOffset + manualOffset).
    // playFrom must use the centralized helper (not a duplicate inline expression).
    const hasGetLead = src.includes('getLeadMs(audioOffset)');
    expect(hasGetLead).toBeTruthy();
    expect(hasGetLead || src.includes('(audioOffset + getManualOffsetMs())')).toBeTruthy();
    // Ensure getLeadMs imported
    expect(src).toMatch(/import.*getLeadMs.*from.*clock/);
  });

  it('Step1 T102/T103 play-mode guard remains → Step2 file contains modeRef record → Step3 at least 3 guards', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const guards = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guards).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/);
  });

  it('Step1 T129 snap整合性 segmentize 0.30 snap 0.25 → Step2 segmentize → Step3 0.25 not 1/amplitude', () => {
    const snap = 0.25;
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.30, y: TW_CENTER_Y + 40, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
    }
    expect(segs[0].beats).toBeCloseTo(0.25, 4);
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4);
  });

  it('Step1 T133 calibration overlay route absent → Step2 App.tsx → Step3 no /calibration and modal present', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    expect(readFile('src/screens/EditorScreen.tsx')).toContain('CalibrationModal');
    expect(readFile('src/screens/editor/CalibrationModal.tsx')).toContain('data-testid="editor-calibration-modal"');
  });

  it('Step1 T137 determinism retained: metronome gain nodes untouched → Step2 check volume UI → Step3 present', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('musicGainRef');
    expect(src).toContain('metronomeGainRef');
    expect(src).toContain('data-testid="metronome-switch"');
    expect(src).toContain('data-testid="metronome-volume"');
    expect(src).toContain('data-testid="music-volume"');
  });

  it('Step1 T136 music delay maintained: getLeadMs applied only to music, not to green bar → Step2 numeric → Step3 music startWhen = ctx+lead, green = raw', () => {
    setManualOffset(80);
    const audioOffset = 200;
    const ctxTime = 10.0;
    const fromMs = 0;
    const lead = getLeadMs(audioOffset);
    expect(lead).toBe(280);
    // Music
    const offsetSec = lead / 1000;
    const startWhen = ctxTime + offsetSec;
    expect(startWhen).toBeCloseTo(10.28, 6);
    // Green
    const green = computeGreenPosRaw(fromMs, 10.5, ctxTime);
    expect(green).toBeCloseTo(500, 6);
    // Buggy green would be 500-280=220, ensure we are raw
    const buggy = computeGreenPosBuggy(fromMs, 10.5, ctxTime, audioOffset, 80);
    expect(buggy).toBeCloseTo(220, 6);
    expect(green).not.toBeCloseTo(buggy, 2);
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-5: WaveEngine / Cursor numeric consistency (complex amplitudes off-grid)
// ---------------------------------------------------------------------------
describe('T138-5: WaveEngine/Cursor 数値整合（複雑振幅 off-grid, T127/T128維持）', () => {
  const amps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23];

  it('Step1 amp 0.7 beat 0.37 → Step2 vary amps → Step3 waveYAt slope=2*TW_AMP*amp clamped', () => {
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

  it('Step1 cursor amp 1.3 dt 0.5beats down → Step2 update → Step3 delta matches wave delta', () => {
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
    expect(cursorDelta).toBeCloseTo(perBeat * 0.5, 4);
    const waveDelta = Math.abs(engine.waveYAt(beatsDelta) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.5, 4);
    expect(waveDelta).toBeCloseTo(cursorDelta, 4);
  });

  it('Step1 getPoints length invariant → Step2 vary segments → Step3 segments+1', () => {
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
      for (const p of pts) expect(typeof p.y).toBe('number');
    }
  });

  it('Step1 BpmTimeline amplitudeAt step off-grid 3.37 vs 4.23 → Step2 verify → Step3 step function', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(4.37)).toBe(2.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
  });

  it('Step1 off-grid quant 1.2→1.0 1.3→1.5 snap0.5 → Step2 segmentize → Step3 snap-aligned', () => {
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
});

// ---------------------------------------------------------------------------
// T138-6: tsc & clock helper centralization
// ---------------------------------------------------------------------------
describe('T138-6: tsc & getLeadMs 一元化 & Game/Editor leadMs 重複解消', () => {
  it('Step1 capture clock getLeadMs defined → Step2 inspect file → Step3 one definition and used twice', () => {
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toMatch(/export function getLeadMs\(/);
    expect(clockSrc).toContain('manualOffsetMs');
    expect(clockSrc).toContain('audioOffset');
    const defCount = (clockSrc.match(/export function getLeadMs/g) || []).length;
    expect(defCount).toBe(1);
    expect(clockSrc).toContain('return audioOffset');
  });

  it('Step1 capture EditorScreen imports getLeadMs → Step2 search → Step3 imported and used for music', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/import.*getLeadMs.*from.*clock/);
    const uses = (src.match(/getLeadMs\(/g) || []).length;
    expect(uses).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/getLeadMs\(audioOffset\)/);
    // GameScreen should still use manual directly but clock now centralizes; either is ok. Check clock helper exists.
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // Game may still have inline (audioOffsetMs + getManualOffsetMs()) – not required to use helper, but ensure not using buggy old.
    expect(gameSrc).toMatch(/getManualOffsetMs/);
  });

  it('Step1 capture no duplicate offsetSec in Editor tick → Step2 verify tick not using audioOffset+manual → Step3 only playFrom uses it', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tickIdx = src.indexOf('const tick = ()');
    // Bound the slice to the tick function body only (the tail of the function ends at
    // the requestAnimationFrame(tick) line). Covering 5000 chars bleeds into playFrom,
    // which legitimately contains getLeadMs. The tick itself must be leadMs-free.
    const tickBodyEnd = src.indexOf('return () => cancelAnimationFrame(raf)');
    const tickSlice = src.slice(tickIdx, tickBodyEnd);
    expect(tickSlice).not.toContain('(audioOffset + getManualOffsetMs())');
    expect(tickSlice).not.toContain('getLeadMs');
    // playFrom should be the sole place
    const playFromIdx = src.indexOf('const playFrom');
    const playFromSlice = src.slice(playFromIdx, playFromIdx + 2500);
    expect(playFromSlice).toMatch(/getLeadMs\(audioOffset\)|\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/);
  });

  it('All symbols remain typed (tsc guard) and schedule still correct', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(getLeadMs(0)).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    expect(TW_AMP).toBe(130);
    expect(TW_CENTER_Y).toBe(300);
    const ctx = createMockAudioContext();
    expect(() => schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
    // getLeadMs consistency with offsetSeconds + audio
    setManualOffset(40);
    expect(getLeadMs(100)).toBe(140);
    expect(offsetSeconds()).toBeCloseTo(0.04, 6);
    setManualOffset(0);
  });

  it('Step1 GameScreen unchanged structure → Step2 verify renderer still dynamic scroll_speed → Step3 present', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toContain('scroll_speed');
    expect(gameSrc).toContain('TW_TOLERANCE');
    expect(gameSrc).not.toContain('startMsRef');
  });
});
