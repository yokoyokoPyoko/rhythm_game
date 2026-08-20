import type { BpmTimeline } from '../audio/bpmTimeline';
import type { WaveEngine } from './waveEngine';
import type { RingDef, RingState } from '../types';

const TW_LEAD_BEATS = 3;

function sanitizeBeat(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

export class RingSpawner {
  private readonly ringDefs: RingDef[];
  private readonly spawned: RingState[] = [];
  private nextIndex = 0;

  constructor(rings: RingDef[] = []) {
    this.ringDefs = (rings ?? [])
      .filter((r): r is RingDef => !!r && Number.isFinite(r.beat))
      .map((r) => ({ beat: sanitizeBeat(r.beat) }))
      .sort((a, b) => a.beat - b.beat);
  }

  update(
    songTimeMs: number,
    bpmTimeline: BpmTimeline,
    waveEngine: WaveEngine,
  ): RingState[] {
    const now = Number.isFinite(songTimeMs) ? songTimeMs : 0;

    while (this.nextIndex < this.ringDefs.length) {
      const def = this.ringDefs[this.nextIndex];
      const hitTime = bpmTimeline.beatToMs(def.beat);
      const beatMs = bpmTimeline.beatMsAt(def.beat);
      const leadMs = TW_LEAD_BEATS * (Number.isFinite(beatMs) && beatMs > 0 ? beatMs : 500);
      const spawnTime = hitTime - leadMs;

      if (now >= spawnTime) {
        this.spawned.push({
          id: this.nextIndex,
          spawnTime,
          hitTime,
          targetY: waveEngine.waveYAt(def.beat),
          resolved: false,
          hit: false,
        });
        this.nextIndex++;
      } else {
        break;
      }
    }

    return this.spawned.filter((r) => !r.resolved);
  }
}
