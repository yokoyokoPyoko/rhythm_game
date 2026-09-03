import type { BpmTimeline } from '../audio/bpmTimeline';
import { quantizeBeat } from '../chart/quantize';
import type { Segment } from '../types';
import { TW_CENTER_Y, TW_AMP, WaveEngine } from './waveEngine';

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

  const baseAmp = bpmTimeline.amplitudeAt(0);
  const engine = new WaveEngine(segments, bpmTimeline, baseAmp, startPosition);
  const pts = engine.getPoints();
  const idx = pointIndex;

  if (idx < 0 || idx >= pts.length) return null;

  // Endpoint: first vertex (index 0) — adjust only segment 0
  if (idx === 0 && segments.length > 0) {
    const nextPt = pts[1];
    const nextBeat = nextPt?.beat ?? pts[0].beat + safeSnap;
    let clampedBeat = Math.max(safeSnap, Math.min(nextBeat - safeSnap, targetBeat));
    clampedBeat = quantizeBeat(clampedBeat, safeSnap);
    const clampedTargetY = clampY(targetY);
    const prevY = pts[0].y;
    const pb = perBeat(bpmTimeline, 0);
    const dy0 = Math.abs(clampedTargetY - prevY);
    const segBeats = Math.max(safeSnap, quantizeBeat(dy0 / pb, safeSnap));
    const d = dir(clampedTargetY - prevY);
    return segments.map((s, i) => (i === 0 ? { ...s, beats: segBeats, direction: d } : s));
  }

  // Endpoint: last vertex — adjust only last segment
  if (idx === pts.length - 1 && segments.length > 0) {
    const prevPt = pts[idx - 1];
    const prevBeat = prevPt?.beat ?? 0;
    const yPrev = prevPt?.y ?? TW_CENTER_Y;
    const pb = perBeat(bpmTimeline, prevBeat);
    const clampedTargetY = clampY(targetY);
    const dyLast = Math.abs(clampedTargetY - yPrev);
    const segBeats = Math.max(safeSnap, quantizeBeat(dyLast / pb, safeSnap));
    const dLastDir = dir(clampedTargetY - yPrev);
    return segments.map((s, i) => (i === idx - 1 ? { ...s, beats: segBeats, direction: dLastDir } : s));
  }

  // Interior vertex — adjust 2 adjacent segments
  const prevPt = pts[idx - 1];
  const nextPt = pts[idx + 1];
  const prevBeat = prevPt.beat;
  const nextBeat = nextPt.beat;
  const yPrev = prevPt.y;
  const yNext = nextPt.y;

  let beatPrime = quantizeBeat(targetBeat, safeSnap);
  beatPrime = Math.max(prevBeat + safeSnap, Math.min(nextBeat - safeSnap, beatPrime));
  beatPrime = quantizeBeat(beatPrime, safeSnap);

  const clampedTargetY = clampY(targetY);
  const pbPrev = perBeat(bpmTimeline, prevBeat);
  const pbNext = perBeat(bpmTimeline, beatPrime);

  const dyPrev = Math.abs(clampedTargetY - yPrev);
  const dyNext = Math.abs(yNext - clampedTargetY);

  const beatsPrev = Math.max(safeSnap, quantizeBeat(dyPrev / pbPrev, safeSnap));
  const beatsNext = Math.max(safeSnap, quantizeBeat(dyNext / pbNext, safeSnap));

  const candidateSegs = segments.map((s, i) => {
    if (i === idx - 1) return { ...s, direction: dir(clampedTargetY - yPrev), beats: beatsPrev };
    if (i === idx) return { ...s, direction: dir(yNext - clampedTargetY), beats: beatsNext };
    return s;
  });

  const candidateEngine = new WaveEngine(candidateSegs, bpmTimeline, baseAmp, startPosition);
  const achievedY = candidateEngine.waveYAt(beatPrime);
  const tol = 0.5 * pbNext * safeSnap + 1.0;
  void achievedY;
  void tol;

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

  const newBeatStart = pStart.beat + dxBeat;
  const newBeatEnd = pEnd.beat + dxBeat;
  const newYStart = clampY(pStart.y + dy);
  const newYEnd = clampY(pEnd.y + dy);

  const pp = perBeat(bpmTimeline, newBeatStart);
  const dyEdge = Math.abs(newYEnd - newYStart);
  const dyBeats = dyEdge / pp;
  const dxQuantized = Math.abs(dxBeat);

  const edgeBeats = Math.max(safeSnap, quantizeBeat(dxQuantized, safeSnap), quantizeBeat(dyBeats, safeSnap));
  const d = newYEnd - newYStart;
  const dirEdge = Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';

  const segmentFor = (fromBeat: number, fromY: number, toBeat: number, toY: number): Segment => {
    const dBeats = toBeat - fromBeat;
    const dY = toY - fromY;
    if (Math.abs(dY) < 0.5) return { direction: 'stay', beats: Math.max(safeSnap, quantizeBeat(Math.abs(dBeats), safeSnap)) };
    const p = perBeat(bpmTimeline, fromBeat);
    const beats = Math.max(safeSnap, quantizeBeat(Math.abs(dBeats), safeSnap), quantizeBeat(Math.abs(dY) / p, safeSnap));
    return {
      direction: dY < 0 ? 'up' : 'down',
      beats: quantizeBeat(beats, safeSnap),
    };
  };

  return segments.map((s, i) => {
    if (i === idx - 1 && i >= 0) {
      const pPrev = pts[idx - 1];
      return segmentFor(pPrev.beat, pPrev.y, newBeatStart, newYStart);
    }
    if (i === idx) {
      return {
        direction: dirEdge,
        beats: edgeBeats,
      };
    }
    if (i === idx + 1 && i + 1 < pts.length) {
      const pAfter = pts[idx + 2];
      return pAfter ? segmentFor(newBeatEnd, newYEnd, pAfter.beat, pAfter.y) : s;
    }
    return s;
  });
}
