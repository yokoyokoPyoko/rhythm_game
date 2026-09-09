import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { calculateVertexDrag, calculateVertexMultiDrag, calculateEdgeDrag, calculateMultiDrag } from '../src/game/editorDrag';
import { Cursor } from '../src/game/cursor';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;
const ZONE_MID_START = 256.7;
const ZONE_MID_END = 343.3;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}
function ceilBeat(x: number, snap: number): number {
  if (!(snap > 0) || !Number.isFinite(x)) return Math.max(0, x);
  const n = Math.max(0, x);
  return Number((Math.ceil(n / snap - 1e-9) * snap).toFixed(4));
}
function zoneOf(y: number): 0 | 1 | 2 {
  return y < ZONE_MID_START ? 0 : y < ZONE_MID_END ? 1 : 2;
}
function snapY(y: number): number {
  const z = zoneOf(y);
  return z === 0 ? TOP : z === 1 ? CENTER : BOTTOM;
}
function readSrc(p: string): string {
  return fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
}
function makeTimeline(amp: number, extra: any[] = []): BpmTimeline {
  const base = [{ beat: 0, bpm: 120, amplitude: amp } as any, ...extra];
  return new BpmTimeline(base as any, amp);
}

describe('T216 頂点ドラッグXハイジャック解消（静止Xゲート）— Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------------
  // 0. Source guards — must FAIL before T216 (Red), PASS after (Green)
  // Prohibited: quantizeBeat for need, const reassigned; Required: ceilBeat, stationary gate
  // ------------------------------------------------------------------
  describe('0. Source fix guards (T215 unconditional -> T216 stationary gate)', () => {
    it('editorDrag.ts must use let clampedBeat (not const with later reassignment)', () => {
      const src = readSrc('src/game/editorDrag.ts');
      const hasLet = /let\s+clampedBeat/.test(src);
      const hasConstReassign = /const\s+clampedBeat[\s\S]*?clampedBeat\s*=/.test(src);
      expect(hasLet, 'T216: endpoint clampedBeat must be let (reassigned under gate)').toBe(true);
      expect(hasConstReassign, 'should not have const clampedBeat with later assignment').toBe(false);
    });
    it('editorDrag.ts must implement ceilBeat (round-up) for Y reachability, not quantizeBeat(needRaw)', () => {
      const src = readSrc('src/game/editorDrag.ts');
      expect(src).toMatch(/function ceilBeat/);
      expect(src).toMatch(/Math\.ceil/);
      expect(src).not.toMatch(/quantizeBeat\(needRaw/);
    });
    it('editorDrag.ts calculateVertexDrag must contain stationary X gate (quantized target vs current)', () => {
      const src = readSrc('src/game/editorDrag.ts');
      // Gate pattern: only when quantized target equals current beat should shift be allowed.
      // Look for comparison of targetBeat quantization with pts[idx].beat or prev-equivalent, gating need-shift.
      // Before T216 no such gate exists; after T216 it must exist in interior and endpoint branches.
      const hasInteriorGate = /quantizeBeat\(targetBeat.*\)[\s\S]*?pts\[idx\]\.beat/.test(src) || /pts\[idx\]\.beat[\s\S]*?quantizeBeat\(targetBeat/.test(src);
      // Endpoint gate variant: nextBeat - seg0.beats or current last beat
      const hasEndpointGate = /nextBeat\s*-\s*.*beats/.test(src) && /quantizeBeat\(targetBeat/.test(src);
      // At minimum one of the interior gate forms must be present
      expect(hasInteriorGate, 'interior must gate shift on quantized target == current beat (stationary)').toBe(true);
      // Check that need-shift is inside a conditional that checks stationary (not unconditional)
      // Heuristic: the interior need>mouse block should be inside an if that checks stationary
      const hasGatedNeed = /if\s*\(.*quantizeBeat\(targetBeat/.test(src) || /if\s*\(.*stationary/.test(src) || /stationary/.test(src);
      expect(hasGatedNeed, 'need>mouse shift must be gated by stationary check').toBe(true);
      expect(hasEndpointGate, 'endpoint must also gate on nextBeat-segBeats or current last beat').toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 1. Horizontal drag (X variable, same or crossing zone) must strictly reproduce mouse X
  //    Current T215 unconditional shift hijacks X to prev+need or next-snap.
  // ------------------------------------------------------------------
  describe('1. Horizontal drag X fidelity (X variable -> no hijack, even with zone-cross Y)', () => {
    const snap = 0.25;
    const amp = 1.0;
    const perBeat = 2 * TW_AMP * amp; // 260
    // need TOP from CENTER = 130/260=0.5
    const needTop = Math.max(snap, ceilBeat(Math.abs(TOP - CENTER) / perBeat, snap));

    it('interior: diagonal with small X (0.25) and TOP demand must stay at 0.25, not hijacked to need 0.5 (off-grid 0.37 variant)', () => {
      // [Step1: Capture Initial State]
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 2; // beat 2.0
      const prevBeat = pts0[idx - 1].beat; // 1.0
      const nextBeat = pts0[idx + 1].beat; // 3.0
      const mouseBeat = quantizeBeat(prevBeat + 0.25, snap); // 1.25 (small)
      const stationaryBeat = quantizeBeat(pts0[idx].beat, snap); // 2.0
      expect(mouseBeat).not.toBe(stationaryBeat); // X variable
      expect(needTop).toBe(0.5);
      expect(needTop).toBeGreaterThan(0.25);

      // [Step2: Perform Interaction] diagonal: X variable + zone-cross Y
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: mouseBeat,
        targetY: TOP, // demands Y shift, need 0.5
        snap,
      });
      expect(result, 'horizontal diagonal must not be null').not.toBeNull();
      const segs = result!;

      // [Step3: Assert Resulting Transition] X strictly reproduced
      const engine1 = new WaveEngine(segs, tl, amp, 0);
      const pts1 = engine1.getPoints();
      expect(pts1.length).toBe(pts0.length);
      for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
      // Achieved beat must equal mouse quantized, NOT shifted to prev+need (1.5)
      expect(Math.abs(pts1[idx].beat - mouseBeat)).toBeLessThan(1e-6);
      // Must NOT be hijacked to need location
      const hijackedBeat = prevBeat + needTop; // 1.5
      expect(Math.abs(pts1[idx].beat - hijackedBeat)).toBeGreaterThan(0.1);
      // Direction still best-effort (TOP zone) but beats not hijacked
      // For this X, Y best-effort: direction up but beats stays mouse
      expect(segs[idx - 1].beats).toBeCloseTo(quantizeBeat(mouseBeat - prevBeat, snap), 4);
    });

    it('interior: horizontal X variable with BOTTOM demand also not hijacked (amp 1.0)', () => {
      // [Step1]
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 2;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const mouseBeat = quantizeBeat(prevBeat + 0.25, snap);
      const stationaryBeat = quantizeBeat(engine0.getPoints()[idx].beat, snap);
      expect(mouseBeat).not.toBe(stationaryBeat);

      // [Step2]
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: mouseBeat,
        targetY: BOTTOM,
        snap,
      });
      expect(result).not.toBeNull();
      // [Step3]
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[idx].beat - mouseBeat)).toBeLessThan(1e-6);
      expect(Math.abs(pts1[idx].beat - (prevBeat + needTop))).toBeGreaterThan(0.1);
    });

    it('interior: off-grid mouse 1.23 with TOP demand must track X, not maxAvail', () => {
      // [Step1]
      const snap2 = 0.5;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1; // beat 2.0
      const prevBeat = engine0.getPoints()[idx - 1].beat; // 0
      const nextBeat = engine0.getPoints()[idx + 1].beat; // 4.0
      // off-grid 0.37 quantize 0.5, 1.23 quantize 1.0 with snap 0.5
      const raw = 1.23;
      const mouseBeat = quantizeBeat(prevBeat + raw, snap2); // 1.0? actually 0+1.23 ->1.0
      const stationary = quantizeBeat(engine0.getPoints()[idx].beat, snap2); // 2.0
      expect(mouseBeat).not.toBe(stationary);
      // [Step2]
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: mouseBeat,
        targetY: TOP,
        snap: snap2,
      });
      expect(result).not.toBeNull();
      // [Step3]
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[idx].beat - mouseBeat)).toBeLessThan(1e-6);
      // Ensure not hijacked to prev+need (0.5) nor maxAvail
      const maxAvail = nextBeat - snap2 - prevBeat;
      expect(Math.abs(pts1[idx].beat - (prevBeat + maxAvail))).toBeGreaterThan(0.1);
    });

    it('interior: pure horizontal within same zone (no Y demand) tracks X exactly', () => {
      // [Step1] same zone Y => no need, but still verify X not collapsed to need
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1; // beat 1.0
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const nextBeat = engine0.getPoints()[idx + 1].beat;
      const mouseBeat = quantizeBeat(prevBeat + 0.37, snap); // 0.25? actually 0.37->0.25
      const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, mouseBeat));
      const sameZoneY = CENTER + 5; // still CENTER zone (256.7-343.3)
      expect(zoneOf(sameZoneY)).toBe(zoneOf(CENTER));
      // [Step2]
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: clamped,
        targetY: sameZoneY,
        snap,
      });
      expect(result).not.toBeNull();
      // [Step3]
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[idx].beat - clamped)).toBeLessThan(1e-6);
      for (const s of result!) expect(isSnapAligned(s.beats, snap)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 2. Pure vertical drag (X stationary) must retain T215 reachability
  // ------------------------------------------------------------------
  describe('2. Pure vertical drag retains T215 reachability (stationary X gate)', () => {
    it('interior stationary X with TOP demand in narrow span shifts to need (off-grid Y 200.37)', () => {
      // [Step1: Capture Initial State] narrow span where need > current tiny mouse equivalent
      const snap = 0.25;
      const amp = 1.0;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 2; // at beat 1.25 ? let's compute: 0,1.0,1.25,2.25
      const actualIdx = 2;
      const prevBeat = pts0[actualIdx - 1].beat; // 1.0
      const nextBeat = pts0[actualIdx + 1].beat; // 2.25
      const curBeat = pts0[actualIdx].beat; // 1.25
      const yPrev = pts0[actualIdx - 1].y; // CENTER
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / perBeat, snap)); // 0.5
      expect(need).toBe(0.5);
      // Current distance from prev to cur is 0.25 < need, so stationary TOP requires shift
      const curDist = curBeat - prevBeat;
      expect(curDist).toBe(0.25);
      expect(need).toBeGreaterThan(curDist);
      const stationaryBeat = quantizeBeat(curBeat, snap);
      // [Step2: Perform Interaction] pure vertical: same beat, zone-cross Y
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: actualIdx,
        targetBeat: stationaryBeat, // stationary X
        targetY: 200.37, // TOP zone off-grid
        snap,
      });
      expect(result).not.toBeNull();
      const segs = result!;
      // [Step3: Assert Resulting Transition] shifted to need
      for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
      const engine1 = new WaveEngine(segs, tl, amp, 0);
      const pts1 = engine1.getPoints();
      expect(Math.abs(pts1[actualIdx].beat - (prevBeat + need))).toBeLessThan(1e-6);
      expect(pts1[actualIdx].y).toBeCloseTo(TOP, 6);
      expect(segs[actualIdx - 1].beats).toBeCloseTo(need, 4);
      expect(segs[actualIdx - 1].direction).toBe('up');
    });

    it('interior stationary X with BOTTOM demand shifts symmetrically (off-grid)', () => {
      // [Step1]
      const snap = 0.25;
      const amp = 1.0;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 2;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const curBeat = engine0.getPoints()[idx].beat;
      const yPrev = engine0.getPoints()[idx - 1].y;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const need = Math.max(snap, ceilBeat(Math.abs(BOTTOM - yPrev) / perBeat, snap));
      expect(need).toBeGreaterThan(curBeat - prevBeat);
      // [Step2]
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: quantizeBeat(curBeat, snap),
        targetY: BOTTOM, // bottom zone
        snap,
      });
      expect(result).not.toBeNull();
      // [Step3]
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[idx].beat - (prevBeat + need))).toBeLessThan(1e-6);
      expect(pts1[idx].y).toBeCloseTo(BOTTOM, 6);
    });

    it('interior stationary with complex amp 1.3 and snap 0.5 off-grid phase', () => {
      // [Step1]
      const snap = 0.5;
      const amp = 1.3;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 0.5 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 2;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const curBeat = engine0.getPoints()[idx].beat;
      const perBeat = 2 * TW_AMP * amp;
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - CENTER) / perBeat, snap));
      // [Step2] stationary
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: quantizeBeat(curBeat, snap),
        targetY: TOP,
        snap,
      });
      expect(result).not.toBeNull();
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      // need for amp1.3: 130/338≈0.384 ceil to 0.5 => 0.5, current dist 0.5 equals need, no shift beyond but still reaches
      expect(isSnapAligned(result![idx - 1].beats, snap)).toBe(true);
      if (need > curBeat - prevBeat + 1e-9) {
        expect(Math.abs(pts1[idx].beat - (prevBeat + need))).toBeLessThan(1e-6);
      }
    });

    it('stationary must use ceilBeat not quantizeBeat: need 0.714 beats with snap 0.5 must round up to 1.0', () => {
      // This distinguishes ceil (must reach) vs quantize (would under-shoot to 0.5)
      // Choose amp 0.7: perBeat 182, TOP diff 130 => 0.714..., ceil to 1.0, quantize would give 0.5
      const snap = 0.5;
      const amp = 0.7;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 0.5 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 2; // narrow 0.5 distance, need 1.0 >0.5
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const yPrev = engine0.getPoints()[idx - 1].y;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const needCeil = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / perBeat, snap));
      const needQuant = Math.max(snap, quantizeBeat(Math.abs(TOP - yPrev) / perBeat, snap));
      expect(needCeil).toBe(1.0);
      expect(needQuant).toBe(0.5); // would under-shoot
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: quantizeBeat(engine0.getPoints()[idx].beat, snap),
        targetY: TOP,
        snap,
      });
      expect(result).not.toBeNull();
      expect(result![idx - 1].beats).toBeCloseTo(needCeil, 4);
      expect(result![idx - 1].beats).not.toBeCloseTo(needQuant, 4);
    });
  });

  // ------------------------------------------------------------------
  // 3. Endpoint stationary gates
  // ------------------------------------------------------------------
  describe('3. Endpoint vertex gates (first and last)', () => {
    it('first vertex: stationary-equivalent (clampedBeat==next-segBeats) with TOP demand shifts, X variable does not', () => {
      // [Step1]
      const snap = 0.25;
      const amp = 1.0;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.5 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const nextBeat = pts0[1].beat; // 0.5
      const seg0Beats = initial[0].beats;
      const stationaryClamped = nextBeat - seg0Beats; // 0
      const y0 = pts0[0].y; // CENTER
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(0);
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - y0) / perBeat, snap)); // 0.5
      expect(need).toBe(0.5);
      // narrow: nextBeat 0.5, need 0.5 equals total span, so stationary should keep 0.5, but small mouse would need shift?
      // Use smaller seg0 to trigger need>mouse: create initial with seg0 0.25 (mouse 0.25 distance 0.25 < need 0.5)
      const initialNarrow: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'up', beats: 1 },
      ];
      const engineN = new WaveEngine(initialNarrow, tl, amp, 0);
      const nextN = engineN.getPoints()[1].beat; // 0.25
      const stationaryN = nextN - initialNarrow[0].beats; // 0
      // stationary case: targetBeat stationary (0)
      const resStationary = calculateVertexDrag({
        segments: initialNarrow,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 0,
        targetBeat: quantizeBeat(stationaryN, snap),
        targetY: TOP,
        snap,
      });
      expect(resStationary).not.toBeNull();
      // need > beats (0.5 >0.25) and stationary so should shift to need
      expect(resStationary![0].beats).toBeCloseTo(need, 4);

      // X variable case: targetBeat = next - snap =0.0? Actually next 0.25 next-snap=0.0 => clamp?
      // Let's use wider initial for X variable test: initial with seg 0.5, X variable 0.25 distance
      const mouseBeatVar = quantizeBeat(nextBeat - snap, snap); // 0.25 for initial 0.5? wait next 0.5 next-snap 0.25
      expect(mouseBeatVar).not.toBe(stationaryClamped); // X variable
      const resVar = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 0,
        targetBeat: mouseBeatVar,
        targetY: TOP, // demands need 0.5, but X variable => should NOT hijack to 0.5? Actually mouse gives 0.25 < need 0.5 but X variable => stay 0.25
        snap,
      });
      expect(resVar).not.toBeNull();
      expect(resVar![0].beats).toBeCloseTo(quantizeBeat(nextBeat - mouseBeatVar, snap), 4);
      expect(Math.abs(resVar![0].beats - need)).toBeGreaterThan(0.1);
    });

    it('last vertex: stationary X with BOTTOM demand shifts to need, X variable does not', () => {
      // [Step1]
      const snap = 0.25;
      const amp = 0.7;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 0.25 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const n = pts0.length - 1;
      const prevBeat = pts0[n - 1].beat; // 1.0
      const curBeat = pts0[n].beat; // 1.25
      const yPrev = pts0[n - 1].y; // CENTER
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const need = Math.max(snap, ceilBeat(Math.abs(BOTTOM - yPrev) / perBeat, snap));
      // For amp 0.7 need ~0.75, current 0.25 < need so stationary should expand
      expect(need).toBeGreaterThan(curBeat - prevBeat);
      // [Step2] stationary
      const resStat = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: n,
        targetBeat: quantizeBeat(curBeat, snap),
        targetY: BOTTOM,
        snap,
      });
      expect(resStat).not.toBeNull();
      expect(resStat![resStat!.length - 1].beats).toBeCloseTo(need, 4);
      // [Step3] X variable: move to 1.5 (prev 1.0 +0.5) demand BOTTOM but X moving => stay at 0.5 not hijacked to 0.75
      const mouseVar = quantizeBeat(prevBeat + 0.5, snap);
      expect(mouseVar).not.toBe(quantizeBeat(curBeat, snap));
      const resVar = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: n,
        targetBeat: mouseVar,
        targetY: BOTTOM,
        snap,
      });
      expect(resVar).not.toBeNull();
      expect(resVar![resVar!.length - 1].beats).toBeCloseTo(quantizeBeat(mouseVar - prevBeat, snap), 4);
      expect(Math.abs(resVar![resVar!.length - 1].beats - need)).toBeGreaterThan(0.1);
    });
  });

  // ------------------------------------------------------------------
  // 4. T215 reproduction harness with X fidelity assertion (including endpoints)
  // ------------------------------------------------------------------
  describe('4. T215 harness + X fidelity across all combinations (amp, snap, distance, height, endpoints)', () => {
    const amps = [0.7, 1.0, 1.3, 2.7] as const;
    const snaps = [0.25, 0.5] as const;
    const distances = [0.25, 0.5, 0.75, 1.0, 1.23]; // from prev
    const heights: Array<{ y: number; name: string }> = [
      { y: TOP, name: 'TOP' },
      { y: CENTER, name: 'CENTER' },
      { y: BOTTOM, name: 'BOTTOM' },
    ];

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const h of heights) {
          it(`amp=${amp} snap=${snap} height=${h.name}: sweep retains X fidelity or T215 reachability (no freeze)`, () => {
            // [Step1] narrow-ish span
            const tl = makeTimeline(amp);
            const initial: Segment[] = [
              { direction: 'stay', beats: 1 },
              { direction: 'stay', beats: 0.25 },
              { direction: 'stay', beats: 1 },
              { direction: 'stay', beats: 0.25 },
              { direction: 'stay', beats: 1 },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const idx = 2; // at 1.25 (narrow)
            const prevBeat = engine0.getPoints()[idx - 1].beat; // 1.0
            const nextBeat = engine0.getPoints()[idx + 1].beat; // 2.25
            const curBeat = engine0.getPoints()[idx].beat; // 1.25
            const yPrev = engine0.getPoints()[idx - 1].y;
            const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
            const need = Math.max(snap, ceilBeat(Math.abs(snapY(h.y) - yPrev) / perBeat, snap));

            const achieved: number[] = [];
            for (const d of distances) {
              const rawTarget = prevBeat + d;
              const targetBeat = quantizeBeat(rawTarget, snap);
              const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
              const isStationary = Math.abs(clamped - quantizeBeat(curBeat, snap)) < 1e-9;
              // T157 no-op skip
              if (Math.abs(clamped - curBeat) < 1e-9 && Math.abs(h.y - engine0.getPoints()[idx].y) < 1e-9) continue;
              const result = calculateVertexDrag({
                segments: initial,
                bpmTimeline: tl,
                startPosition: 0,
                pointIndex: idx,
                targetBeat: clamped,
                targetY: h.y,
                snap,
              });
              expect(result).not.toBeNull();
              const engine1 = new WaveEngine(result!, tl, amp, 0);
              const beatAchieved = engine1.getPoints()[idx].beat;
              achieved.push(beatAchieved);
              // X fidelity assertion: if not stationary, beat must equal clamped (not hijacked)
              if (!isStationary && h.y !== CENTER && need > d + 1e-9 && need <= (nextBeat - prevBeat - snap) + 1e-9) {
                // For X variable, should NOT be shifted to need
                expect(Math.abs(beatAchieved - clamped)).toBeLessThan(1e-6);
                // Old bug would shift to prev+need
                expect(Math.abs(beatAchieved - (prevBeat + need))).toBeGreaterThan(0.01);
              }
              // If stationary and need > d, must shift to need
              if (isStationary && need > (curBeat - prevBeat) + 1e-9) {
                expect(beatAchieved).toBeCloseTo(prevBeat + need, 4);
              }
              // invariants per step
              for (const s of result!) expect(isSnapAligned(s.beats, snap)).toBe(true);
              expect(engine1.getPoints().length).toBe(engine0.getPoints().length);
            }
            // monotonic non-decreasing
            for (let i = 1; i < achieved.length; i++) {
              expect(achieved[i]).toBeGreaterThanOrEqual(achieved[i - 1] - 1e-9);
            }
          });
        }
      }
    }

    it('off-grid 0.37 vs 0.87 must give distinct beats (not collapsed) with zone-cross Y', () => {
      const amp = 2.7;
      const snap = 0.25;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const t1 = quantizeBeat(prevBeat + 0.37, snap);
      const t2 = quantizeBeat(prevBeat + 0.87, snap);
      const r1 = calculateVertexDrag({ segments: initial, bpmTimeline: tl, startPosition: 0, pointIndex: idx, targetBeat: t1, targetY: TOP, snap });
      const r2 = calculateVertexDrag({ segments: initial, bpmTimeline: tl, startPosition: 0, pointIndex: idx, targetBeat: t2, targetY: TOP, snap });
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      const b1 = new WaveEngine(r1!, tl, amp, 0).getPoints()[idx].beat;
      const b2 = new WaveEngine(r2!, tl, amp, 0).getPoints()[idx].beat;
      expect(Math.abs(b1 - t1)).toBeLessThan(1e-6);
      expect(Math.abs(b2 - t2)).toBeLessThan(1e-6);
      expect(b2).toBeGreaterThan(b1);
    });

    it('endpoint first: X variable not hijacked, stationary hijack retained (amp 1.3 snap 0.25 off-grid)', () => {
      const snap = 0.25;
      const amp = 1.3;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const nextBeat = engine0.getPoints()[1].beat; // 0.25
      // X variable: target 0.0? Actually clampedBeat = 0.5? Wait next 0.25, need bigger
      // For this test, use diagonal with TOP demand: stationary 0 -> need 0.5 >0.25 => would shift
      // X variable: choose clampedBeat = 0.0? That's stationary? Let's choose 0.25? Hmm
      // For first vertex, stationary is 0, variable is like 0.25? But clamped range is [snap, next-snap] => with next 0.25, range empty => null? Use wider initial for variable test
      const initialWide: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engW = new WaveEngine(initialWide, tl, amp, 0);
      const nextW = engW.getPoints()[1].beat; //1
      const mouseVar = quantizeBeat(nextW - 0.25, snap); //0.75 -> beats 0.25
      const resVar = calculateVertexDrag({
        segments: initialWide,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 0,
        targetBeat: mouseVar,
        targetY: 400.37, // BOTTOM zone
        snap,
      });
      expect(resVar).not.toBeNull();
      // With X variable (mouse 0.75 !=0) should stay at 0.25 beats, not hijacked to need 0.5
      expect(resVar![0].beats).toBeCloseTo(quantizeBeat(nextW - mouseVar, snap), 4);
    });
  });

  // ------------------------------------------------------------------
  // 5. Invariants: length, snap, only 2 segments changed, posterior immobility
  // ------------------------------------------------------------------
  describe('5. Invariants: getPoints length, snap, 2-segment scope, posterior shift', () => {
    it('interior drag changes exactly 2 segments, others bit-exact, total span preserved (amp 2.7 off-grid)', () => {
      // [Step1]
      const amp = 2.7;
      const snap = 0.25;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 2;
      const prevBeat = pts0[idx - 1].beat;
      const nextBeat = pts0[idx + 1].beat;
      const targetBeat = quantizeBeat(prevBeat + 0.63, snap);
      const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
      // [Step2] choose same zone Y to keep pure X (no shift)
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: clamped,
        targetY: engine0.getPoints()[idx].y, // stationary Y but X moves -> no hijack
        snap,
      });
      expect(result).not.toBeNull();
      const segs = result!;
      // [Step3]
      expect(segs.length).toBe(initial.length);
      expect(new WaveEngine(segs, tl, amp, 0).getPoints().length).toBe(pts0.length);
      for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
      for (let k = 0; k < initial.length; k++) {
        if (k === idx - 1 || k === idx) continue;
        expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
        expect(segs[k].direction).toBe(initial[k].direction);
      }
      const spanOrig = nextBeat - prevBeat;
      const spanNew = segs[idx - 1].beats + segs[idx].beats;
      expect(Math.abs(spanNew - spanOrig)).toBeLessThan(1e-6);
      const pts1 = new WaveEngine(segs, tl, amp, 0).getPoints();
      for (let i = idx + 1; i < pts0.length; i++) {
        expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
      }
    });

    it('all beats remain snap multiples across off-grid drags (snap 0.125/0.25/0.5/1 amp 0.7/1.3/2.7)', () => {
      const snaps = [0.125, 0.25, 0.5] as const;
      const amp = 2.7;
      for (const snap of snaps) {
        const tl = makeTimeline(amp);
        const initial: Segment[] = [
          { direction: 'down', beats: quantizeBeat(1.5, snap) },
          { direction: 'up', beats: quantizeBeat(0.75, snap) || snap },
          { direction: 'down', beats: quantizeBeat(0.5, snap) || snap },
        ];
        const engine0 = new WaveEngine(initial, tl, amp, 0);
        for (const idx of [1, 2]) {
          const prevBeat = engine0.getPoints()[idx - 1].beat;
          const nextBeat = engine0.getPoints()[idx + 1].beat;
          const targetBeat = quantizeBeat(prevBeat + 0.37, snap);
          const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: clamped,
            targetY: idx === 1 ? TOP : BOTTOM,
            snap,
          });
          if (res) {
            for (const s of res) expect(isSnapAligned(s.beats, snap), `snap=${snap} idx=${idx} beats=${s.beats}`).toBe(true);
          }
        }
      }
      {
        const snap = 1 as const;
        const tl = makeTimeline(amp);
        const initial: Segment[] = [
          { direction: 'down', beats: 2 },
          { direction: 'up', beats: 1 },
          { direction: 'down', beats: 2 },
        ];
        const engine0 = new WaveEngine(initial, tl, amp, 0);
        for (const idx of [1, 2]) {
          const prevBeat = engine0.getPoints()[idx - 1].beat;
          const nextBeat = engine0.getPoints()[idx + 1].beat;
          const targetBeat = quantizeBeat(prevBeat + 0.37, snap);
          const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: clamped,
            targetY: idx === 1 ? TOP : BOTTOM,
            snap,
          });
          if (res) {
            for (const s of res) expect(isSnapAligned(s.beats, snap)).toBe(true);
          }
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // 6. Complex amplitudes + off-grid numeric consistency (WaveEngine <-> Cursor)
  // ------------------------------------------------------------------
  describe('6. Complex amplitudes + off-grid numeric consistency (WaveEngine dY & Cursor)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGrid = [0.37, 1.23] as const;
    for (const amp of amps) {
      for (const off of offGrid) {
        it(`amp=${amp} off=${off}: waveYAt per-beat dY clamped matches expected`, () => {
          const tl = makeTimeline(amp);
          const segs: Segment[] = [{ direction: 'down', beats: 5 }];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const perBeat = 2 * TW_AMP * amp;
          const rawY = CENTER + perBeat * off;
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          const actualY = engine.waveYAt(off);
          expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-6);
          const beatMs = 500;
          const cursor = new Cursor(amp, 0);
          cursor.setAmplitude(amp);
          const startY = cursor.y;
          cursor.update(beatMs / 1000, false, true, beatMs);
          const disp = cursor.y - startY;
          const clampedDisp = Math.min(BOTTOM - CENTER, perBeat);
          expect(Math.abs(disp - clampedDisp)).toBeLessThan(1e-3);
          if (off * perBeat < TW_AMP + 1e-9) {
            const smallOff = 0.1;
            const dy = engine.waveYAt(smallOff) - engine.waveYAt(0);
            expect(Math.abs(dy / smallOff - perBeat)).toBeLessThan(1);
          }
        });
      }
    }
    it('drag result interior X variable preserves per-beat slope (amp 1.3 off 0.37)', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 2 },
        { direction: 'stay', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = engine0.getPoints()[idx - 1].beat;
      const yPrev = engine0.getPoints()[idx - 1].y;
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / (2 * TW_AMP * amp), snap));
      const mouseBeat = prevBeat + snap; // small
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: mouseBeat,
        targetY: TOP,
        snap,
      });
      // For X variable? mouse 0.25 vs cur 2.0 => variable, should NOT shift. So if we use prev+snap not stationary, result should be mouse, not need
      if (result) {
        const engine1 = new WaveEngine(result, tl, amp, 0);
        // X variable => beat equals mouse, need shift not applied
        expect(Math.abs(engine1.getPoints()[idx].beat - mouseBeat)).toBeLessThan(1e-6);
      }
    });
  });

  // ------------------------------------------------------------------
  // 7. Diagonal spec: X variable + zone cross = X priority, Y best-effort (explicit)
  // ------------------------------------------------------------------
  describe('7. Diagonal drag spec (X priority, Y best-effort) — with off-grid verification', () => {
    it('diagonal (dx variable, dy zone-cross) keeps X, does not snap Y to TOP if beats insufficient (amp 0.7 off 0.37)', () => {
      // [Step1]
      const snap = 0.25;
      const amp = 0.7;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1; // beat 1.0
      const prevBeat = engine0.getPoints()[idx - 1].beat; // 0
      const curBeat = engine0.getPoints()[idx].beat; //1.0
      const perBeat = 2 * TW_AMP * amp; // 182
      const needTop = ceilBeat(Math.abs(TOP - CENTER) / perBeat, snap); // 0.75
      // Choose mouse X = prev+0.25 (small) but X variable (cur 1.0 !=0.25) and Y TOP demand
      const mouseBeat = quantizeBeat(prevBeat + 0.37, snap); // 0.25
      // Fixed behavior: X stays 0.25, Y tries TOP but beats only 0.25 => displacement 45.5, not reach TOP
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: mouseBeat,
        targetY: TOP + 10, // top zone
        snap,
      });
      expect(result).not.toBeNull();
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[idx].beat - mouseBeat)).toBeLessThan(1e-6);
      // Direction should be up (best-effort), but Y not fully TOP because beats insufficient (X priority)
      expect(result![idx - 1].direction).toBe('up');
      // Wave Y at that beat should be yPrev + perBeat * 0.25 clamped, not TOP
      const expectedY = Math.max(TOP, Math.min(BOTTOM, CENTER + (-perBeat) * (mouseBeat - prevBeat) * 0)); // wait actually direction up: perBeat negative
      // For up, y = CENTER - perBeat * beatsPrev
      const expectedYUp = Math.max(TOP, CENTER - perBeat * (pts1[idx].beat - prevBeat));
      expect(pts1[idx].y).toBeCloseTo(expectedYUp, 0);
      // Should NOT be at TOP since insufficient beats, proving X priority over Y reach
      if (needTop > (pts1[idx].beat - prevBeat) + 1e-9) {
        expect(Math.abs(pts1[idx].y - TOP)).toBeGreaterThan(10);
      }
    });
    it('pure vertical (dx stationary) with same TOP demand DOES reach TOP (same amp/snap)', () => {
      const snap = 0.25;
      const amp = 0.7;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const curBeat = engine0.getPoints()[idx].beat;
      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: quantizeBeat(curBeat, snap), // stationary
        targetY: TOP,
        snap,
      });
      expect(result).not.toBeNull();
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      // stationary => shifts to need, reaches TOP
      expect(pts1[idx].y).toBeCloseTo(TOP, 6);
    });
  });

  // ------------------------------------------------------------------
  // 8. Regression: other editorDrag APIs still satisfy invariants
  // ------------------------------------------------------------------
  describe('8. Regression: edge/multi drag invariants not broken by T216', () => {
    it('calculateEdgeDrag preserves original length and snap, getPoints invariant (amp 1.3 off 0.37)', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1.5 },
        { direction: 'up', beats: 2.0 },
        { direction: 'down', beats: 1.5 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const edgeIdx = 1;
      const result = calculateEdgeDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        edgeIndex: edgeIdx,
        startBeat: pts0[edgeIdx].beat,
        startY: pts0[edgeIdx].y,
        startPrevBeat: pts0[edgeIdx - 1]?.beat ?? 0,
        startNextBeat: pts0[edgeIdx + 2]?.beat ?? pts0[pts0.length - 1].beat,
        dxBeat: quantizeBeat(0.37, snap),
        dy: 30,
        snap,
      });
      expect(result).not.toBeNull();
      expect(result!.length).toBe(initial.length);
      for (const s of result!) expect(isSnapAligned(s.beats, snap)).toBe(true);
      expect(new WaveEngine(result!, tl, amp, 0).getPoints().length).toBe(pts0.length);
    });
    it('calculateVertexMultiDrag single vertex {v} moves only that vertex', () => {
      const snap = 0.25;
      const amp = 1.3;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const v = 2;
      const dx = quantizeBeat(0.37, snap);
      const res = calculateVertexMultiDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        vertexIndices: [v],
        dxBeat: dx,
        dy: 0,
        snap,
      });
      expect(res).not.toBeNull();
      const pts1 = new WaveEngine(res!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[v].beat - quantizeBeat(pts0[v].beat + dx, snap))).toBeLessThan(1e-6);
      expect(Math.abs(pts1[v + 1].beat - pts0[v + 1].beat)).toBeLessThan(1e-6);
      for (const s of res!) expect(isSnapAligned(s.beats, snap)).toBe(true);
    });
    it('calculateMultiDrag still works (edge collection)', () => {
      const snap = 0.25;
      const amp = 1.0;
      const tl = makeTimeline(amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const res = calculateMultiDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        selSegIdxs: [1],
        dxBeat: quantizeBeat(0.37, snap),
        dy: 20,
        snap,
      });
      expect(res).not.toBeNull();
      expect(res!.length).toBe(initial.length);
    });
  });
});
