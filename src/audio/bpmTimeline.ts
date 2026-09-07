import type { BpmChange } from '../types';

interface BpmSegment {
  startBeat: number;
  endBeat: number;
  bpm: number;
  beatMs: number;
  amplitude: number;
  zoom: number;
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
  /** Sorted amplitude entries from sections (beat, amplitude). */
  private readonly amplitudeEntries: { beat: number; amplitude: number }[];
  /** Sorted zoom entries from sections (beat, zoom). */
  private readonly zoomEntries: { beat: number; zoom: number }[];

  constructor(bpmChanges: BpmChange[] = [], baseAmplitude = 1.0, legacyFallback?: unknown) {
    // T187/T186: primary signature is (bpmChanges, baseAmplitude). Legacy callers
    // that pass (baseBpm, bpmChanges, baseAmplitude) are tolerated: the explicit
    // base is IGNORED and the base tempo is derived from the first (beat-min)
    // section instead.
    let effectiveChanges = bpmChanges;
    let effectiveBaseAmplitude: number = baseAmplitude;
    if (typeof (bpmChanges as unknown) === 'number') {
      const legacyChanges = baseAmplitude as unknown as BpmChange[];
      effectiveChanges = Array.isArray(legacyChanges) ? legacyChanges : [];
      effectiveBaseAmplitude =
        typeof legacyFallback === 'number' ? (legacyFallback as number) : 1.0;
    }

    this.baseAmplitude =
      Number.isFinite(effectiveBaseAmplitude) && effectiveBaseAmplitude > 0
        ? effectiveBaseAmplitude
        : 1.0;

    const changes = (effectiveChanges ?? [])
      .filter((c): c is BpmChange => !!c && Number.isFinite(c.beat) && Number.isFinite(c.bpm))
      .map((c) => ({ beat: Math.max(0, Number(c.beat)), bpm: sanitizeBpm(c.bpm), amplitude: c.amplitude, zoom: c.zoom }))
      .sort((a, b) => a.beat - b.beat);

    // T187: base BPM is derived from the first section (lowest beat). Fall back
    // to 120 when there is no section.
    const firstSection = changes.length > 0 ? changes[0] : null;
    this.baseBpm = sanitizeBpm(firstSection ? firstSection.bpm : 120);

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
        zoom: 1.0,
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
      zoom: 1.0,
    });

    this.segments = segs;

    // Build amplitude step entries from sections that carry an amplitude value
    this.amplitudeEntries = changes
      .filter((c) => Number.isFinite(c.amplitude) && (c.amplitude as number) > 0)
      .map((c) => ({ beat: c.beat, amplitude: c.amplitude as number }));

    // Build zoom step entries from sections that carry a zoom value
    this.zoomEntries = changes
      .filter((c) => Number.isFinite(c.zoom) && (c.zoom as number) > 0)
      .map((c) => ({ beat: c.beat, zoom: c.zoom as number }));
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

  /**
   * T187: Returns the horizontal zoom (scroll speed coefficient) that applies
   * at the given beat. Step function: returns the zoom from the most recent
   * section at or before `beat`. Falls back to 1.0 if none is set.
   */
  zoomAt(beat: number): number {
    let result = 1.0;
    const b = Number.isFinite(beat) ? beat : 0;
    for (const entry of this.zoomEntries) {
      if (entry.beat <= b) {
        result = entry.zoom;
      } else {
        break;
      }
    }
    return result;
  }
}
