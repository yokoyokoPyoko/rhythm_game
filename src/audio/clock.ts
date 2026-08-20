const OFFSET_KEY = 'rhythmManualOffsetMs';
const OFFSET_MIN_MS = -2000;
const OFFSET_MAX_MS = 2000;

let audioStartTime: number | null = null;

export function songNow(audioCtx: AudioContext): number {
  if (audioStartTime === null) {
    return 0;
  }
  const elapsed = (audioCtx.currentTime - audioStartTime) * 1000;
  return Number.isFinite(elapsed) ? elapsed : 0;
}

export function resetClock(audioCtx: AudioContext): void {
  const now = audioCtx.currentTime;
  audioStartTime = Number.isFinite(now) ? now : 0;
}

export function getManualOffsetMs(): number {
  const raw = localStorage.getItem(OFFSET_KEY);
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return clampOffset(parsed);
}

export function setManualOffset(ms: number): void {
  const parsed = Number(ms);
  const clamped = Number.isFinite(parsed) ? clampOffset(parsed) : 0;
  localStorage.setItem(OFFSET_KEY, String(clamped));
}

export function getManualOffsetSec(): number {
  return getManualOffsetMs() / 1000;
}

function clampOffset(ms: number): number {
  if (ms < OFFSET_MIN_MS) return OFFSET_MIN_MS;
  if (ms > OFFSET_MAX_MS) return OFFSET_MAX_MS;
  return ms;
}
