import { offsetSeconds } from './clock';

export const LOOKAHEAD_MS = 200;
const SCHEDULE_INTERVAL_MS = 25;
const CLICK_DURATION = 0.04;
const STRONG_FREQ = 880;
const WEAK_FREQ = 440;

export class Metronome {
  private timerId: number | null = null;
  private nextBeatTime = 0;
  private nextBeatNumber = 0;
  private beatMs: number;
  private audioCtx: AudioContext;
  private getBeatMs: (beat: number) => number;

  constructor(
    audioCtx: AudioContext,
    startAudioTime: number,
    initialBeatMs: number,
    getBeatMs: (beat: number) => number,
  ) {
    this.audioCtx = audioCtx;
    this.beatMs = initialBeatMs;
    this.getBeatMs = getBeatMs;
    this.nextBeatTime = startAudioTime;
    this.nextBeatNumber = 0;
  }

  start(): void {
    if (this.timerId !== null) return;
    this.timerId = window.setInterval(() => this.tick(), SCHEDULE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private tick(): void {
    const horizon = this.audioCtx.currentTime + LOOKAHEAD_MS / 1000;
    while (this.nextBeatTime < horizon) {
      schedule(this.audioCtx, this.nextBeatTime, this.nextBeatNumber, 0);
      this.nextBeatNumber += 1;
      this.beatMs = this.getBeatMs(this.nextBeatNumber);
      this.nextBeatTime += this.beatMs / 1000;
    }
  }
}

export function schedule(
  audioCtx: AudioContext,
  nextBeatTime: number,
  beat: number,
  latency: number,
): void {
  const isStrong = beat % 4 === 0;
  const freq = isStrong ? STRONG_FREQ : WEAK_FREQ;
  const when = nextBeatTime + offsetSeconds() + Math.max(0, latency);

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;

  const peak = isStrong ? 0.18 : 0.1;
  gain.gain.setValueAtTime(peak, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + CLICK_DURATION);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(when);
  osc.stop(when + CLICK_DURATION + 0.01);
}
