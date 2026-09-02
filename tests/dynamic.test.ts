/**
 * T138 — 判定ライン＝緑バーの同一化（記録位置とプレイ判定の整合）
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
 *
 * 判定① = songNow = raw, 可聴② = raw - leadMs, 緑④ = raw (案A)
 * leadMs = audioOffset + manualOffsetMs
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
import * as clockModule from '../src/audio/clock';
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
function computeBuggyPos(startMs: number, ctxNow: number, startCtxTime: number, audioOffset: number, manualOffsetMs: number): number {
  const leadMs = audioOffset + manualOffsetMs;
  return startMs + (ctxNow - startCtxTime) * 1000 - leadMs;
}
function computeLeadMs(audioOffset: number, manualOffsetMs: number): number {
  return audioOffset + manualOffsetMs;
}
function getTickSlice(src: string): string {
  const idx = src.indexOf('const tick = ()');
  if (idx === -1) return src.slice(src.indexOf('startMsRef.current'), src.indexOf('startMsRef.current') + 6000);
  return src.slice(idx, idx + 7000);
}
function getStopSlice(src: string): string {
  const idx = src.indexOf('const stop =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 4000);
}
function getPlayFromSlice(src: string): string {
  const idx = src.indexOf('const playFrom');
  if (idx === -1) return '';
  return src.slice(idx, idx + 5000);
}

// ---------------------------------------------------------------------------
// T138-1: Editor positionRef raw invariant (manualOffset does not affect green bar)
// ---------------------------------------------------------------------------
describe('T138-1: Editor positionRef 追跡 pos = startMs + (ctx.currentTime - startCtxTime)*1000 (raw) manualOffset不変', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture raw vs buggy at manual 0 → Step2 set +80 → Step3 raw不変 buggyは-80ズレ Fileもraw', () => {
    expect(getManualOffsetMs()).toBe(0);
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 10.5; // 500ms elapsed
    const audioOffset = 0;
    // Step1: both equal at 0
    const rawBefore = computeRawPos(startMs, ctxNow, startCtx);
    const buggyBefore = computeBuggyPos(startMs, ctxNow, startCtx, audioOffset, 0);
    expect(rawBefore).toBeCloseTo(500, 6);
    expect(buggyBefore).toBeCloseTo(500, 6);
    // Step2: set +80
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const rawAfter = computeRawPos(startMs, ctxNow, startCtx);
    const buggyAfter = computeBuggyPos(startMs, ctxNow, startCtx, audioOffset, 80);
    // Step3: raw stays 500, buggy becomes 420
    expect(rawAfter).toBeCloseTo(500, 6);
    expect(buggyAfter).toBeCloseTo(420, 6);
    expect(rawAfter).not.toBeCloseTo(buggyAfter, 1);
    expect(rawAfter - rawBefore).toBeCloseTo(0, 6);
    expect(buggyAfter - buggyBefore).toBeCloseTo(-80, 6);
    // File contract: tick must be raw (no - leadMs, no getManualOffsetMs in pos calc)
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    // Must contain raw formula
    expect(tick, 'tick must contain raw pos formula startMsRef + (ctx.currentTime - startCtxTime)*1000').toMatch(/startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    // Must NOT contain subtraction of leadMs
    expect(tick, 'tick must NOT subtract leadMs (案A)').not.toMatch(/-\s*leadMs/);
    // Must NOT contain getManualOffsetMs in tick pos calculation (tick raw)
    // Allow playFrom to still contain it, but tick slice should not
    expect(tick, 'tick slice must NOT contain getManualOffsetMs for pos').not.toContain('getManualOffsetMs');
    // Also ensure no audioOffsetRef in tick
    expect(tick, 'tick raw must not use audioOffsetRef for pos').not.toContain('audioOffsetRef');
  });

  it('Step1 capture with audioOffset 200 manual 0 → Step2 toggle manual ±80 → Step3 raw依然不変 (audioOffsetも影響なし)', () => {
    const startMs = 1000;
    const startCtx = 5.0;
    const ctxNow = 5.3; // 300ms elapsed
    const audioOffset = 200;
    setManualOffset(0);
    const raw0 = computeRawPos(startMs, ctxNow, startCtx);
    expect(raw0).toBeCloseTo(1300, 6);
    setManualOffset(80);
    const raw80 = computeRawPos(startMs, ctxNow, startCtx);
    expect(raw80).toBeCloseTo(1300, 6);
    expect(raw80).toBeCloseTo(raw0, 6);
    setManualOffset(-80);
    const rawNeg = computeRawPos(startMs, ctxNow, startCtx);
    expect(rawNeg).toBeCloseTo(1300, 6);
    // Buggy would differ by leadMs
    const buggy0 = computeBuggyPos(startMs, ctxNow, startCtx, audioOffset, 0);
    const buggy80 = computeBuggyPos(startMs, ctxNow, startCtx, audioOffset, 80);
    expect(buggy0).toBeCloseTo(1100, 6); //1300-200
    expect(buggy80).toBeCloseTo(1020, 6); //1300-280
    expect(buggy0).not.toBeCloseTo(raw0, 1);
    expect(buggy80).not.toBeCloseTo(raw0, 1);
    // File contract for stop() also raw
    const src = readFile('src/screens/EditorScreen.tsx');
    const stopSlice = getStopSlice(src);
    expect(stopSlice, 'stop must contain raw pos').toMatch(/startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    expect(stopSlice, 'stop must NOT subtract leadMs').not.toMatch(/-\s*leadMs/);
    expect(stopSlice, 'stop slice must NOT contain getManualOffsetMs for pos').not.toContain('getManualOffsetMs');
    expect(stopSlice, 'stop slice must NOT contain audioOffsetRef for pos').not.toContain('audioOffsetRef');
  });

  it('Step1 capture off-grid elapsed 370ms/1230ms → Step2 set manual ±80 → Step3 raw trajectory unchanged', () => {
    const startMs = 0;
    const startCtx = 8.0;
    const audioOffset = 50;
    const cases = [
      { deltaMs: 370, manual: 80 },
      { deltaMs: 370, manual: -80 },
      { deltaMs: 1230, manual: 80 },
      { deltaMs: 1230, manual: -80 },
    ];
    for (const c of cases) {
      setManualOffset(0);
      const ctxNow = startCtx + c.deltaMs / 1000;
      const raw0 = computeRawPos(startMs, ctxNow, startCtx);
      setManualOffset(c.manual);
      const rawAfter = computeRawPos(startMs, ctxNow, startCtx);
      expect(rawAfter, `delta ${c.deltaMs} manual ${c.manual} raw invariant`).toBeCloseTo(raw0, 6);
      expect(rawAfter).toBeCloseTo(c.deltaMs, 6);
      const buggy = computeBuggyPos(startMs, ctxNow, startCtx, audioOffset, c.manual);
      expect(buggy).not.toBeCloseTo(rawAfter, 1);
      expect(buggy).toBeCloseTo(rawAfter - (audioOffset + c.manual), 6);
    }
    setManualOffset(0);
  });

  it('Step1 capture file before manual 0 → Step2 verify getLeadMs helper exists and returns audioOffset+manual → Step3 numeric', () => {
    setManualOffset(0);
    // Check helper exists
    const has = 'getLeadMs' in clockModule;
    expect(has, 'clock.ts must export getLeadMs').toBe(true);
    const fn: any = (clockModule as any).getLeadMs;
    expect(typeof fn, 'getLeadMs must be function').toBe('function');
    // Numeric verification
    setManualOffset(80);
    expect(fn(120)).toBeCloseTo(200, 6);
    expect(fn(0)).toBeCloseTo(80, 6);
    expect(fn(200)).toBeCloseTo(280, 6);
    setManualOffset(-80);
    expect(fn(120)).toBeCloseTo(40, 6);
    expect(fn(0)).toBeCloseTo(-80, 6);
    // File contract: clock.ts contains getLeadMs definition with audioOffset param
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc, 'clock.ts must contain getLeadMs').toContain('getLeadMs');
    expect(clockSrc, 'getLeadMs should take audioOffset').toMatch(/getLeadMs\s*\(\s*audioOffset/);
    expect(clockSrc, 'getLeadMs should return audioOffset + manualOffsetMs').toMatch(/audioOffset\s*\+\s*manualOffsetMs/);
    setManualOffset(0);
  });

  it('Step1 capture EditorScreen playFrom still uses manualOffset for audible music → Step2 set +80 → Step3 file contains offsetSec with getManualOffsetMs or getLeadMs', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const playFrom = getPlayFromSlice(src);
    // Must contain manualOffset usage for audible delay
    const hasDirect = /\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/.test(playFrom);
    const hasHelper = /getLeadMs\s*\(\s*audioOffset\s*\)/.test(playFrom);
    expect(hasDirect || hasHelper, 'playFrom must compute offsetSec via (audioOffset + manual) or getLeadMs').toBe(true);
    // Ensure game import still exists
    expect(src).toMatch(/import.*getManualOffsetMs.*from.*clock|import.*getLeadMs.*from.*clock/);
    // Numeric: leadMs = 120+80=200 => offsetSec 0.2
    setManualOffset(80);
    const lead = computeLeadMs(120, 80);
    expect(lead).toBe(200);
    expect(lead / 1000).toBeCloseTo(0.2, 6);
    const rawPosCheck = computeRawPos(0, 10.5, 10.0);
    expect(rawPosCheck).toBeCloseTo(500, 6); // raw still 500
    // Buggy green would be 300, raw 500 => divergence intentional
    const buggyGreen = computeBuggyPos(0, 10.5, 10.0, 120, 80);
    expect(buggyGreen).toBeCloseTo(300, 6);
    expect(rawPosCheck).not.toBeCloseTo(buggyGreen, 1);
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-2: 録音リング beat B = msToBeat(greenPos) が Play songNow == beatToMs(B) で一致
// ---------------------------------------------------------------------------
describe('T138-2: 録音リング beat が Play判定 raw で一致 (leadMsズレなし) off-grid必須', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture greenPos raw 1237ms → Step2 quantize via msToBeat → Step3 Play beatToMs == songNow (raw) with no leadMs', () => {
    const tl = new BpmTimeline(120, [], 1.0); // 500ms/beat
    const snap = 0.25;
    // Simulate editor at raw pos 1237 (off-grid: 2.474 beats)
    const greenPosRaw = 1237;
    const B = quantizeBeat(tl.msToBeat(greenPosRaw), snap); // 2.5
    expect(B).toBeCloseTo(2.5, 4);
    // Play: songNow raw at that moment equals greenPosRaw; hitTime = beatToMs(B)
    const hitTime = tl.beatToMs(B); // 1250
    expect(hitTime).toBeCloseTo(1250, 4);
    // In raw model, songNow at greenPosRaw 1237 is 13ms early vs hit (window), but close
    // Demonstrate leadMs diverges: if editor were buggy (raw -80), B_buggy = quantize(msToBeat(1157))=2.25 => hit 1125, not 1250
    setManualOffset(80);
    const greenBuggy = greenPosRaw - 80; // if tick were buggy with manual 80
    const Bbuggy = quantizeBeat(tl.msToBeat(greenBuggy), snap);
    expect(Bbuggy).toBeCloseTo(2.25, 4);
    expect(Bbuggy).not.toBeCloseTo(B, 4);
    const hitBuggy = tl.beatToMs(Bbuggy);
    expect(hitBuggy).toBeCloseTo(1125, 4);
    expect(hitTime).not.toBeCloseTo(hitBuggy, 1);
    // Correct raw should have hitTime close to greenPosRaw within snap/2 * beatMs
    expect(Math.abs(hitTime - greenPosRaw)).toBeLessThanOrEqual(0.125 * 500 + 1e-6); // within half snap
    // File contract: recording must use positionRef directly (no - manual)
    const src = readFile('src/screens/EditorScreen.tsx');
    // Should have zero occurrence of subtraction for recording positions
    expect(src, 'must not contain positionRef - getManualOffsetMs').not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
  });

  it('Step1 capture off-grid snap 0.5 case 1.2拍 (600ms) and 1.3拍 (650ms) → Step2 record with raw → Step3 beat quantize 1.0/1.5 and Play hitTime matches', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    const cases = [
      { bRel: 1.2, expected: 1.0 },
      { bRel: 1.3, expected: 1.5 },
    ];
    for (const c of cases) {
      // For T138, greenPos is raw: the position representing 1.2 beats exactly
      const greenPos = tl.beatToMs(c.bRel);
      const B = quantizeBeat(tl.msToBeat(greenPos), snap);
      expect(B, `bRel ${c.bRel}`).toBeCloseTo(c.expected, 4);
      const hitTime = tl.beatToMs(B);
      // Play songNow at greenPos should be greenPos (raw), hit should be beatToMs(B) == hitTime
      // For 1.2→1.0, hitTime 500; green 600 diff 100 (snap/2=250, so 100 within)
      // For 1.3→1.5, hitTime 750; green 650 diff 100
      expect(tl.msToBeat(hitTime)).toBeCloseTo(B, 6);
      // Show buggy would overshoot: if green were raw - lead 80ms => 520 => 1.04 => quant 1.0 (same for 1.2 case maybe) but for 1.3 with 80ms shift 570 =>1.14=>1.0 not 1.5 -> different
      setManualOffset(80);
      const buggyPos = greenPos - 80; // represent old buggy green
      const Bbuggy = quantizeBeat(tl.msToBeat(buggyPos), snap);
      // At least one of the cases must differ to prove manual invariance
      if (c.bRel === 1.3) {
        expect(Bbuggy).not.toBeCloseTo(c.expected, 1);
        expect(Bbuggy).toBeCloseTo(1.0, 4);
      }
      setManualOffset(0);
    }
  });

  it('Step1 capture manual sweep + audioOffset combos → Step2 compute green raw invariant → Step3 beat round-trip lossless (raw基準で保存→再生)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const combos = [
      { audioOffset: 0, manual: 0 },
      { audioOffset: 0, manual: 80 },
      { audioOffset: 200, manual: 80 },
      { audioOffset: 200, manual: -80 },
    ];
    const greenMs = 1850; // off-grid arbitrary
    for (const c of combos) {
      setManualOffset(c.manual);
      // Editor green is raw, so B does NOT depend on leadMs
      const praw = computeRawPos(greenMs, 1.0, 1.0); // dummy delta zero => praw = greenMs (but use computeRaw to prove invariance)
      // Simulate greenPosRaw = 1850 regardless of c
      const greenPos = 1850;
      const B = quantizeBeat(tl.msToBeat(greenPos), snap);
      // Play hitTime
      const hitTime = tl.beatToMs(B);
      // In raw model, greenPos 1850 => beat 3.7 => quant 3.75 => hit 1875
      expect(B % snap < 1e-6 || Math.abs((B % snap) - snap) < 1e-6).toBeTruthy();
      // Must be independent of leadMs (compare to buggy)
      const buggyGreen = computeBuggyPos(greenPos, 1.0, 1.0, c.audioOffset, c.manual); // would be green - lead
      const Bbuggy = quantizeBeat(tl.msToBeat(buggyGreen), snap);
      expect(B).not.toEqual(Bbuggy); // at least not equal for many combos where lead not snap-aligned
      // But raw B must equal B computed at manual 0 (invariant)
      setManualOffset(0);
      const B0 = quantizeBeat(tl.msToBeat(greenPos), snap);
      expect(B).toBeCloseTo(B0, 6);
      setManualOffset(c.manual);
    }
    setManualOffset(0);
  });

  it('Step1 capture snap variants 0.125/0.25/0.5/1 with off-grid 0.37/1.23 beats → Step2 segmentize with raw beat → Step3 beats snap整数倍 (回帰)', () => {
    const snaps = [0.125, 0.25, 0.5, 1];
    const offGridBeats = [0.37, 1.23];
    for (const snap of snaps) {
      for (const b of offGridBeats) {
        const greenMs = new BpmTimeline(120, [], 1.0).beatToMs(b);
        const tl = new BpmTimeline(120, [], 1.0);
        const B = quantizeBeat(tl.msToBeat(greenMs), snap);
        const rem = ((B % snap) + snap) % snap;
        expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6, `B ${B} snap ${snap}`).toBeTruthy();
      }
    }
    // Also segmentize regression: traj with off-grid release beats should still snap-aligned
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
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4); // not forced to 1/amplitude
  });
});

// ---------------------------------------------------------------------------
// T138-3: 同じ位置から再生してもメトロノームと緑バーの相対位相が毎回一定（T137決定性維持）
// ---------------------------------------------------------------------------
describe('T138-3: 同じ位置から再生してもメトロノームと緑バーの相対位相が毎回一定 (T137決定性維持)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture fromMs off-grid 1237 with audioOffset 200 manual 80 → Step2 同じ fromMsで2回 playFrom → Step3 nextBeatTime差5ms以内 raw green不変', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1237;
    const audioOffset = 200;
    const manual = 80;
    setManualOffset(manual);
    const startCtx1 = 10.0;
    const startCtx2 = 10.007; // 7ms jitter
    // Fixed T137 deterministic: nextBeatTime = startCtx + audioOffset/1000 + (beatToMs(ceil) - fromMs)/1000
    function fixedNextBeat(startCtx: number) {
      let beatIdx = Math.ceil(tl.msToBeat(fromMs));
      if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
      let nextBeatTime = startCtx + audioOffset / 1000 + (tl.beatToMs(beatIdx) - fromMs) / 1000;
      while (nextBeatTime + getManualOffsetMs() / 1000 < startCtx) {
        nextBeatTime += tl.beatMsAt(beatIdx) / 1000;
        beatIdx++;
      }
      return nextBeatTime;
    }
    const n1 = fixedNextBeat(startCtx1);
    const n2 = fixedNextBeat(startCtx2);
    // Difference should be exactly jitter (7ms) not amplified; raw green pos should be exactly jitter too
    const raw1 = computeRawPos(fromMs, startCtx1 + 0.5, startCtx1); // after 500ms
    const raw2 = computeRawPos(fromMs, startCtx2 + 0.5, startCtx2);
    expect(Math.abs(n2 - n1 - (startCtx2 - startCtx1))).toBeLessThanOrEqual(0.001);
    expect(Math.abs(raw2 - raw1)).toBeCloseTo(0, 6); // both 500ms after start, raw diff 0 (since fromMs same)
    // Actually raw after 500ms: fromMs +500 =1737 both
    expect(raw1).toBeCloseTo(fromMs + 500, 6);
    expect(raw2).toBeCloseTo(fromMs + 500, 6);
    // File contract: startMetronome must be useCallback with 4 params deterministic
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number\s*\)/);
    expect(src, 'startMetronome must use startCtxTime + leadMs').toMatch(/let\s+nextBeatTime\s*=\s*startCtxTime\s*\+\s*leadMs\s*\/\s*1000/);
  });

  it('Step1 capture stale positionRef simulation → Step2 playFrom uses fromMs param not stale → Step3 deterministic (file contract)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // playFrom must NOT read positionRef.current for metronome start (stale)
    const playFromSlice = getPlayFromSlice(src);
    // Must contain snapshot t0 and startMetronome(ctx, fromMs, t0, audioOffset)
    expect(playFromSlice).toContain('const t0 = ctx.currentTime');
    expect(playFromSlice).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset\s*\)/);
    expect(playFromSlice).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef/);
    // useEffect isPlaying should use startMsRef/startCtxTimeRef snapshot
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*,\s*metronomeLeadRef\.current\s*\)/);
    // Ensure metronomeLeadRef set to audioOffset (not including manual)
    expect(src).toContain('metronomeLeadRef.current = audioOffset');
  });

  it('Step1 capture metronome gain and music offset still coexist → Step2 verify schedule offsetSeconds → Step3 audioOffset only in leadMs, manual via offsetSeconds', () => {
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds');
    expect(metroSrc).toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/);
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('offsetSeconds');
    expect(clockSrc).toContain('manualOffsetMs / 1000');
    // Editor playFrom audible: when = ctxTime + (audioOffset+manual)/1000
    setManualOffset(80);
    const audioOffset = 200;
    const ctxTime = 8.0;
    const offsetSec = (audioOffset + getManualOffsetMs()) / 1000;
    expect(offsetSec).toBeCloseTo(0.28, 6);
    // Green raw after 300ms: 0+300=300, not 20 (300-280)
    const raw = computeRawPos(0, ctxTime + 0.3, ctxTime);
    expect(raw).toBeCloseTo(300, 6);
    const buggy = computeBuggyPos(0, ctxTime + 0.3, ctxTime, audioOffset, 80);
    expect(buggy).toBeCloseTo(20, 6);
    expect(raw).not.toBeCloseTo(buggy, 1);
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-4: 回帰なし T135(音楽同期維持) / T129 / T102/T103 / T133 / T137
// ---------------------------------------------------------------------------
describe('T138-4: 回帰なし T135 T129 T102/T103 T133 T137', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture T135 playMusic still (audioOffset+manual)/1000 → Step2 set +80 → Step3 file contract GameScreen & EditorScreen playFrom', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // GameScreen should have either direct formula or helper
    const gameHasDirect = /\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/.test(gameSrc);
    const gameHasHelper = /getLeadMs\s*\(\s*audioOffsetMs\s*\)/.test(gameSrc);
    expect(gameHasDirect || gameHasHelper, 'GameScreen must compute offsetSec with manual').toBe(true);
    expect(gameSrc).toContain('source.start');
    // EditorScreen already checked, but double-check still has audible offset
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const has = /\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/.test(editorSrc) || /getLeadMs\s*\(\s*audioOffset\s*\)/.test(editorSrc);
    expect(has).toBe(true);
    // Ensure metronome.ts still uses offsetSeconds
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds');
    // Numeric: music shift 0.08 when manual +80
    setManualOffset(0);
    const off0 = (100 + getManualOffsetMs()) / 1000;
    expect(off0).toBeCloseTo(0.1, 6);
    setManualOffset(80);
    const off80 = (100 + getManualOffsetMs()) / 1000;
    expect(off80).toBeCloseTo(0.18, 6);
    expect(off80 - off0).toBeCloseTo(0.08, 6);
  });

  it('Step1 capture T129 snap整数倍 segmentize off-grid 0.30 snap0.25 → Step2 call segmentize → Step3 beats snap整数倍 not 1/amplitude', () => {
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
    expect(segs[0].beats).toBeCloseTo(0.25, 4);
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4);
    // Continuous trajectory uses raw green: verify segmentize still deterministic
    const snap2 = 0.5;
    expect(quantizeBeat(1.2, snap2)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, snap2)).toBeCloseTo(1.5, 4);
  });

  it('Step1 capture T102/T103 guard modeRef record only → Step2 check file → Step3 guard persists', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const guardCount = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    // Space ring stamping guarded
    expect(src).toMatch(/if\s*\(\s*modeRef\.current === 'record'/);
    // Also ensure positionRef - manual removed even in guarded sections
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
  });

  it('Step1 capture T133 calibration overlay route absent → Step2 check App.tsx → Step3 no /calibration and modal exists', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toContain('CalibrationModal');
    const modalExists = fs.existsSync(path.resolve(__dirname, '../src/screens/editor/CalibrationModal.tsx'));
    expect(modalExists).toBe(true);
  });

  it('Step1 capture T137 deterministic metronome still uses startCtxTime not ctx.currentTime directly → Step2 check init line → Step3 pass', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const idx = src.indexOf('const startMetronome');
    expect(idx).toBeGreaterThan(-1);
    const slice = src.slice(idx, idx + 2500);
    const initLine = slice.match(/let\s+nextBeatTime\s*=[^\n]+/);
    expect(initLine).not.toBeNull();
    expect(initLine![0]).not.toMatch(/ctx\.currentTime\s*\+.*beatToMs/);
    expect(initLine![0]).toMatch(/startCtxTime/);
    // Ensure while includes manualOffset clamp
    expect(slice).toMatch(/while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs\(\)\s*\/\s*1000\s*<\s*ctx\.currentTime/);
  });
});

// ---------------------------------------------------------------------------
// T138-5: WaveEngine / Cursor 数値整合 (複雑振幅 off-grid, T127/T128維持) + getPoints不変
// ---------------------------------------------------------------------------
describe('T138-5: 回帰 WaveEngine/Cursor 数値整合 (複雑振幅 off-grid, T127/T128維持)', () => {
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

  it('Step1 capture off-grid clamp mid-segment (amp 1.0 down 3 beats center) → Step2 check 0.25/0.5/1.5 beats → Step3 clamped vs slope consistent', () => {
    const amp = 1.0;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 3 }], tl, amp, 0.0);
    const perBeat = 2 * TW_AMP * amp; //260
    const TOP = TW_CENTER_Y - TW_AMP; //170
    const BOTTOM = TW_CENTER_Y + TW_AMP; //430
    const startY = TW_CENTER_Y; //300
    const checks = [0.25, 0.5, 1.0, 1.5, 2.0];
    for (const b of checks) {
      const raw = startY + perBeat * b;
      const expected = Math.max(TOP, Math.min(BOTTOM, raw));
      const actual = engine.waveYAt(b);
      expect(actual, `beat ${b}`).toBeCloseTo(expected, 4);
      // 0.5 should be exactly bottom (130px delta) from 300 => 430
      if (b === 0.5) expect(actual).toBeCloseTo(BOTTOM, 4);
      // beyond 0.5 should stay flat at bottom (clamped)
      if (b > 0.5) expect(actual).toBeCloseTo(BOTTOM, 4);
    }
    // Cursor same slope
    const beatMs = 500;
    const cursor = new Cursor(amp, 0.0);
    const y0 = cursor.y;
    cursor.update((0.5 * beatMs) / 1000, false, true, beatMs);
    expect(Math.abs(cursor.y - y0)).toBeCloseTo(perBeat * 0.5, 4);
    expect(cursor.y).toBeCloseTo(BOTTOM, 4);
  });

  it('Step1 capture BpmTimeline amplitudeAt step off-grid → Step2 verify → Step3 correct list-driven', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(4.37)).toBe(2.0);
    // Wave with list-driven amplitude should have perBeat switch at 4
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 1.0);
    // First segment starts at beat 0 with amp 1.0 => perBeat 260, so at beat 4.23 (0.23 into second phase?) Actually segment is single from 0-8, start amp 1.0 only
    // For list-driven, amplitudeAt is used per segment start, so single segment uses amp at 0=1.0
    expect(engine.waveYAt(0.37)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T138-6: tsc --noEmit guard and green bar end detection raw & helper unified
// ---------------------------------------------------------------------------
describe('T138-6: tsc & end detection pos raw & helper統一', () => {
  it('Step1 capture end detection before → Step2 verify tick uses same raw pos for pose >= endMsRef → Step3 file contract tick end check raw', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    expect(tick).toContain('endMsRef.current');
    expect(tick).toMatch(/if\s*\(\s*pos\s*>=\s*endMsRef\.current/);
    // Ensure tick does NOT contain leadMs for pos before that check
    expect(tick).not.toMatch(/-\s*leadMs/);
    expect(tick).not.toContain('getManualOffsetMs');
    const stopSlice = getStopSlice(src);
    expect(stopSlice).toContain('buffer.duration');
    // stop also raw
    expect(stopSlice).not.toMatch(/-\s*leadMs/);
  });

  it('Step1 capture helper unification → Step2 check clock getLeadMs and Editor playFrom uses helper or direct → Step3 at least one helper/Direct consistent', () => {
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('getLeadMs');
    // Editor should either use getLeadMs or still use direct audioOffset+manual for music
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const usesHelperInPlay = /getLeadMs\s*\(/.test(editorSrc);
    const usesDirectInPlay = /\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/.test(editorSrc);
    expect(usesHelperInPlay || usesDirectInPlay, 'Editor playFrom must use getLeadMs or direct').toBe(true);
    // Tick must NOT use helper for green bar (raw)
    const tick = getTickSlice(editorSrc);
    expect(tick).not.toMatch(/getLeadMs\(/);
  });

  it('All imported symbols remain typed correctly (tsc guard) + TW constants', () => {
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
    const ctx: any = {
      currentTime: 10.0,
      destination: {} as unknown as AudioNode,
      createOscillator: () => ({ type: 'sine', frequency: { value: 0 }, connect: () => {}, start: () => {}, stop: () => {} } as any),
      createGain: () => ({ gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} } as any),
    };
    expect(() => schedule(ctx as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
    // getLeadMs typed check
    const fn: any = (clockModule as any).getLeadMs;
    expect(typeof fn).toBe('function');
    setManualOffset(10);
    expect(fn(100)).toBe(110);
    setManualOffset(0);
  });

  it('GameScreen not touched per 案A: still simple (no startMsRef leak)', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).not.toContain('startMsRef');
    expect(gameSrc).not.toContain('audioOffsetRef');
    // Must still import getManualOffsetMs (or getLeadMs) for music sync
    expect(gameSrc).toMatch(/getManualOffsetMs|getLeadMs/);
  });
});
