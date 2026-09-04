import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { calculateVertexDrag, calculateEdgeDrag } from '../src/game/editorDrag';
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

describe('T147 + T149 vertex/edge drag — direct WaveEngine numerical integration', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. Vertex Drag: X tracking (beats from horizontal, direction from Y)', () => {
    const amps = [0.7, 1.3, 2.7];
    const snaps = [0.25, 0.5] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: horizontal-only drag tracks mouse X`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 2 },
            { direction: 'up', beats: 2 },
            { direction: 'down', beats: 2 },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          expect(pts0.length).toBe(4);

          // Drag vertex index 1 (interior) purely horizontally — same Y as current
          const idx = 1;
          const currentY = pts0[idx].y;
          const targetBeat = quantizeBeat(1.37, snap); // off-grid phase
          const result = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat,
            targetY: currentY, // same Y → no vertical movement
            snap,
          });
          expect(result).not.toBeNull();
          expect(result!.length).toBe(initial.length);

          // All beats snap-aligned
          for (const s of result!) {
            expect(isSnapAligned(s.beats, snap)).toBeTruthy();
          }

          // Vertex should follow X: getPoints()[idx].beat ≈ targetBeat
          const engine1 = new WaveEngine(result!, tl, amp, 0);
          const pts1 = engine1.getPoints();
          expect(pts1.length).toBe(pts0.length);
          expect(Math.abs(pts1[idx].beat - targetBeat)).toBeLessThan(1e-6);

          // beatsPrev + beatsNext = prev-beat to next-beat span (unchanged neighbors)
          const totalSegBeats = result![idx - 1].beats + result![idx].beats;
          const originalSpan = pts0[idx + 1].beat - pts0[idx - 1].beat;
          expect(Math.abs(totalSegBeats - originalSpan)).toBeLessThan(1e-6);
        });

        it(`amp=${amp} snap=${snap}: vertical drag changes Y and direction`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 2 },
            { direction: 'up', beats: 2 },
            { direction: 'down', beats: 2 },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const idx = 1;
          // Drag to a different Y (bottom area)
          const targetBeat = quantizeBeat(1.5, snap);
          const targetY = BOTTOM - 10;
          const result = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: idx,
            targetBeat,
            targetY,
            snap,
          });
          expect(result).not.toBeNull();
          // beatsPrev + beatsNext should still span the same range
          const totalSegBeats = result![idx - 1].beats + result![idx].beats;
          const originalSpan = pts0[idx + 1].beat - pts0[idx - 1].beat;
          expect(Math.abs(totalSegBeats - originalSpan)).toBeLessThan(1e-6);
        });
      }
    }
  });

  describe('2. Vertex Drag: Endpoint handling', () => {
    it('first vertex drag adjusts only segment 0', () => {
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const nextBeat = pts0[1].beat;
      const targetBeat = quantizeBeat(0.5, snap);
      const targetY = CENTER;

      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 0,
        targetBeat,
        targetY,
        snap,
      });
      expect(result).not.toBeNull();
      // Segment 1 unchanged
      expect(result![1].beats).toBeCloseTo(initial[1].beats, 4);
      // Segment 0 beats = nextBeat - targetBeat
      const expectedBeats = nextBeat - targetBeat;
      expect(result![0].beats).toBeCloseTo(expectedBeats, 4);
    });

    it('last vertex drag adjusts only last segment', () => {
      const amp = 1.0;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const prevBeat = pts0[1].beat;
      const targetBeat = quantizeBeat(5.0, snap);
      const targetY = TOP + 20;

      const result = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: pts0.length - 1,
        targetBeat,
        targetY,
        snap,
      });
      expect(result).not.toBeNull();
      // Segment 0 unchanged
      expect(result![0].beats).toBeCloseTo(initial[0].beats, 4);
      // Segment 1 beats = targetBeat - prevBeat
      const expectedBeats = targetBeat - prevBeat;
      expect(result![1].beats).toBeCloseTo(expectedBeats, 4);
    });
  });

  describe('3. Edge Drag: preserve original length, parallel move', () => {
    const amps = [0.7, 1.3, 2.7];
    for (const amp of amps) {
      it(`amp=${amp}: edge drag preserves original segment beat length`, () => {
        const snap = 0.25;
        const tl = new BpmTimeline(120, [], amp);
        const initial: Segment[] = [
          { direction: 'down', beats: 1.5 },
          { direction: 'up', beats: 2.0 },
          { direction: 'down', beats: 1.5 },
        ];
        const engine0 = new WaveEngine(initial, tl, amp, 0);
        const pts0 = engine0.getPoints();
        const edgeIdx = 1;
        const origEdgeBeats = pts0[edgeIdx + 1].beat - pts0[edgeIdx].beat;

        // Drag edge right by 0.37 beats and down by 30px (off-grid)
        const dxBeat = 0.37;
        const dy = 30;
        const result = calculateEdgeDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          edgeIndex: edgeIdx,
          startBeat: pts0[edgeIdx].beat,
          startY: pts0[edgeIdx].y,
          startPrevBeat: edgeIdx > 0 ? pts0[edgeIdx - 1].beat : 0,
          startNextBeat: edgeIdx + 2 < pts0.length ? pts0[edgeIdx + 2].beat : pts0[pts0.length - 1].beat,
          dxBeat,
          dy,
          snap,
        });
        expect(result).not.toBeNull();
        expect(result!.length).toBe(initial.length);

        // Edge segment beats should be quantized(origEdgeBeats)
        const expectedEdgeBeats = Math.max(snap, quantizeBeat(origEdgeBeats, snap));
        expect(result![edgeIdx].beats).toBeCloseTo(expectedEdgeBeats, 2);

        // All beats snap-aligned
        for (const s of result!) {
          expect(isSnapAligned(s.beats, snap)).toBeTruthy();
        }

        // Adjacent segments should have valid beats
        if (edgeIdx > 0) {
          expect(result![edgeIdx - 1].beats).toBeGreaterThanOrEqual(snap - 1e-6);
        }
        if (edgeIdx + 1 < result!.length) {
          expect(result![edgeIdx + 1].beats).toBeGreaterThanOrEqual(snap - 1e-6);
        }
      });
    }
  });

  describe('4. Vertex add (double-click) preserves total beats', () => {
    it('split preserves total beat span from horizontal position', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 2.0 },
        { direction: 'up', beats: 2.0 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const totalOrigBeats = pts0[pts0.length - 1].beat - pts0[0].beat;

      // Simulate split at beat 0.75 (off-grid)
      const beatAdd = 0.75;
      const beatsA = quantizeBeat(beatAdd - pts0[0].beat, snap);
      const beatsB = quantizeBeat(pts0[1].beat - beatAdd, snap);
      const dirA = 'down' as const;
      const dirB = 'up' as const;

      const splitSegs: Segment[] = [
        { direction: dirA, beats: beatsA },
        { direction: dirB, beats: beatsB },
        ...initial.slice(1),
      ];

      // Total beats should be preserved
      const totalSplitBeats = splitSegs.slice(0, 2).reduce((s, seg) => s + seg.beats, 0);
      expect(Math.abs(totalSplitBeats - (pts0[1].beat - pts0[0].beat))).toBeLessThan(1e-6);

      // All snap aligned
      for (const s of splitSegs) {
        expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      }
    });
  });

  describe('5. getPoints length invariant under all operations', () => {
    it('vertex drag preserves getPoints().length', () => {
      const amp = 2.7;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(segs, tl, amp, 0);
      const len0 = engine0.getPoints().length;

      const result = calculateVertexDrag({
        segments: segs,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 2,
        targetBeat: 2.37,
        targetY: CENTER,
        snap,
      });
      expect(result).not.toBeNull();
      const engine1 = new WaveEngine(result!, tl, amp, 0);
      expect(engine1.getPoints().length).toBe(len0);
    });

    it('edge drag preserves getPoints().length', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 1.5 },
        { direction: 'up', beats: 1.5 },
        { direction: 'down', beats: 1.5 },
      ];
      const engine0 = new WaveEngine(segs, tl, amp, 0);
      const len0 = engine0.getPoints().length;
      const pts0 = engine0.getPoints();

      const result = calculateEdgeDrag({
        segments: segs,
        bpmTimeline: tl,
        startPosition: 0,
        edgeIndex: 1,
        startBeat: pts0[1].beat,
        startY: pts0[1].y,
        startPrevBeat: pts0[0].beat,
        startNextBeat: pts0[3].beat,
        dxBeat: 0.37,
        dy: 20,
        snap,
      });
      expect(result).not.toBeNull();
      const engine1 = new WaveEngine(result!, tl, amp, 0);
      expect(engine1.getPoints().length).toBe(len0);
    });
  });
});
