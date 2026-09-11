// Global high scores (shared across PCs, keyed by song title).
// Source of truth is play_events (MAX(score) per song); the legacy
// high_scores table is kept as a read-only fallback so previously recorded
// bests are never lost. Empty object when unconfigured/offline.

import { COUNTER_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from './counterConfig';
import { bestScoresFromEvents, fetchAllEvents, isCountingPaused } from './playCounts';

const FETCH_TIMEOUT_MS = 6000;

export interface HighScoreEntry {
  score: number;
  rank: string | null;
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

function mergeBests(
  a: Record<string, HighScoreEntry>,
  b: Record<string, HighScoreEntry>,
): Record<string, HighScoreEntry> {
  const out: Record<string, HighScoreEntry> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (!cur || v.score > cur.score) out[k] = v;
  }
  return out;
}

/** Fetch all global bests keyed by song title (events MAX merged with legacy table). */
export async function fetchBestScores(): Promise<Record<string, HighScoreEntry>> {
  if (!COUNTER_ENABLED) return {};
  const fromEvents = bestScoresFromEvents(await fetchAllEvents());
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/high_scores?select=song_id,score,rank`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      },
    );
    if (!res.ok) return fromEvents;
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return fromEvents;
    const legacy: Record<string, HighScoreEntry> = {};
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { song_id?: unknown }).song_id === 'string' &&
        typeof (row as { score?: unknown }).score === 'number'
      ) {
        const r = row as { song_id: string; score: number; rank?: unknown };
        legacy[r.song_id] = {
          score: r.score,
          rank: typeof r.rank === 'string' ? r.rank : null,
        };
      }
    }
    return mergeBests(fromEvents, legacy);
  } catch {
    return fromEvents;
  }
}

async function postRpc(
  fn: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty body */
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: -1, json: null };
  }
}

/**
 * Submit a score as a scored event row. The best is derived (MAX over events
 * merged with the legacy table), so this only needs the write to succeed.
 * Returns { best, isRecord } or null when skipped (paused / unconfigured /
 * offline / missing title). Falls back to the legacy submit_high_score RPC
 * when the 3-arg log_play overload is not deployed yet. Never throws.
 */
export async function submitHighScore(
  title: string,
  score: number,
  rank: string | null,
): Promise<{ best: HighScoreEntry; isRecord: boolean } | null> {
  const key = (title || '').trim();
  if (!key || !Number.isFinite(score) || !COUNTER_ENABLED || isCountingPaused()) {
    return null;
  }
  const rounded = Math.round(score);
  const prevEntry = (await fetchBestScores())[key];
  const prevBest = prevEntry?.score ?? 0;
  const logged = await postRpc('log_play', { sid: key, sc: rounded, rk: rank });
  if (!logged.ok && logged.status !== 404) return null;
  if (!logged.ok) {
    // Old backend without the 3-arg overload: use the legacy upsert RPC.
    const legacy = await postRpc('submit_high_score', { sid: key, sc: rounded, rk: rank });
    if (!legacy.ok) return null;
    const v = legacy.json as { best?: unknown; beaten?: unknown } | null;
    if (v && typeof v === 'object' && typeof v.best === 'number' && Number.isFinite(v.best)) {
      return {
        best: { score: v.best, rank: v.beaten === true ? rank : (prevEntry?.rank ?? rank) },
        isRecord: v.beaten === true || rounded > prevBest,
      };
    }
    return {
      best: rounded > prevBest ? { score: rounded, rank } : (prevEntry ?? { score: prevBest, rank }),
      isRecord: rounded > prevBest,
    };
  }
  return {
    best: rounded > prevBest ? { score: rounded, rank } : (prevEntry ?? { score: prevBest, rank }),
    isRecord: rounded > prevBest,
  };
}
