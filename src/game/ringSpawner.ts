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
  private ringDefs: RingDef[] = [];
  private readonly spawned: RingState[] = [];
  private nextIndex = 0;
  private lastRingsRef: RingDef[] | null = null;

  constructor(rings: RingDef[] = []) {
    this.ringDefs = (rings ?? [])
      .filter((r): r is RingDef => !!r && Number.isFinite(r.beat))
      .map((r) => ({
        beat: sanitizeBeat(r.beat),
        duration: typeof r.duration === 'number' && r.duration > 0 ? r.duration : undefined,
        type: r.type === 'hold' ? ('hold' as const) : ('single' as const),
      }))
      .sort((a, b) => a.beat - b.beat);
  }

  update(
    songTimeMs: number,
    rings: RingDef[],
    bpmTimeline: BpmTimeline,
    waveEngine: WaveEngine,
  ): RingState[] {
    const now = Number.isFinite(songTimeMs) ? songTimeMs : 0;

    if (rings !== this.lastRingsRef) {
      this.ringDefs = (rings ?? [])
        .filter((r): r is RingDef => !!r && Number.isFinite(r.beat))
        .map((r) => ({
          beat: sanitizeBeat(r.beat),
          duration: typeof r.duration === 'number' && r.duration > 0 ? r.duration : undefined,
          type: r.type === 'hold' ? ('hold' as const) : ('single' as const),
        }))
        .sort((a, b) => a.beat - b.beat);
      this.lastRingsRef = rings;
      this.spawned.length = 0;
      this.nextIndex = 0;
    }

    while (this.nextIndex < this.ringDefs.length) {
      const def = this.ringDefs[this.nextIndex];
      const hitTime = bpmTimeline.beatToMs(def.beat);
      const beatMs = bpmTimeline.beatMsAt(def.beat);
      const leadMs = TW_LEAD_BEATS * (Number.isFinite(beatMs) && beatMs > 0 ? beatMs : 500);
      const spawnTime = hitTime - leadMs;

      if (now >= spawnTime) {
        const type = def.type === 'hold' ? ('hold' as const) : ('single' as const);
        const duration = type === 'hold' && typeof def.duration === 'number' && def.duration > 0 ? def.duration : 0;
        const releaseBeat = def.beat + duration;
        const releaseTime = bpmTimeline.beatToMs(releaseBeat);

        this.spawned.push({
          id: this.nextIndex,
          spawnTime,
          hitTime,
          targetY: waveEngine.waveYAt(def.beat),
          resolved: false,
          hit: false,
          type,
          duration,
          releaseTime,
          holding: false,
          holdCompleted: false,
        });
        this.nextIndex++;
      } else {
        break;
      }
    }

    return this.spawned.filter((r) => !r.resolved);
  }
}
