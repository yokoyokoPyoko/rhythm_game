import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

function isSnapAligned(beats: number, snap: number, epsilon = 1e-6): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < epsilon || Math.abs(rem - snap) < epsilon;
}

/**
 * Reference implementation of T148 vertex deletion helper for testing spec compliance.
 * Vertex deletion (vi):
 * - totalBeats = segments[vi-1].beats + segments[vi].beats
 * - dir based on d = yNext - yPrev
 * - beats = quantizeBeat(totalBeats, safeSnap) (total beats preservation priority)
 * - Endpoints cannot be deleted.
 */
function referenceDeleteVertex(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  vi: number,
  safeSnap: number
): Segment[] | null {
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  if (vi <= 0 || vi >= pts.length - 1) return null; // Endpoints cannot be deleted

  const segIdxPrev = vi - 1;
  const segIdxNext = vi;
  if (segIdxPrev < 0 || segIdxNext >= segments.length) return null;

  const totalBeats = segments[segIdxPrev].beats + segments[segIdxNext].beats;
  const mergedBeats = Math.max(safeSnap, quantizeBeat(totalBeats, safeSnap));

  const prevPt = pts[vi - 1];
  const nextPt = pts[vi + 1];
  const d = nextPt.y - prevPt.y;
  const dir: 'up' | 'down' | 'stay' = Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';

  const mergedSeg: Segment = { direction: dir, beats: Number(mergedBeats.toFixed(4)) };

  const newSegments: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i === segIdxPrev) {
      newSegments.push(mergedSeg);
      i++; // skip next segment as it's merged
    } else {
      newSegments.push(segments[i]);
    }
  }
  return newSegments;
}

/**
 * Reference implementation of T148 edge deletion helper for testing spec compliance.
 * Edge deletion (ei) = deleting vertex i+1 (merging segments[i] and segments[i+1]).
 */
function referenceDeleteEdge(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  ei: number,
  safeSnap: number
): Segment[] | null {
  if (ei < 0 || ei >= segments.length - 1) return null;
  const vi = ei + 1;
  return referenceDeleteVertex(segments, timeline, startPosition, vi, safeSnap);
}

describe('T148 頂点/辺削除時の周辺変化最小化 — Vitest node unit tests', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  const amplitudes = [0.7, 1.3, 2.7, 3.4];
  const snaps = [0.25, 0.5, 0.125];

  describe('1. Vertex Deletion (vi) invariants and totalBeats preservation', () => {
    for (const amp of amplitudes) {
      for (const snap of snaps) {
        it(`amp=${amp}, snap=${snap}: vertex deletion preserves totalBeats and decreases points length by 1`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const initialSegments: Segment[] = [
            { direction: 'up', beats: 1.25 },
            { direction: 'down', beats: 1.37 }, // off-grid phase
            { direction: 'up', beats: 1.0 },
            { direction: 'down', beats: 0.75 },
          ];

          const engine0 = new WaveEngine(initialSegments, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const initialPointsLen = pts0.length;

          const vi = 2; // interior vertex
          const segPrev = initialSegments[vi - 1];
          const segNext = initialSegments[vi];
          const originalTotalBeats = segPrev.beats + segNext.beats;

          const newSegments = referenceDeleteVertex(initialSegments, tl, 0, vi, snap);
          expect(newSegments).not.toBeNull();

          const engine1 = new WaveEngine(newSegments!, tl, amp, 0);
          const pts1 = engine1.getPoints();

          // Completion Criterion (1): totalBeats invariant within +/- 0.5 * snap
          const newTotalBeats = newSegments![vi - 1].beats;
          expect(Math.abs(newTotalBeats - originalTotalBeats)).toBeLessThanOrEqual(0.5 * snap + 1e-6);

          // Completion Criterion (2): getPoints length decreases by 1
          expect(pts1.length).toBe(initialPointsLen - 1);

          // Completion Criterion (3): all beats are exact snap multiples
          for (const s of newSegments!) {
            expect(isSnapAligned(s.beats, snap)).toBeTruthy();
          }
        });
      }
    }
  });

  describe('2. Edge Deletion (ei) 2-to-1 merge and snap alignment', () => {
    for (const amp of amplitudes) {
      for (const snap of snaps) {
        it(`amp=${amp}, snap=${snap}: edge deletion merges two segments correctly`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const initialSegments: Segment[] = [
            { direction: 'down', beats: 1.0 },
            { direction: 'up', beats: 1.23 },
            { direction: 'down', beats: 1.5 },
          ];

          const engine0 = new WaveEngine(initialSegments, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const initialPointsLen = pts0.length;

          const ei = 1; // edge 1 (between vertex 1 and 2)
          const originalSum = initialSegments[ei].beats + initialSegments[ei + 1].beats;

          const newSegments = referenceDeleteEdge(initialSegments, tl, 0, ei, snap);
          expect(newSegments).not.toBeNull();

          const engine1 = new WaveEngine(newSegments!, tl, amp, 0);
          const pts1 = engine1.getPoints();

          // Deleting edge i merges segments[i] and segments[i+1]
          expect(newSegments!.length).toBe(initialSegments.length - 1);
          expect(pts1.length).toBe(initialPointsLen - 1);
          expect(Math.abs(newSegments![ei].beats - originalSum)).toBeLessThanOrEqual(0.5 * snap + 1e-6);

          for (const s of newSegments!) {
            expect(isSnapAligned(s.beats, snap)).toBeTruthy();
          }
        });
      }
    }
  });

  describe('3. Add -> Delete Round-trip Total Beats Restoration', () => {
    it('round-trip add vertex then delete vertex restores total beats and point count', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const baseSegments: Segment[] = [
        { direction: 'up', beats: 2.0 },
        { direction: 'down', beats: 2.0 },
      ];
      const snap = 0.25;

      const engineBase = new WaveEngine(baseSegments, tl, 1.0, 0);
      const basePtsLen = engineBase.getPoints().length;

      // Simulate adding a vertex by splitting segment 0 into two segments of equal sum
      const splitSegments: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 2.0 },
      ];
      const engineSplit = new WaveEngine(splitSegments, tl, 1.0, 0);
      expect(engineSplit.getPoints().length).toBe(basePtsLen + 1);

      // Now delete the added vertex (vi = 1)
      const deletedSegments = referenceDeleteVertex(splitSegments, tl, 0, 1, snap);
      expect(deletedSegments).not.toBeNull();

      const engineFinal = new WaveEngine(deletedSegments!, tl, 1.0, 0);
      expect(engineFinal.getPoints().length).toBe(basePtsLen);
      expect(deletedSegments![0].beats + deletedSegments![1].beats).toBeCloseTo(baseSegments[0].beats + baseSegments[1].beats, 4);
    });
  });

  describe('4. Endpoints Deletion Protection', () => {
    it('attempts to delete endpoint vertex (vi = 0 or last) return null or are rejected', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const segments: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 1.0 },
      ];
      const engine = new WaveEngine(segments, tl, 1.0, 0);
      const pts = engine.getPoints();

      // vi = 0 is start endpoint
      const res0 = referenceDeleteVertex(segments, tl, 0, 0, 0.25);
      expect(res0).toBeNull();

      // vi = pts.length - 1 is end endpoint
      const resLast = referenceDeleteVertex(segments, tl, 0, pts.length - 1, 0.25);
      expect(resLast).toBeNull();
    });
  });
});
