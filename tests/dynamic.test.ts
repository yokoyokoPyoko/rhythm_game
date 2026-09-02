/**
 * T136 — エディタ録音位置のバグ修正：緑バー（positionRef）を楽曲実位置に一致させ、録音打刻をそのまま使う
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

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

// Correct green bar position: leadMs = audioOffset + manualOffsetMs
function computeGreenBarPosCorrect(startMs: number, ctxNow: number, startCtxTime: number, audioOffset: number, manualOffsetMs: number): number {
  const leadMs = audioOffset + manualOffsetMs;
  return startMs + (ctxNow - startCtxTime) * 1000 - leadMs;
}
function computeGreenBarPosBuggy(startMs: number, ctxNow: number, startCtxTime: number): number {
  return startMs + (ctxNow - startCtxTime) * 1000;
}

// Correct recording beat: positionRef directly (no manual subtraction)
function computeRecordBeatCorrect(timeline: BpmTimeline, positionRef: number, snap: number): number {
  return quantizeBeat(timeline.msToBeat(positionRef), snap);
}
function computeRecordBeatBuggy(timeline: BpmTimeline, positionRef: number, manualOffsetMs: number, snap: number): number {
  return quantizeBeat(timeline.msToBeat(positionRef - manualOffsetMs), snap);
}

// Resolve slices for tick and stop inspection
function getTickSlice(src: string): string {
  const idx = src.indexOf('const tick = ()');
  if (idx === -1) return src.slice(src.indexOf('startMsRef.current'), src.indexOf('startMsRef.current') + 5000);
  return src.slice(idx, idx + 6000);
}
function getStopSlice(src: string): string {
  const idx = src.indexOf('const stop =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3000);
}

// ---------------------------------------------------------------------------
// T136-1: Green bar tracking pos = startMs + delta - (audioOffset+manual)
// ---------------------------------------------------------------------------
describe('T136-1: 緑バー追跡 pos = startMsRef + (ctx.currentTime - startCtxTime)*1000 - (audioOffset + manualOffsetMs)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture buggy vs fixed at 0 → Step2 set +80 → Step3 assert fixed pos = correct and differs from buggy by 80ms', () => {
    expect(getManualOffsetMs()).toBe(0);
    const startMs = 0;
    const startCtxTime = 10.0;
    const ctxNow = 10.5; // 500ms elapsed
    const audioOffset = 0;
    const buggyBefore = computeGreenBarPosBuggy(startMs, ctxNow, startCtxTime);
    const fixedBefore = computeGreenBarPosCorrect(startMs, ctxNow, startCtxTime, audioOffset, 0);
    expect(buggyBefore).toBeCloseTo(500, 6);
    expect(fixedBefore).toBeCloseTo(500, 6);
    // Step2: set +80
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    // Step3: after offset, fixed shifts -80, buggy unchanged
    const buggyAfter = computeGreenBarPosBuggy(startMs, ctxNow, startCtxTime);
    const fixedAfter = computeGreenBarPosCorrect(startMs, ctxNow, startCtxTime, audioOffset, 80);
    expect(buggyAfter).toBeCloseTo(500, 6);
    expect(fixedAfter).toBeCloseTo(420, 6); // 500 - 80
    expect(fixedAfter - buggyAfter).toBeCloseTo(-80, 6);
    expect(fixedAfter).not.toBeCloseTo(buggyAfter, 1);
  });

  it('Step1 capture pos with negative offset -80 → Step2 vary ctx delta → Step3 assert pos precedes by +80 (leadMs negative => pos larger)', () => {
    setManualOffset(0);
    const startMs = 0;
    const startCtxTime = 5.0;
    // Step1 initial
    expect(getManualOffsetMs()).toBe(0);
    // Step2 set -80
    setManualOffset(-80);
    expect(getManualOffsetMs()).toBe(-80);
    const ctxNow = 5.2; // 200ms elapsed
    const audioOffset = 0;
    const fixed = computeGreenBarPosCorrect(startMs, ctxNow, startCtxTime, audioOffset, -80);
    const buggy = computeGreenBarPosBuggy(startMs, ctxNow, startCtxTime);
    // lead -80 => pos = 200 - (-80) = 280 (ahead, because buffer started earlier)
    expect(fixed).toBeCloseTo(280, 6);
    expect(buggy).toBeCloseTo(200, 6);
    expect(fixed - buggy).toBeCloseTo(80, 6);
    expect(fixed).not.toBeCloseTo(buggy, 1);
  });

  it('Step1 capture with audioOffset +200 manual +80 → Step2 compute tick pos → Step3 assert file contract tick contains leadMs subtraction', () => {
    setManualOffset(80);
    const audioOffset = 200;
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 10.5; // 500ms elapsed
    const posFixed = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, audioOffset, 80);
    // 500 - (200+80)=220
    expect(posFixed).toBeCloseTo(220, 6);
    const posBuggy = computeGreenBarPosBuggy(startMs, ctxNow, startCtx);
    expect(posBuggy).toBeCloseTo(500, 6);
    expect(posFixed).not.toBeCloseTo(posBuggy, 1);
    // Also show that before music start (elapsed < leadMs) pos negative
    const ctxEarly = 10.1; // 100ms elapsed, lead 280 => pos -180
    const earlyPos = computeGreenBarPosCorrect(startMs, ctxEarly, startCtx, audioOffset, 80);
    expect(earlyPos).toBeCloseTo(-180, 6);
    expect(earlyPos).toBeLessThan(0);

    // Step3 file contract: EditorScreen tick must contain subtraction with audioOffset+manual
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    // Must contain leadMs or direct subtraction
    const hasLeadMsVar = tick.includes('leadMs');
    const hasDirect = /audioOffset\s*\+\s*getManualOffsetMs\(\)/.test(tick);
    const hasSubtraction = tick.includes('- leadMs') || tick.includes('- (audioOffset') || hasDirect;
    expect(hasLeadMsVar || hasDirect, 'tick slice must compute leadMs = audioOffset + getManualOffsetMs()').toBe(true);
    expect(hasSubtraction, 'tick must subtract leadMs from pos').toBe(true);
    // Ensure tick uses getManualOffsetMs
    expect(tick).toContain('getManualOffsetMs');
    expect(tick).toContain('audioOffset');
    // And must contain the exact pos formula with subtraction
    const hasCorrectPos = tick.includes('- leadMs') || /startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000\s*-\s*/.test(tick);
    expect(hasCorrectPos, 'tick pos must be startMs + delta - leadMs').toBe(true);
  });

  it('Step1 capture stop() buggy → Step2 set offset → Step3 assert stop() also uses leadMs subtraction (file contract)', () => {
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(50);
    const src = readFile('src/screens/EditorScreen.tsx');
    const stopSlice = getStopSlice(src);
    // stop should also subtract leadMs
    const hasLead = stopSlice.includes('leadMs') || /audioOffset\s*\+\s*getManualOffsetMs\(\)/.test(stopSlice);
    const hasSub = stopSlice.includes('- leadMs') || /-\s*\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/.test(stopSlice) || /-\s*leadMs/.test(stopSlice);
    expect(hasLead, 'stop() must reference audioOffset + manualOffset').toBe(true);
    expect(hasSub, 'stop() pos must subtract leadMs').toBe(true);
    expect(stopSlice).toContain('getManualOffsetMs');
    // Numeric verification for stop pos: same as tick
    const startMs = 1000;
    const startCtx = 5.0;
    const ctxNow = 5.3; // 300ms
    const fixed = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, 120, 50); // lead 170 => 1000+300-170=1130
    expect(fixed).toBeCloseTo(1130, 6);
    const buggy = computeGreenBarPosBuggy(startMs, ctxNow, startCtx);
    expect(buggy).toBeCloseTo(1300, 6);
    expect(fixed).not.toBeCloseTo(buggy, 1);
  });

  it('Step1 capture file before with manual 0 → Step2 set manual 80 and audioOffset 120 → Step3 assert green bar aligns with buffer position via src.start when/offset (positive branch)', () => {
    // Simulate playFrom with leadMs positive
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const audioOffset = 120;
    const fromMs = 0;
    const ctxTime = 8.0;
    // Before: lead 120 => startWhen 8.12 offset 0
    const leadBefore = audioOffset + getManualOffsetMs();
    expect(leadBefore).toBe(120);
    // Step2 apply +80 => lead 200
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const leadAfter = audioOffset + getManualOffsetMs();
    expect(leadAfter).toBe(200);
    // Check playFrom contract file
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    // Numeric: green bar pos = fromMs + delta - lead
    const startMs = fromMs;
    const startCtx = ctxTime;
    const deltaMs = 800; // ctxNow = 8.8
    const ctxNow = 8.8;
    const pos = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, audioOffset, 80);
    // 0 + 800 -200 =600 => buffer position 600ms => beat 1.2 at 120BPM (500ms/beat)
    expect(pos).toBeCloseTo(600, 6);
    // Buggy would be 800
    expect(computeGreenBarPosBuggy(startMs, ctxNow, startCtx)).toBeCloseTo(800, 6);
    // Verify this pos maps to correct buffer position that src.start would produce after lead
    // For positive lead, buffer starts at startWhen = ctxTime + lead/1000 =8.2, so at ctxNow 8.8 buffer elapsed 600ms -> matches pos
    const startWhen = ctxTime + leadAfter / 1000;
    expect(startWhen).toBeCloseTo(8.2, 6);
    expect(ctxNow - startWhen).toBeCloseTo(0.6, 6);
  });

  it('Step1 capture negative lead branch (audioOffset 0 manual -80) → Step2 compute pos → Step3 assert matches src.start offset logic', () => {
    setManualOffset(-80);
    expect(getManualOffsetMs()).toBe(-80);
    const audioOffset = 0;
    const lead = audioOffset + getManualOffsetMs(); // -80
    expect(lead).toBe(-80);
    // playFrom negative: startWhen = ctxTime, startOffset = fromMs/1000 - lead/1000 = fromMs/1000 +0.08
    const fromMs = 1000;
    const audioTime = fromMs / 1000; //1.0
    const offsetSec = lead / 1000; // -0.08
    let startOffset: number;
    let startWhen: number;
    const ctxTime = 10.0;
    if (offsetSec >= 0) {
      startWhen = ctxTime + offsetSec;
      startOffset = audioTime;
    } else {
      startWhen = ctxTime;
      startOffset = Math.max(0, audioTime - offsetSec);
    }
    expect(startOffset).toBeCloseTo(1.08, 6);
    expect(startWhen).toBeCloseTo(10.0, 6);
    // Green bar pos: startMs + delta - lead = 1000 + 200 - (-80) =1280 => buffer position matches?
    // At ctxNow 10.2 delta 200 => pos 1280 => 1.28s buffer time. Buffer elapsed = (ctxNow - startWhen)*1000 + startOffset*1000 - fromMs? Actually buffer elapsed from start: (ctxNow - startWhen)*1000 + startOffset*1000 =200+1080=1280 => matches pos.
    const startMs = fromMs;
    const startCtx = ctxTime;
    const ctxNow = 10.2;
    const pos = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, audioOffset, -80);
    expect(pos).toBeCloseTo(1280, 6);
  });
});

