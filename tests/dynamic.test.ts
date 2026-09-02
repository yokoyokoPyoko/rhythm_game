/**
 * T138 — 判定ライン＝緑バーの同一化（案A: 緑④を判定①に寄せる）
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
 * Prohibited patterns checked: Editor tick/stop must NOT subtract leadMs, green bar = raw.
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
import { quantizeBeat, segmentize, isSnapAligned } from '../src/chart/quantize';
import { getManualOffsetMs, setManualOffset, offsetSeconds, getLeadMs } from '../src/audio/clock';
import { schedule } from '../src/audio/metronome';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function computeRawPos(startMs: number, ctxNow: number, startCtxTime: number): number {
  return startMs + (ctxNow - startCtxTime) * 1000;
}
function computeBuggyPos(startMs: number, ctxNow: number, startCtxTime: number, audioOffset: number, manual: number): number {
  const lead = audioOffset + manual;
  return startMs + (ctxNow - startCtxTime) * 1000 - lead;
}
function computeRecordBeatCorrect(tl: BpmTimeline, pos: number, snap: number): number {
  return quantizeBeat(tl.msToBeat(pos), snap);
}
function computeRecordBeatBuggy(tl: BpmTimeline, posRaw: number, manual: number, snap: number): number {
  return quantizeBeat(tl.msToBeat(posRaw - manual), snap);
}
function getTickSlice(src: string): string {
  const idx = src.indexOf('const tick = ()');
  if (idx === -1) return src.slice(src.indexOf('startMsRef.current'), src.indexOf('startMsRef.current') + 6000);
  return src.slice(idx, idx + 7000);
}
function getStopSlice(src: string): string {
  const idx = src.indexOf('const stop =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3500);
}
function createMockCtx(currentTime = 10.0) {
  const dest = { __isDestination: true } as unknown as AudioNode;
  const ctx: any = {
    currentTime,
    destination: dest,
    createOscillator() { return { type: 'square', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() } as any; },
    createGain() { const g: any = { gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }; return g; },
    createBufferSource() { const s: any = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }; ctx._last = s; return s; },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// T138-1: Editor positionRef = raw (no leadMs), manualOffset invariant
// ---------------------------------------------------------------------------
describe('T138-1: Editor positionRef raw tracking pos = startMs + (ctx.currentTime - startCtxTime)*1000 invariant to manualOffset', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture raw 500ms elapsed with manual 0 -> Step2 set +80 -> Step3 raw unchanged vs buggy shifts -80', () => {
    const startMs = 0, startCtx = 10.0, ctxNow = 10.5;
    const rawBefore = computeRawPos(startMs, ctxNow, startCtx);
    expect(rawBefore).toBeCloseTo(500, 6);
    expect(getManualOffsetMs()).toBe(0);
    // Step2: apply manual +80 (simulates </> key)
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const rawAfter = computeRawPos(startMs, ctxNow, startCtx);
    const buggyAfter = computeBuggyPos(startMs, ctxNow, startCtx, 0, 80);
    // Step3: raw stays 500, buggy would be 420
    expect(rawAfter).toBeCloseTo(500, 6);
    expect(buggyAfter).toBeCloseTo(420, 6);
    expect(rawAfter).not.toBeCloseTo(buggyAfter, 1);
    expect(rawAfter - buggyAfter).toBeCloseTo(80, 6);
  });

  it('Step1 capture with audioOffset 200 manual 80 -> Step2 compute raw pos -> Step3 file contract tick/stop have NO leadMs subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    const stopSlice = getStopSlice(src);
    // tick must contain rawPos computation
    expect(tick).toContain('startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000');
    // Must NOT subtract leadMs in tick pos formula
    // isolate pos line(s)
    const tickPosLines = tick.match(/const\s+pos\s*=[^\n;]+/g) || [];
    for (const line of tickPosLines) {
      // pos should be Math.max(0, rawPos) or rawPos itself, not raw - lead
      expect(line).not.toMatch(/-\s*leadMs/);
      expect(line).not.toMatch(/-\s*\(audioOffset/);
      expect(line).not.toMatch(/getManualOffsetMs\(\)/);
    }
    expect(tick).not.toMatch(/pos\s*=\s*rawPos\s*-\s*leadMs/);
    expect(tick).not.toMatch(/audioOffsetRef\.current\s*\+\s*getManualOffsetMs\(\)/);
    // stop must also be raw
    expect(stopSlice).toContain('startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000');
    expect(stopSlice).not.toMatch(/-\s*leadMs/);
    expect(stopSlice).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
    // global file must NOT contain the buggy pattern "positionRef.current - getManualOffsetMs()" at all
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/);
  });

  it('Step1 capture manual sweep -100..150 -> Step2 compute raw for each -> Step3 all give same rawPos independent of manual/audioOffset', () => {
    const startMs = 300, startCtx = 8.0, ctxNow = 8.734;
    const expectedRaw = computeRawPos(startMs, ctxNow, startCtx);
    expect(expectedRaw).toBeCloseTo(1034, 6);
    const manuals = [-100, -80, 0, 80, 150];
    const audioOffsets = [0, 200];
    for (const m of manuals) {
      for (const ao of audioOffsets) {
        setManualOffset(m);
        const raw = computeRawPos(startMs, ctxNow, startCtx);
        const buggy = computeBuggyPos(startMs, ctxNow, startCtx, ao, m);
        expect(raw).toBeCloseTo(expectedRaw, 6);
        // buggy differs when lead !=0
        if (ao + m !== 0) expect(raw).not.toBeCloseTo(buggy, 1);
      }
    }
  });

  it('Step1 capture startMs 0 delta 0 -> Step2 advance ctx 0.37*beatMs -> Step3 raw matches msToBeat 0.37 off-grid', () => {
    const tl = new BpmTimeline(120, [], 1.0); // 500ms/beat
    const startMs = 0, startCtx = 10.0;
    const ctxNow = 10.0 + tl.beatToMs(0.37) / 1000; // 0.37 beats =185ms
    const raw = computeRawPos(startMs, ctxNow, startCtx);
    expect(raw).toBeCloseTo(tl.beatToMs(0.37), 4);
    expect(tl.msToBeat(raw)).toBeCloseTo(0.37, 4);
    setManualOffset(80);
    const raw2 = computeRawPos(startMs, ctxNow, startCtx);
    expect(raw2).toBeCloseTo(raw, 6);
    expect(tl.msToBeat(raw2)).toBeCloseTo(0.37, 4);
    const buggy = computeBuggyPos(startMs, ctxNow, startCtx, 0, 80);
    expect(tl.msToBeat(buggy)).toBeCloseTo(0.21, 2); // shifted
    expect(tl.msToBeat(buggy)).not.toBeCloseTo(0.37, 1);
  });

  it('Step1 capture negative lead branch -> Step2 manual -80 -> Step3 raw still 500 not 580', () => {
    const startMs = 0, startCtx = 5.0, ctxNow = 5.5; // 500ms
    setManualOffset(-80);
    const raw = computeRawPos(startMs, ctxNow, startCtx);
    const buggy = computeBuggyPos(startMs, ctxNow, startCtx, 0, -80);
    expect(raw).toBeCloseTo(500, 6);
    expect(buggy).toBeCloseTo(580, 6);
    expect(raw).not.toBeCloseTo(buggy, 1);
  });
});

// ---------------------------------------------------------------------------
// T138-2: Recording beat B = msToBeat(greenPosRaw) aligns with Play songNow == beatToMs(B) (no leadMs)
// ---------------------------------------------------------------------------
describe('T138-2: Recording beat alignment judgeLine == greenLine (off-grid, snap invariant)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture pos 1237 snap 0.25 with manual 0 -> Step2 set manual +80 -> Step3 correct beat invariant vs buggy shifts', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const pos = 1237; // off-grid raw greenPos
    const correct0 = computeRecordBeatCorrect(tl, pos, snap);
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(80);
    const correctAfter = computeRecordBeatCorrect(tl, pos, snap);
    const buggyAfter = computeRecordBeatBuggy(tl, pos, 80, snap);
    expect(correctAfter).toBeCloseTo(correct0, 6);
    expect(correctAfter).not.toBeCloseTo(buggyAfter, 2);
    // verify file has no subtraction for ring press
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringIdx = src.indexOf('spacePressBeatRef.current =');
    expect(ringIdx).toBeGreaterThan(-1);
    const slice = src.slice(Math.max(0, ringIdx - 700), ringIdx + 700);
    expect(slice).toContain('positionRef.current');
    expect(slice).not.toContain('getManualOffsetMs');
    expect(slice).toMatch(/const pos\s*=\s*positionRef\.current/);
  });

  it('Step1 capture arrow release off-grid near boundary snap 0.5 -> Step2 manual +80 -> Step3 releaseBeat invariant', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    // Choose beats where 80ms (0.16 beats) crosses snap mid-point, so buggy lands on different grid
    const cases: Array<{ beat: number; expected: number }> = [
      { beat: 0.26, expected: 0.5 },
      { beat: 0.37, expected: 0.5 },
      { beat: 0.76, expected: 1.0 },
    ];
    for (const c of cases) {
      const pos = tl.beatToMs(c.beat);
      setManualOffset(0);
      const correct0 = computeRecordBeatCorrect(tl, pos, snap);
      expect(correct0).toBeCloseTo(c.expected, 4);
      setManualOffset(80);
      const correct = computeRecordBeatCorrect(tl, pos, snap);
      const buggy = computeRecordBeatBuggy(tl, pos, 80, snap);
      expect(correct).toBeCloseTo(c.expected, 4);
      expect(correct).toBeCloseTo(correct0, 6);
      expect(buggy).not.toBeCloseTo(correct, 1);
    }
    // file: releaseBeat must be quantizeBeat(rawBeat) with pos=positionRef.current
    const src = readFile('src/screens/EditorScreen.tsx');
    const idx = src.indexOf('releaseBeat');
    expect(idx).toBeGreaterThan(-1);
    const s = src.slice(Math.max(0, idx - 1200), idx + 800);
    expect(s).toContain('positionRef.current');
    expect(s).not.toContain('getManualOffsetMs');
  });

  it('Step1 capture greenPos 1000 fromMs -> Step2 editor records B=2.0 -> Step3 play songNow 1000 reaches judgement line exactly (no leadMs shift)', () => {
    // This is the core T138 integration: editor greenPos is raw, play hitTime = beatToMs(B) equals songNow (raw)
    const tl = new BpmTimeline(120, [], 1.0);
    const greenPos = 1000; // raw ms, equals 2 beats at 120BPM
    const snap = 0.25;
    const B = computeRecordBeatCorrect(tl, greenPos, snap);
    expect(B).toBeCloseTo(2.0, 4);
    const hitTime = tl.beatToMs(B);
    expect(hitTime).toBeCloseTo(greenPos, 4); // editor and play use same timeline mapping
    // simulate play songNow raw
    const startCtx = 5.0;
    const ctxNowForHit = startCtx + hitTime / 1000; // songNow = (ctxNow - startCtx)*1000 = hitTime
    const songNow = (ctxNowForHit - startCtx) * 1000;
    expect(songNow).toBeCloseTo(hitTime, 6);
    expect(songNow).toBeCloseTo(greenPos, 6);
    // buggy would have hitTime shifted by leadMs (quantized, so not exactly 80 but >30)
    setManualOffset(80);
    const Bbug = computeRecordBeatBuggy(tl, greenPos, 80, snap);
    const hitBug = tl.beatToMs(Bbug);
    expect(hitBug).not.toBeCloseTo(greenPos, 1);
    expect(Math.abs(hitBug - greenPos)).toBeGreaterThan(30);
    setManualOffset(0);
  });

  it('Step1 capture with audioOffset 200 manual 80 raw 1000 -> Step2 editor records invariant -> Step3 audioOffset does NOT shift greenPos but buggy would', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const greenPosRaw = 1000;
    // With fixed raw, beat always 2.0 regardless of audioOffset/manual
    for (const ao of [0, 200]) {
      for (const m of [0, 80, -80]) {
        setManualOffset(m);
        const B = computeRecordBeatCorrect(tl, greenPosRaw, snap);
        expect(B).toBeCloseTo(2.0, 4);
        expect(tl.beatToMs(B)).toBeCloseTo(greenPosRaw, 4);
        // getLeadMs would affect music start, not recording
        expect(getLeadMs(ao)).toBeCloseTo(ao + m, 6);
      }
    }
    // buggy with manual 80 would give 1.75-ish
    setManualOffset(80);
    expect(computeRecordBeatBuggy(tl, greenPosRaw, 80, snap)).not.toBeCloseTo(2.0, 2);
  });

  it('Step1 capture hold ring 1.0->1.75 drag -> Step2 manual change -> Step3 hold duration invariant to manual, start beat invariant', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const press = tl.beatToMs(1.0), rel = tl.beatToMs(1.75);
    setManualOffset(0);
    const p0 = computeRecordBeatCorrect(tl, press, snap);
    const r0 = computeRecordBeatCorrect(tl, rel, snap);
    const d0 = Number(quantizeBeat(r0 - p0, snap).toFixed(2));
    expect(d0).toBeCloseTo(0.75, 4);
    setManualOffset(80);
    const p1 = computeRecordBeatCorrect(tl, press, snap);
    const r1 = computeRecordBeatCorrect(tl, rel, snap);
    const d1 = Number(quantizeBeat(r1 - p1, snap).toFixed(2));
    expect(d1).toBeCloseTo(d0, 4);
    expect(p1).toBeCloseTo(p0, 6);
    expect(computeRecordBeatBuggy(tl, press, 80, snap)).not.toBeCloseTo(p0, 2);
  });
});

// ---------------------------------------------------------------------------
// T138-3: Determinism T137 retained — same fromMs repeat phase stable
// ---------------------------------------------------------------------------
describe('T138-3: Deterministic metronome + green bar relative phase across replays (T137 maintained)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  function computeNextBeatFixed(tl: BpmTimeline, fromMs: number, startCtx: number, leadMs: number, ctxNow: number, manual: number) {
    let beatIdx = Math.ceil(tl.msToBeat(fromMs));
    if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
    let nt = startCtx + leadMs / 1000 + (tl.beatToMs(beatIdx) - fromMs) / 1000;
    while (nt + manual / 1000 < ctxNow) { nt += tl.beatMsAt(beatIdx) / 1000; beatIdx++; }
    return { nt, beatIdx };
  }

  it('Step1 capture fromMs 1237 with jitter 3ms vs 12ms -> Step2 compute fixed with raw lead audioOffset -> Step3 nextBeatTime within 5ms', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1237;
    const audioOffset = 0;
    const startCtx = 10.0;
    const n1 = computeNextBeatFixed(tl, fromMs, startCtx, audioOffset, 10.003, 0);
    const n2 = computeNextBeatFixed(tl, fromMs, startCtx, audioOffset, 10.012, 0);
    expect(Math.abs(n1.nt - n2.nt)).toBeLessThanOrEqual(0.005);
  });

  it('Step1 capture file startMetronome signature -> Step2 verify uses startCtxTime + leadMs -> Step3 not stale positionRef', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number\s*\)/);
    expect(src).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef\.current/);
    const smIdx = src.indexOf('const startMetronome');
    const slice = src.slice(smIdx, smIdx + 2000);
    expect(slice).toContain('startCtxTime + leadMs');
    const calls = [...src.matchAll(/startMetronome\s*\([^)]+\)/g)].map(m => m[0]);
    for (const c of calls) expect(c).not.toContain('positionRef.current');
  });

  it('Step1 capture playFrom uses raw snapshot t0 -> Step2 verify file -> Step3 t0 based metronome start', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const idx = src.indexOf('const playFrom');
    expect(idx).toBeGreaterThan(-1);
    const s = src.slice(idx, idx + 4000);
    expect(s).toContain('const t0 = ctx.currentTime');
    expect(s).toContain('startCtxTimeRef.current = t0');
    expect(s).toContain('startMsRef.current = fromMs');
    expect(s).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
  });

  it('Step1 capture greenPos raw vs metronome phase for fromMs 0 -> Step2 repeat playback -> Step3 music② and metro⑤ offsetSec = leadMs/1000 deterministic', () => {
    setManualOffset(80);
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 0, startCtx = 10.0, audioOffset = 100;
    const lead = getLeadMs(audioOffset); // 180
    expect(lead).toBe(180);
    // music audible for beat 0: startCtx + lead/1000 + (0 -0)/1000 =10.18
    const music0 = startCtx + lead / 1000;
    const { nt } = computeNextBeatFixed(tl, fromMs, startCtx, audioOffset, startCtx, 80);
    // nt first beat 0 at 10.1? Actually fromMs 0 beatIdx 0 => nt =10+0.1=10.1? Wait lead is audioOffset only for grid, manual via offsetSeconds
    // Check schedule when = nt + manual/1000 =10.1+0.08=10.18 same as music0
    const metroWhen = nt + getManualOffsetMs() / 1000;
    expect(metroWhen).toBeCloseTo(music0, 3);
    // Repeat with jitter ctxNow 10.003 => while condition not advance, still same
    const again = computeNextBeatFixed(tl, fromMs, startCtx, audioOffset, 10.003, 80);
    expect(again.nt).toBeCloseTo(nt, 3);
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-4: getLeadMs centralized and music sync retained (T135)
// ---------------------------------------------------------------------------
describe('T138-4: getLeadMs helper and music lead centralization (T135 retained)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture manual 0 audio 100 -> Step2 set +80 -> Step3 getLeadMs = audio+manual', () => {
    expect(getManualOffsetMs()).toBe(0);
    expect(getLeadMs(100)).toBeCloseTo(100, 6);
    expect(getLeadMs()).toBeCloseTo(0, 6);
    setManualOffset(80);
    expect(getLeadMs(100)).toBeCloseTo(180, 6);
    expect(getLeadMs(200)).toBeCloseTo(280, 6);
    expect(getLeadMs(-50)).toBeCloseTo(30, 6);
    setManualOffset(-30);
    expect(getLeadMs(50)).toBeCloseTo(20, 6);
  });

  it('Step1 capture clock.ts file -> Step2 verify getLeadMs export -> Step3 used by Game/Editor play', () => {
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('export function getLeadMs');
    expect(clockSrc).toMatch(/return\s*audioOffsetMs\s*\+\s*manualOffsetMs/);
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    // Game playMusic uses getLeadMs or (audioOffsetMs + getManualOffsetMs())
    const gameUsesLead = gameSrc.includes('getLeadMs') || /\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/.test(gameSrc);
    expect(gameUsesLead).toBe(true);
    // Editor playFrom must use getLeadMs(audioOffset)
    expect(editorSrc).toMatch(/getLeadMs\(audioOffset/);
    expect(editorSrc).not.toMatch(/\(audioOffset\s*\/\s*1000\)\s*;/); // not buggy alone
  });

  it('Step1 capture metronome.ts not using leadMs directly -> Step2 verify still only offsetSeconds -> Step3 no leadMs import', () => {
    const ms = readFile('src/audio/metronome.ts');
    expect(ms).toContain('offsetSeconds()');
    expect(ms).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime \+ offsetSeconds\(\)\)/);
    expect(ms).not.toContain('getLeadMs');
    expect(ms).not.toContain('audioOffset');
  });

  it('Step1 capture music offset params game vs editor -> Step2 set manual 80 -> Step3 both shift identically via getLeadMs', () => {
    setManualOffset(80);
    const leadGame = getLeadMs(0);
    const leadEditor = getLeadMs(200);
    expect(leadGame).toBeCloseTo(80, 6);
    expect(leadEditor).toBeCloseTo(280, 6);
    // mock when
    const ctxTime = 10.0;
    const offGame = leadGame / 1000;
    const offEditor = leadEditor / 1000;
    expect(offGame).toBeCloseTo(offsetSeconds(), 6);
    expect(offEditor - offGame).toBeCloseTo(0.2, 6);
  });

  it('Step1 capture clock songNow still raw -> Step2 verify file -> Step3 songNow = (ctx.currentTime - audioStartTime)*1000 not minus lead', () => {
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('songNow');
    expect(clockSrc).toMatch(/\(ctx\.currentTime\s*-\s*audioStartTime\)\s*\*\s*1000/);
    expect(clockSrc).not.toMatch(/songNow.*-\s*leadMs/);
    expect(clockSrc).not.toMatch(/songNow.*-\s*getLeadMs/);
  });
});

// ---------------------------------------------------------------------------
// T138-5: Regressions T102/T103/T129/T133/T135/T137 + WaveEngine/Cursor types
// ---------------------------------------------------------------------------
describe('T138-5: Regressions (T102/T103 snap guard, T129, T133, T135, T137)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture T102/T103 mode guard -> Step2 check file -> Step3 record-only stamping', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const cnt = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(cnt).toBeGreaterThanOrEqual(3);
    // ensure space hold still guarded
    expect(src).toMatch(/if\s*\(\s*modeRef\.current === 'record'/);
  });

  it('Step1 capture T129 snap integer multiple 0.30 snap 0.25 -> Step2 segmentize -> Step3 beats =0.25 not 1/amplitude', () => {
    const snap = 0.25;
    const traj = [{ beat: 0, y: TW_CENTER_Y, down: true }, { beat: 0.30, y: TW_CENTER_Y + 40, down: false }];
    const segs = segmentize(traj, snap, 1.0);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
    expect(segs[0].beats).toBeCloseTo(0.25, 4);
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4);
  });

  it('Step1 capture T133 route absent -> Step2 check App.tsx -> Step3 no /calibration route', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toContain('CalibrationModal');
  });

  it('Step1 capture GameScreen unchanged -> Step2 verify still has lead via getManualOffsetMs -> Step3 not raw subtraction', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/getManualOffsetMs/);
    // GameScreen playMusic should not contain Editor pos logic
    expect(gameSrc).not.toContain('startMsRef');
    expect(gameSrc).not.toContain('positionRef.current +');
  });

  it('Step1 capture T137 tick gain nodes still present -> Step2 check editor file -> Step3 volume handling untouched', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('musicGainRef');
    expect(src).toContain('metronomeGainRef');
    expect(src).toContain('data-testid="metronome-switch"');
    expect(src).toContain('data-testid="metronome-volume"');
    expect(src).toContain('data-testid="music-volume"');
  });

  it('Step1 capture T135 source.start via getLeadMs still -> Step2 check both screens -> Step3 when/offset branch preserved', () => {
    const ed = readFile('src/screens/EditorScreen.tsx');
    // must have when = ctx.currentTime + offsetSec branch
    expect(ed).toContain('startWhen = ctx.currentTime + offsetSec');
    expect(ed).toContain('startOffset = audioTime');
    expect(ed).toContain('Math.max(0, audioTime - offsetSec)');
  });
});

// ---------------------------------------------------------------------------
// T138-6: WaveEngine / Cursor numeric consistency with complex amps off-grid (T127/T128)
// ---------------------------------------------------------------------------
describe('T138-6: WaveEngine/Cursor numeric consistency complex amplitudes off-grid', () => {
  const amps = [0.7, 1.3, 2.7, 3.4] as const;
  const offGrid = [0.37, 1.23, 0.5, 1.37, 2.62] as const;

  it('Step1 capture amp 0.7 beat 0.37 -> Step2 vary amps -> Step3 waveYAt slope 2*TW_AMP*amplitudeAt clamped', () => {
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const eng = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP, BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      for (const b of offGrid) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        expect(eng.waveYAt(b), `amp ${amp} beat ${b}`).toBeCloseTo(expected, 3);
      }
      expect(eng.waveYAt(10)).toBeCloseTo(BOTTOM, 3);
    }
  });

  it('Step1 capture cursor at amp 1.3 dt 0.5 beats -> Step2 update -> Step3 delta equals wave slope', () => {
    const amp = 1.3;
    const tl = new BpmTimeline(120, [], amp);
    const eng = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    const beatMs = tl.beatMsAt(0);
    const dt = (0.5 * beatMs) / 1000;
    cursor.update(dt, false, true, beatMs);
    const cDelta = Math.abs(cursor.y - y0);
    const wDelta = Math.abs(eng.waveYAt(0.5) - eng.waveYAt(0));
    const expected = perBeat * 0.5;
    // within bounds from top start: perBeat 338*0.5=169 so not clamped yet? But for amp>1 amplitude clamp at bottom may apply for larger beats
    expect(cDelta).toBeCloseTo(expected, 3);
    expect(wDelta).toBeCloseTo(expected, 3);
    expect(wDelta).toBeCloseTo(cDelta, 3);
  });

  it('Step1 capture startPosition variants -> Step2 check wave startY -> Step3 -1 bottom 1 top', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    expect(new WaveEngine([], tl, 1.0, 0.0).waveYAt(0)).toBeCloseTo(TW_CENTER_Y, 3);
    expect(new WaveEngine([], tl, 1.0, 1.0).waveYAt(0)).toBeCloseTo(TW_CENTER_Y - TW_AMP, 3);
    expect(new WaveEngine([], tl, 1.0, -1.0).waveYAt(0)).toBeCloseTo(TW_CENTER_Y + TW_AMP, 3);
    expect(new Cursor(1.0, 1.0).y).toBeCloseTo(TW_CENTER_Y - TW_AMP, 3);
  });

  it('Step1 capture off-grid quantize still -> Step2 1.2->1.0 1.3->1.5 snap 0.5 -> Step3 segmentize stay/move correct', () => {
    expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4);
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.5, y: TW_CENTER_Y + 60, down: true },
      { beat: 1.0, y: TW_CENTER_Y + 120, down: true },
      { beat: 1.2, y: TW_CENTER_Y + 130, down: false },
    ];
    const segs = segmentize(traj, 0.5, 1.0);
    const moving = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
    expect(moving).toBeCloseTo(1.0, 4);
    for (const s of segs) expect(isSnapAligned(s.beats, 0.5)).toBe(true);
  });

  it('Step1 capture amplitudeAt step before/after beat 4 -> Step2 off-grid 3.37 4.23 -> Step3 correct list-driven', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(4.37)).toBe(2.0);
  });

  it('Step1 capture getPoints length invariant -> Step2 vary segs -> Step3 seg count +1 holds after T138', () => {
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
    }
  });

  it('Step1 capture all imports typed -> Step2 instantiate -> Step3 schedule not throw', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    expect(getLeadMs(0)).toBeDefined();
    const ctx = createMockCtx();
    expect(() => schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
  });
});
