// Play/access counter.
//
// Local: localStorage (per browser, keyed by song id).
// Global: Supabase `play_counts` table (shared across PCs, keyed by song
// title so separately-imported copies of the same song accumulate together).
// When the backend is not configured (counterConfig.ts), local-only mode.

import { COUNTER_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from './counterConfig';

const STORAGE_KEY = 'traceWavePlayCounts';
const FETCH_TIMEOUT_MS = 6000;

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

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Increment the play count for a song.
 * - Local counter (keyed by id) is always bumped (offline backup).
 * - Global counter (keyed by title, so copies on other PCs merge) is
 *   incremented server-side (atomic) when the backend is configured.
 * Never throws.
 */
export async function recordPlay(id: string, globalKey?: string): Promise<number> {
  let next = 0;
  if (id) {
    const all = readAll();
    next = (all[id] ?? 0) + 1;
    all[id] = next;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* ignore storage errors */
    }
  }
  const gkey = (globalKey || id || '').trim();
  if (COUNTER_ENABLED && gkey) {
    try {
      await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/increment_play_count`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sid: gkey }),
      });
    } catch {
      /* offline or backend error — local count already saved */
    }
  }
  return next;
}

/** Fetch global counts keyed by song title. Empty object when unconfigured/offline. */
export async function fetchGlobalCounts(): Promise<Record<string, number>> {
  if (!COUNTER_ENABLED) return {};
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/play_counts?select=song_id,count`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );
    if (!res.ok) return {};
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return {};
    const out: Record<string, number> = {};
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { song_id?: unknown }).song_id === 'string' &&
        typeof (row as { count?: unknown }).count === 'number'
      ) {
        out[(row as { song_id: string }).song_id] = (row as { count: number }).count;
      }
    }
    return out;
  } catch {
    return {};
  }
}
