import type { BpmTimeline } from '../audio/bpmTimeline';
import type { RingDef, RingState } from '../types';
import type { WaveEngine } from './waveEngine';

const TW_JUDGE_X = Math.round(800 * 0.26);
const TW_SCROLL = 110;
const TW_LEAD_BEATS = 3;

export class RingSpawner {
  private nextIndex = 0;
  private nextId = 0;
  private readonly active: RingState[] = [];

  update(
    songTimeMs: number,
    rings: RingDef[],
    bpmTimeline: BpmTimeline,
    waveEngine: WaveEngine,
  ): RingState[] {
    while (this.nextIndex < rings.length) {
      const ring = rings[this.nextIndex];
      const beat = Number.isFinite(ring.beat) && ring.beat >= 0 ? ring.beat : 0;
      const hitTime = bpmTimeline.beatToMs(beat);
      const beatMs = Number.isFinite(bpmTimeline.beatMsAt(beat)) ? bpmTimeline.beatMsAt(beat) : 500;
      const leadMs = TW_LEAD_BEATS * beatMs;
      if (songTimeMs < hitTime - leadMs) {
        break;
      }
      this.active.push({
        id: this.nextId++,
        spawnTime: hitTime - leadMs,
        hitTime,
        targetY: waveEngine.waveYAt(beat),
        resolved: false,
        hit: false,
      });
      this.nextIndex++;
    }
    return this.active;
  }

  xAt(ring: RingState, songTimeMs: number): number {
    return TW_JUDGE_X + ((ring.hitTime - songTimeMs) / 1000) * TW_SCROLL;
  }
}
