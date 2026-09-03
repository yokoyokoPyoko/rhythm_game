import type { BpmTimeline } from '../audio/bpmTimeline';
import { quantizeBeat } from '../chart/quantize';
import type { Segment } from '../types';
import { TW_CENTER_Y, TW_AMP, WaveEngine } from './waveEngine';

const EDITOR_BASE_AMP = 1.0;

function dir(d: number): 'up' | 'down' | 'stay' {
  return Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';
}

function perBeat(bpmTimeline: BpmTimeline, beat: number): number {
  return 2 * TW_AMP * bpmTimeline.amplitudeAt(beat);
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

  const engine = new WaveEngine(segments, bpmTimeline, EDITOR_BASE_AMP, startPosition);
  const pts = engine.getPoints();
  const idx = pointIndex;

  // Endpoint: first vertex (index 0) — adjust only segment 0
  if (idx === 0 && segments.length > 0) {
    const nextPt = pts[1];
    const nextBeat = nextPt?.beat ?? pts[0].beat + safeSnap;
    let clampedBeat = Math.max(safeSnap, Math.min(nextBeat - safeSnap, targetBeat));
    clampedBeat = quantizeBeat(clampedBeat, safeSnap);
    const yNext = nextPt?.y ?? TW_CENTER_Y;
    const pb = perBeat(bpmTimeline, 0);
    const d0 = targetY - yNext;
    const segBeats = Math.max(safeSnap, quantizeBeat(Math.abs(d0) / pb, safeSnap));
    const d = dir(d0);
    return segments.map((s, i) => (i === 0 ? { ...s, beats: segBeats, direction: d } : s));
  }

  // Endpoint: last vertex — adjust only last segment
  if (idx === pts.length - 1 && segments.length > 0) {
    const prevPt = pts[idx - 1];
    const prevBeat = prevPt?.beat ?? 0;
    const yPrev = prevPt?.y ?? TW_CENTER_Y;
    const pb = perBeat(bpmTimeline, prevBeat);
    const dLast = targetY - yPrev;
    const segBeats = Math.max(safeSnap, quantizeBeat(Math.abs(dLast) / pb, safeSnap));
    const dLastDir = dir(dLast);
    return segments.map((s, i) => (i === idx - 1 ? { ...s, beats: segBeats, direction: dLastDir } : s));
  }

  // Interior vertex — adjust 2 adjacent segments
  if (idx < 1 || idx >= pts.length) return null;

  const prevPt = pts[idx - 1];
  const nextPt = pts[idx + 1];
  const prevBeat = prevPt.beat;
  const nextBeat = nextPt.beat;
  const yPrev = prevPt.y;
  const yNext = nextPt.y;

  // Clamp beat to [prevBeat + safeSnap, nextBeat - safeSnap] and quantize
  let beatPrime = Math.max(prevBeat + safeSnap, Math.min(nextBeat - safeSnap, targetBeat));
  beatPrime = quantizeBeat(beatPrime, safeSnap);

  const pbPrev = perBeat(bpmTimeline, prevBeat);
  const pbCur = perBeat(bpmTimeline, beatPrime);

  const beatsPrev = Math.max(safeSnap, quantizeBeat(Math.abs(targetY - yPrev) / pbPrev, safeSnap));
  const beatsNext = Math.max(safeSnap, quantizeBeat(Math.abs(yNext - targetY) / pbCur, safeSnap));

  const candidateSegs = segments.map((s, i) => {
    if (i === idx - 1) return { ...s, direction: dir(targetY - yPrev), beats: beatsPrev };
    if (i === idx) return { ...s, direction: dir(yNext - targetY), beats: beatsNext };
    return s;
  });

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
  const safeSnap = snap > 0 ? snap : 0.25;
  if (segments.length === 0) return null;

  const engine = new WaveEngine(segments, bpmTimeline, EDITOR_BASE_AMP, startPosition);
  const pts = engine.getPoints();
  const idx = edgeIndex;

  // Shift the edge endpoints
  const beatI = pts[idx].beat + dxBeat;
  const beatI1 = pts[idx + 1].beat + dxBeat;
  const yI = clampY(startY + dy);
  const yI1 = clampY(pts[idx + 1].y + dy);

  const segmentFor = (fromBeat: number, fromY: number, toY: number): Segment => {
    const d = toY - fromY;
    if (Math.abs(d) < 0.5) return { direction: 'stay', beats: safeSnap };
    return {
      direction: d < 0 ? 'up' : 'down',
      beats: Math.max(safeSnap, quantizeBeat(Math.abs(d) / perBeat(bpmTimeline, fromBeat), safeSnap)),
    };
  };

  return segments.map((s, i) => {
    if (i === idx - 1 && i >= 0) {
      return segmentFor(pts[idx - 1].beat, pts[idx - 1].y, yI);
    }
    if (i === idx) {
      return segmentFor(beatI, yI, yI1);
    }
    if (i === idx + 1 && i + 1 < pts.length) {
      const pAfter = pts[idx + 2];
      return pAfter ? segmentFor(beatI1, yI1, pAfter.y) : s;
    }
    return s;
  });
}
