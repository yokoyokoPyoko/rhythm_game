import type { BpmTimeline } from '../audio/bpmTimeline';
import { quantizeBeat } from '../chart/quantize';
import type { Segment } from '../types';
import { TW_CENTER_Y, TW_AMP, WaveEngine } from './waveEngine';

// T150: Y-snapping divides the physical range [TOP, BOTTOM] into 3 equal zones.
// [170,256.7) -> TOP(170) / [256.7,343.3) -> CENTER(300) / [343.3,430] -> BOTTOM(430).
// Out-of-range clamps to TOP/BOTTOM. The legacy dir() 0.5px threshold is abolished;
// direction and snapped y' are determined simultaneously from the zone (stay when both
// endpoints share a zone). This lets a vertex be placed exactly at CENTER (previously
// impossible with the strict 0.5px stay check).
const ZONE_MID_START = 256.7;
const ZONE_MID_END = 343.3;
const TOP_Y = TW_CENTER_Y - TW_AMP;
const CENTER_Y = TW_CENTER_Y;
const BOTTOM_Y = TW_CENTER_Y + TW_AMP;

function zoneOf(y: number): 0 | 1 | 2 {
  return y < ZONE_MID_START ? 0 : y < ZONE_MID_END ? 1 : 2;
}
function snapY(y: number): number {
  const z = zoneOf(y);
  return z === 0 ? TOP_Y : z === 1 ? CENTER_Y : BOTTOM_Y;
}
function dirBetween(fromY: number, toY: number): 'up' | 'down' | 'stay' {
  const fz = zoneOf(fromY);
  const tz = zoneOf(toY);
  return fz === tz ? 'stay' : tz > fz ? 'down' : 'up';
}

function clampY(y: number): number {
  return Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, y));
}

interface VertexDragInput {
  segments: Segment[];
  bpmTimeline: BpmTimeline;
  startPosition: number;
  pointIndex: number;
  targetBeat: number;
  targetY: number;
  snap: number;
}

