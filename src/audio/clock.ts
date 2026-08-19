const OFFSET_KEY = 'rhythmManualOffsetMs';

let audioStartTime: number | null = null;

export function songNow(audioCtx: AudioContext): number {
  if (audioStartTime === null) {
    return 0;
  }
  return (audioCtx.currentTime - audioStartTime) * 1000;
}

export function resetClock(audioCtx: AudioContext): void {
  audioStartTime = audioCtx.currentTime;
}

export function getManualOffsetMs(): number {
  const raw = localStorage.getItem(OFFSET_KEY);
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setManualOffset(ms: number): void {
  localStorage.setItem(OFFSET_KEY, String(ms));
}

export function getManualOffsetSec(): number {
  return getManualOffsetMs() / 1000;
}