// ---------------------------------------------------------------------------
// T136-2: Recording taps use positionRef directly (no - manual)
// ---------------------------------------------------------------------------
describe('T136-2: 録音打刻は positionRef.current をそのまま使う（-getManualOffsetMs 補正撤廃）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture ring Space押下 beat at manual 0 → Step2 set manual +80 and compute both → Step3 assert correct unchanged vs buggy shifts', () => {
    const timeline = new BpmTimeline(120, [], 1.0); // 500ms/beat
    const snap = 0.25;
    const positionRef = 1237; // off-grid ms: 2.474 beats
    // Step1 at 0
    expect(getManualOffsetMs()).toBe(0);
    const beatAt0Correct = computeRecordBeatCorrect(timeline, positionRef, snap);
    const beatAt0Buggy = computeRecordBeatBuggy(timeline, positionRef, 0, snap);
    expect(beatAt0Correct).toBeCloseTo(beatAt0Buggy, 6);
    // Step2 set +80
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const beatCorrect = computeRecordBeatCorrect(timeline, positionRef, snap);
    const beatBuggy = computeRecordBeatBuggy(timeline, positionRef, 80, snap);
    // Correct stays same (positionRef is already green bar real position, independent of manual)
    expect(beatCorrect).toBeCloseTo(beatAt0Correct, 6);
    expect(beatCorrect).not.toBeCloseTo(beatBuggy, 4);
    // Verify buggy shift: 1237-80=1157 => 2.314 beats => quant to 2.25 vs correct 2.5 => definitely shifted
    expect(beatBuggy).not.toEqual(beatCorrect);
    // File contract
    const src = readFile('src/screens/EditorScreen.tsx');
    // Should have NO occurrence of positionRef.current - getManualOffsetMs()
    const buggyOccurrences = (src.match(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/g) || []).length;
    expect(buggyOccurrences, 'EditorScreen must have 0 occurrences of "positionRef.current - getManualOffsetMs()" after fix (3 places removed)').toBe(0);
  });

  it('Step1 capture arrow release beat snap 0.5 bRel 1.2 vs 1.3 off-grid → Step2 switch manual → Step3 assert releaseBeat unchanged (correct) vs buggy would shift 0.16 beats', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    const cases: Array<{ bRel: number; expectedCorrect: number }> = [
      // 1.35 is off-grid and, at snap 0.5 with manual +80 (0.16 beats), the buggy
      // subtraction crosses a grid midpoint (1.35 -> 1.5) while the buggy value
      // (1.19 -> 1.0) lands on a different grid line, so the two are distinguishable.
      { bRel: 1.35, expectedCorrect: 1.5 },
      { bRel: 1.3, expectedCorrect: 1.5 },
    ];
    for (const c of cases) {
      const tapPos = timeline.beatToMs(c.bRel); // posRef is already real position, no manual subtraction
      // At manual 0 correct = quant(msToBeat(tapPos))
      setManualOffset(0);
      const correct0 = computeRecordBeatCorrect(timeline, tapPos, snap);
      expect(correct0).toBeCloseTo(c.expectedCorrect, 4);
      // At manual +80 buggy would compute tapPos -80
      setManualOffset(80);
      const correctAfter = computeRecordBeatCorrect(timeline, tapPos, snap);
      const buggyAfter = computeRecordBeatBuggy(timeline, tapPos, 80, snap);
      expect(correctAfter).toBeCloseTo(c.expectedCorrect, 4);
      expect(correctAfter).toBeCloseTo(correct0, 6); // manual invariant
      expect(buggyAfter).not.toBeCloseTo(correctAfter, 1); // buggy shifts
      expect(buggyAfter).toBeCloseTo(quantizeBeat(timeline.msToBeat(tapPos - 80), snap), 4);
    }
    // file: arrow release line must be const pos = positionRef.current
    const src = readFile('src/screens/EditorScreen.tsx');
    const arrowSectionIdx = src.indexOf("releaseBeat");
    expect(arrowSectionIdx).toBeGreaterThan(-1);
    const arrowSlice = src.slice(Math.max(0, arrowSectionIdx - 1200), arrowSectionIdx + 800);
    expect(arrowSlice).toContain('positionRef.current');
    expect(arrowSlice).not.toContain('getManualOffsetMs');
  });

  it('Step1 capture hold tail (ring Space離し) duration with manual 0 → Step2 set manual 80 → Step3 assert hold duration unchanged (correct) vs buggy differs', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const pressPos = timeline.beatToMs(1.0); // 500ms
    const releasePos = timeline.beatToMs(1.75); // 875ms duration 0.75 beats
    setManualOffset(0);
    const pressCorrect0 = computeRecordBeatCorrect(timeline, pressPos, snap);
    const releaseCorrect0 = computeRecordBeatCorrect(timeline, releasePos, snap);
    const durCorrect0 = Number(quantizeBeat(releaseCorrect0 - pressCorrect0, snap).toFixed(2));
    expect(durCorrect0).toBeCloseTo(0.75, 4);
    setManualOffset(80);
    const pressCorrect = computeRecordBeatCorrect(timeline, pressPos, snap);
    const releaseCorrect = computeRecordBeatCorrect(timeline, releasePos, snap);
    const durCorrect = Number(quantizeBeat(releaseCorrect - pressCorrect, snap).toFixed(2));
    const pressBuggy = computeRecordBeatBuggy(timeline, pressPos, 80, snap);
    const releaseBuggy = computeRecordBeatBuggy(timeline, releasePos, 80, snap);
    const durBuggy = Number(quantizeBeat(releaseBuggy - pressBuggy, snap).toFixed(2));
    // Correct stays same
    expect(durCorrect).toBeCloseTo(durCorrect0, 4);
    // Buggy also same difference if both shift equally? Actually for hold, both shift by same offset, so duration may stay same but start beat shifts -> rings misaligned.
    // So check start beat shift
    expect(pressCorrect).not.toBeCloseTo(pressBuggy, 3);
    expect(releaseCorrect).not.toBeCloseTo(releaseBuggy, 3);
    // File contract for hold tail
    const src = readFile('src/screens/EditorScreen.tsx');
    // The hold release section must NOT contain minus manual
    const holdIdx = src.indexOf('snapped - startBeat');
    expect(holdIdx).toBeGreaterThan(-1);
    const holdSlice = src.slice(Math.max(0, holdIdx - 1500), holdIdx + 500);
    expect(holdSlice).toContain('positionRef.current');
    // Ensure that specific hold pos line does NOT subtract
    const holdPosMatches = src.match(/const pos = positionRef\.current - getManualOffsetMs\(\)/g) || [];
    expect(holdPosMatches.length).toBe(0);
  });

  it('Step1 capture with varying snap 0.125/0.25/0.5/1 end-to-end (off-grid) → Step2 toggle manual 0↔80 → Step3 assert beats manual-invariant and snap-aligned', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const positions = [185, 615, 762, 1237]; // off-grid ms already representing real buffer position
    const snaps = [0.125, 0.25, 0.5, 1];
    for (const pos of positions) {
      for (const snap of snaps) {
        setManualOffset(0);
        const b0 = computeRecordBeatCorrect(timeline, pos, snap);
        setManualOffset(80);
        const b80 = computeRecordBeatCorrect(timeline, pos, snap);
        expect(b80, `pos ${pos} snap ${snap} manual invariant`).toBeCloseTo(b0, 6);
        expect(b80 % snap === 0 || Math.abs((b80 % snap) - snap) < 1e-6 || Math.abs(b80 % snap) < 1e-6).toBeTruthy();
        // buggy would differ at least for some positions where bucket boundary sensitive (pos 762 with snap 0.25)
        if (pos === 762 && snap === 0.25) {
          const buggy = computeRecordBeatBuggy(timeline, pos, 80, snap);
          expect(buggy).not.toBeCloseTo(b0, 6);
        }
      }
    }
  });

  it('Step1 capture file positionRef occurrences → Step2 verify ring Space押下 section → Step3 assert const pos = positionRef.current (no subtraction)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // ring Space press section
    const ringPressIdx = src.indexOf('spacePressBeatRef.current =');
    expect(ringPressIdx).toBeGreaterThan(-1);
    const ringSlice = src.slice(Math.max(0, ringPressIdx - 600), ringPressIdx + 600);
    expect(ringSlice).toContain('positionRef.current');
    expect(ringSlice).not.toContain('getManualOffsetMs');
    // Should be exactly const pos = positionRef.current
    expect(ringSlice).toMatch(/const pos\s*=\s*positionRef\.current/);
    expect(ringSlice).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
  });
});

