import type { BpmTimeline } from '../audio/bpmTimeline';
import type { Segment } from '../types';

const TW_CENTER_Y = 600 / 2;

interface WavePoint {
  beat: number;
  y: number;
}

function sanitizeBeat(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function sanitizeDirection(value: unknown): 'up' | 'down' {
  return value === 'down' ? 'down' : 'up';
}

export class WaveEngine {
  private readonly timeline: BpmTimeline;
  private readonly points: WavePoint[];
  private readonly amplitude: number;

  constructor(segments: Segment[], bpmTimeline: BpmTimeline, amplitude = 130) {
    this.timeline = bpmTimeline;
    this.amplitude = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 130;
    this.points = this.buildPoints(segments ?? []);
  }

  private buildPoints(segments: Segment[]): WavePoint[] {
    const waveTop = TW_CENTER_Y - this.amplitude;
    const waveBottom = TW_CENTER_Y + this.amplitude;
    const points: WavePoint[] = [{ beat: 0, y: waveTop }];
    let beat = 0;
    for (const seg of segments) {
      if (!seg) {
        continue;
      }
      const beats = sanitizeBeat(seg.beats);
      if (beats <= 0) {
        continue;
      }
      beat += beats;
      points.push({
        beat,
        y: sanitizeDirection(seg.direction) === 'up' ? waveTop : waveBottom,
      });
    }
    if (points.length === 1) {
      points.push({ beat: 1, y: waveTop });
    }
    return points;
  }

  waveYAt(beat: number): number {
    const waveTop = TW_CENTER_Y - this.amplitude;
    if (!Number.isFinite(beat)) {
      return waveTop;
    }
    if (beat <= 0) {
      return waveTop;
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
    const waveTop = TW_CENTER_Y - this.amplitude;
    if (!Number.isFinite(ms)) {
      return waveTop;
    }
    return this.waveYAt(this.timeline.msToBeat(ms));
  }
}
