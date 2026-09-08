import type { BpmChange, EasingType } from '../types';

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
  /** Sorted amplitude entries from sections (beat, amplitude, easeToNext). */
  private readonly amplitudeEntries: { beat: number; amplitude: number; easeToNext?: EasingType }[];
  /** Sorted zoom entries from sections (beat, zoom, easeToNext). */
  private readonly zoomEntries: { beat: number; zoom: number; easeToNext?: EasingType }[];

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
      .map((c) => ({ beat: Math.max(0, Number(c.beat)), bpm: sanitizeBpm(c.bpm), amplitude: c.amplitude, zoom: c.zoom, easeToNext: c.easeToNext }))
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
      .map((c) => ({ beat: c.beat, amplitude: c.amplitude as number, easeToNext: c.easeToNext }));

    // Build zoom step entries from sections that carry a zoom value
    this.zoomEntries = changes
      .filter((c) => Number.isFinite(c.zoom) && (c.zoom as number) > 0)
      .map((c) => ({ beat: c.beat, zoom: c.zoom as number, easeToNext: c.easeToNext }));
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
   * T131/T202: Returns the amplitude (speed coefficient) that applies at the given beat.
   * Between sections whose preceding entry has an `easeToNext` set, the value is
   * interpolated from the preceding entry's value to the following entry's value using
   * the selected easing curve. Without easing (or beyond the last entry) the value is a
   * step function (most recent entry at or before `beat`), falling back to baseAmplitude.
   */
  amplitudeAt(beat: number): number {
    const b = Number.isFinite(beat) ? beat : 0;
    if (this.amplitudeEntries.length === 0) return this.baseAmplitude;
    if (b <= this.amplitudeEntries[0].beat) return this.amplitudeEntries[0].amplitude;
    return this.interpolateEntries(
      this.amplitudeEntries.map((e) => ({ beat: e.beat, value: e.amplitude, easeToNext: e.easeToNext })),
      b,
      this.baseAmplitude
    );
  }

  /**
   * T187/T202: Returns the horizontal zoom (scroll speed coefficient) that applies
   * at the given beat. Between sections with easing, the value is interpolated.
   * Otherwise a step function falling back to 1.0.
   */
  zoomAt(beat: number): number {
    const b = Number.isFinite(beat) ? beat : 0;
    if (this.zoomEntries.length === 0) return 1.0;
    if (b <= this.zoomEntries[0].beat) return this.zoomEntries[0].zoom;
    return this.interpolateEntries(
      this.zoomEntries.map((e) => ({ beat: e.beat, value: e.zoom, easeToNext: e.easeToNext })),
      b,
      1.0
    );
  }

  /**
   * T202: Generic interval interpolation lookup over sorted entries.
   * For the interval [entries[i], entries[i+1]] where the preceding entry i has an
   * `easeToNext`, interpolate from entries[i].value to entries[i+1].value by easing
   * factor e(t) where t = (beat - a.beat) / (b.beat - a.beat). Zero-length intervals
   * fall back to a step (use the preceding value). Beyond the last entry, use the last value.
   */
  private interpolateEntries(
    entries: { beat: number; value: number; easeToNext?: EasingType }[],
    beat: number,
    base: number
  ): number {
    let result = base;
    for (let i = 0; i < entries.length; i++) {
      const a = entries[i];
      if (beat >= a.beat) {
        result = a.value;
      } else {
        break;
      }
      const b = entries[i + 1];
      if (b && beat >= b.beat) {
        result = b.value;
        continue;
      }
      if (!b) break;
      const ease = a.easeToNext;
      if (!ease || b.beat <= a.beat) break;
      const rawT = (beat - a.beat) / (b.beat - a.beat);
      const t = Math.max(0, Math.min(1, rawT));
      const eased = easeFactor(ease, t);
      result = a.value + (b.value - a.value) * eased;
    }
    return result;
  }
}

function easeFactor(ease: EasingType, t: number): number {
  switch (ease) {
    case 'linear':
      return t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    case 'ease-in':
      return t * t;
    default:
      return t;
  }
}