// ---------------------------------------------------------------------------
// T136-3: audioOffset !=0 case — recording reflects buffer real position
// ---------------------------------------------------------------------------
describe('T136-3: audioOffset が0でない場合、録音がバッファ実位置に記録される（旧実装では audioOffset分ズレ）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture pos with audioOffset 0 → Step2 set audioOffset +200 manual +80 → Step3 assert ring beat = timeline.msToBeat(posCorrect) reflects real buffer', () => {
    // Simulate editor at ctxNow where green bar should be buffer position.
    const timeline = new BpmTimeline(120, [], 1.0); // 500ms/beat
    const snap = 0.25;
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 11.0; // 1000ms elapsed
    // Step1: audioOffset 0 manual 0 => pos 1000 => beat 2.0 => snaps 2.0
    const pos0 = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, 0, 0);
    expect(pos0).toBeCloseTo(1000, 6);
    const beat0 = computeRecordBeatCorrect(timeline, pos0, snap);
    expect(beat0).toBeCloseTo(2.0, 4);
    // Step2: audioOffset 200 manual 80 => pos 1000 -280=720 => beat 1.44 => snaps 1.5
    const pos200 = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, 200, 80);
    expect(pos200).toBeCloseTo(720, 6);
    const beat200 = computeRecordBeatCorrect(timeline, pos200, snap);
    expect(beat200).toBeCloseTo(1.5, 4);
    expect(beat200).not.toBeCloseTo(beat0, 4);
    // Buggy pos (ignores lead) would still be 1000 => 2.0, off by audioOffset+manual=280ms =0.56 beats
    const buggyPos = computeGreenBarPosBuggy(startMs, ctxNow, startCtx);
    expect(buggyPos).toBeCloseTo(1000, 6);
    const buggyBeat = computeRecordBeatCorrect(timeline, buggyPos, snap);
    expect(buggyBeat).toBeCloseTo(2.0, 4);
    expect(beat200).not.toBeCloseTo(buggyBeat, 4);
    // File contract: tick's leadMs includes audioOffset
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    expect(tick).toContain('audioOffset');
  });

  it('Step1 capture audioOffset 200 manual 0 → Step2 toggle manual to 80 → Step3 assert recording beat invariant to manual but sensitive to audioOffset via green bar', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    const startMs = 500; // start from 500ms in timeline
    const startCtx = 12.0;
    const ctxNow = 12.67; // 670ms elapsed
    // audioOffset 200 manual 0 => pos = 500+670-200=970 => beat 1.94 => snap 2.0
    const posA = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, 200, 0);
    expect(posA).toBeCloseTo(970, 6);
    const beatA = computeRecordBeatCorrect(timeline, posA, snap);
    // audioOffset 200 manual 80 => pos =500+670-280=890 => beat 1.78 => snap 2.0 also? Need off-grid sensitive case: 615ms region
    const posB = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, 200, 80);
    expect(posB).toBeCloseTo(890, 6);
    // Both should differ from buggy 1170 (500+670)
    const buggy = computeGreenBarPosBuggy(startMs, ctxNow, startCtx);
    expect(buggy).toBeCloseTo(1170, 6);
    expect(posA).not.toBeCloseTo(buggy, 3);
    expect(posB).not.toBeCloseTo(buggy, 3);
    // For audioOffset test, we want to prove audioOffset portion causes shift: pos with audioOffset 0 vs 200 differs by 200ms
    const posZeroAudio = computeGreenBarPosCorrect(startMs, ctxNow, startCtx, 0, 0);
    expect(posZeroAudio - posA).toBeCloseTo(200, 6); // 1170-970=200
    // And manual portion: posA - posB = 80
    expect(posA - posB).toBeCloseTo(80, 6);
  });

  it('Step1 capture continuous trajectory beat is msToBeat(pos) with fixed green bar → Step2 simulate 1.2 beats off-grid → Step3 assert snapped to 1.0 vs 1.5 handling with audioOffset', () => {
    // T136 says continuous trajectory (:378-380) is automatically correct after tick fix because it uses pos beat.
    // Verify that with audioOffset shift, trajectory beats also shift accordingly (since they derive from corrected pos).
    const timeline = new BpmTimeline(120, [], 1.0);
    const snap = 0.5;
    // raw 1.2 beats =600ms, with audioOffset 200 manual 80 => real pos =600-280=320? That's not correct framing.
    // Instead choose a posRef that already is corrected green bar position: e.g., pos = timeline.beatToMs(1.2) + some offset then quantize
    // With fixed pos, beat =1.2 snaps 1.0; buggy would be 1.2+0.56=1.76 snap 2.0 -> difference.
    const realPos = timeline.beatToMs(1.2); // 600ms
    const buggyPosStill = realPos + 200 + 80; // if buggy green bar 280 ahead, buggy pos would be larger
    const correctBeat = computeRecordBeatCorrect(timeline, realPos, snap);
    const buggyBeat = computeRecordBeatCorrect(timeline, buggyPosStill, snap);
    expect(correctBeat).toBeCloseTo(1.0, 4);
    expect(buggyBeat).toBeCloseTo(2.0, 4);
    expect(correctBeat).not.toBeCloseTo(buggyBeat, 4);
    // off-grid 1.3 => 1.5
    const realPos13 = timeline.beatToMs(1.3); //650ms
    expect(computeRecordBeatCorrect(timeline, realPos13, snap)).toBeCloseTo(1.5, 4);
  });
});

