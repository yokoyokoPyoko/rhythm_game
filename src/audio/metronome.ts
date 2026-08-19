export const LOOKAHEAD_MS = 200;

export function schedule(
  audioCtx: AudioContext,
  nextBeatTime: number,
  beat: number,
  latency: number,
): void {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  const frequency = beat % 4 === 0 ? 880 : 440;
  const startTime = nextBeatTime - latency;
  const duration = 0.03;

  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.3, startTime + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}