export function calculateVertexDrag(input: VertexDragInput): Segment[] | null {
  const { segments, bpmTimeline, startPosition, pointIndex, targetBeat, targetY, snap } = input;
  const safeSnap = snap > 0 ? snap : 0.25;
  if (segments.length === 0) return null;

  const baseAmp = bpmTimeline.amplitudeAt(0);
  const engine = new WaveEngine(segments, bpmTimeline, baseAmp, startPosition);
  const pts = engine.getPoints();
  const idx = pointIndex;

  if (idx < 0 || idx >= pts.length) return null;

  // Endpoint: first vertex (index 0) — adjust only segment 0
  if (idx === 0 && segments.length > 0) {
    const nextPt = pts[1];
    const nextBeat = nextPt?.beat ?? pts[0].beat + safeSnap;
    const clampedBeat = Math.max(safeSnap, Math.min(nextBeat - safeSnap, quantizeBeat(targetBeat, safeSnap)));
    // beats = horizontal distance, direction = from Y
    const beats = quantizeBeat(nextBeat - clampedBeat, safeSnap);
    if (beats < safeSnap) return null;
    const snappedY = snapY(targetY);
    const d = dirBetween(pts[0].y, snappedY);
    return segments.map((s, i) => (i === 0 ? { ...s, beats, direction: d } : s));
  }

  // Endpoint: last vertex — adjust only last segment
  if (idx === pts.length - 1 && segments.length > 0) {
    const prevPt = pts[idx - 1];
    const prevBeat = prevPt?.beat ?? 0;
    const clampedBeat = Math.max(prevBeat + safeSnap, quantizeBeat(targetBeat, safeSnap));
    // beats = horizontal distance, direction = from Y
    const beats = quantizeBeat(clampedBeat - prevBeat, safeSnap);
    if (beats < safeSnap) return null;
    const snappedTargetY = snapY(targetY);
    const d = dirBetween(prevPt.y, snappedTargetY);
    return segments.map((s, i) => (i === idx - 1 ? { ...s, beats, direction: d } : s));
  }

  // Interior vertex — adjust 2 adjacent segments (2 segments only)
  const prevPt = pts[idx - 1];
  const nextPt = pts[idx + 1];
  const prevBeat = prevPt.beat;
  const nextBeat = nextPt.beat;
  const yPrev = prevPt.y;
  const yNext = nextPt.y;

  // T149: beats from X (horizontal) position, direction from Y only
  let beatPrime = quantizeBeat(targetBeat, safeSnap);
  beatPrime = Math.max(prevBeat + safeSnap, Math.min(nextBeat - safeSnap, beatPrime));

  // T157: a drag that (after clamping) lands exactly back on the current beat AND
  // exactly on the current wave Y is a true no-op — return null so the chart and
  // the snap alignment of untouched neighboring segments are left exactly as they
  // were. (Out-of-bounds Y that only snaps/clamps inside the same zone is still a
  // real drag and returns a clamped result.)
  if (Math.abs(beatPrime - pts[idx].beat) < 1e-9 && Math.abs(targetY - pts[idx].y) < 1e-9) {
    return null;
  }

  let beatsPrev = quantizeBeat(beatPrime - prevBeat, safeSnap);
  let beatsNext = quantizeBeat(nextBeat - beatPrime, safeSnap);

  if (beatsPrev < safeSnap || beatsNext < safeSnap) return null;

  const snappedTargetY = snapY(targetY);
  const dirPrev = dirBetween(yPrev, snappedTargetY);
  const dirNext = dirBetween(snappedTargetY, yNext);

  const candidateSegs = segments.map((s, i) => {
    if (i === idx - 1) return { ...s, direction: dirPrev, beats: beatsPrev };
    if (i === idx) return { ...s, direction: dirNext, beats: beatsNext };
    return s;
  });

  // Validate: the vertex at beatPrime should match our clamped target
  const candidateEngine = new WaveEngine(candidateSegs, bpmTimeline, baseAmp, startPosition);
  const pts2 = candidateEngine.getPoints();
  const achievedBeat = pts2[idx]?.beat;
  if (Math.abs(achievedBeat - beatPrime) > safeSnap * 0.51) {
    // The beat didn't land where expected — re-derive beats from actual points
    const actualPrevBeat = pts2[idx - 1]?.beat ?? prevBeat;
    const actualNextBeat = pts2[idx + 1]?.beat ?? nextBeat;
    beatsPrev = quantizeBeat(beatPrime - actualPrevBeat, safeSnap);
    beatsNext = quantizeBeat(actualNextBeat - beatPrime, safeSnap);
    if (beatsPrev < safeSnap || beatsNext < safeSnap) return null;
    for (let i = 0; i < candidateSegs.length; i++) {
      if (i === idx - 1) candidateSegs[i] = { ...candidateSegs[i], beats: beatsPrev };
      if (i === idx) candidateSegs[i] = { ...candidateSegs[i], beats: beatsNext };
    }
  }

  return candidateSegs;
}

export interface MultiDragInput {
  segments: Segment[];
  bpmTimeline: BpmTimeline;
  startPosition: number;
  selSegIdxs: number[];
  dxBeat: number;
  /** Vertical shift in wave-Y units (mapYInverse space, continuous). */
  dy: number;
  snap: number;
}

