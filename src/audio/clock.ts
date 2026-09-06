const OFFSET_KEY = 'rhythmManualOffsetMs';
const OFFSET_VERSION_KEY = 'rhythmManualOffsetVersion';
// T167: オフセットの刺激→判定への移設。manualOffset は判定側のみに効く。
// 新符号: 保存値 = +L（端末の音声出力遅延）。
// 旧方式（刺激側に加算する -L 符号）で保存された値は、初回読込時に符号反転
// （invert migration）して移行するため、ユーザーの再計測は不要。
const OFFSET_VERSION = 2;

let audioStartTime = 0;
export let manualOffsetMs = loadOffset();

function loadOffset(): number {
  try {
    const raw = localStorage.getItem(OFFSET_KEY);
    if (raw === null) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    const version = Number(localStorage.getItem(OFFSET_VERSION_KEY) || 0);
    if (version < OFFSET_VERSION) {
      const migrated = -n;
      localStorage.setItem(OFFSET_KEY, String(migrated));
      localStorage.setItem(OFFSET_VERSION_KEY, String(OFFSET_VERSION));
      return migrated;
    }
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
    localStorage.setItem(OFFSET_VERSION_KEY, String(OFFSET_VERSION));
  } catch {
    /* ignore storage errors */
  }
}

export function getManualOffset(): number {
  return manualOffsetMs;
}

export function getManualOffsetMs(): number {
  return manualOffsetMs;
}

export function offsetSeconds(): number {
  return manualOffsetMs / 1000;
}
