// Debug-only play/access counter (per browser, localStorage).
// Counts how many times each song's main chart started playing.

const STORAGE_KEY = 'traceWavePlayCounts';

function readAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[k] = Math.floor(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function getPlayCounts(): Record<string, number> {
  return readAll();
}

export function getPlayCount(id: string): number {
  if (!id) return 0;
  return readAll()[id] ?? 0;
}

/** Increment the play count for a song. Returns the new count. */
export function recordPlay(id: string): number {
  if (!id) return 0;
  const all = readAll();
  const next = (all[id] ?? 0) + 1;
  all[id] = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore storage errors */
  }
  return next;
}
