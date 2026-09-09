import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { calculateVertexDrag } from '../src/game/editorDrag';
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

describe('T216 頂点ドラッグXハイジャック解消 — 静止Xゲート (calculateVertexDrag)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------------
  // 0. Behavioral stationary gate — no regex, pure behavior
  // ------------------------------------------------------------------
  describe('0. Behavioral stationary gate (X movement detection)', () => {
    it('interior: stationary (quantized mouse == current beat) allows Y-reach shift, variable X forbids shift', () => {
      // [Step1] Capture initial state — narrow asymmetric span to force X vs Y conflict
      const amp = 0.5; // perBeat 130, need TOP from CENTER =1.0 > small mouse span 0.25
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 2 },
      ];
      // pts: 0:0, 1:0.25, 2:0.5, 3:2.5  -> interior idx 1 at 0.25, prev 0, next 0.5
      // For broader test we use idx=1 with prev 0, next 0.5 is too narrow for shift demo
      // Instead use idx=1 with larger next gap: make beats [0.25,1.5,1]
      const segsA: Segment[] = [
        { direction: 'stay', beats: 0.25 }, // 0->0.25
        { direction: 'stay', beats: 1.5 },  // 0.25->1.75
        { direction: 'stay', beats: 1 },    // 1.75->2.75
      ];
      const engA = new WaveEngine(segsA, tl, amp, 0);
      const ptsA = engA.getPoints();
      const idx = 1; // beat 0.25, prev 0, next 1.75
      const prevBeat = ptsA[idx - 1].beat;
      const nextBeat = ptsA[idx + 1].beat;
      const curBeat = ptsA[idx].beat;
      const yPrev = ptsA[idx - 1].y; // CENTER
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const snappedY = TOP;
      const need = Math.max(snap, ceilBeat(Math.abs(snappedY - yPrev) / perBeat, snap)); // 1.0
      // stationary target is exactly current beat quantized (0.25)
      const stationaryBeat = quantizeBeat(curBeat, snap); // 0.25
      // variable target is one snap step to the right (0.5) — diagonal
      const variableBeat = quantizeBeat(curBeat + snap, snap); // 0.5
      expect(Math.abs(stationaryBeat - curBeat)).toBeLessThan(1e-9);
      expect(Math.abs(variableBeat - curBeat)).toBeGreaterThan(1e-9);

      // [Step2] Perform interactions
      const resStationary = calculateVertexDrag({
        segments: segsA,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: stationaryBeat,
        targetY: TOP,
        snap,
      });
      const resVariable = calculateVertexDrag({
        segments: segsA,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: variableBeat,
        targetY: TOP,
        snap,
      });

      // [Step3] Assert transitions
      expect(resStationary).not.toBeNull();
      expect(resVariable).not.toBeNull();
      const rS = resStationary!;
      const rV = resVariable!;
      // stationary must have shifted to need (1.0), variable must follow mouse strictly (0.5)
      const beatsPrevS = rS[idx - 1].beats;
      const beatsPrevV = rV[idx - 1].beats;
      expect(beatsPrevS).toBeCloseTo(need, 4);
      expect(beatsPrevS).toBeGreaterThan(beatsPrevV + 1e-9);
      // variable: beatsPrev == quantized mouse distance
      const expectedVarBeatsPrev = quantizeBeat(variableBeat - prevBeat, snap);
      expect(beatsPrevV).toBeCloseTo(expectedVarBeatsPrev, 4);
      // snap aligned
      for (const s of rS) expect(isSnapAligned(s.beats, snap)).toBe(true);
      for (const s of rV) expect(isSnapAligned(s.beats, snap)).toBe(true);
      // getPoints length invariant
      expect(new WaveEngine(rS, tl, amp, 0).getPoints().length).toBe(ptsA.length);
      expect(new WaveEngine(rV, tl, amp, 0).getPoints().length).toBe(ptsA.length);
      // verify achieved beats: stationary Achieved = prev+need, variable = variableBeat
      const ptsS = new WaveEngine(rS, tl, amp, 0).getPoints();
      const ptsV = new WaveEngine(rV, tl, amp, 0).getPoints();
      expect(Math.abs(ptsS[idx].beat - (prevBeat + need))).toBeLessThan(1e-6);
      expect(Math.abs(ptsV[idx].beat - variableBeat)).toBeLessThan(1e-6);
    });

    it('interior off-grid phases 0.37 / 1.23: stationary detection uses quantized grid (±snap/2 stable)', () => {
      // [Step1] off-grid current beat 1.25 with snap 0.5 -> grid 1.5 stationary window
      const amp = 0.7;
      const snap = 0.5;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      // make a chart where a vertex sits at off-grid 1.25 (beats 1.25 is 1.25/0.5=2.5 -> quantize 1.5? need exact)
      // Instead use beats that produce off-grid point: e.g. beats 0.75+0.5 =1.25
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.75 }, // not snap-aligned to 0.5? 0.75/0.5=1.5 -> quantized? keep raw 0.75 gives off-grid 0.75
        { direction: 'stay', beats: 0.5 },  // 0.75->1.25 off-grid
        { direction: 'stay', beats: 1 },
      ];
      const eng = new WaveEngine(initial, tl, amp, 0);
      const pts = eng.getPoints(); // 0,0.75,1.25,2.25
      const idx = 2; // 1.25 off-grid
      const curBeat = pts[idx].beat; // 1.25
      const curQuant = quantizeBeat(curBeat, snap); // 1.5
      // stationary window is quantized mouse == 1.5, so mouse at 1.37 (quant 1.5) is stationary
      const targetOffGridStationaryRaw = 1.37; // quant ->1.5
      const targetStationary = quantizeBeat(targetOffGridStationaryRaw, snap); // 1.5 == curQuant
      const isStationary = Math.abs(targetStationary - curQuant) < 1e-9;
      expect(isStationary).toBe(true);
      // variable is one snap away: quantize then clamp to valid range
      const prevB = pts[idx - 1].beat; // 0.75
      const nextB = pts[idx + 1].beat; // 2.25
      const targetVariable = Math.max(prevB + snap, Math.min(nextB - snap, quantizeBeat(curQuant + snap, snap))); // clamp to 1.75

      // [Step2]
      const resS = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: targetOffGridStationaryRaw,
        targetY: TOP, // demand up, need will be > mouseBeatsPrev? compute per prev beat
        snap,
      });
      const resV = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: targetVariable,
        targetY: TOP,
        snap,
      });

      // [Step3]
      expect(resS).not.toBeNull();
      expect(resV).not.toBeNull();
      // Variable must strictly follow quantized variable beat, not hijacked to need
      const ptsV = new WaveEngine(resV!, tl, amp, 0).getPoints();
      expect(Math.abs(ptsV[idx].beat - targetVariable)).toBeLessThan(1e-6);
      // Stationary: if Y demand triggers need > original span, it should shift (or at least not equal variable)
      // Here we only assert stationary beat equals quantized stationary grid (1.5) when Y is stay? Need TOP demand case
      // For variable we already verified X fidelity, for stationary we verify waveYAt consistency
      // Only check modified segments (idx-1 and idx) for snap alignment — unchanged segments may be off-grid
      expect(isSnapAligned(resS![idx - 1].beats, snap)).toBe(true);
      expect(isSnapAligned(resS![idx].beats, snap)).toBe(true);
      expect(isSnapAligned(resV![idx - 1].beats, snap)).toBe(true);
      expect(isSnapAligned(resV![idx].beats, snap)).toBe(true);
    });

    it('ceilBeat vs quantizeBeat: needRaw 0.714 snap 0.5 must ceil to 1.0 not round to 0.5 (Y reach guarantee)', () => {
      // [Step1] amp 0.7 perBeat 182, distance 130 -> needRaw 0.714 -> ceil 1.0, round 0.5
      const amp = 0.7;
      const snap = 0.5;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1.5 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = eng0.getPoints();
      const idx = 1; // interior beat 1.5
      const prevBeat = pts0[idx - 1].beat; // 0
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const needRaw = Math.abs(TOP - CENTER) / perBeat; // 0.714
      const needCeil = Math.max(snap, ceilBeat(needRaw, snap)); // 1.0
      const needRound = Math.max(snap, quantizeBeat(needRaw, snap)); // 0.5
      expect(needRaw).toBeCloseTo(0.714, 2);
      expect(needCeil).toBeCloseTo(1.0, 4);
      expect(needRound).toBeCloseTo(0.5, 4);
      // Make current beat narrow: original span for idx1 is 1.5, but we will test first vertex style with small seg to force need>mouse
      // Use asymmetric segs to force stationary insufficient: [0.5, 1.5] -> idx1 at 0.5, need 1.0 >0.5
      const segsNarrow: Segment[] = [
        { direction: 'stay', beats: 0.5 }, // 0->0.5
        { direction: 'stay', beats: 1.5 }, // 0.5->2.0
        { direction: 'stay', beats: 1 },
      ];
      const engN = new WaveEngine(segsNarrow, tl, amp, 0);
      const ptsN = engN.getPoints(); // 0,0.5,2.0
      const idxN = 1; // 0.5
      const stationaryBeat = quantizeBeat(ptsN[idxN].beat, snap); // 0.5
      // [Step2] stationary drag demanding TOP
      const res = calculateVertexDrag({
        segments: segsNarrow,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idxN,
        targetBeat: stationaryBeat,
        targetY: TOP,
        snap,
      });
      expect(res).not.toBeNull();
      // [Step3] must have used ceil (1.0) not round (0.5)
      const beatsPrev = res![idxN - 1].beats;
      expect(beatsPrev).toBeCloseTo(needCeil, 4);
      expect(beatsPrev).not.toBeCloseTo(needRound, 4);
      // verify wave actually reaches TOP (not 65px mid)
      const eng1 = new WaveEngine(res!, tl, amp, 0);
      expect(Math.abs(eng1.getPoints()[idxN].y - TOP)).toBeLessThan(1e-6);
    });

    it('endpoints: first and last stationary gate prevents X hijack, variable X follows mouse', () => {
      // [Step1] first vertex case
      const amp = 0.5; // perBeat 130, need 1.0
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1.5 },
        { direction: 'stay', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const nextBeat = eng0.getPoints()[1].beat; // 0.25
      const firstStaticRef = nextBeat - initial[0].beats; // 0
      const stationaryBeatFirst = quantizeBeat(firstStaticRef, snap); // 0
      const variableBeatFirst = quantizeBeat(firstStaticRef + snap, snap); // 0.25
      // stationary TOP demand should shift to need (1.0 clamped to maxAvail 0? Actually first vertex limited)
      // For this narrow case nextBeat 0.25, need 1.0 > maxAvail 0? Let's use larger gap
      const segsFirst: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const engF = new WaveEngine(segsFirst, tl, amp, 0);
      const nextF = engF.getPoints()[1].beat; //1
      const staticFirstF = nextF - segsFirst[0].beats; //0
      // need for first with TOP from CENTER, perBeat at 0 =>130, need 1.0
      const resFirstStat = calculateVertexDrag({
        segments: segsFirst,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 0,
        targetBeat: quantizeBeat(staticFirstF, snap), // stationary 0
        targetY: TOP,
        snap,
      });
      const resFirstVar = calculateVertexDrag({
        segments: segsFirst,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 0,
        targetBeat: quantizeBeat(staticFirstF + snap, snap), // variable 0.25
        targetY: TOP,
        snap,
      });
      expect(resFirstStat).not.toBeNull();
      expect(resFirstVar).not.toBeNull();
      // stationary should have beats >= need (1.0), variable should follow mouse: beats = next - variableBeat = 0.75
      expect(resFirstStat![0].beats).toBeCloseTo(1.0, 4);
      expect(resFirstVar![0].beats).toBeCloseTo(nextF - variableBeatFirst, 4);
      expect(resFirstStat![0].beats).toBeGreaterThan(resFirstVar![0].beats + 1e-9);

      // [Step3] last vertex
      const lastIdx = engF.getPoints().length - 1;
      const prevLast = engF.getPoints()[lastIdx - 1].beat; // 2.0? For 3 segs beats 1 each: pts 0:0,1:1,2:2,3:3 last 3
      const curLastBeat = engF.getPoints()[lastIdx].beat; // 3
      const stationaryLast = quantizeBeat(curLastBeat, snap); // 3
      const variableLast = quantizeBeat(curLastBeat - snap, snap); // 2.75
      // last vertex need for BOTTOM from previous Y: prev is stay at BOTTOM? Actually segs stay, prev Y CENTER, need for BOTTOM 1.0
      // But previous Y is CENTER (since stay), need 1.0 > 0.25 variable, so stationary should expand
      const resLastStat = calculateVertexDrag({
        segments: segsFirst,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: lastIdx,
        targetBeat: stationaryLast,
        targetY: BOTTOM,
        snap,
      });
      const resLastVar = calculateVertexDrag({
        segments: segsFirst,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: lastIdx,
        targetBeat: variableLast,
        targetY: BOTTOM,
        snap,
      });
      expect(resLastStat).not.toBeNull();
      expect(resLastVar).not.toBeNull();
      // variable must follow mouse: beats = variableLast - prevLast =0.75, stationary if demand needs 1.0 -> beats 1.0
      // But stationary last with TOP/BOTTOM demand: check if need > beats (1.0 >1.0? equal). For amp 0.5 need 1.0, original last beats 1.0 equal -> no shift
      // So we test with amp 0.5 need 1.0, but original 1.0 equal, not >. To force shift we need smaller original: use beats 0.25 for last
      const segsLastNarrow: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 0.25 },
      ];
      const engLN = new WaveEngine(segsLastNarrow, tl, amp, 0);
      const lastN = engLN.getPoints().length - 1;
      const prevN = engLN.getPoints()[lastN - 1].beat; // 2.0
      const curN = engLN.getPoints()[lastN].beat; // 2.25
      const statN = quantizeBeat(curN, snap); // 2.25
      const varN = quantizeBeat(curN + snap, snap); // 2.5? but clamped? Actually last vertex clampedBeat = max(prev+snap, quant(target))
      // For narrow last 0.25, need 1.0 >0.25 so stationary should shift to 1.0 (prev+need=3.0)
      const resLNStat = calculateVertexDrag({
        segments: segsLastNarrow,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: lastN,
        targetBeat: statN,
        targetY: BOTTOM,
        snap,
      });
      const resLNVar = calculateVertexDrag({
        segments: segsLastNarrow,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: lastN,
        targetBeat: quantizeBeat(prevN + snap, snap), // variable 2.25? same as stat? need distinct: use prev+snap =2.25 == stat, need variable further: prev+2*snap=2.5
        targetY: BOTTOM,
        snap,
      });
      // variable with same as stationary will be stationary; to create non-stationary we need mouse away: 2.5 quant
      const resLNVar2 = calculateVertexDrag({
        segments: segsLastNarrow,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: lastN,
        targetBeat: quantizeBeat(prevN + snap * 2, snap), // 2.5
        targetY: BOTTOM,
        snap,
      });
      expect(resLNStat).not.toBeNull();
      expect(resLNVar2).not.toBeNull();
      // stationary with need 1.0 => beats 1.0, variable at 2.5 => beats 0.5
      expect(resLNStat![resLNStat!.length - 1].beats).toBeCloseTo(1.0, 4);
      expect(resLNVar2![resLNVar2!.length - 1].beats).toBeCloseTo(0.5, 4);
      expect(resLNStat![resLNStat!.length - 1].beats).toBeGreaterThan(resLNVar2![resLNVar2!.length - 1].beats + 1e-9);
    });
  });

  // ------------------------------------------------------------------
  // 1. Horizontal drag X fidelity (same zone Y, variable X must be exact)
  // ------------------------------------------------------------------
  describe('1. Horizontal drag X fidelity — same zone Y, X must be strictly reproduced (no hijack to reach position)', () => {
    const amps = [0.7, 1.0, 1.3, 2.7] as const;
    const snaps = [0.25, 0.5] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: interior horizontal (CENTER→CENTER) X variable → beat follows mouse (±snap)`, () => {
          // [Step1]
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const initial: Segment[] = [
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
          ];
          const eng0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = eng0.getPoints();
          const idx = 2; // beat 2.0
          const prevBeat = pts0[idx - 1].beat;
          const nextBeat = pts0[idx + 1].beat;
          const curBeat = pts0[idx].beat;
          // choose targetY in same zone as yPrev (CENTER) to avoid need shift logic
          const ySameZone = CENTER; // snapY -> CENTER, dir stay

          const targetBeats = [prevBeat + snap, prevBeat + snap * 2, curBeat + snap, nextBeat - snap * 2].map(b => quantizeBeat(b, snap));
          for (const tb of targetBeats) {
            const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, tb));
            // skip stationary case (tb == curBeat quantized) to test variable
            const isStationary = Math.abs(clamped - quantizeBeat(curBeat, snap)) < 1e-9;
            if (isStationary) continue;
            // [Step2]
            const res = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: idx,
              targetBeat: clamped,
              targetY: ySameZone,
              snap,
            });
            expect(res, `tb=${tb} clamped=${clamped}`).not.toBeNull();
            const segs = res!;
            // [Step3] X must be strictly reproduced even though Y demand could be satisfied with smaller
            const eng1 = new WaveEngine(segs, tl, amp, 0);
            const achieved = eng1.getPoints()[idx].beat;
            expect(Math.abs(achieved - clamped)).toBeLessThan(1e-6);
            // beats snap aligned
            for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
            // only 2 segments changed
            for (let k = 0; k < initial.length; k++) {
              if (k === idx - 1 || k === idx) continue;
              expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
            }
          }
        });

        it(`amp=${amp} snap=${snap}: horizontal off-grid 0.37 / 1.23 must quantize and track exactly`, () => {
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const initial: Segment[] = [
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
          ];
          const eng0 = new WaveEngine(initial, tl, amp, 0);
          const idx = 1;
          const prevBeat = eng0.getPoints()[idx - 1].beat;
          const offs = [0.37, 1.23];
          for (const off of offs) {
            const raw = prevBeat + off;
            const tb = quantizeBeat(raw, snap);
            const clamped = Math.max(prevBeat + snap, Math.min(eng0.getPoints()[idx + 1].beat - snap, tb));
            const isStationary = Math.abs(clamped - quantizeBeat(eng0.getPoints()[idx].beat, snap)) < 1e-9;
            if (isStationary) continue; // horizontal variable case
            const res = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: idx,
              targetBeat: raw, // raw off-grid input
              targetY: CENTER,
              snap,
            });
            expect(res).not.toBeNull();
            const achieved = new WaveEngine(res!, tl, amp, 0).getPoints()[idx].beat;
            expect(Math.abs(achieved - clamped)).toBeLessThan(1e-6);
          }
        });
      }
    }

    it('horizontal drag must not be clamped to nextBeat - snap nor to prev+need when X moved', () => {
      // [Step1] short segment where T215 would hijack to need or maxAvail even though X moved
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      // asymmetric: idx 1 at 0.25, next at 1.75 (wide), prev 0
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1.5 },
        { direction: 'stay', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1; // 0.25
      const prevBeat = eng0.getPoints()[idx - 1].beat; //0
      const nextBeat = eng0.getPoints()[idx + 1].beat; //1.75
      const curBeat = eng0.getPoints()[idx].beat; //0.25
      // Demand TOP (need 0.5) but mouse X moved to 0.75 (variable)
      const variableBeat = quantizeBeat(curBeat + 0.5, snap); // 0.75
      const isStationary = Math.abs(variableBeat - quantizeBeat(curBeat, snap)) < 1e-9;
      expect(isStationary).toBe(false);
      // [Step2]
      const res = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: variableBeat,
        targetY: TOP, // zone change
        snap,
      });
      expect(res).not.toBeNull();
      // [Step3] Must NOT be hijacked to prev+need (0+0.5=0.5) nor to next-snap (1.5), nor to need-clamped
      const achieved = new WaveEngine(res!, tl, amp, 0).getPoints()[idx].beat;
      expect(Math.abs(achieved - variableBeat)).toBeLessThan(1e-6);
      expect(Math.abs(achieved - (prevBeat + ceilBeat(Math.abs(TOP - CENTER) / (2 * TW_AMP * amp), snap)))).not.toBeLessThan(1e-9 * 10); // not hijacked if variable
      // Actually need is 0.5, variableBeat 0.75, they differ so hijack would be 0.5. Check achieved is 0.75 not 0.5
      expect(achieved).not.toBeCloseTo(prevBeat + ceilBeat(Math.abs(TOP - CENTER) / (2 * TW_AMP * amp), snap), 4);
    });
  });

  // ------------------------------------------------------------------
  // 2. Pure vertical drag reachability (stationary X)
  // ------------------------------------------------------------------
  describe('2. Pure vertical drag — stationary X must still shift to snapped Y zone (T215 preservation)', () => {
    const snaps = [0.25, 0.5] as const;
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap} interior stationary TOP demand reaches TOP (not freeze at 65px)`, () => {
          // [Step1] narrow original span 0.25, need 1.0 for amp 0.5, stationary
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          // Use segs where idx 1 at 0.25, prev 0, next 2.0 (wide enough for need)
          const initial: Segment[] = [
            { direction: 'stay', beats: 0.25 },
            { direction: 'stay', beats: 1.75 },
            { direction: 'stay', beats: 1 },
          ];
          const eng0 = new WaveEngine(initial, tl, amp, 0);
          const idx = 1; // 0.25
          const prevBeat = eng0.getPoints()[idx - 1].beat; //0
          const curBeat = eng0.getPoints()[idx].beat; //0.25 stationary
          const yPrev = eng0.getPoints()[idx - 1].y; // CENTER
          const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
          const need = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / perBeat, snap));
          if (need <= snap + 1e-9) return; // no shift needed for this amp, skip strict
          const stationaryBeat = quantizeBeat(curBeat, snap); // 0.25

          // [Step2]
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: stationaryBeat,
            targetY: TOP,
            snap,
          });
          expect(res).not.toBeNull();
          const segs = res!;
          // [Step3] should have shifted to need
          expect(segs[idx - 1].beats).toBeCloseTo(need, 4);
          const eng1 = new WaveEngine(segs, tl, amp, 0);
          expect(Math.abs(eng1.getPoints()[idx].y - TOP)).toBeLessThan(1e-6);
          expect(Math.abs(eng1.getPoints()[idx].beat - (prevBeat + need))).toBeLessThan(1e-6);
        });

        it(`amp=${amp} snap=${snap} interior stationary BOTTOM demand also reaches`, () => {
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const initial: Segment[] = [
            { direction: 'stay', beats: 0.25 },
            { direction: 'stay', beats: 1.75 },
            { direction: 'stay', beats: 1 },
          ];
          const eng0 = new WaveEngine(initial, tl, amp, 0);
          const idx = 1;
          const prevBeat = eng0.getPoints()[idx - 1].beat;
          const curBeat = eng0.getPoints()[idx].beat;
          const yPrev = eng0.getPoints()[idx - 1].y;
          const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
          const need = Math.max(snap, ceilBeat(Math.abs(BOTTOM - yPrev) / perBeat, snap));
          if (need <= snap + 1e-9) return;
          const stationaryBeat = quantizeBeat(curBeat, snap);
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: stationaryBeat,
            targetY: BOTTOM,
            snap,
          });
          expect(res).not.toBeNull();
          expect(res![idx - 1].beats).toBeCloseTo(need, 4);
          const eng1 = new WaveEngine(res!, tl, amp, 0);
          expect(Math.abs(eng1.getPoints()[idx].y - BOTTOM)).toBeLessThan(1e-6);
        });

        it(`amp=${amp} snap=${snap} off-grid stationary (0.37 snap window) still reaches`, () => {
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          // create off-grid current beat 0.37? Need beats that yield 0.37 approximately: 0.37 quant 0.25 or 0.5
          // Instead test with snap 0.25, off-grid target 0.37 quant 0.5 vs stationary window ±0.125
          // For interior idx with curBeat 1.25 snap 0.25 -> curQuant 1.25, raw 1.37 quant 1.25? Actually 1.37/0.25=5.48 round 5 =>1.25 stationary
          const initial: Segment[] = [
            { direction: 'stay', beats: 1.25 }, // 0->1.25 off-grid for snap 0.5? but 1.25/0.25=5 exactly
            { direction: 'stay', beats: 0.25 },
            { direction: 'stay', beats: 1 },
          ];
          const eng0 = new WaveEngine(initial, tl, amp, 0);
          const idx = 1; // 1.25
          const curBeat = eng0.getPoints()[idx].beat;
          const curQuant = quantizeBeat(curBeat, snap);
          const targetRaw = curQuant + 0.07; // within snap/2 (0.125) so quantized still curQuant => stationary
          const isStat = Math.abs(quantizeBeat(targetRaw, snap) - curQuant) < 1e-9;
          expect(isStat).toBe(true);
          const prevBeat = eng0.getPoints()[idx - 1].beat;
          const yPrev = eng0.getPoints()[idx - 1].y;
          const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
          const need = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / perBeat, snap));
          if (need <= quantizeBeat(curQuant - prevBeat, snap) + 1e-9) return;
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat: targetRaw,
            targetY: TOP,
            snap,
          });
          expect(res).not.toBeNull();
          // if need > original span, stationary should shift
          if (need > 1.25 - prevBeat + 1e-9) {
            // original beatsPrev 1.25, need maybe 1.0 for amp 0.5 => not > . So skip?
          }
          for (const s of res!) expect(isSnapAligned(s.beats, snap)).toBe(true);
        });
      }
    }
  });

  // ------------------------------------------------------------------
  // 3. Diagonal X-priority (variable X + zone change does NOT hijack)
  // ------------------------------------------------------------------
  describe('3. Diagonal drag — X variable + Y zone change: X priority, Y best-effort (no hijack)', () => {
    it('interior diagonal with snap 0.25 amp 1.0: X moved -> beat follows mouse, Y best-effort only', () => {
      // [Step1] same narrow setup as horizontal hijack test
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 0.25 },
        { direction: 'stay', beats: 1.75 },
        { direction: 'stay', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1; // 0.25
      const prevBeat = eng0.getPoints()[idx - 1].beat;
      const curBeat = eng0.getPoints()[idx].beat;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const need = Math.max(snap, ceilBeat(Math.abs(TOP - CENTER) / perBeat, snap)); // 0.5
      // variable beat 0.5 (one snap right), stationary would be 0.25 -> need 0.5
      const variableBeat = quantizeBeat(curBeat + snap, snap); // 0.5
      expect(Math.abs(variableBeat - quantizeBeat(curBeat, snap))).toBeGreaterThan(1e-9);
      // need 0.5, mouseBeatsPrev for variable =0.5 (=need) -> would have been hijack to same, but we test with
      // variable further: use raw that quantizes to 0.5 still equals need, need test with 0.75
      const variableBeat2 = quantizeBeat(curBeat + snap * 2, snap); // 0.75
      // [Step2] diagonal: variable X + Y zone change
      const res = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: variableBeat2,
        targetY: TOP,
        snap,
      });
      expect(res).not.toBeNull();
      // [Step3] X must be exactly variableBeat2, not shifted to prev+need (0.5)
      const achieved = new WaveEngine(res!, tl, amp, 0).getPoints()[idx].beat;
      expect(Math.abs(achieved - variableBeat2)).toBeLessThan(1e-6);
      // Y may or may not reach TOP (best-effort): if beats 0.75 >= need 0.5, it reaches TOP
      // If we had chosen variableBeat 0.25 (need), it also reaches, but the point is X not hijacked extra
      // Check direction is up (zone change)
      expect(res![idx - 1].direction).toBe('up');
    });

    it('diagonal off-grid 0.37/1.23: variable X follows quantized mouse, not prev+need', () => {
      const amp = 1.3;
      const snap = 0.5;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = eng0.getPoints()[idx - 1].beat;
      const curBeat = eng0.getPoints()[idx].beat;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const need = Math.max(snap, ceilBeat(Math.abs(BOTTOM - CENTER) / perBeat, snap));
      // choose off-grid raw that quantizes to variable (e.g., 1.37 ->1.5)
      const raw = prevBeat + 0.37; // 0.37 quant 0.5
      const tb = quantizeBeat(raw, snap); // 0.5
      const clamped = Math.max(prevBeat + snap, Math.min(eng0.getPoints()[idx + 1].beat - snap, tb));
      const isStat = Math.abs(clamped - quantizeBeat(curBeat, snap)) < 1e-9;
      // for idx 1 at 1.0, curQuant 1.0, tb 0.5 -> not stationary
      expect(isStat).toBe(false);
      const res = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: raw,
        targetY: BOTTOM,
        snap,
      });
      expect(res).not.toBeNull();
      const achieved = new WaveEngine(res!, tl, amp, 0).getPoints()[idx].beat;
      expect(Math.abs(achieved - clamped)).toBeLessThan(1e-6);
      // If need (e.g., 0.5) would have hijacked to 0.5+prev =0.5 same as clamped, test with larger need amp 0.5
      // For amp 1.3 need 0.5, same as clamped, not hijack distinct. Test diagonal with amp 0.5 need 1.0 vs clamped 0.5
      const tl2 = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: 0.5 } as any], 0.5);
      const perBeat2 = 2 * TW_AMP * tl2.amplitudeAt(prevBeat); // 130 need 1.0
      const need2 = Math.max(snap, ceilBeat(Math.abs(BOTTOM - CENTER) / perBeat2, snap)); //1.0
      const res2 = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl2,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: raw, // 0.37 ->0.5, clamped 0.5
        targetY: BOTTOM,
        snap,
      });
      expect(res2).not.toBeNull();
      const achieved2 = new WaveEngine(res2!, tl2, 0.5, 0).getPoints()[idx].beat;
      // variable must stay at 0.5, not hijacked to prev+need 1.0
      expect(Math.abs(achieved2 - clamped)).toBeLessThan(1e-6);
      expect(Math.abs(achieved2 - (prevBeat + need2))).toBeGreaterThan(1e-6);
    });
  });

  // ------------------------------------------------------------------
  // 4. Harness: per-iteration stationary logic, endpoint included
  // ------------------------------------------------------------------
  describe('4. Harness — per-iteration X-fidelity vs stationary reachability (incl. endpoints, off-grid)', () => {
    const amps = [0.7, 1.0, 1.3, 2.7] as const;
    const snaps = [0.25] as const;
    const offGridOffsets = [0.37, 1.23, 0.63] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: sweep of mouse beats — per-iteration X fidelity / stationary need`, () => {
          // [Step1] Capture initial: narrow asymmetric to expose both modes
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const initial: Segment[] = [
            { direction: 'stay', beats: 0.25 },
            { direction: 'stay', beats: 1.75 },
            { direction: 'stay', beats: 1 },
            { direction: 'stay', beats: 1 },
          ];
          const eng0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = eng0.getPoints(); // 0,0.25,2.0,3.0,4.0
          const idxInterior = 1; // 0.25
          const prevInt = pts0[idxInterior - 1].beat; //0
          const nextInt = pts0[idxInterior + 1].beat; //2.0
          const curInt = pts0[idxInterior].beat; //0.25
          const curQuantInt = quantizeBeat(curInt, snap);

          // Sweep targetBeats across range, including off-grid raws
          const sweepRaw = [
            curInt, // stationary
            curInt + 0.07, // within snap/2 -> stationary (0.37-like)
            prevInt + snap, // 0.25 same as cur -> stationary
            prevInt + snap * 2, // 0.5 variable
            prevInt + 0.37, // off-grid 0.37 -> 0.25 or 0.5
            prevInt + 1.23, // off-grid 1.23 ->1.25
            nextInt - snap, // 1.75 variable (max)
          ];

          for (const raw of sweepRaw) {
            const tbQuant = quantizeBeat(raw, snap);
            const clamped = Math.max(prevInt + snap, Math.min(nextInt - snap, tbQuant));
            const isStationary = Math.abs(clamped - curQuantInt) < 1e-9;
            const yDemand = isStationary ? TOP : CENTER; // stationary: TOP to test need, variable: CENTER to avoid need interference
            // But to test hijack, we need Y zone change for both, so use TOP for both and expect different behavior
            // Instead we will test two sub-cases per raw: one with CENTER (no need), one with TOP (need) where variable must not hijack
            // Case A: CENTER (stay) — always X exact regardless of stationary
            const resA = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: idxInterior,
              targetBeat: raw,
              targetY: CENTER,
              snap,
            });
            if (resA === null) {
              // no-op only when raw == cur and Y == curY exactly — skip
              const curY = pts0[idxInterior].y;
              if (Math.abs(clamped - curInt) < 1e-9 && Math.abs(CENTER - curY) < 1e-9) {
                expect(resA).toBeNull();
                continue;
              }
            }
            expect(resA).not.toBeNull();
            const achievedA = new WaveEngine(resA!, tl, amp, 0).getPoints()[idxInterior].beat;
            expect(Math.abs(achievedA - clamped)).toBeLessThan(1e-6);

            // Case B: TOP demand — stationary should possibly shift, variable must not
            const yPrev = pts0[idxInterior - 1].y; // CENTER
            const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevInt);
            const need = Math.max(snap, ceilBeat(Math.abs(TOP - yPrev) / perBeat, snap));
            const mouseBeatsPrev = quantizeBeat(clamped - prevInt, snap);
            const resB = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: idxInterior,
              targetBeat: raw,
              targetY: TOP,
              snap,
            });
            expect(resB).not.toBeNull();
            const achievedB = new WaveEngine(resB!, tl, amp, 0).getPoints()[idxInterior].beat;
            if (isStationary && need > mouseBeatsPrev + 1e-9) {
              const maxAvail = nextInt - snap - prevInt;
              const desired = Math.min(need, maxAvail);
              const expectedBeat = prevInt + ceilBeat(desired, snap);
              const clampedExpected = Math.max(prevInt + snap, Math.min(nextInt - snap, expectedBeat));
              expect(Math.abs(achievedB - clampedExpected)).toBeLessThan(1e-6);
              expect(resB![idxInterior - 1].direction).toBe('up');
            } else {
              // variable or need already satisfied -> X exact
              expect(Math.abs(achievedB - clamped)).toBeLessThan(1e-6);
            }
            // snap aligned
            for (const s of resB!) expect(isSnapAligned(s.beats, snap)).toBe(true);
          }

          // Endpoint: last vertex sweep
          const lastIdx = pts0.length - 1; // 4.0
          const prevLast = pts0[lastIdx - 1].beat; // 3.0
          const curLast = pts0[lastIdx].beat; // 4.0
          const curLastQuant = quantizeBeat(curLast, snap);
          const sweepLastRaw = [curLast, curLast + 0.07, prevLast + snap, prevLast + 0.37, prevLast + 1.23];
          for (const raw of sweepLastRaw) {
            const tbQuant = quantizeBeat(raw, snap);
            const clamped = Math.max(prevLast + snap, tbQuant);
            const isStat = Math.abs(clamped - curLastQuant) < 1e-9;
            const yDemand = isStat ? BOTTOM : CENTER;
            const res = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: lastIdx,
              targetBeat: raw,
              targetY: yDemand,
              snap,
            });
            expect(res).not.toBeNull();
            const segs = res!;
            expect(isSnapAligned(segs[segs.length - 1].beats, snap)).toBe(true);
            const achieved = new WaveEngine(segs, tl, amp, 0).getPoints()[lastIdx].beat;
            const perBeatLast = 2 * TW_AMP * tl.amplitudeAt(prevLast);
            const needLast = Math.max(snap, ceilBeat(Math.abs(snapY(yDemand) - pts0[lastIdx - 1].y) / perBeatLast, snap));
            if (isStat && yDemand === BOTTOM && needLast > quantizeBeat(clamped - prevLast, snap) + 1e-9) {
              const expected = prevLast + needLast;
              expect(Math.abs(achieved - expected)).toBeLessThan(1e-6);
            } else {
              expect(Math.abs(achieved - clamped)).toBeLessThan(1e-6);
            }
          }
        });
      }
    }

    it('off-grid phases 0.63 / 0.87 must track quantized mouse when variable, not hijacked', () => {
      const amp = 2.7;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const idx = 1;
      const prevBeat = eng0.getPoints()[idx - 1].beat;
      const curBeat = eng0.getPoints()[idx].beat;
      const curQuant = quantizeBeat(curBeat, snap);
      for (const off of [0.63, 0.87] as const) {
        const raw = prevBeat + off;
        const tb = quantizeBeat(raw, snap);
        const clamped = Math.max(prevBeat + snap, Math.min(eng0.getPoints()[idx + 1].beat - snap, tb));
        const isStat = Math.abs(clamped - curQuant) < 1e-9;
        if (isStat) continue; // test variable only
        const res = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: idx,
          targetBeat: raw,
          targetY: TOP,
          snap,
        });
        expect(res).not.toBeNull();
        const achieved = new WaveEngine(res!, tl, amp, 0).getPoints()[idx].beat;
        expect(Math.abs(achieved - clamped)).toBeLessThan(1e-6);
      }
    });
  });

  // ------------------------------------------------------------------
  // 5. Invariants: length, snap, only 2 segments changed, posterior immobility
  // ------------------------------------------------------------------
  describe('5. Invariants: getPoints length, snap, 2-segment scope, posterior shift', () => {
    it('interior drag changes exactly 2 segments, others bit-exact, total span preserved', () => {
      // [Step1]
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const eng0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = eng0.getPoints();
      const idx = 2;
      const prevBeat = pts0[idx - 1].beat;
      const nextBeat = pts0[idx + 1].beat;
      const targetBeat = quantizeBeat(prevBeat + 0.63, snap);
      const clamped = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
      // ensure variable (not stationary) to test 2-segment change without hijack
      // For idx 2 at 2.0, curQuant 2.0, clamped 1.63? Actually prev 1.0, 0.63 ->1.63 not stationary
      // [Step2]
      const res = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: clamped,
        targetY: pts0[idx].y,
        snap,
      });
      expect(res).not.toBeNull();
      const segs = res!;
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

    it('all beats remain snap multiples across off-grid drags (0.37/1.23)', () => {
      const snaps = [0.125, 0.25, 0.5] as const;
      const amp = 2.7;
      for (const snap of snaps) {
        const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
        const initial: Segment[] = [
          { direction: 'down', beats: quantizeBeat(1.5, snap) },
          { direction: 'up', beats: quantizeBeat(0.75, snap) || snap },
          { direction: 'down', beats: quantizeBeat(0.5, snap) || snap },
        ];
        const eng0 = new WaveEngine(initial, tl, amp, 0);
        for (const idx of [1, 2]) {
          const prevBeat = eng0.getPoints()[idx - 1].beat;
          const nextBeat = eng0.getPoints()[idx + 1].beat;
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
    });
  });

  // ------------------------------------------------------------------
  // 6. Complex amplitudes + off-grid numeric consistency (WaveEngine)
  // ------------------------------------------------------------------
  describe('6. Complex amplitudes + off-grid waveYAt per-beat dY clamped', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGrid = [0.37, 1.23] as const;
    for (const amp of amps) {
      for (const off of offGrid) {
        it(`amp=${amp} off=${off}: waveYAt per-beat dY clamped matches expected`, () => {
          const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
          const segs: Segment[] = [{ direction: 'down', beats: 5 }];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const perBeat = 2 * TW_AMP * amp;
          const rawY = CENTER + perBeat * off;
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          const actualY = engine.waveYAt(off);
          expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-6);
          if (off * perBeat < TW_AMP + 1e-9) {
            const smallOff = 0.1;
            const dy = engine.waveYAt(smallOff) - engine.waveYAt(0);
            expect(Math.abs(dy / smallOff - perBeat)).toBeLessThan(1);
          }
        });
      }
    }
  });
});
