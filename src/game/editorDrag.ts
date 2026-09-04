import type { BpmTimeline } from '../audio/bpmTimeline';
import { quantizeBeat } from '../chart/quantize';
import type { Segment } from '../types';
import { TW_CENTER_Y, TW_AMP, WaveEngine } from './waveEngine';

function dir(d: number): 'up' | 'down' | 'stay' {
  return Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';
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
    const yPrev = clampY(targetY);
    const d = dir(yPrev - pts[0].y);
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
    const clampedTargetY = clampY(targetY);
    const d = dir(clampedTargetY - prevPt.y);
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

  let beatsPrev = quantizeBeat(beatPrime - prevBeat, safeSnap);
  let beatsNext = quantizeBeat(nextBeat - beatPrime, safeSnap);

  if (beatsPrev < safeSnap || beatsNext < safeSnap) return null;

  const clampedTargetY = clampY(targetY);
  const dirPrev = dir(clampedTargetY - yPrev);
  const dirNext = dir(yNext - clampedTargetY);

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
  void startY;
  const safeSnap = snap > 0 ? snap : 0.25;
  if (segments.length === 0) return null;

  const baseAmp = bpmTimeline.amplitudeAt(0);
  const engine = new WaveEngine(segments, bpmTimeline, baseAmp, startPosition);
  const pts = engine.getPoints();
  const idx = edgeIndex;
  if (idx < 0 || idx >= segments.length) return null;

  const pStart = pts[idx];
  const pEnd = pts[idx + 1];

  // T149: parallel move — shift both endpoints by dxBeat
  const origLen = pEnd.beat - pStart.beat;
  const newBeatStart = pStart.beat + dxBeat;
  const newBeatEnd = pEnd.beat + dxBeat;
  const newYStart = clampY(pStart.y + dy);
  const newYEnd = clampY(pEnd.y + dy);

  // Edge segment: preserve original duration, direction from Y delta
  const d = newYEnd - newYStart;
  const dirEdge = dir(d);
  const edgeBeats = Math.max(safeSnap, quantizeBeat(origLen, safeSnap));

  // Left adjacent segment (i = idx - 1): from prev point to newBeatStart
  // Right adjacent segment (i = idx + 1): from newBeatEnd to next point
  return segments.map((s, i) => {
    if (i === idx - 1 && i >= 0) {
      const pPrev = pts[idx - 1];
      const segBeats = newBeatStart - pPrev.beat;
      if (segBeats < safeSnap - 1e-6) return s; // too compressed, keep original
      const quantized = Math.max(safeSnap, quantizeBeat(segBeats, safeSnap));
      const dY = newYStart - pPrev.y;
      const segDir = dir(dY);
      return { direction: segDir, beats: quantized };
    }
    if (i === idx) {
      return {
        direction: dirEdge,
        beats: edgeBeats,
      };
    }
    if (i === idx + 1 && i + 1 < pts.length) {
      const pAfter = pts[idx + 2];
      if (!pAfter) return s;
      const segBeats = pAfter.beat - newBeatEnd;
      if (segBeats < safeSnap - 1e-6) return s; // too compressed, keep original
      const quantized = Math.max(safeSnap, quantizeBeat(segBeats, safeSnap));
      const dY = pAfter.y - newYEnd;
      const segDir = dir(dY);
      return { direction: segDir, beats: quantized };
    }
    return s;
  });
}