// ---------------------------------------------------------------------------
// T136-4: Regression — T132, T102/T103, T129, T133, GameScreen unchanged
// ---------------------------------------------------------------------------
describe('T136-4: 回帰なし（T132, T102/T103, T129, T133, GameScreen不変）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture T132 offset fine-tuning ,/< -10 and ./> +10 still present → Step2 simulate adjust → Step3 file contract holds', () => {
    expect(getManualOffsetMs()).toBe(0);
    const adjust = (delta: number) => {
      const next = Math.round(getManualOffsetMs() + delta);
      setManualOffset(next);
      return next;
    };
    // Simulate ',' press
    const afterComma = adjust(-10);
    expect(afterComma).toBe(-10);
    expect(getManualOffsetMs()).toBe(-10);
    const afterDot = adjust(10);
    expect(afterDot).toBe(0);
    // File still contains handlers
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("e.key === ','");
    expect(src).toContain("e.key === '<'");
    expect(src).toContain("e.key === '.'");
    expect(src).toContain("e.key === '>'");
    expect(src).toMatch(/getManualOffsetMs\(\)\s*-\s*10/);
    expect(src).toMatch(/getManualOffsetMs\(\)\s*\+\s*10/);
    expect(src).toContain('data-testid="editor-offset"');
  });

  it('Step1 capture T102/T103 play-mode guard → Step2 check file → Step3 assert modeRef guard still exists for recording taps', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Ring/segment stamping must still be guarded by mode === record
    expect(src).toContain("modeRef.current === 'record'");
    expect(src).toMatch(/if\s*\(\s*modeRef\.current === 'record'/);
    const guardCount = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    // And no regression: positionRef - manual must NOT appear even in guarded section (already removed)
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/);
    // CalibrationModal still exists and holds its file contract
    const modalExists = fs.existsSync(path.resolve(__dirname, '../src/screens/editor/CalibrationModal.tsx'));
    expect(modalExists).toBe(true);
    const modalSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(modalSrc).toContain('setManualOffset(0)');
    expect(modalSrc).toContain('data-testid="editor-calibration-modal"');
  });

  it('Step1 capture T129 snap整合性 segmentize beats snap整数倍 → Step2 produce off-grid 0.30 snap 0.25 → Step3 still snap-aligned', () => {
    const snap = 0.25;
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.30, y: TW_CENTER_Y + 40, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      const aligned = rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
      expect(aligned, `beats ${s.beats} snap ${snap}`).toBeTruthy();
    }
    // Must NOT be forced to 1/amplitude=1.0 when snap smaller
    const total = segs.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
    expect(total).toBeCloseTo(0.25, 4);
    expect(total).not.toBeCloseTo(1.0, 4);
  });

  it('Step1 capture T133 calibration overlay full-screen (route removed) → Step2 check App.tsx → Step3 assert /calibration route absent', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    // CalibrationModal still referenced from EditorScreen and SelectScreen
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toContain('CalibrationModal');
    const selectSrc = readFile('src/screens/SelectScreen.tsx');
    // SelectScreen should not navigate to /calibration anymore (should use overlay)
    expect(selectSrc).not.toMatch(/navigate\(['"]\/calibration['"]\)/);
  });

  it('Step1 capture GameScreen unchanged → Step2 check GameScreen playMusic still uses (audioOffsetMs + getManualOffsetMs()) → Step3 assert not modified to green bar logic', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // GameScreen playMusic must still be (audioOffsetMs + getManualOffsetMs())/1000 (T135) – not green bar
    expect(gameSrc).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    // GameScreen should NOT have green bar pos logic with audioOffset + manual (that's editor only)
    // It should NOT contain startMsRef (editor var) and no positionRef subtraction
    expect(gameSrc).not.toContain('startMsRef');
    expect(gameSrc).not.toContain('positionRef.current - getManualOffsetMs()');
    // Ensure GameScreen still imports getManualOffsetMs for playMusic (unchanged)
    expect(gameSrc).toMatch(/import.*getManualOffsetMs.*from.*clock/);
    // Ensure clock/metronome unchanged: clock still has offsetSeconds returning manual/1000
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toContain('return manualOffsetMs / 1000');
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds()');
    expect(metroSrc).toMatch(/nextBeatTime \+ offsetSeconds\(\)/);
  });

  it('Step1 capture editor offset display still reflects getManualOffsetMs → Step2 set +40 → Step3 assert display logic still uses offsetMs state', () => {
    setManualOffset(40);
    expect(getManualOffsetMs()).toBe(40);
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('useState(getManualOffsetMs()');
    expect(src).toContain('setOffsetMs');
    expect(src).toContain('data-testid="editor-offset"');
    // Verify that offset display format still exists
    expect(src).toContain('offset:');
    // Reset
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T136-5: WaveEngine / Cursor consistency (T127/T128) regression — complex amplitudes off-grid
// ---------------------------------------------------------------------------
describe('T136-5: 回帰 WaveEngine/Cursor 数値整合（複雑振幅 off-grid, T127/T128維持）', () => {
  const amps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23];

  it('Step1 capture amp 0.7 beat 0.37 → Step2 set amp 1.3 etc → Step3 assert waveYAt slope = 2*TW_AMP*amplitudeAt and clamped', () => {
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

  it('Step1 capture cursor at amp 1.3 dt 0.25s → Step2 advance → Step3 assert cursor delta == wave delta == perBeat*deltaBeats', () => {
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
    expect(cursorDelta).toBeCloseTo(perBeat * beatsDelta, 4);
    const waveDelta = Math.abs(engine.waveYAt(beatsDelta) - engine.waveYAt(0));
    // Top start clamped: top 170 bottom 430, amp 1.3 perBeat 338, 0.5*338=169 <260 so not clipped yet from top
    expect(waveDelta).toBeCloseTo(perBeat * beatsDelta, 4);
    expect(waveDelta).toBeCloseTo(cursorDelta, 4);
  });

  it('Step1 capture getPoints length invariant → Step2 vary segments → Step3 assert segments+1 holds after T136', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const cases = [
      [{ direction: 'down', beats: 1 } as const],
      [{ direction: 'up', beats: 0.5 } as const, { direction: 'down', beats: 0.5 } as const, { direction: 'stay', beats: 1 } as const],
      [] as any[],
    ];
    for (const segs of cases) {
      const eng = new WaveEngine(segs as any, tl, 1.0, 0);
      const pts = eng.getPoints();
      if (segs.length === 0) expect(pts.length).toBe(2);
      else expect(pts.length).toBe(segs.length + 1);
      for (const p of pts) {
        expect(typeof p.beat).toBe('number');
        expect(typeof p.y).toBe('number');
      }
    }
  });

  it('Step1 capture off-grid trajectory quantize 1.2→1.0 and 1.3→1.5 snap 0.5 → Step2 segmentize → Step3 assert still snap-aligned after green bar fix', () => {
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
    // With snap 0.5, 1.2 quant to 1.0
    expect(totalMoving).toBeCloseTo(1.0, 4);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// T136-6: tsc --noEmit guard and green bar end detection also uses leadMs
// ---------------------------------------------------------------------------
describe('T136-6: tsc & end detection pos >= endMsRef uses same corrected pos', () => {
  it('Step1 capture end detection before → Step2 verify tick uses same corrected pos for pose >= endMsRef → Step3 file contract tick end check uses leadMs', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickSlice(src);
    // tick must have if (pos >= endMsRef.current)
    expect(tick).toContain('endMsRef.current');
    expect(tick).toMatch(/if\s*\(\s*pos\s*>=\s*endMsRef\.current/);
    // And pos there must be the corrected one (same variable)
    expect(tick).toContain('getManualOffsetMs');
    // stop() also clamps with same corrected pos
    const stopSlice = getStopSlice(src);
    expect(stopSlice).toContain('buffer.duration');
    expect(stopSlice).toContain('getManualOffsetMs');
  });

  it('EditorScreen imports getManualOffsetMs once and does not duplicate offset addition', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/import.*getManualOffsetMs.*from.*clock/);
    // Ensure playFrom still has one fixed offsetSec line
    const playFromFixed = (src.match(/\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/g) || []).length;
    expect(playFromFixed).toBe(1);
    // Tick and stop should not reintroduce offsetSec double addition – they use leadMs subtraction, not offsetSec
    // But they must contain audioOffset + manual pattern at least via leadMs
    const leadOccurrences = (src.match(/audioOffset(?:Ref\.current)?\s*\+\s*getManualOffsetMs\(\)/g) || []).length;
    // Expect at least 2 (tick + stop + playFrom = 3, but playFrom already 1, tick+stop 2 => total 3). If using leadMs variable once, may be 2 distinct lines.
    expect(leadOccurrences).toBeGreaterThanOrEqual(2);
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
  });
});
