import type { BpmChange } from '../types';

interface BpmSegment {
  startBeat: number;
  endBeat: number;
  bpm: number;
  beatMs: number;
  amplitude: number;
}

const MIN_BPM = 1;
const MAX_BPM = 1000;

function sanitizeBpm(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MIN_BPM;
  return Math.min(MAX_BPM, n);
}

export class BpmTimeline {
  private readonly baseBpm: number;
  private readonly baseAmplitude: number;
  private readonly segments: BpmSegment[];
  /** Sorted amplitude entries from bpm_changes (beat, amplitude). */
  private readonly amplitudeEntries: { beat: number; amplitude: number }[];

  constructor(baseBpm: number, bpmChanges: BpmChange[] = [], baseAmplitude = 1.0) {
    this.baseBpm = sanitizeBpm(baseBpm);
    this.baseAmplitude = Number.isFinite(baseAmplitude) && baseAmplitude > 0 ? baseAmplitude : 1.0;

    const changes = (bpmChanges ?? [])
      .filter((c): c is BpmChange => !!c && Number.isFinite(c.beat) && Number.isFinite(c.bpm))
      .map((c) => ({ beat: Math.max(0, Number(c.beat)), bpm: sanitizeBpm(c.bpm), amplitude: c.amplitude }))
      .sort((a, b) => a.beat - b.beat);

    const segs: BpmSegment[] = [];
    let currentBpm = this.baseBpm;
    let currentBeat = 0;

    for (const change of changes) {
      if (change.beat < currentBeat) continue;
      segs.push({
        startBeat: currentBeat,
        endBeat: change.beat,
        bpm: currentBpm,
        beatMs: 60000 / currentBpm,
        amplitude: this.baseAmplitude,
      });
      currentBpm = change.bpm;
      currentBeat = change.beat;
    }

    segs.push({
      startBeat: currentBeat,
      endBeat: Infinity,
      bpm: currentBpm,
      beatMs: 60000 / currentBpm,
      amplitude: this.baseAmplitude,
    });

    this.segments = segs;

    // Build amplitude step entries from bpm_changes that carry an amplitude value
    this.amplitudeEntries = changes
      .filter((c) => Number.isFinite(c.amplitude) && (c.amplitude as number) > 0)
      .map((c) => ({ beat: c.beat, amplitude: c.amplitude as number }));
  }

  private segmentAt(beat: number): BpmSegment {
    const b = Number.isFinite(beat) ? beat : 0;
    for (const seg of this.segments) {
      if (b >= seg.startBeat && b < seg.endBeat) return seg;
    }
    return this.segments[this.segments.length - 1];
  }

  bpmAt(beat: number): number {
    return this.segmentAt(beat).bpm;
  }

  beatMsAt(beat: number): number {
    return this.segmentAt(beat).beatMs;
  }

  beatToMs(beat: number): number {
    const b = Number.isFinite(beat) ? beat : 0;
    let ms = 0;
    for (const seg of this.segments) {
      if (b <= seg.startBeat) break;
      const end = Math.min(b, seg.endBeat);
      ms += (end - seg.startBeat) * seg.beatMs;
    }
    return ms;
  }

  msToBeat(ms: number): number {
    const m = Number.isFinite(ms) && ms > 0 ? ms : 0;
    let remaining = m;
    let beat = 0;
    for (const seg of this.segments) {
      if (seg.endBeat === Infinity) {
        beat += remaining / seg.beatMs;
        break;
      }
      const segMs = (seg.endBeat - seg.startBeat) * seg.beatMs;
      if (remaining <= segMs) {
        beat += remaining / seg.beatMs;
        break;
      }
      remaining -= segMs;
      beat += seg.endBeat - seg.startBeat;
    }
    return beat;
  }

  /**
   * T131: Returns the amplitude (speed coefficient) that applies at the given beat.
   * Step function: returns the amplitude from the most recent bpm_change entry
   * (with amplitude set) at or before `beat`. Falls back to baseAmplitude if none.
   */
  amplitudeAt(beat: number): number {
    let result = this.baseAmplitude;
    const b = Number.isFinite(beat) ? beat : 0;
    for (const entry of this.amplitudeEntries) {
      if (entry.beat <= b) {
        result = entry.amplitude;
      } else {
        break;
      }
    }
    return result;
  }
}
