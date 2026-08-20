import type { BpmChange } from '../types';

interface BpmSegment {
  startBeat: number;
  endBeat: number;
  bpm: number;
  beatMs: number;
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
  private readonly segments: BpmSegment[];

  constructor(baseBpm: number, bpmChanges: BpmChange[] = []) {
    this.baseBpm = sanitizeBpm(baseBpm);

    const changes = (bpmChanges ?? [])
      .filter((c): c is BpmChange => !!c && Number.isFinite(c.beat) && Number.isFinite(c.bpm))
      .map((c) => ({ beat: Math.max(0, Number(c.beat)), bpm: sanitizeBpm(c.bpm) }))
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
      });
      currentBpm = change.bpm;
      currentBeat = change.beat;
    }

    segs.push({
      startBeat: currentBeat,
      endBeat: Infinity,
      bpm: currentBpm,
      beatMs: 60000 / currentBpm,
    });

    this.segments = segs;
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
}
