import type { BpmTimeline } from '../audio/bpmTimeline';
import type { Segment } from '../types';

export const TW_CENTER_Y = 600 / 2;
export const TW_AMP = 130;

export const WAVELENGTH_BEATS = 4;

interface WavePoint {
  beat: number;
  y: number;
  /** Per-beat Y displacement for this segment (px). Up = negative, down = positive, stay = 0. */
  dY: number;
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
    startPosition = 0.0,
  ) {
    this.timeline = bpmTimeline;
    this.amplitude = Number.isFinite(amplitude) && amplitude >= 0 ? amplitude : 1.0;
    this.startPosition = sanitizeStartPosition(startPosition);
    this.points = this.buildPoints(segments ?? []);
  }

  private buildPoints(segments: Segment[]): WavePoint[] {
    const waveTop = TW_CENTER_Y - TW_AMP;
    const waveBottom = TW_CENTER_Y + TW_AMP;
    const startY = TW_CENTER_Y - this.startPosition * TW_AMP;
    const perBeatPx = 2 * TW_AMP * this.amplitude;
    const dYOf = (dir: 'up' | 'down' | 'stay') =>
      dir === 'up' ? -perBeatPx : dir === 'down' ? perBeatPx : 0;

    const validSegs: { beats: number; dir: 'up' | 'down' | 'stay' }[] = [];
    for (const seg of segments ?? []) {
      if (!seg) {
        continue;
      }
      const beats = sanitizeBeat(seg.beats);
      if (beats <= 0) {
        continue;
      }
      validSegs.push({ beats, dir: sanitizeDirection(seg.direction) });
    }

    // T127/T128: amplitude is speed coefficient. Per-beat displacement = 2*TW_AMP*amplitude.
    // Segment total displacement = perBeatPx * beats, clamped to [waveTop, waveBottom].
    // points[k] is the start vertex of segment k, so its dY = dY of segment k.
    const points: WavePoint[] = [];
    points.push({
      beat: 0,
      y: startY,
      dY: validSegs.length > 0 ? dYOf(validSegs[0].dir) : 0,
    });
    let beat = 0;
    let currentY = startY;
    for (let k = 0; k < validSegs.length; k++) {
      const vs = validSegs[k];
      beat += vs.beats;
      const delta = perBeatPx * vs.beats;
      if (vs.dir === 'up') {
        currentY = Math.max(waveTop, Math.min(waveBottom, currentY - delta));
      } else if (vs.dir === 'down') {
        currentY = Math.max(waveTop, Math.min(waveBottom, currentY + delta));
      }
      // stay: no change
      const nextDY = k + 1 < validSegs.length ? dYOf(validSegs[k + 1].dir) : 0;
      points.push({ beat, y: currentY, dY: nextDY });
    }
    if (points.length === 1) {
      points.push({ beat: 1, y: waveTop, dY: 0 });
    }
    return points;
  }

  getPoints(): { beat: number; y: number }[] {
    return this.points.map(p => ({ beat: p.beat, y: p.y }));
  }

  waveYAt(beat: number): number {
    const startY = TW_CENTER_Y - this.startPosition * TW_AMP;
    if (!Number.isFinite(beat)) {
      return startY;
    }
    if (beat <= 0) {
      return startY;
    }
    const last = this.points[this.points.length - 1];
    if (beat >= last.beat) {
      return last.y;
    }
    const waveTop = TW_CENTER_Y - TW_AMP;
    const waveBottom = TW_CENTER_Y + TW_AMP;
    for (let i = 0; i < this.points.length - 1; i++) {
      const p0 = this.points[i];
      const p1 = this.points[i + 1];
      if (beat >= p0.beat && beat <= p1.beat) {
        if (p1.beat <= p0.beat) {
          return p1.y;
        }
        // T128: interpolate using per-beat displacement dY, clamped to bounds.
        // This ensures the wave slope matches the cursor speed exactly,
        // and after reaching a boundary the wave stays flat (horizontal stay).
        const rawY = p0.y + p0.dY * (beat - p0.beat);
        return Math.max(waveTop, Math.min(waveBottom, rawY));
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
    const startY = TW_CENTER_Y - this.startPosition * TW_AMP;
    if (!Number.isFinite(ms)) {
      return startY;
    }
    return this.waveYAt(this.timeline.msToBeat(ms));
  }
}
