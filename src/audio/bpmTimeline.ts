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
  /** Sorted amplitude entries from sections (beat, amplitude?, easeToNext). Value optional (undefined => inherit). */
  private readonly amplitudeEntries: { beat: number; amplitude?: number; easeToNext?: EasingType }[];
  /** Sorted zoom entries from sections (beat, zoom?, easeToNext). Value optional (undefined => inherit). */
  private readonly zoomEntries: { beat: number; zoom?: number; easeToNext?: EasingType }[];

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

    // Build amplitude step entries from all sections. A section without an explicit
    // amplitude resolves to the inherited (preceding / base) value during evaluation.
    this.amplitudeEntries = changes
      .filter((c) => c.amplitude === undefined || (Number.isFinite(c.amplitude) && (c.amplitude as number) > 0))
      .map((c) => ({ beat: c.beat, amplitude: c.amplitude, easeToNext: c.easeToNext }));

    // Build zoom step entries from all sections (same unit semantics).
    this.zoomEntries = changes
      .filter((c) => c.zoom === undefined || (Number.isFinite(c.zoom) && (c.zoom as number) > 0))
      .map((c) => ({ beat: c.beat, zoom: c.zoom, easeToNext: c.easeToNext }));
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
    return this.resolveAt(
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
    return this.resolveAt(
      this.zoomEntries.map((e) => ({ beat: e.beat, value: e.zoom, easeToNext: e.easeToNext })),
      b,
      1.0
    );
  }

  /**
   * T202: Interval-eased evaluation over all sections (sorted by beat, stable).
   *
   * Each section resolves to an *effective value*: its explicit value if set,
   * otherwise the inherited value (preceding section's effective value, or `base`).
   * Before the first section the value equals `base` (step).
   *
   * For the interval [A.beat, B.beat] where the preceding section A carries an
   * `easeToNext`, interpolate from A's effective value to B's effective value using
   * e(t) with t = (beat - A.beat) / (B.beat - A.beat). Zero-length intervals
   * (A.beat === B.beat) fall back to a step (use the last section's effective value).
   * Without easing the value is a step function. Beyond the last section use its value.
   */
  private resolveAt(
    entries: { beat: number; value?: number; easeToNext?: EasingType }[],
    beat: number,
    base: number
  ): number {
    // Resolve effective value per section (undefined => inherit / base).
    let current = base;
    const resolved = entries.map((e) => {
      if (e.value !== undefined && Number.isFinite(e.value)) {
        current = e.value;
      }
      return { beat: e.beat, value: current, easeToNext: e.easeToNext };
    });

    if (resolved.length === 0) return base;
    if (beat < resolved[0].beat) return base;

    let result = base;
    for (let i = 0; i < resolved.length; i++) {
      const a = resolved[i];
      if (beat >= a.beat) {
        result = a.value;
      } else {
        break;
      }
      const b = resolved[i + 1];
      if (b && beat >= b.beat) {
        result = b.value;
        continue;
      }
      if (!b) break;
      // Interpolate only when the preceding section requests easing and the
      // interval has positive length.
      if (!a.easeToNext || b.beat <= a.beat) break;
      const rawT = (beat - a.beat) / (b.beat - a.beat);
      const t = Math.max(0, Math.min(1, rawT));
      const eased = easeFactor(a.easeToNext, t);
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
