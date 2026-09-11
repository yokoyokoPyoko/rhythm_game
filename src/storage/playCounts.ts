// Play/access counter.
//
// Local: localStorage (per browser, keyed by song id).
// Global: Supabase `play_events` table (one row per play, shared across PCs,
// keyed by song title so separately-imported copies of the same song merge).
// Counts are derived by aggregation; the single write path is the `log_play`
// RPC. When the backend is not configured (counterConfig.ts), local-only mode.

import { COUNTER_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from './counterConfig';

const STORAGE_KEY = 'traceWavePlayCounts';
const PAUSED_KEY = 'traceWaveCountingPaused';
const FETCH_TIMEOUT_MS = 6000;

/** When true, plays are not counted (local nor global). Toggled by Ctrl+Alt+Shift+0. */
export function isCountingPaused(): boolean {
  try {
    return localStorage.getItem(PAUSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCountingPaused(paused: boolean): boolean {
  const next = !!paused;
  try {
    localStorage.setItem(PAUSED_KEY, next ? '1' : '0');
  } catch {
    /* ignore storage errors */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('trace-wave-counting-changed'));
  }
  return next;
}

export function toggleCountingPaused(): boolean {
  return setCountingPaused(!isCountingPaused());
}

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
  if (isCountingPaused()) {
    return id ? (readAll()[id] ?? 0) : 0;
  }
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
    // Single write path: 3-arg log_play (event + score/rank columns).
    // Falls back to the legacy 1-arg form when the new overload is not
    // deployed yet, so event logging keeps working across the deploy gap.
    const status = await postLogPlay({ sid: gkey, sc: null, rk: null });
    if (status === 404) {
      await postLogPlay({ sid: gkey });
    }
  }
  return next;
}

export interface PlayEvent {
  song_id: string;
  played_at: string;
  score?: number | null;
  rank?: string | null;
}

/** POST a log_play call. Returns the HTTP status, or -1 on network failure. */
async function postLogPlay(body: Record<string, unknown>): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/log_play`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.status;
  } catch {
    return -1;
  }
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST midnight (start of today) as an ISO timestamp. Japan has no DST. */
export function jstDayStartISO(nowMs = Date.now()): string {
  const jst = new Date(nowMs + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();
  return new Date(Date.UTC(y, m, d) - JST_OFFSET_MS).toISOString();
}

/** Fetch today's per-play events (for the trends graph). Empty when unconfigured/offline. */
export async function fetchTodayEvents(nowMs = Date.now()): Promise<PlayEvent[]> {
  if (!COUNTER_ENABLED) return [];
  try {
    const since = encodeURIComponent(jstDayStartISO(nowMs));
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/play_events?select=song_id,played_at&played_at=gte.${since}&order=played_at.asc&limit=5000`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    const out: PlayEvent[] = [];
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { song_id?: unknown }).song_id === 'string' &&
        typeof (row as { played_at?: unknown }).played_at === 'string'
      ) {
        const r = row as { song_id: string; played_at: string };
        const t = Date.parse(r.played_at);
        if (Number.isFinite(t)) out.push({ song_id: r.song_id, played_at: r.played_at });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface TrendSlot {
  /** Slot start as ms since epoch. */
  startMs: number;
  count: number;
}

/**
 * Bucket event timestamps into fixed slots (pure, testable).
 * Slots cover [dayStartMs, dayStartMs + slotCount * slotMs).
 */
export function bucketEventsToSlots(
  eventMsList: number[],
  dayStartMs: number,
  slotMs: number,
  slotCount: number,
): TrendSlot[] {
  const slots: TrendSlot[] = Array.from({ length: slotCount }, (_, i) => ({
    startMs: dayStartMs + i * slotMs,
    count: 0,
  }));
  if (!(slotMs > 0) || !(slotCount > 0)) return slots;
  for (const t of eventMsList) {
    if (!Number.isFinite(t)) continue;
    const idx = Math.floor((t - dayStartMs) / slotMs);
    if (idx >= 0 && idx < slotCount) slots[idx].count += 1;
  }
  return slots;
}

/** Fetch all per-play events (oldest first). Empty when unconfigured/offline. */
export async function fetchAllEvents(limit = 10000): Promise<PlayEvent[]> {
  if (!COUNTER_ENABLED) return [];
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/play_events?select=song_id,played_at,score,rank&order=played_at.asc&limit=${limit}`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    const out: PlayEvent[] = [];
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { song_id?: unknown }).song_id === 'string' &&
        typeof (row as { played_at?: unknown }).played_at === 'string'
      ) {
        const r = row as { song_id: string; played_at: string; score?: unknown; rank?: unknown };
        if (Number.isFinite(Date.parse(r.played_at))) {
          out.push({
            song_id: r.song_id,
            played_at: r.played_at,
            score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null,
            rank: typeof r.rank === 'string' ? r.rank : null,
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Derive per-song bests from events (max score, null scores ignored). Pure. */
export function bestScoresFromEvents(
  events: PlayEvent[],
): Record<string, { score: number; rank: string | null }> {
  const out: Record<string, { score: number; rank: string | null }> = {};
  for (const e of events) {
    if (!e || typeof e.song_id !== 'string' || e.song_id === '') continue;
    if (typeof e.score !== 'number' || !Number.isFinite(e.score)) continue;
    const cur = out[e.song_id];
    if (!cur || e.score > cur.score) {
      out[e.song_id] = { score: e.score, rank: typeof e.rank === 'string' ? e.rank : null };
    }
  }
  return out;
}

/** Group events into per-song totals. Pure. */
export function groupCountsBySong(events: PlayEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (!e || typeof e.song_id !== 'string' || e.song_id === '') continue;
    out[e.song_id] = (out[e.song_id] ?? 0) + 1;
  }
  return out;
}

/** Fetch global counts keyed by song title (derived from events). Empty when unconfigured/offline. */
export async function fetchGlobalCounts(): Promise<Record<string, number>> {
  return groupCountsBySong(await fetchAllEvents());
}
