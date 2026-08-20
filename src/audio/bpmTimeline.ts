import type { BpmChange } from '../types';

const FALLBACK_BPM = 120;

interface BpmSegment {
  startBeat: number;
  endBeat: number;
  bpm: number;
  startMs: number;
}

function beatMs(bpm: number): number {
  return 60000 / bpm;
}

function sanitizeBpm(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return FALLBACK_BPM;
  }
  return Math.min(Math.max(value, 20), 400);
}

function sanitizeBeat(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

export class BpmTimeline {
  private segments: BpmSegment[];

  constructor(baseBpm: number, bpmChanges: BpmChange[]) {
    this.segments = this.buildSegments(baseBpm, bpmChanges ?? []);
  }

  private buildSegments(baseBpm: number, bpmChanges: BpmChange[]): BpmSegment[] {
    const sorted = [...bpmChanges]
      .map((c) => ({
        beat: sanitizeBeat(c?.beat),
        bpm: sanitizeBpm(c?.bpm),
      }))
      .filter((c) => c.beat > 0)
      .sort((a, b) => a.beat - b.beat);
    const segments: BpmSegment[] = [];
    let cursorBeat = 0;
    let cursorMs = 0;
    let bpm = sanitizeBpm(baseBpm);
    for (const change of sorted) {
      if (change.beat <= cursorBeat) {
        continue;
      }
      segments.push({
        startBeat: cursorBeat,
        endBeat: change.beat,
        bpm,
        startMs: cursorMs,
      });
      cursorMs += (change.beat - cursorBeat) * beatMs(bpm);
      cursorBeat = change.beat;
      bpm = change.bpm;
    }
    segments.push({
      startBeat: cursorBeat,
      endBeat: Number.POSITIVE_INFINITY,
      bpm,
      startMs: cursorMs,
    });
    return segments;
  }

  private segmentAtBeat(beat: number): BpmSegment {
    let current = this.segments[0];
    for (const seg of this.segments) {
      if (seg.startBeat <= beat) {
        current = seg;
      } else {
        break;
      }
    }
    return current;
  }

  private segmentAtMs(ms: number): BpmSegment {
    let current = this.segments[0];
    for (const seg of this.segments) {
      if (seg.startMs <= ms) {
        current = seg;
      } else {
        break;
      }
    }
    return current;
  }

  beatToMs(beat: number): number {
    const seg = this.segmentAtBeat(beat);
    return seg.startMs + (beat - seg.startBeat) * beatMs(seg.bpm);
  }

  msToBeat(ms: number): number {
    const seg = this.segmentAtMs(ms);
    return seg.startBeat + (ms - seg.startMs) / beatMs(seg.bpm);
  }

  bpmAt(beat: number): number {
    return this.segmentAtBeat(beat).bpm;
  }

  beatMsAt(beat: number): number {
    return beatMs(this.segmentAtBeat(beat).bpm);
  }
}
