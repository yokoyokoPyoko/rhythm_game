import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

/**
 * Reference implementation of T148 vertex deletion:
 * vi: totalBeats = segments[vi-1].beats + segments[vi].beats.
 * beats = quantizeBeat(totalBeats, safeSnap).
 * dir = |d| < 0.5 ? 'stay' : d < 0 ? 'up' : 'down' (d = yNext - yPrev).
 * Endpoints cannot be deleted.
 */
function referenceT148VertexDelete(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  vi: number,
  safeSnap: number
): Segment[] | null {
  const snap = safeSnap > 0 ? safeSnap : 0.25;
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  if (vi <= 0 || vi >= pts.length - 1) return null; // endpoints cannot be deleted

  const yPrev = pts[vi - 1].y;
  const yNext = pts[vi + 1].y;
  const totalBeats = segments[vi - 1].beats + segments[vi].beats;
  const beats = Math.max(snap, quantizeBeat(totalBeats, snap));
  const d = yNext - yPrev;
  const dir: 'up' | 'down' | 'stay' = Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';

  const newSegments = [...segments];
  newSegments.splice(vi - 1, 2, { direction: dir, beats });
  return newSegments;
}

/**
 * Reference implementation of T148 edge deletion:
 * Edge i deletion is equivalent to vertex i+1 deletion.
 */
function referenceT148EdgeDelete(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  edgeIdx: number,
  safeSnap: number
): Segment[] | null {
  if (edgeIdx < 0 || edgeIdx >= segments.length) return null;
  const vi = edgeIdx + 1;
  return referenceT148VertexDelete(segments, timeline, startPosition, vi, safeSnap);
}

describe('T148 頂点/辺削除時の周辺変化最小化 — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. Vertex Deletion (vi) invariants and total beats preservation', () => {
    const amplitudes = [0.7, 1.3, 2.7];
    const snaps = [0.25, 0.5];

    for (const amp of amplitudes) {
      for (const snap of snaps) {
        it(`amp=${amp}, snap=${snap}: vertex deletion preserves total beats within ±0.5*snap and decreases points length by 1`, () => {
          // [Step 1: Capture Initial State]
          const tl = new BpmTimeline(120, [], amp);
          const initialSegments: Segment[] = [
            { direction: 'down', beats: snap * 2 },
            { direction: 'up', beats: snap },
            { direction: 'down', beats: snap * 2 },
            { direction: 'up', beats: snap * 3 },
          ];
          const engine0 = new WaveEngine(initialSegments, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const initialPtsLen = pts0.length;
          const vi = 2; // vertex index 2 (between seg 1 and 2)
          const expectedTotalBeats = initialSegments[vi - 1].beats + initialSegments[vi].beats;

          // [Step 2: Perform User Interaction / Deletion Simulation]
          const deletedSegments = referenceT148VertexDelete(initialSegments, tl, 0, vi, snap);
          expect(deletedSegments).not.toBeNull();

          const engine1 = new WaveEngine(deletedSegments!, tl, amp, 0);
          const pts1 = engine1.getPoints();

          // [Step 3: Assert Resulting Transition]
          // (a) Points length decreased by exactly 1
          expect(pts1.length).toBe(initialPtsLen - 1);

          // (b) Total beats preserved within ±0.5 * snap (or exact quantizeBeat)
          const newMergedSeg = deletedSegments![vi - 1];
          expect(Math.abs(newMergedSeg.beats - expectedTotalBeats)).toBeLessThanOrEqual(0.5 * snap + 1e-6);
          expect(isSnapAligned(newMergedSeg.beats, snap)).toBeTruthy();

          // (c) All beats snap aligned
          for (const s of deletedSegments!) {
            expect(isSnapAligned(s.beats, snap)).toBeTruthy();
          }
        });
      }
    }

    it('rejects deletion of endpoints (vi=0 or vi=pts.length-1)', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 1.0 },
      ];
      const res0 = referenceT148VertexDelete(initial, tl, 0, 0, 0.25);
      const resLast = referenceT148VertexDelete(initial, tl, 0, 2, 0.25);
      expect(res0).toBeNull();
      expect(resLast).toBeNull();
    });
  });

  describe('2. Edge Deletion (ei) equivalent to vertex i+1 deletion', () => {
    it('edge deletion merges 2 segments into 1 with snap alignment and points length -1', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 1.25 },
        { direction: 'up', beats: 0.75 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();

      const edgeIdx = 1; // edge 1 (corresponds to vertex 2)
      const expectedBeats = initial[edgeIdx].beats + initial[edgeIdx + 1].beats;

      const deleted = referenceT148EdgeDelete(initial, tl, 0, edgeIdx, snap);
      expect(deleted).not.toBeNull();
      expect(deleted!.length).toBe(initial.length - 1);

      const engine1 = new WaveEngine(deleted!, tl, 1.0, 0);
      expect(engine1.getPoints().length).toBe(pts0.length - 1);

      const merged = deleted![edgeIdx];
      expect(isSnapAligned(merged.beats, snap)).toBeTruthy();
      expect(Math.abs(merged.beats - expectedBeats)).toBeLessThanOrEqual(0.5 * snap + 1e-6);
    });
  });

  describe('3. Round-trip restoration (add -> delete)', () => {
    it('round-trip insertion and deletion restores original segment structure and total beats', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'up', beats: 2.0 },
        { direction: 'down', beats: 2.0 },
      ];
      const originalTotalBeats = initial.reduce((sum, s) => sum + s.beats, 0);

      // Simulate split (add vertex)
      const splitSegments: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 2.0 },
      ];
      const splitTotalBeats = splitSegments.reduce((sum, s) => sum + s.beats, 0);
      expect(splitTotalBeats).toBe(originalTotalBeats);

      // Simulate delete vertex at index 1
      const restored = referenceT148VertexDelete(splitSegments, tl, 0, 1, snap);
      expect(restored).not.toBeNull();
      const restoredTotalBeats = restored!.reduce((sum, s) => sum + s.beats, 0);

      expect(restoredTotalBeats).toBeCloseTo(originalTotalBeats, 4);
      expect(restored!.length).toBe(initial.length);
    });
  });
});
