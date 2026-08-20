const OFFSET_KEY = 'rhythmManualOffsetMs';

let audioStartTime = 0;
let manualOffsetMs = loadOffset();

function loadOffset(): number {
  try {
    const raw = localStorage.getItem(OFFSET_KEY);
    if (raw === null) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return n;
  } catch {
    return 0;
  }
}

export function songNow(): number {
  const ctx = clockCtxRef;
  if (!ctx) return 0;
  return (ctx.currentTime - audioStartTime) * 1000;
}

let clockCtxRef: AudioContext | null = null;

export function resetClock(audioCtx: AudioContext): void {
  clockCtxRef = audioCtx;
  audioStartTime = audioCtx.currentTime;
}

export function setManualOffset(ms: number): void {
  const n = Number(ms);
  if (!Number.isFinite(n)) return;
  manualOffsetMs = n;
  try {
    localStorage.setItem(OFFSET_KEY, String(n));
  } catch {
    /* ignore storage errors */
  }
}

export function getManualOffset(): number {
  return manualOffsetMs;
}

export function offsetSeconds(): number {
  return manualOffsetMs / 1000;
}
