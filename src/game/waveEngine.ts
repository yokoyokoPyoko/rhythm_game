import type { BpmTimeline } from '../audio/bpmTimeline';
import type { Segment } from '../types';

const TW_CENTER_Y = 600 / 2;
const TW_AMP = 80;

const WAVE_TOP = TW_CENTER_Y - TW_AMP;
const WAVE_BOTTOM = TW_CENTER_Y + TW_AMP;

interface WavePoint {
  beat: number;
  y: number;
}

export class WaveEngine {
  private readonly timeline: BpmTimeline;
  private readonly points: WavePoint[];

  constructor(segments: Segment[], bpmTimeline: BpmTimeline) {
    this.timeline = bpmTimeline;
    this.points = this.buildPoints(segments);
  }

  private buildPoints(segments: Segment[]): WavePoint[] {
    const points: WavePoint[] = [{ beat: 0, y: WAVE_TOP }];
    let beat = 0;
    for (const seg of segments) {
      beat += seg.beats;
      points.push({ beat, y: seg.direction === 'up' ? WAVE_TOP : WAVE_BOTTOM });
    }
    return points;
  }

  waveYAt(beat: number): number {
    if (beat <= 0) {
      return WAVE_TOP;
    }
    const last = this.points[this.points.length - 1];
    if (beat >= last.beat) {
      return last.y;
    }
    for (let i = 0; i < this.points.length - 1; i++) {
      const p0 = this.points[i];
      const p1 = this.points[i + 1];
      if (beat >= p0.beat && beat <= p1.beat) {
        if (p1.beat === p0.beat) {
          return p1.y;
        }
        const t = (beat - p0.beat) / (p1.beat - p0.beat);
        return p0.y + (p1.y - p0.y) * t;
      }
    }
    return last.y;
  }

  waveYAtMs(ms: number): number {
    return this.waveYAt(this.timeline.msToBeat(ms));
  }
}