// T156-fix: rigid parallel move of a multi-selection.
// Moved vertices (= union of selected segments' endpoints, except anchored
// vertex 0) shift together by (dx, dy). Internal segments (both endpoints
// moved) are kept bit-exact — no stretch. Only boundary segments (exactly
// one endpoint moved) are re-derived: beats from the new horizontal distance
// (X-first, snap-quantized), direction from the zone relationship
// (dirBetween), preserving the original direction while the moved endpoint
// stays in its zone. dx is clamped so every boundary keeps >= safeSnap.
export function calculateMultiDrag(input: MultiDragInput): Segment[] | null {
  const { segments, bpmTimeline, startPosition, selSegIdxs, dxBeat, dy, snap } = input;
  const safeSnap = snap > 0 ? snap : 0.25;
  const n = segments.length;
  if (n === 0) return null;
  const selSet = new Set(selSegIdxs.filter((i) => i >= 0 && i < n));
  if (selSet.size === 0) return null;

  const baseAmp = bpmTimeline.amplitudeAt(0);
  const engine = new WaveEngine(segments, bpmTimeline, baseAmp, startPosition);
  const pts = engine.getPoints();

  const moved = new Set<number>();
  selSet.forEach((i) => {
    if (i > 0) moved.add(i);
    moved.add(i + 1);
  });
  moved.delete(0);
  if (moved.size === 0) return segments.map((s) => ({ ...s }));

  const dx = quantizeBeat(dxBeat, safeSnap);
  // Clamp dx so boundary segments keep >= safeSnap and beats stay >= 0.
  let lo = -Infinity;
  let hi = Infinity;
  for (let j = 0; j < n; j++) {
    const a = moved.has(j);
    const b = moved.has(j + 1);
    if (a === b) continue;
    const origLen = pts[j + 1].beat - pts[j].beat;
    if (a && !b) hi = Math.min(hi, origLen - safeSnap);
    else lo = Math.max(lo, safeSnap - origLen);
  }
  moved.forEach((v) => {
    lo = Math.max(lo, -pts[v].beat);
  });
  if (lo > hi) return null;
  const dxC = Math.max(lo, Math.min(hi, dx));

  const newBeat = (v: number): number => pts[v].beat + (moved.has(v) ? dxC : 0);
  const newY = (v: number): number =>
    moved.has(v) ? clampY(pts[v].y + dy) : pts[v].y;

  return segments.map((s, j) => {
    const a = moved.has(j);
    const b = moved.has(j + 1);
    if (!a && !b) return { ...s };
    if (a && b) return { ...s };
    // Boundary: beats from the new horizontal span; direction from zones,
    // preserving the original direction while the moved endpoint stays in
    // its zone (so horizontal-only drags never flip slopes).
    const beats = Math.max(safeSnap, quantizeBeat(newBeat(j + 1) - newBeat(j), safeSnap));
    const movedV = a ? j : j + 1;
    const dir =
      zoneOf(newY(movedV)) === zoneOf(pts[movedV].y)
        ? s.direction
        : dirBetween(newY(j), newY(j + 1));
    return { direction: dir, beats };
  });
}

interface VertexMultiDragInput {
  segments: Segment[];
  bpmTimeline: BpmTimeline;
  startPosition: number;
  vertexIndices: number[];
  dxBeat: number;
  dy: number;
  snap: number;
}

// T157: vertex-unit selection move. Only the selected vertices shift by (dx, dy);
// vertex 0 (the chart start) is always anchored. Changed segments are exactly the
// two neighbors around each moved vertex — no other segments are touched, so a
// single vertex {v} moves alone and trailing beats never shift (the bug where a
// seg-based interpretation moved 2 vertices at once is fixed here).
// Beats come from the new horizontal (X) span (snap-quantized, >= snap); direction
// comes from the zone relationship (T150), preserving the segment's direction while
// the moved endpoint stays inside its zone. dx is clamped so each boundary segment
// keeps >= snap (mirrors the pre-clamp the caller/tests apply).
export function calculateVertexMultiDrag(input: VertexMultiDragInput): Segment[] | null {
  const { segments, bpmTimeline, startPosition, vertexIndices, dxBeat, dy, snap } = input;
  const safeSnap = snap > 0 ? snap : 0.25;
  const n = segments.length;
  if (n === 0) return null;
  if (!Array.isArray(vertexIndices) || vertexIndices.length === 0) return null;

  const baseAmp = bpmTimeline.amplitudeAt(0);
  const engine = new WaveEngine(segments, bpmTimeline, baseAmp, startPosition);
  const pts = engine.getPoints();

  const moved = new Set<number>();
  for (const v of vertexIndices) {
    if (v > 0 && v < pts.length) moved.add(v);
  }
  if (moved.size === 0) return null;

  const dx = quantizeBeat(dxBeat, safeSnap);

  // Only segments adjacent to a moved vertex may change.
  const changed = new Set<number>();
  moved.forEach((v) => {
    if (v - 1 >= 0) changed.add(v - 1);
    if (v < n) changed.add(v);
  });

  // Clamp dx so every boundary segment (exactly one endpoint moved) keeps >= snap,
  // and no moved vertex goes before beat 0.
  let lo = -Infinity;
  let hi = Infinity;
  for (let j = 0; j < n; j++) {
    const a = moved.has(j);
    const b = moved.has(j + 1);
    if (a === b || !changed.has(j)) continue;
    const origLen = pts[j + 1].beat - pts[j].beat;
    if (a && !b) hi = Math.min(hi, origLen - safeSnap);
    else lo = Math.max(lo, safeSnap - origLen);
  }
  moved.forEach((v) => {
    lo = Math.max(lo, -pts[v].beat);
  });
  if (lo > hi) return null;
  const dxC = Math.max(lo, Math.min(hi, dx));

  const newBeat = (v: number): number => pts[v].beat + (moved.has(v) ? dxC : 0);
  const newY = (v: number): number => (moved.has(v) ? clampY(pts[v].y + dy) : pts[v].y);

  return segments.map((s, j) => {
    if (!changed.has(j)) return { ...s };
    const a = moved.has(j);
    const b = moved.has(j + 1);
    // Internal segment (both endpoints moved) travels rigidly — bit-exact.
    if (a && b) return { ...s };
    const beats = Math.max(safeSnap, quantizeBeat(newBeat(j + 1) - newBeat(j), safeSnap));
    const movedV = a ? j : j + 1;
    const dir =
      zoneOf(newY(movedV)) === zoneOf(pts[movedV].y)
        ? s.direction
        : dirBetween(newY(j), newY(j + 1));
    return { direction: dir, beats };
  });
}

