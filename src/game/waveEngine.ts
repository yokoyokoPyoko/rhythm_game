import type { BpmTimeline } from '../audio/bpmTimeline';
import type { Segment } from '../types';

const TW_CENTER_Y = 600 / 2;
const NORM_TO_PX = 130;

export const WAVELENGTH_BEATS = 4;

interface WavePoint {
  beat: number;
  y: number;
}

function sanitizeStartPosition(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

function sanitizeBeat(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function sanitizeDirection(value: unknown): 'up' | 'down' | 'stay' {
  if (value === 'down') return 'down';
  if (value === 'stay') return 'stay';
  return 'up';
}

export class WaveEngine {
  private readonly timeline: BpmTimeline;
  private readonly points: WavePoint[];
  private readonly amplitude: number;
  private readonly startPosition: number;

  constructor(
    segments: Segment[],
    bpmTimeline: BpmTimeline,
    amplitude = 1.0,
    startPosition = 0,
  ) {
    this.timeline = bpmTimeline;
    this.amplitude = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0;
    this.startPosition = sanitizeStartPosition(startPosition);
    this.points = this.buildPoints(segments ?? []);
  }

  private buildPoints(segments: Segment[]): WavePoint[] {
    const waveTop = TW_CENTER_Y - this.amplitude * NORM_TO_PX;
    const waveBottom = TW_CENTER_Y + this.amplitude * NORM_TO_PX;
    const startY = TW_CENTER_Y - this.startPosition * this.amplitude * NORM_TO_PX;
    const points: WavePoint[] = [{ beat: 0, y: startY }];
    let beat = 0;
    let currentY = waveTop;
    for (const seg of segments) {
      if (!seg) {
        continue;
      }
      const beats = sanitizeBeat(seg.beats);
      if (beats <= 0) {
        continue;
      }
      beat += beats;
      const dir = sanitizeDirection(seg.direction);
      const moveNorm = 2 * this.amplitude * (beats / WAVELENGTH_BEATS);
      const move = moveNorm * NORM_TO_PX;
      if (dir === 'up') {
        currentY = Math.max(waveTop, currentY - move);
      } else if (dir === 'down') {
        currentY = Math.min(waveBottom, currentY + move);
      } else {
        // stay: currentY remains unchanged
      }
      points.push({
        beat,
        y: currentY,
      });
    }
    if (points.length === 1) {
      points.push({ beat: 1, y: waveTop });
    }
    return points;
  }

  getPoints(): WavePoint[] {
    return this.points;
  }

  waveYAt(beat: number): number {
    if (!Number.isFinite(beat)) {
      return TW_CENTER_Y - this.startPosition * this.amplitude * NORM_TO_PX;
    }
    if (beat <= 0) {
      return TW_CENTER_Y - this.startPosition * this.amplitude * NORM_TO_PX;
    }
    const last = this.points[this.points.length - 1];
    if (beat >= last.beat) {
      return last.y;
    }
    for (let i = 0; i < this.points.length - 1; i++) {
      const p0 = this.points[i];
      const p1 = this.points[i + 1];
      if (beat >= p0.beat && beat <= p1.beat) {
        if (p1.beat <= p0.beat) {
          return p1.y;
        }
        const t = (beat - p0.beat) / (p1.beat - p0.beat);
        return p0.y + (p1.y - p0.y) * t;
      }
    }
    return last.y;
  }

  segmentBeatsAt(beat: number): number {
    if (!Number.isFinite(beat)) {
      return 1;
    }
    const b = Math.max(0, beat);
    const last = this.points[this.points.length - 1];
    const lastSeg = this.points[this.points.length - 2];
    if (b >= last.beat) {
      return Math.max(1, last.beat - lastSeg.beat);
    }
    for (let i = 0; i < this.points.length - 1; i++) {
      const p0 = this.points[i];
      const p1 = this.points[i + 1];
      if (b >= p0.beat && b <= p1.beat) {
        return Math.max(1, p1.beat - p0.beat);
      }
    }
    return 1;
  }

  waveYAtMs(ms: number): number {
    const waveTop = TW_CENTER_Y - this.amplitude * NORM_TO_PX;
    if (!Number.isFinite(ms)) {
      return waveTop;
    }
    return this.waveYAt(this.timeline.msToBeat(ms));
  }
}
