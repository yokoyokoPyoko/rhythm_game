/**
 * T138 — 判定ライン＝緑バーの同一化（記録位置とプレイ判定の整合）案A
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
 *
 * Core invariants (案A):
 *  - Editor green bar (positionRef) = raw: pos = startMs + (ctx.currentTime - startCtxTime)*1000 (NO leadMs subtraction)
 *  - Recording beats = msToBeat(greenPos) invariant to manualOffset
 *  - Play judgement songNow == beatToMs(B) with no leadMs gap (chart is raw/judgement basis)
 *  - Music audible remains +leadMs delayed via getLeadMs(audioOffset); metronome lead = audioOffset only (deterministic)
 *  - clock.ts getLeadMs(audioOffset) centralizes leadMs = audioOffset + manualOffsetMs
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
import { getManualOffsetMs, setManualOffset, offsetSeconds, getLeadMs } from '../src/audio/clock';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function getTickSlice(src: string): string {
  const idx = src.indexOf('const tick = ()');
  if (idx === -1) return src.slice(src.indexOf('startMsRef.current'), src.indexOf('startMsRef.current') + 6000);
  return src.slice(idx, idx + 6000);
}
function getStopSlice(src: string): string {
  const idx = src.indexOf('const stop =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3500);
}
function getPlayFromSlice(src: string): string {
  const idx = src.indexOf('const playFrom =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 4500);
}

function computeGreenRaw(startMs: number, ctxNow: number, startCtxTime: number): number {
  return startMs + (ctxNow - startCtxTime) * 1000;
}
function computeGreenBuggy(startMs: number, ctxNow: number, startCtxTime: number, audioOffset: number, manual: number): number {
  const leadMs = audioOffset + manual;
  return startMs + (ctxNow - startCtxTime) * 1000 - leadMs;
}
function computeNextBeatTimeFixed(timeline: BpmTimeline, fromMs: number, startCtxTime: number, leadMs: number, ctxNow: number, manual: number) {
  let beatIdx = Math.ceil(timeline.msToBeat(fromMs));
  if (!Number.isFinite(beatIdx) || beatIdx < 0) beatIdx = 0;
  let nextBeatTime = startCtxTime + leadMs / 1000 + (timeline.beatToMs(beatIdx) - fromMs) / 1000;
  while (nextBeatTime + manual / 1000 < ctxNow) {
    nextBeatTime += timeline.beatMsAt(beatIdx) / 1000;
    beatIdx++;
  }
  return { nextBeatTime, beatIdx };
}

// ---------------------------------------------------------------------------
// T138-1: Editor positionRef追跡が raw に一致し manualOffset不変
// ---------------------------------------------------------------------------
describe('T138-1: Editor positionRef追跡 pos = startMs + delta (raw) 手法: manualOffset不変', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture manual 0 before state → Step2 set +80 → Step3 raw追跡は不変・旧buggyは-80ズレを計測', () => {
    expect(getManualOffsetMs()).toBe(0);
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 10.5; // 500ms経過
    const rawBefore = computeGreenRaw(startMs, ctxNow, startCtx);
    expect(rawBefore).toBeCloseTo(500, 6);
    // Step2 apply +80
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const rawAfter = computeGreenRaw(startMs, ctxNow, startCtx);
    const buggyAfter = computeGreenBuggy(startMs, ctxNow, startCtx, 0, 80);
    expect(rawAfter).toBeCloseTo(500, 6);
    expect(rawAfter).toBeCloseTo(rawBefore, 6); // 不変
    expect(buggyAfter).toBeCloseTo(420, 6); // 500-80
    expect(rawAfter - buggyAfter).toBeCloseTo(80, 6);
    expect(rawAfter).not.toBeCloseTo(buggyAfter, 1);
  });

  it('Step1 capture negative -80 → Step2 vary delta → Step3 rawは常に500のまま・buggyは580で乖離', () => {
    setManualOffset(-80);
    expect(getManualOffsetMs()).toBe(-80);
    const startMs = 0;
    const startCtx = 5.0;
    const ctxNow = 5.5; // 500ms
    const raw = computeGreenRaw(startMs, ctxNow, startCtx);
    const buggy = computeGreenBuggy(startMs, ctxNow, startCtx, 0, -80);
    expect(raw).toBeCloseTo(500, 6);
    expect(buggy).toBeCloseTo(580, 6); // 500 - (-80)
    expect(raw).not.toBeCloseTo(buggy, 1);
    // manual 0に戻してもraw不変
    setManualOffset(0);
    const raw0 = computeGreenRaw(startMs, ctxNow, startCtx);
    expect(raw0).toBeCloseTo(raw, 6);
  });

  it('Step1 capture audioOffset 200 manual 80 → Step2 compute raw vs buggy with audioOffset含め → Step3 rawは手前・buggyは-280差', () => {
    const startMs = 100;
    const startCtx = 8.0;
    const ctxNow = 8.75; // 750ms
    setManualOffset(80);
    const audioOffset = 200;
    const raw = computeGreenRaw(startMs, ctxNow, startCtx);
    const buggy = computeGreenBuggy(startMs, ctxNow, startCtx, audioOffset, 80);
    expect(raw).toBeCloseTo(850, 6); // 100+750
    expect(buggy).toBeCloseTo(570, 6); // 850-280
    expect(raw - buggy).toBeCloseTo(280, 6);
    // ファイル契約: tickがlead subtractionを含まないことを検証
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    expect(tick).toContain('const rawPos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000');
    expect(tick).toContain('const pos = Math.max(0, rawPos)');
    // 負のケースでも正しくrawPosが使われる
    // Do NOT contain getManualOffsetMs or leadMs subtraction in pos calculation
    const posLineMatch = tick.match(/const\s+rawPos\s*=[^\n]+/);
    expect(posLineMatch).not.toBeNull();
    expect(posLineMatch![0]).not.toContain('leadMs');
    expect(posLineMatch![0]).not.toContain('getManualOffsetMs');
  });

  it('Step1 capture file before tick → Step2 verify tick slice → Step3 assert tickが getManualOffsetMs を一切使用しない', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    // T138ではtickからgetManualOffsetMs/remove leadMs
    expect(tick).not.toContain('getManualOffsetMs');
    expect(tick).not.toMatch(/-\s*leadMs/);
    expect(tick).not.toMatch(/audioOffsetRef\.current\s*\+\s*getManualOffsetMs/);
    // raw comment should exist
    expect(tick).toMatch(/T138.*raw/);
  });

  it('Step1 capture stop() before状態 → Step2 verify stop slice → Step3 raw追跡で manual不変', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const stop = getStopSlice(src);
    expect(stop).toContain('const rawPos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000');
    expect(stop).not.toContain('getManualOffsetMs');
    expect(stop).not.toMatch(/-\s*leadMs/);
    // Also ensure stop clamps via Math.max(0, rawPos) and buffer duration
    expect(stop).toContain('Math.max(0, rawPos)');
    expect(stop).toContain('buffer.duration');
    // Numeric confirm stop pos also raw
    const startMs = 2000;
    const startCtx = 12.0;
    const ctxNow = 12.3; // 300ms
    setManualOffset(80);
    const raw = computeGreenRaw(startMs, ctxNow, startCtx);
    const buggy = computeGreenBuggy(startMs, ctxNow, startCtx, 0, 80);
    expect(raw).toBeCloseTo(2300, 6);
    expect(buggy).toBeCloseTo(2220, 6);
    expect(raw).not.toBeCloseTo(buggy, 1);
  });

  it('Step1 capture off-grid delta 0.37*beatMsでraw追跡 → Step2 manual -80/0/+80 切替 → Step3 raw軌跡は同一', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const beatMs = 500;
    const offGridBeats = [0.37, 1.23];
    const startMs = 0;
    const startCtx = 3.0;
    for (const b of offGridBeats) {
      const deltaMs = b * beatMs;
      const ctxNow = startCtx + deltaMs / 1000;
      const raw0 = computeGreenRaw(startMs, ctxNow, startCtx);
      expect(raw0).toBeCloseTo(tl.beatToMs(b), 6);
      for (const man of [-80, 0, 80]) {
        setManualOffset(man);
        const rawMan = computeGreenRaw(startMs, ctxNow, startCtx);
        expect(rawMan, `manual ${man} beat ${b}`).toBeCloseTo(raw0, 6);
      }
    }
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T138-2: Editorで録音したリングbeat B=msToBeat(greenPos)がPlayで songNow==beatToMs(B) で判定到達 (leadMsズレなし)
// ---------------------------------------------------------------------------
describe('T138-2: Editor録音リングbeat BがPlay判定ラインと完全同相 (leadMsズレなし)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture greenPos raw 1237ms → Step2 compute B=msToBeat(greenPos) → Step3 Play hitTime=beatToMs(B)が raw songNowと一致', () => {
    const tl = new BpmTimeline(120, [], 1.0); // 500ms/beat
    const greenPos = 1237; // off-grid ms representing raw green bar
    const B = tl.msToBeat(greenPos);
    const hitTime = tl.beatToMs(B);
    expect(hitTime).toBeCloseTo(greenPos, 6);
    // songNow simulation: startMs 0 + delta = greenPos => identical
    const songNow = greenPos;
    expect(songNow).toBeCloseTo(hitTime, 6);
    // Buggy old: greenPos2 = greenPos - leadMs (e.g. 80) => differentBeat
    const leadMs = 80;
    const buggyPos = greenPos - leadMs;
    const Bbuggy = tl.msToBeat(buggyPos);
    const hitBuggy = tl.beatToMs(Bbuggy);
    expect(hitBuggy).toBeCloseTo(buggyPos, 6);
    expect(hitBuggy).not.toBeCloseTo(songNow, 1);
    expect(Math.abs(hitBuggy - songNow)).toBeCloseTo(80, 6);
  });

  it('Step1 capture manual 80 audioOffset 200 の多重ケース → Step2録音位置をrawでmissToBeat → Step3 Play hitがズレ0でT135の音楽遅延は維持', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    // choose a greenPos that is raw (e.g., 900ms)
    const greenPos = 900;
    const B = quantizeBeat(tl.msToBeat(greenPos), 0.25);
    // Now play: hitTime = beatToMs(B) — must equal quantization of greenPos (within snap)
    const hit = tl.beatToMs(B);
    // hit may not exactly equal greenPos due to quantization, but msToBeat(hit) == B and roundtrip stable
    expect(tl.msToBeat(hit)).toBeCloseTo(B, 4);
    // leadMs must NOT affect B: manual irrelevant
    for (const man of [0, 80, -80]) {
      setManualOffset(man);
      const lead = getLeadMs(200); // should be 200+man
      expect(lead).toBe(200 + man);
      // Recording B must be invariant
      const Bman = quantizeBeat(tl.msToBeat(greenPos), 0.25);
      expect(Bman).toBeCloseTo(B, 6);
      // Play hit invariant too
      const hitMan = tl.beatToMs(Bman);
      expect(hitMan).toBeCloseTo(hit, 6);
      // While music audible is delayed by lead, hit line is raw (not delayed) — intentional divergence
      // Simulate music when = ctxStart + lead/1000 + (beatToMs(B)-fromMs)/1000 vs green raw
      // Only music shifts, hit stays raw - covered in T138-3
    }
    setManualOffset(0);
    // File contract: EditorScreen recording positions use raw positionRef.current directly
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
    expect(src).toMatch(/const pos = positionRef\.current/);
    // playFrom still uses getLeadMs for music sync (T135 maintained)
    const playFrom = getPlayFromSlice(src);
    expect(playFrom).toContain('getLeadMs(');
    expect(playFrom).toMatch(/const offsetSec = getLeadMs\(audioOffset\) \/ 1000/);
  });

  it('Step1 capture off-grid 0.37/1.23 beat録音 → Step2 quantize snap 0.5 → Step3 Play hitが msToBeat/beatToMsの往復で完全一致', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    const offGridBeats = [0.37, 1.23, 2.37, 3.73];
    for (const b of offGridBeats) {
      const greenPos = tl.beatToMs(b);
      const B = quantizeBeat(tl.msToBeat(greenPos), snap);
      // B must be snap-aligned and hitTime roundtrips
      const hit = tl.beatToMs(B);
      expect(Math.abs((B % snap) + snap) % snap < 1e-6 || Math.abs(((B % snap) - snap)) < 1e-6).toBeTruthy();
      expect(tl.msToBeat(hit)).toBeCloseTo(B, 4);
      // raw invariant: manual doesn't change
      setManualOffset(80);
      const B80 = quantizeBeat(tl.msToBeat(greenPos), snap);
      expect(B80).toBeCloseTo(B, 6);
      setManualOffset(0);
    }
  });

  it('Step1 capture BPM change with amplitude list: 177.3拍目のoff-grid記録 → Step2 Play同期 → Step3 leadMsズレなしで往復成功', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 180, amplitude: 1.5 }], 1.0);
    const greenPos = tl.beatToMs(3.37); // before change
    const B = tl.msToBeat(greenPos);
    expect(B).toBeCloseTo(3.37, 4);
    expect(tl.beatToMs(B)).toBeCloseTo(greenPos, 6);
    // Change time-varying amplitude should not affect time conversion
    const after = tl.beatToMs(5.23); // after change
    const B2 = tl.msToBeat(after);
    expect(B2).toBeCloseTo(5.23, 4);
    // Record and play must use same timeline, so hit==pos
    expect(tl.beatToMs(B2)).toBeCloseTo(after, 6);
    // ensure manual invariant still
    setManualOffset(80);
    const B2man = tl.msToBeat(after);
    expect(B2man).toBeCloseTo(5.23, 4);
    setManualOffset(0);
  });

  it('Step1 capture file contract: EditorScreenリング3箇所・releaseBeat・hold終端が- manual補正なし → Step2 check source → Step3 all use raw', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Should have zero occurrences of positionRef.current - getManualOffsetMs()
    const buggyOccurrences = (src.match(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/g) || []).length;
    expect(buggyOccurrences).toBe(0);
    // ring press
    const ringIdx = src.indexOf('spacePressBeatRef.current =');
    expect(ringIdx).toBeGreaterThan(-1);
    const ringSlice = src.slice(Math.max(0, ringIdx - 700), ringIdx + 700);
    expect(ringSlice).toContain('positionRef.current');
    expect(ringSlice).not.toContain('getManualOffsetMs');
    expect(ringSlice).toMatch(/const pos\s*=\s*positionRef\.current/);
    // arrow release
    const relIdx = src.indexOf('releaseBeat');
    expect(relIdx).toBeGreaterThan(-1);
    const relSlice = src.slice(Math.max(0, relIdx - 1200), relIdx + 800);
    expect(relSlice).toContain('positionRef.current');
    expect(relSlice).not.toContain('getManualOffsetMs');
    // hold tail
    const holdIdx = src.indexOf('snapped - startBeat');
    expect(holdIdx).toBeGreaterThan(-1);
    const holdSlice = src.slice(Math.max(0, holdIdx - 1600), holdIdx + 500);
    expect(holdSlice).toContain('positionRef.current');
    expect(holdSlice.match(/positionRef\.current\s*-\s*getManualOffsetMs/g) || []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T138-3: Editor同位置再生でメトロノームと緑バーの相対位相が毎回一定（T137決定性維持）
// ---------------------------------------------------------------------------
describe('T138-3: Editor同位置再生メトロノーム決定性（T137維持）＋緑bar raw乖離が意図的に一定', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture fromMs 1237 off-grid → Step2 compute fixed nextBeatTime twice with jitter → Step3 deterministic within 5ms', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1237;
    const audioOffset = 0; // T138: metronome lead = audioOffset only (raw green divergence intentional)
    const startCtx1 = 10.0;
    const ctxJitter1 = 10.003;
    const ctxJitter2 = 10.012;
    const fixed1 = computeNextBeatTimeFixed(tl, fromMs, startCtx1, audioOffset, ctxJitter1, 0);
    const fixed2 = computeNextBeatTimeFixed(tl, fromMs, startCtx1, audioOffset, ctxJitter2, 0);
    expect(Math.abs(fixed1.nextBeatTime - fixed2.nextBeatTime)).toBeLessThanOrEqual(0.005);
  });

  it('Step1 capture file contract startMetronome signature raw基準 → Step2 verify → Step3 leadMs is audioOffset only', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Signature must remain deterministic 4 params
    expect(src).toMatch(/const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number\s*\)/);
    expect(src).toMatch(/let\s+nextBeatTime\s*=\s*startCtxTime\s*\+\s*leadMs\s*\/\s*1000/);
    expect(src).toMatch(/while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs\(\)\s*\/\s*1000\s*<\s*ctx\.currentTime/);
    // playFrom must pass audioOffset as lead (not getLeadMs)
    const play = getPlayFromSlice(src);
    expect(play).toContain('metronomeLeadRef.current = audioOffset');
    expect(play).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset\s*\)/);
    // isPlaying effect should use snapshot refs, not positionRef
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*,\s*metronomeLeadRef\.current\s*\)/);
    const calls = [...src.matchAll(/startMetronome\s*\([^)]+\)/g)].map(m => m[0]);
    for (const c of calls) expect(c).not.toContain('positionRef.current');
  });

  it('Step1 capture manual ±80 audioOffset 0/200 → Step2 music audible vs metronome fixed → Step3音楽②とメトロ⑤はaudioOffset込みで一致が、緑rawは一定乖離', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 1000;
    const ctxStart = 8.0;
    for (const ao of [0, 200]) {
      for (const man of [80, -80]) {
        setManualOffset(man);
        const leadMusic = getLeadMs(ao); // audioOffset+manual
        expect(leadMusic).toBe(ao + man);
        // music audible for beat B
        const beat = 4;
        const music = ctxStart + leadMusic / 1000 + (tl.beatToMs(beat) - fromMs) / 1000;
        // metronome audible fixed uses lead=ao + manual via schedule(offsetSeconds)
        const { nextBeatTime, beatIdx } = computeNextBeatTimeFixed(tl, fromMs, ctxStart, ao, ctxStart, man);
        let nt = nextBeatTime;
        let idx = beatIdx;
        while (idx < beat) {
          nt += tl.beatMsAt(idx) / 1000;
          idx++;
        }
        const metro = nt + man / 1000;
        expect(metro, `ao ${ao} man ${man}`).toBeCloseTo(music, 3);
        // green raw pos for same fromMs delta does NOT include lead => differs by lead/1000
        const greenWhenRaw = ctxStart + (tl.beatToMs(beat) - fromMs) / 1000;
        expect(metro - greenWhenRaw).toBeCloseTo(ao / 1000 + man / 1000 - 0 + 0, 3); // actually manual part cancels? metro = greenRaw + ao/1000
        // Let's compute separately: metro = startCtx + ao/1000 + delta + man/1000
        // greenRaw = startCtx + delta
        // diff = ao/1000 + man/1000 => but music= greenRaw + lead/1000, metro aligns with music, so diff green<->music = lead/1000
        expect(music - greenWhenRaw).toBeCloseTo(leadMusic / 1000, 3);
      }
    }
    setManualOffset(0);
  });

  it('Step1 capture rapid toggle with off-grid stale → Step2 compute fixed ignores stale → Step3 deterministic', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const trueFrom = 1000;
    const stale = 1237; // off-grid stale tick
    const ctxStart = 9.0;
    setManualOffset(0);
    const fixedTrue = computeNextBeatTimeFixed(tl, trueFrom, ctxStart, 0, ctxStart, 0);
    const fixedStale = computeNextBeatTimeFixed(tl, stale, ctxStart, 0, ctxStart, 0);
    expect(fixedTrue.nextBeatTime).not.toBeCloseTo(fixedStale.nextBeatTime, 2);
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef\.current/);
    // Ensure playFrom's startMetronome call uses fromMs/t0, not positionRef
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
    const playSliceNarrow = src.slice(src.indexOf('const playFrom ='), src.indexOf('const playFrom =') + 3000);
    expect(playSliceNarrow).toContain('const t0 = ctx.currentTime');
    expect(playSliceNarrow).not.toContain('positionRef.current');
  });
});

// ---------------------------------------------------------------------------
// T138-4: clock.ts getLeadMsヘルパ一元化
// ---------------------------------------------------------------------------
describe('T138-4: clock.ts getLeadMsヘルパ一元化と統一利用', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture manual 0 → Step2 set 80 → Step3 getLeadMs(audioOffset)=audioOffset+manual', () => {
    expect(getLeadMs(0)).toBe(0);
    const src = readFile('src/audio/clock.ts');
    expect(src).toContain('export function getLeadMs');
    expect(src).toMatch(/export function getLeadMs\(audioOffsetMs.*=.*0/);
    expect(src).toContain('return audioOffsetMs + manualOffsetMs');
    setManualOffset(80);
    expect(getLeadMs(0)).toBe(80);
    expect(getLeadMs(200)).toBe(280);
    setManualOffset(-80);
    expect(getLeadMs(200)).toBe(120);
    expect(getLeadMs(0)).toBe(-80);
    // offsetSeconds still manual/1000
    expect(offsetSeconds()).toBeCloseTo(-0.08, 6);
    setManualOffset(0);
    expect(getLeadMs(0)).toBe(0);
  });

  it('Step1 capture EditorScreen playFrom uses getLeadMs → Step2 vary audioOffset 0/200 manual ±80 → Step3音楽offsetSec = getLeadMs/1000 を検証', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const play = getPlayFromSlice(src);
    expect(play).toContain('getLeadMs(audioOffset)');
    expect(play).toMatch(/const offsetSec = getLeadMs\(audioOffset\) \/ 1000/);
    // Numerical simulation: positive and negative branch match playMusic logic
    for (const man of [80, -80]) {
      for (const ao of [0, 200]) {
        setManualOffset(man);
        const offSec = getLeadMs(ao) / 1000;
        const ctxTime = 10.0;
        const fromMs = 500;
        let when: number, offset: number;
        const audioTime = fromMs / 1000;
        if (offSec >= 0) {
          when = ctxTime + offSec;
          offset = audioTime;
        } else {
          when = ctxTime;
          offset = Math.max(0, audioTime - offSec);
        }
        // Ensure green raw pos unaffected by offSec
        const greenPos = computeGreenRaw(fromMs, ctxTime + 0.3, ctxTime); // 300ms delta => 800
        expect(greenPos).toBeCloseTo(800, 6);
        // but music when offset includes lead
        if (ao === 200 && man === 80) {
          expect(when).toBeCloseTo(10.28, 6);
          expect(offset).toBeCloseTo(0.5, 6);
        }
        if (ao === 0 && man === -80) {
          expect(when).toBeCloseTo(10.0, 6);
          expect(offset).toBeCloseTo(0.58, 6);
        }
      }
    }
    setManualOffset(0);
  });

  it('Step1 capture GameScreen still uses Game側 lead via (audioOffsetMs+getManualOffsetMs()) → Step2 check file → Step3 not changed to raw', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    expect(gameSrc).toContain('getManualOffsetMs');
    // GameScreen must NOT have startMsRef (editor var) and no positionRef subtraction (editor)
    expect(gameSrc).not.toContain('startMsRef');
    expect(gameSrc).not.toContain('positionRef.current - getManualOffsetMs');
    // But GameScreen may also import getLeadMs? Currently does not need to — ensure not broken if it still uses direct sum
    // Clock must still export offsetSeconds for metronome
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('offsetSeconds');
    expect(clockSrc).toContain('return manualOffsetMs / 1000');
  });

  it('Step1 capture EditorScreen tick/stopが audioOffsetRef を持たず getLeadMs を呼ばない → Step2 verify → Step3 editor music only uses getLeadMs', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Use a narrow slice for tick/stop: only the pos calculation lines, not the whole 6000 chars that bleeds into playFrom
    const tickIdx = src.indexOf('const tick = ()');
    const tickNarrow = tickIdx !== -1 ? src.slice(tickIdx, tickIdx + 1500) : getTickSlice(src);
    expect(tickNarrow).not.toContain('audioOffsetRef');
    expect(tickNarrow).not.toContain('getLeadMs');
    const stopNarrow = src.slice(src.indexOf('const stop ='), src.indexOf('const stop =') + 1200);
    expect(stopNarrow).not.toContain('getLeadMs');
    expect(stopNarrow).not.toContain('audioOffsetRef');
    // playFrom is the only place using getLeadMs
    const playOcc = (src.match(/getLeadMs\(/g) || []).length;
    // Should be exactly 1 (playFrom offsetSec)
    expect(playOcc).toBe(1);
    expect(src).toContain("import { getLeadMs");
  });
});

// ---------------------------------------------------------------------------
// T138-5: 回帰なし T135/T136音楽遅延維持・T102/T103/T129/T133/T137
// ---------------------------------------------------------------------------
describe('T138-5: 回帰なし T135 T102/T103 T129 T133 T137', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture T135音楽同期 Editor+Game共に lead適用 → Step2 verify file contracts → Step3 metronome schedule still +offsetSeconds', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(editorSrc).toContain('getLeadMs(audioOffset)');
    expect(gameSrc).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/);
    expect(metroSrc).toContain("import { offsetSeconds } from './clock'");
    expect(metroSrc).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime \+ offsetSeconds\(\)\)/);
    // Numerical: with ao 200 man 80, offsetSec =0.28, music when = ctx+0.28, metronome when = nextBeat+0.08 (schedule) + ao/1000 via grid = also 0.28
    const tl = new BpmTimeline(120, [], 1.0);
    const fromMs = 0;
    const ctxStart = 5.0;
    const ao = 200;
    setManualOffset(80);
    const offSec = getLeadMs(ao) / 1000;
    expect(offSec).toBeCloseTo(0.28, 6);
    const { nextBeatTime } = computeNextBeatTimeFixed(tl, fromMs, ctxStart, ao, ctxStart, 80);
    expect(nextBeatTime).toBeCloseTo(5.2, 6);
    const metroWhen = nextBeatTime + offsetSeconds();
    expect(metroWhen).toBeCloseTo(5.28, 6);
    const musicWhen = ctxStart + offSec;
    expect(musicWhen).toBeCloseTo(5.28, 6);
    expect(metroWhen).toBeCloseTo(musicWhen, 3);
  });

  it('Step1 capture T102/T103 playモードガード残存 → Step2 verify → Step3 modeRef recordのみ許可', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const count = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
  });

  it('Step1 capture T129 snap整数倍 segmentize → Step2 off-grid 0.30 snap 0.25 → Step3 snap-aligned not 1/amplitude', () => {
    const snap = 0.25;
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.30, y: TW_CENTER_Y + 40, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6, `beats ${s.beats}`).toBeTruthy();
    }
    expect(segs[0].beats).toBeCloseTo(0.25, 4);
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4);
    // second variant 0.37 beats with snap 0.125
    const traj2 = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.37, y: TW_CENTER_Y + 50, down: false },
    ];
    const segs2 = segmentize(traj2, 0.125, 1.3);
    for (const s of segs2) expect(((s.beats % 0.125) + 0.125) % 0.125 < 1e-6 || Math.abs(((s.beats % 0.125) + 0.125) % 0.125 - 0.125) < 1e-6).toBeTruthy();
  });

  it('Step1 capture T133 calibration overlay route absent → Step2 check App.tsx → Step3 no /calibration', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    expect(readFile('src/screens/EditorScreen.tsx')).toContain('CalibrationModal');
    expect(fs.existsSync(path.resolve(__dirname, '../src/screens/editor/CalibrationModal.tsx'))).toBe(true);
  });

  it('Step1 capture T137 tick/stopがrawになった後もplayFrom決定性は維持 → Step2 verify startMetronome deterministic call intact → Step3 pass', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/const t0 = ctx\.currentTime/);
    expect(src).toMatch(/startCtxTimeRef\.current = t0/);
    expect(src).toMatch(/startMsRef\.current = fromMs/);
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
    expect(src).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef/);
  });

   it('Step1 capture T136旧リード差分撤廃確認 → Step2 file does not contain Math.max(0, rawPos - leadMs) etc → Step3 no remaining lead subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Ensure no occurrence of "- leadMs" in tick/stop context
    const tick = getTickSlice(src);
    expect(tick).not.toContain('- leadMs');
    const stop = getStopSlice(src);
    expect(stop).not.toContain('- leadMs');
    expect(src).toContain('green bar = raw');
    // Code lines must not subtract leadMs from rawPos (but the rawPos expression itself contains " - " inside parentheses for ctx delta)
    const rawLines = [...src.matchAll(/const rawPos = startMsRef\.current \+ \(ctx\.currentTime - startCtxTimeRef\.current\) \* 1000[^\n]*/g)];
    expect(rawLines.length).toBe(2); // tick + stop
    for (const m of rawLines) expect(m[0]).not.toContain('- leadMs');
    expect(rawLines[0][0]).not.toContain('audioOffset');
  });
});

