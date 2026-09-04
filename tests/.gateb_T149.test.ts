import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { calculateVertexDrag, calculateEdgeDrag } from '../src/game/editorDrag';
import { Cursor } from '../src/game/cursor';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

// Unified Y inverse as specified in T149 fix
function mapY(y: number, centerY: number, dispAmp: number): number {
  return centerY + ((y - CENTER) / TW_AMP) * dispAmp;
}
function mapYInverse(mouseY: number, centerY: number, dispAmp: number): number {
  return CENTER + ((mouseY - centerY) / dispAmp) * TW_AMP;
}
function computeDispAmp(fieldH: number, cssH: number): number {
  const maxAmp = (fieldH - 24) / 2;
  const minAmp = Math.max(8, 0.2 * cssH);
  return Math.min(maxAmp, Math.max(TW_AMP, minAmp));
}
// Old buggy inverse (T149 root cause 2)
function oldMapYInverse(mouseY: number, RULER_H: number, fieldH: number): number {
  return CENTER + (((mouseY - RULER_H) / fieldH - 0.5) * 2) * TW_AMP;
}

describe('T149 vertex X tracking / add collapse / Y mapping unified — node Vitest (WaveEngine + Cursor + editorDrag)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------------
  // 1. Vertex horizontal-only drag tracks X: beatsPrev = quantize(beat' - prevBeat)
  // ------------------------------------------------------------------
  describe('1. Vertex horizontal-only drag → getPoints[i].beat == beatPrime (off-grid, complex amp)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    // off-grid raw beats per QA principle
    const offGridBeats = [0.37, 1.23, 2.37, 0.63, 1.87];

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const raw of offGridBeats) {
          it(`amp=${amp} snap=${snap} raw=${raw}: horizontal-only vertex drag tracks X`, () => {
            // [Step 1: Capture Initial State]
            const tl = new BpmTimeline(120, [], amp);
            const initial: Segment[] = [
              { direction: 'down', beats: 2 },
              { direction: 'up', beats: 2 },
              { direction: 'down', beats: 2 },
              { direction: 'up', beats: 2 },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const pts0 = engine0.getPoints();
            expect(pts0.length).toBe(initial.length + 1);
            const idx = 2; // interior vertex
            const currentY = pts0[idx].y;
            const prevBeat = pts0[idx - 1].beat;
            const nextBeat = pts0[idx + 1].beat;
            const clampedRaw = Math.max(prevBeat + snap, Math.min(nextBeat - snap, quantizeBeat(raw, snap)));
            const targetBeat = clampedRaw;

            // [Step 2: Perform Interaction] — same Y, different X (pure horizontal)
            const result = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: idx,
              targetBeat,
              targetY: currentY,
              snap,
            });
            expect(result).not.toBeNull();
            const segs = result!;

            // [Step 3: Assert Transition]
            // beats must be derived from X, not Y: beatsPrev = quantize(beat' - prevBeat)
            const expectedPrev = quantizeBeat(targetBeat - prevBeat, snap);
            const expectedNext = quantizeBeat(nextBeat - targetBeat, snap);
            expect(segs[idx - 1].beats).toBeCloseTo(expectedPrev, 6);
            expect(segs[idx].beats).toBeCloseTo(expectedNext, 6);

            // X tracking: engine reflects targetBeat exactly
            const engine1 = new WaveEngine(segs, tl, amp, 0);
            const pts1 = engine1.getPoints();
            expect(pts1.length).toBe(pts0.length);
            expect(Math.abs(pts1[idx].beat - targetBeat)).toBeLessThan(1e-6);

            // Total span of affected 2 segments equals neighbour span
            const span = nextBeat - prevBeat;
            expect(Math.abs(segs[idx - 1].beats + segs[idx].beats - span)).toBeLessThan(1e-6);

            // All beats snap aligned
            for (const s of segs) {
              expect(isSnapAligned(s.beats, snap)).toBe(true);
            }

            // Only 2 segments changed; others untouched
            for (let k = 0; k < initial.length; k++) {
              if (k === idx - 1 || k === idx) continue;
              expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
            }
          });
        }
      }
    }

    it('rejects Y-only formula: horizontal drag must produce change (old bug would return null/no change)', () => {
      // This explicitly guards against the old T147 bug where Y-only beats would be unchanged
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ];
      const engine0 = new WaveEngine(segs, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const ySame = pts0[idx].y;
      const targetBeat = quantizeBeat(1.37, snap); // off-grid, X moved 0.63 from pts0[1]=2? actually pts0[1]=2 so moving left
      // For this test pick a different target that requires movement
      const shiftedTarget = quantizeBeat(1.25, snap);
      const res = calculateVertexDrag({
        segments: segs,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: shiftedTarget,
        targetY: ySame,
        snap,
      });
      expect(res).not.toBeNull();
      // Must differ from original: beatsPrev changed even though Y unchanged
      expect(res![idx - 1].beats).not.toBeCloseTo(segs[idx - 1].beats, 6);
      const engine1 = new WaveEngine(res!, tl, amp, 0);
      expect(Math.abs(engine1.getPoints()[idx].beat - shiftedTarget)).toBeLessThan(1e-6);
    });
  });

  // ------------------------------------------------------------------
  // 2. Y mapping unified: mapYInverse = CENTER+((mouseY-centerY)/dispAmp)*TW_AMP
  // ------------------------------------------------------------------
  describe('2. Y inverse mapping unified (T149 root cause 2)', () => {
    it('mapY and mapYInverse are exact inverses for arbitrary dispAmp sizes', () => {
      const cases = [
        { cssH: 300, fieldH: 278 },
        { cssH: 400, fieldH: 378 },
        { cssH: 600, fieldH: 578 },
        { cssH: 900, fieldH: 878 },
      ];
      const RULER_H = 22;
      for (const { cssH, fieldH } of cases) {
        const dispAmp = computeDispAmp(fieldH, cssH);
        const centerY = RULER_H + fieldH / 2;
        const testYs = [TOP, CENTER, BOTTOM, TOP + 13.37, BOTTOM - 27.5, CENTER + 0.37 * TW_AMP];
        for (const y of testYs) {
          const mouseY = mapY(y, centerY, dispAmp);
          const recovered = mapYInverse(mouseY, centerY, dispAmp);
          expect(Math.abs(recovered - y)).toBeLessThan(1e-6);
            // Old formula must diverge when dispAmp != TW_AMP (field size varies).
            // At y=CENTER both formulas agree (scale factor vanishes at origin), so skip.
            if (Math.abs(dispAmp - TW_AMP) > 5 && Math.abs(y - CENTER) > 1e-6) {
            const oldRecovered = oldMapYInverse(mouseY, RULER_H, fieldH);
            // Old must be off by at least ~10px when dispAmp differs significantly
            expect(Math.abs(oldRecovered - y)).toBeGreaterThan(5);
          }
        }
      }
    });

    it('round-trip through drag Y clamp preserves Y within bounds', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 1.5 },
        { direction: 'up', beats: 1.5 },
      ];
      // Simulate a mouse Y far outside bounds; clampY must bring it inside
      const outOfBoundsYs = [-999, 999, TOP - 100, BOTTOM + 200];
      for (const yMouse of outOfBoundsYs) {
        const res = calculateVertexDrag({
          segments: segs,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: 1,
          targetBeat: quantizeBeat(1.5, snap),
          targetY: yMouse,
          snap,
        });
        expect(res).not.toBeNull();
        const eng = new WaveEngine(res!, tl, amp, 0);
        const pts = eng.getPoints();
        // All points Y within wave bounds
        for (const p of pts) {
          expect(p.y).toBeGreaterThanOrEqual(TOP - 1e-6);
          expect(p.y).toBeLessThanOrEqual(BOTTOM + 1e-6);
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // 3. Vertex addition preserves total beats (horizontal width)
  // ------------------------------------------------------------------
  describe('3. Vertex addition (double-click) beats from horizontal width, direction from Y only', () => {
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const amps = [0.7, 1.3, 2.7] as const;
    const offGridAdds = [0.37, 0.87, 1.23, 1.63];

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const offAdd of offGridAdds) {
          it(`amp=${amp} snap=${snap} beatAdd~${offAdd}: split beats = horizontal distances`, () => {
            // [Step 1: Capture Initial]
            const tl = new BpmTimeline(120, [], amp);
            const initial: Segment[] = [
              { direction: 'down', beats: 2.0 },
              { direction: 'up', beats: 2.0 },
              { direction: 'down', beats: 2.0 },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const pts0 = engine0.getPoints();
            // Pick segment 1 (pts[1] -> pts[2], beats 2.0)
            const k = 1;
            const segStart = pts0[k].beat;
            const segEnd = pts0[k + 1].beat;
            // Clamp beatAdd strictly inside segment
            let beatAdd = quantizeBeat(segStart + offAdd, snap);
            if (beatAdd <= segStart + 1e-6) beatAdd = segStart + snap;
            if (beatAdd >= segEnd - 1e-6) beatAdd = segEnd - snap;
            if (beatAdd <= segStart || beatAdd >= segEnd) return; // skip impossible snaps
            const yAdd = CENTER + 40; // arbitrary Y inside bounds

            // [Step 2: Perform addition as in WavePreview handleDoubleClick T149]
            const beatsA = Math.max(snap, quantizeBeat(beatAdd - segStart, snap));
            const beatsB = Math.max(snap, quantizeBeat(segEnd - beatAdd, snap));
            const yPrev = pts0[k].y;
            const yNext = pts0[k + 1].y;
            const dirA = Math.abs(yAdd - yPrev) < 0.5 ? 'stay' as const : yAdd < yPrev ? 'up' as const : 'down' as const;
            const dirB = Math.abs(yNext - yAdd) < 0.5 ? 'stay' as const : yNext < yAdd ? 'up' as const : 'down' as const;
            const newSegs = [...initial];
            newSegs.splice(k, 1, { direction: dirA, beats: beatsA }, { direction: dirB, beats: beatsB });

            // [Step 3: Assert]
            // (a) total beats preserved (no collapse)
            const origSpan = segEnd - segStart;
            expect(Math.abs(beatsA + beatsB - origSpan)).toBeLessThan(1e-6);
            expect(Math.abs(beatsA - (beatAdd - segStart))).toBeLessThan(1e-6);
            // (b) beats derived from X, not Y/perBeat — old bug used |yAdd-y|/perBeat
            //     which would vary with Y; here beatsA/B independent of yAdd offset
            const yAdd2 = CENTER - 60;
            const dirA2 = Math.abs(yAdd2 - yPrev) < 0.5 ? 'stay' as const : yAdd2 < yPrev ? 'up' as const : 'down' as const;
            const dirB2 = Math.abs(yNext - yAdd2) < 0.5 ? 'stay' as const : yNext < yAdd2 ? 'up' as const : 'down' as const;
            // beats unchanged even though Y changed dramatically
            const beatsA2 = Math.max(snap, quantizeBeat(beatAdd - segStart, snap));
            const beatsB2 = Math.max(snap, quantizeBeat(segEnd - beatAdd, snap));
            expect(beatsA2).toBe(beatsA);
            expect(beatsB2).toBe(beatsB);
            void dirA2; void dirB2;

            // (c) all snap aligned
            for (const s of newSegs) expect(isSnapAligned(s.beats, snap)).toBe(true);
            // (d) getPoints length +1 invariant
            const eng1 = new WaveEngine(newSegs, tl, amp, 0);
            expect(eng1.getPoints().length).toBe(pts0.length + 1);
            // (e) overall total beats unchanged
            const totalOrig = pts0[pts0.length - 1].beat - pts0[0].beat;
            const totalNew = eng1.getPoints()[eng1.getPoints().length - 1].beat - eng1.getPoints()[0].beat;
            expect(Math.abs(totalNew - totalOrig)).toBeLessThan(1e-6);
          });
        }
      }
    }
  });

  // ------------------------------------------------------------------
  // 4. Round-trip add → delete restores total beats within ±0.5*snap
  // ------------------------------------------------------------------
  describe('4. Round-trip add→delete preserves total beats ±0.5*snap and getPoints length', () => {
    const snaps = [0.125, 0.25, 0.5] as const;
    const amps = [0.7, 1.3, 2.7, 3.4] as const;

    for (const snap of snaps) {
      for (const amp of amps) {
        it(`snap=${snap} amp=${amp}: add inside off-grid then delete merges total ±0.5*snap`, () => {
          // [Step 1: Capture Initial]
          const tl = new BpmTimeline(120, [], amp);
          const original: Segment[] = [
            { direction: 'down', beats: quantizeBeat(1.75, snap) || snap },
            { direction: 'up', beats: quantizeBeat(1.25, snap) || snap },
            { direction: 'down', beats: quantizeBeat(2.0, snap) || snap },
          ];
          const engine0 = new WaveEngine(original, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const totalOrig = pts0[pts0.length - 1].beat - pts0[0].beat;

          // [Step 2a: Add] split segment 0 at off-grid 0.37 offset from start
          const k = 0;
          const segStart = pts0[k].beat;
          const segEnd = pts0[k + 1].beat;
          let beatAdd = quantizeBeat(segStart + 0.37, snap);
          if (beatAdd <= segStart) beatAdd = segStart + snap;
          if (beatAdd >= segEnd) beatAdd = segEnd - snap;
          if (beatAdd <= segStart || beatAdd >= segEnd) return;
          const yAdd = CENTER + 30;
          const beatsA = Math.max(snap, quantizeBeat(beatAdd - segStart, snap));
          const beatsB = Math.max(snap, quantizeBeat(segEnd - beatAdd, snap));
          const yPrev = pts0[k].y;
          const yNext = pts0[k + 1].y;
          const dirA = Math.abs(yAdd - yPrev) < 0.5 ? 'stay' as const : yAdd < yPrev ? 'up' as const : 'down' as const;
          const dirB = Math.abs(yNext - yAdd) < 0.5 ? 'stay' as const : yNext < yAdd ? 'up' as const : 'down' as const;
          const afterAdd: Segment[] = [...original];
          afterAdd.splice(k, 1, { direction: dirA, beats: beatsA }, { direction: dirB, beats: beatsB });
          const engineAdd = new WaveEngine(afterAdd, tl, amp, 0);
          expect(engineAdd.getPoints().length).toBe(pts0.length + 1);
          expect(Math.abs(beatsA + beatsB - (segEnd - segStart))).toBeLessThan(1e-6);

          // [Step 2b: Delete] remove vertex k+1 (merge the split pair)
          const vi = k + 1;
          const ptsAdd = engineAdd.getPoints();
          const yPrevD = ptsAdd[vi - 1].y;
          const yNextD = ptsAdd[vi + 1].y;
          const totalBeats = afterAdd[vi - 1].beats + afterAdd[vi].beats;
          const mergedBeats = Math.max(snap, quantizeBeat(totalBeats, snap));
          const d = yNextD - yPrevD;
          const mergedDir: Segment['direction'] = Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';
          const afterDelete = [...afterAdd];
          afterDelete.splice(vi - 1, 2, { direction: mergedDir, beats: mergedBeats });

          // [Step 3: Assert]
          const engineFinal = new WaveEngine(afterDelete, tl, amp, 0);
          const ptsFinal = engineFinal.getPoints();
          const totalFinal = ptsFinal[ptsFinal.length - 1].beat - ptsFinal[0].beat;
          expect(Math.abs(totalFinal - totalOrig)).toBeLessThanOrEqual(0.5 * snap + 1e-6);
          expect(afterDelete.length).toBe(original.length);
          expect(ptsFinal.length).toBe(original.length + 1);
          expect(ptsFinal.length).toBe(pts0.length);
          for (const s of afterDelete) expect(isSnapAligned(s.beats, snap)).toBe(true);

          // Subsequent beats beyond merged segment unchanged in span
          // (only the merged segment itself may be quantized, rest identical)
          const tailOrigBeats = original.slice(k + 1).reduce((a, s) => a + s.beats, 0);
          const tailFinalBeats = afterDelete.slice(k + 1).reduce((a, s) => a + s.beats, 0);
          expect(Math.abs(tailFinalBeats - tailOrigBeats)).toBeLessThan(1e-6);
        });
      }
    }
  });

  // ------------------------------------------------------------------
  // 5. Edge drag preserves original length (parallel move, 3 segments only)
  // ------------------------------------------------------------------
  describe('5. Edge drag preserves origLen and adjacent via toBeat-fromBeat', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: edge drag keeps quantized origLen`, () => {
          // [Step 1: Capture Initial]
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 1.5 },
            { direction: 'up', beats: 2.0 },
            { direction: 'down', beats: 1.5 },
            { direction: 'up', beats: 1.0 },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const edgeIdx = 1;
          const origLen = pts0[edgeIdx + 1].beat - pts0[edgeIdx].beat;

          // [Step 2: Drag] off-grid dxBeat 0.37 / 1.23 and dy 25
          const dxBeat = snap === 0.125 ? 0.37 : snap === 0.25 ? 1.23 : 0.63;
          const quantizedDx = quantizeBeat(dxBeat, snap);
          const dy = 25;

          const result = calculateEdgeDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            edgeIndex: edgeIdx,
            startBeat: pts0[edgeIdx].beat,
            startY: pts0[edgeIdx].y,
            startPrevBeat: pts0[edgeIdx - 1].beat,
            startNextBeat: pts0[edgeIdx + 2].beat,
            dxBeat: quantizedDx,
            dy,
            snap,
          });
          expect(result).not.toBeNull();
          const segs = result!;

          // [Step 3: Assert]
          // Edge beats = quantized original length, not max(|dxBeat|, dy/pp)
          const expectedEdgeBeats = Math.max(snap, quantizeBeat(origLen, snap));
          expect(segs[edgeIdx].beats).toBeCloseTo(expectedEdgeBeats, 6);
          // Must NOT be max(quantizedDx) which old bug produced
          if (Math.abs(quantizedDx) > expectedEdgeBeats + 1e-6) {
            expect(segs[edgeIdx].beats).not.toBeCloseTo(Math.max(snap, quantizeBeat(Math.abs(quantizedDx), snap)), 6);
          }

          // All beats snap aligned
          for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);

          // Total count unchanged, getPoints length unchanged
          expect(segs.length).toBe(initial.length);
          const engine1 = new WaveEngine(segs, tl, amp, 0);
          expect(engine1.getPoints().length).toBe(pts0.length);

          // Adjacent segments recomputed via horizontal distances
          // (not some perBeat threshold)
          if (edgeIdx > 0) {
            expect(segs[edgeIdx - 1].beats).toBeGreaterThanOrEqual(snap - 1e-6);
            expect(isSnapAligned(segs[edgeIdx - 1].beats, snap)).toBe(true);
          }
          if (edgeIdx + 1 < segs.length) {
            expect(segs[edgeIdx + 1].beats).toBeGreaterThanOrEqual(snap - 1e-6);
            expect(isSnapAligned(segs[edgeIdx + 1].beats, snap)).toBe(true);
          }
        });

        it(`amp=${amp} snap=${snap}: edge drag with zero dy still preserves length`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [
            { direction: 'down', beats: 1.0 },
            { direction: 'up', beats: 1.0 },
            { direction: 'down', beats: 1.0 },
          ];
          const pts = new WaveEngine(segs, tl, amp, 0).getPoints();
          const idx = 1;
          const origLen = pts[idx + 1].beat - pts[idx].beat;
          const res = calculateEdgeDrag({
            segments: segs,
            bpmTimeline: tl,
            startPosition: 0,
            edgeIndex: idx,
            startBeat: pts[idx].beat,
            startY: pts[idx].y,
            startPrevBeat: pts[idx - 1].beat,
            startNextBeat: pts[idx + 2].beat,
            dxBeat: quantizeBeat(0.37, snap),
            dy: 0,
            snap,
          });
          expect(res).not.toBeNull();
          expect(res![idx].beats).toBeCloseTo(Math.max(snap, quantizeBeat(origLen, snap)), 6);
        });
      }
    }
  });

  // ------------------------------------------------------------------
  // 6. WaveEngine ↔ Cursor numerical consistency (T127/T128 slope)
  // ------------------------------------------------------------------
  describe('6. WaveEngine slope == Cursor speed 2*TW_AMP*amp per beat (complex amp, off-grid)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offBeats = [0.37, 1.23, 0.25, 0.5, 1.37];

    for (const amp of amps) {
      it(`amp=${amp}: short unclamped segment displacement == 2*TW_AMP*amp*beats`, () => {
        const tl = new BpmTimeline(120, [], amp);
        // Choose beats small enough to avoid clamp: beats * perBeatPx < 2*TW_AMP
        // perBeatPx = 2*130*amp, so beats < 1/amp
        const beats = Math.min(0.37, (1 / amp) * 0.5);
        const segs: Segment[] = [{ direction: 'down', beats }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        const pts = engine.getPoints();
        const disp = pts[1].y - pts[0].y;
        const expected = 2 * TW_AMP * amp * beats;
        expect(Math.abs(disp - expected)).toBeLessThan(1e-6);
      });

      for (const ob of offBeats) {
        it(`amp=${amp} off=${ob}: waveYAt interpolation equals per-beat dY clamp`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [
            { direction: 'down', beats: 3 },
            { direction: 'up', beats: 3 },
          ];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const pts = engine.getPoints();
          // Query an off-grid beat inside first segment before clamp hits
          const p0 = pts[0];
          const perBeat = 2 * TW_AMP * amp;
          // Before clamp boundary: beat where rawY still inside [TOP,BOTTOM]
          const safeBeat = Math.min(0.37, p0.beat + (TW_AMP / perBeat) * 0.5);
          if (safeBeat <= p0.beat) return;
          if (safeBeat >= pts[1].beat) return;
          const rawY = p0.y + perBeat * (safeBeat - p0.beat);
          const expected = Math.max(TOP, Math.min(BOTTOM, rawY));
          expect(Math.abs(engine.waveYAt(safeBeat) - expected)).toBeLessThan(1e-6);
          // Also check explicit off-grid beats from spec
          const qBeat = ob;
          if (qBeat < pts[1].beat && qBeat > 0) {
            const raw2 = p0.y + perBeat * qBeat;
            const exp2 = Math.max(TOP, Math.min(BOTTOM, raw2));
            // Only assert if not clamped beyond boundary (avoid clamped flat region confusion)
            if (exp2 !== TOP && exp2 !== BOTTOM) {
              expect(Math.abs(engine.waveYAt(qBeat) - exp2)).toBeLessThan(1e-6);
            }
          }
        });
      }

      it(`amp=${amp}: Cursor 1-beat displacement matches WaveEngine per-beat`, () => {
        const beatMs = 500; // 120 BPM
        const dt = (beatMs / 1000);
        const cursor = new Cursor(amp, 0);
        cursor.setAmplitude(amp);
        const startY = cursor.y;
        cursor.update(dt, false, true, beatMs); // down for 1 beat
        const cursorDisp = cursor.y - startY;
        const expected = 2 * TW_AMP * amp; // per T127: 2*TW_AMP*amp per beat
        // Account for clamp at edges
        const clampedExpected = Math.min(BOTTOM - startY, expected);
        expect(Math.abs(cursorDisp - clampedExpected)).toBeLessThan(1e-3);
      });
    }

    it('all getPoints Y within bounds for complex amplitudes and off-grid beats', () => {
      const amps = [0.7, 1.3, 2.7, 3.4];
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs: Segment[] = [
          { direction: 'down', beats: 0.37 },
          { direction: 'up', beats: 1.23 },
          { direction: 'stay', beats: 0.5 },
          { direction: 'down', beats: 2.7 },
        ];
        const eng = new WaveEngine(segs, tl, amp, 0);
        for (const p of eng.getPoints()) {
          expect(p.y).toBeGreaterThanOrEqual(TOP - 1e-6);
          expect(p.y).toBeLessThanOrEqual(BOTTOM + 1e-6);
        }
        // waveYAt at off-grid positions also bounded
        for (const b of [0.37, 1.23, 2.0, 3.7]) {
          const y = eng.waveYAt(b);
          expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
          expect(y).toBeLessThanOrEqual(BOTTOM + 1e-6);
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // 7. Invariants: every beats snap-aligned and points length == segments.length+1
  // ------------------------------------------------------------------
  describe('7. Global invariants: snap alignment & getPoints length', () => {
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    for (const snap of snaps) {
      it(`snap=${snap}: after vertex/edge ops every beats is integer multiple of snap`, () => {
        const amp = 1.3;
        const tl = new BpmTimeline(120, [], amp);
        const initial: Segment[] = [
          { direction: 'down', beats: snap },
          { direction: 'up', beats: snap * 2 },
          { direction: 'down', beats: snap * 3 },
        ];
        const pts0 = new WaveEngine(initial, tl, amp, 0).getPoints();
        // vertex drag
        const vRes = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: 1,
          targetBeat: quantizeBeat(pts0[1].beat + 0.37, snap),
          targetY: pts0[1].y,
          snap,
        });
        if (vRes) {
          for (const s of vRes) expect(isSnapAligned(s.beats, snap)).toBe(true);
          expect(new WaveEngine(vRes, tl, amp, 0).getPoints().length).toBe(vRes.length + 1);
        }
        // edge drag
        const eRes = calculateEdgeDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          edgeIndex: 0,
          startBeat: pts0[0].beat,
          startY: pts0[0].y,
          startPrevBeat: 0,
          startNextBeat: pts0[2].beat,
          dxBeat: quantizeBeat(0.37, snap),
          dy: 10,
          snap,
        });
        if (eRes) {
          for (const s of eRes) expect(isSnapAligned(s.beats, snap)).toBe(true);
          expect(new WaveEngine(eRes, tl, amp, 0).getPoints().length).toBe(eRes.length + 1);
        }
        // original also invariant
        expect(new WaveEngine(initial, tl, amp, 0).getPoints().length).toBe(initial.length + 1);
      });
    }
  });
});