interface EdgeDragInput {
  segments: Segment[];
  bpmTimeline: BpmTimeline;
  startPosition: number;
  edgeIndex: number;
  startBeat: number;
  startY: number;
  startPrevBeat: number;
  startNextBeat: number;
  dxBeat: number;
  dy: number;
  snap: number;
}

export function calculateEdgeDrag(input: EdgeDragInput): Segment[] | null {
  const { segments, bpmTimeline, startPosition, edgeIndex, startY, dxBeat, dy, snap } = input;
  const safeSnap = snap > 0 ? snap : 0.25;
  if (segments.length === 0) return null;

  const baseAmp = bpmTimeline.amplitudeAt(0);
  const engine = new WaveEngine(segments, bpmTimeline, baseAmp, startPosition);
  const pts = engine.getPoints();
  const idx = edgeIndex;
  if (idx < 0 || idx >= segments.length) return null;

  const pStart = pts[idx];
  const pEnd = pts[idx + 1];

  // T149: parallel move — shift both endpoints by dxBeat (total from original, not
  // accumulated across preview steps, so successive drags do not double-add).
  const origLen = pEnd.beat - pStart.beat;
  const edgeBeats = Math.max(safeSnap, quantizeBeat(origLen, safeSnap));
  const newYStart = clampY(startY + dy);
  const newYEnd = clampY(pEnd.y + dy);

  // T150: boundary留め clamp — keep adjacent segments from compressing below snap.
  // newBeatStart must satisfy: prev + snap <= newBeatStart and
  // newBeatEnd <= after - snap  (i.e. newBeatStart <= after - edgeBeats - snap).
  const pPrev = pts[idx - 1];
  const pAfter = pts[idx + 2];
  const minStart = pPrev ? pPrev.beat + safeSnap : pStart.beat;
  const maxStart = pAfter ? pAfter.beat - edgeBeats - safeSnap : pStart.beat;
  let newBeatStart = pStart.beat + dxBeat;
  if (maxStart >= minStart) {
    newBeatStart = Math.max(minStart, Math.min(maxStart, newBeatStart));
  } else {
    newBeatStart = pStart.beat;
  }
  const newBeatEnd = newBeatStart + edgeBeats;

  // Edge segment: preserve original duration, direction from Y zone
  const dirEdge = dirBetween(newYStart, newYEnd);

  // Left adjacent segment (i = idx - 1): from prev point to newBeatStart
  // Right adjacent segment (i = idx + 1): from newBeatEnd to next point
  return segments.map((s, i) => {
    if (i === idx - 1 && i >= 0 && pPrev) {
      const segBeats = newBeatStart - pPrev.beat;
      if (segBeats < safeSnap - 1e-6) return s; // too compressed, keep original
      const quantized = Math.max(safeSnap, quantizeBeat(segBeats, safeSnap));
      return { direction: dirBetween(pPrev.y, newYStart), beats: quantized };
    }
    if (i === idx) {
      return {
        direction: dirEdge,
        beats: edgeBeats,
      };
    }
    if (i === idx + 1 && i + 1 < pts.length && pAfter) {
      const segBeats = pAfter.beat - newBeatEnd;
      if (segBeats < safeSnap - 1e-6) return s; // too compressed, keep original
      const quantized = Math.max(safeSnap, quantizeBeat(segBeats, safeSnap));
      return { direction: dirBetween(newYEnd, pAfter.y), beats: quantized };
    }
    return s;
  });
}