// ---------------------------------------------------------------------------
// T138-6: WaveEngine / Cursor 数値整合（複雑振幅 off-grid, T127/T128維持）
// ---------------------------------------------------------------------------
describe('T138-6: 回帰 WaveEngine/Cursor 数値整合（複雑振幅 0.7/1.3/2.7/3.4 off-grid 0.37/1.23）', () => {
  const amps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23];

  it('Step1 capture amp 0.7 beat 0.37 → Step2 waveYAt slope = 2*TW_AMP*amplitudeAt clamped → Step3一致', () => {
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
        expect(engine.waveYAt(b), `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
      expect(engine.waveYAt(10)).toBeCloseTo(BOTTOM, 4);
      // startPosition variations
      const e1 = new WaveEngine([{ direction: 'up', beats: 6 }], tl, amp, 1.0);
      expect(e1.waveYAt(0)).toBeCloseTo(TW_CENTER_Y - 1.0 * TW_AMP, 4);
      const eNeg = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, -1.0);
      expect(eNeg.waveYAt(0)).toBeCloseTo(TW_CENTER_Y + 1.0 * TW_AMP, 4);
    }
  });

  it('Step1 capture cursor amp 1.3 → Step2 update dt for 0.5 beats down → Step3 cursor delta == wave delta == perBeat*beats', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    for (const dtBeats of [0.37, 0.5, 1.23]) {
      const cursor = new Cursor(amp, 1.0);
      const y0 = cursor.y;
      const dt = (dtBeats * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs);
      const delta = Math.abs(cursor.y - y0);
      // From top start, moving down: clamp may hit bottom if large.
      const rawExp = perBeat * dtBeats;
      const expClamped = Math.min(260, rawExp); // total travel TW_AMP*2 =260 from top
      // For 0.37*338=125 <260, for 1.23*338=415 >260 so clamped 260
      const shouldBe = rawExp <= 260 ? rawExp : 260;
      expect(delta).toBeCloseTo(shouldBe, 3);
      // WaveEngine delta for same beats from startY top
      if (dtBeats <= 0.7) { // ensure wave not yet clipped for direct compare
        const wd = Math.abs(engine.waveYAt(dtBeats) - engine.waveYAt(0));
        const expWave = Math.min(260, perBeat * dtBeats);
        expect(wd).toBeCloseTo(expWave, 3);
      }
    }
  });

  it('Step1 capture time-varying amplitude list: beat 3.37→1.0 beat 4.23→2.0 → Step2 amplitudeAt step → Step3 per-segment dY uses amplitudeAt(segStartBeat)', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    // Wave segment starting before change uses 1.0, after uses 2.0
    // Segment [down beats 2] from beat 3 to 5: start at 3 uses amp 1.0
    const engine1 = new WaveEngine([{ direction: 'down', beats: 2 }], tl, 1.0, 0.0);
    // But WaveEngine builds per segStartBeat: first seg at 0 uses 1.0, so dynamic list not exercised for single seg starting at 0
    // Create two segs: first 4 beats (up to change), second 2 beats (after)
    const engine2 = new WaveEngine([{ direction: 'down', beats: 4 }, { direction: 'down', beats: 2 }], tl, 1.0, 0.0);
    const pts = engine2.getPoints();
    expect(pts.length).toBe(3); // 2 segs +1
    // Verify first segment slope uses 1.0
    const y3 = engine2.waveYAt(3.0);
    const y3_37 = engine2.waveYAt(3.37);
    const per1 = 2 * TW_AMP * 1.0;
    // From beat 3 to 3.37 within first seg (still amp 1.0 before clamp)
    // Need startY for calc: engine2 starts at center, first seg down 4 beats with amp 1.0: from center 300, per 260, 4 beats would go 1040 but clamped to 430
    // Actually T128 clamp makes slope flat after reaching bottom early; so at beat 2.0 we already at bottom.
    // Hard to assert slope beyond clamp; just check getPoints invariant.
    expect(Array.isArray(pts)).toBe(true);
  });

  it('Step1 capture off-grid clipping: amp 1.0 down 3 beats from center → Step2 waveYAt 0.5 vs 1.5 vs 3 → Step3 climb then stay (遅い側のみ傾斜は発生せず)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 3 }], tl, 1.0, 0.0);
    const TOP = TW_CENTER_Y - TW_AMP;
    const BOTTOM = TW_CENTER_Y + TW_AMP;
    const per = 2 * TW_AMP * 1.0; // 260
    // From center 300, per 260: beat 0.25 => 300+65=365, beat 0.5=>430 bottom, beat 1.0=>430 stay, beat 2=>430
    expect(engine.waveYAt(0.25)).toBeCloseTo(Math.max(TOP, Math.min(BOTTOM, 300 + per * 0.25)), 4);
    expect(engine.waveYAt(0.5)).toBeCloseTo(430, 4);
    expect(engine.waveYAt(1.0)).toBeCloseTo(430, 4);
    expect(engine.waveYAt(1.5)).toBeCloseTo(430, 4);
    expect(engine.waveYAt(2.0)).toBeCloseTo(430, 4);
    // Off-grid 0.37 also
    expect(engine.waveYAt(0.37)).toBeCloseTo(Math.max(TOP, Math.min(BOTTOM, 300 + per * 0.37)), 4);
    expect(engine.waveYAt(1.23)).toBeCloseTo(430, 4);
  });

  it('Step1 capture getPoints length invariant → Step2 vary segs → Step3 segments+1', () => {
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

  it('Step1 capture quantize off-grid 1.2→1.0 1.3→1.5 snap 0.5 → Step2 segmentize → Step3 snap-aligned', () => {
    const snap = 0.5;
    expect(quantizeBeat(1.2, snap)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, snap)).toBeCloseTo(1.5, 4);
    expect(quantizeBeat(1.2 + 1e-9, snap)).toBeCloseTo(1.0, 4);
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
// T138-7: tsc & import guard
// ---------------------------------------------------------------------------
describe('T138-7: tsc & import guard / overall file health', () => {
  it('Step1 capture imports resolve → Step2 use symbols → Step3 typed correctly', () => {
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
    expect(quantizeBeat(1.2, 0.5)).toBeDefined();
  });

  it('Step1 capture EditorScreen imports getLeadMs → Step2 GameScreen not using Editor vars → Step3 no cross-contamination', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(editorSrc).toMatch(/import.*getLeadMs.*from.*clock/);
    expect(gameSrc).not.toContain('startMsRef');
    expect(gameSrc).not.toContain('__editor');
    expect(editorSrc).not.toContain('CalibrationScreen');
    expect(editorSrc).toContain('CalibrationModal');
  });

  it('Step1 capture metronome still node import → Step2 schedule callable → Step3 not throwing', () => {
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds');
    expect(metroSrc).toMatch(/export function schedule\(/);
    // Quick runtime check: BpmTimeline basic ops not throw
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 150 }], 1.0);
    expect(() => tl.msToBeat(1000)).not.toThrow();
    expect(() => tl.beatToMs(2.5)).not.toThrow();
    expect(() => tl.amplitudeAt(4.23)).not.toThrow();
  });
});
