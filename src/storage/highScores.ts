// Global high scores (shared across PCs, keyed by song title).
// Source of truth is play_events (MAX(score) per song); the legacy
// high_scores table is kept as a read-only fallback so previously recorded
// bests are never lost. Empty object when unconfigured/offline.

import { COUNTER_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from './counterConfig';
import {
  bestScoresFromEvents,
  fetchEventRows,
  isCountingPaused,
} from './playCounts';

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

/**
 * Fetch one song's best with two single-row queries (no full-table scan).
 * Used on the song-start critical path. Returns null when unknown/offline.
 */
export async function fetchBestForTitle(title: string): Promise<HighScoreEntry | null> {
  const key = (title || '').trim();
  if (!key || !COUNTER_ENABLED) return null;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  };
  const parseBest = (rows: unknown): HighScoreEntry | null => {
    if (!Array.isArray(rows)) return null;
    let best: HighScoreEntry | null = null;
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { score?: unknown }).score === 'number'
      ) {
        const r = row as { score: number; rank?: unknown };
        if (!Number.isFinite(r.score)) continue;
        if (!best || r.score > best.score) {
          best = { score: r.score, rank: typeof r.rank === 'string' ? r.rank : null };
        }
      }
    }
    return best;
  };
  try {
    const eq = encodeURIComponent(key);
    const [evRes, legRes] = await Promise.all([
      // NOTE: NULLS FIRST is PostgreSQL's default for DESC, so without the
      // not.is.null filter a score-less play row would win limit=1 and the
      // song would wrongly show "---" despite having scored plays.
      fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/play_events?select=score,rank&song_id=eq.${eq}&score=not.is.null&order=score.desc&limit=1`,
        { headers },
      ),
      fetchWithTimeout(`${SUPABASE_URL}/rest/v1/high_scores?select=score,rank&song_id=eq.${eq}`, {
        headers,
      }),
    ]);
    const evBest = evRes.ok ? parseBest(await evRes.json().catch(() => null)) : null;
    const legBest = legRes.ok ? parseBest(await legRes.json().catch(() => null)) : null;
    if (evBest && legBest) return evBest.score >= legBest.score ? evBest : legBest;
    return evBest ?? legBest;
  } catch {
    return null;
  }
}

/**
 * Events-derived bests with a success signal. `ok === false` means the fetch
 * failed (unknown state) — never treat it as an empty leaderboard, or stale
 * scores will be celebrated as NEW RECORDs.
 */
export async function fetchEventsBestStatus(): Promise<{
  bests: Record<string, HighScoreEntry>;
  ok: boolean;
}> {
  const { events, ok } = await fetchEventRows();
  if (!ok) return { bests: {}, ok: false };
  return { bests: bestScoresFromEvents(events), ok: true };
}

async function fetchLegacyBest(): Promise<Record<string, HighScoreEntry>> {
  if (!COUNTER_ENABLED) return {};
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
    if (!res.ok) return {};
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return {};
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
    return legacy;
  } catch {
    return {};
  }
}

/** Fetch all global bests keyed by song title (events MAX merged with legacy table). */
export async function fetchBestScores(): Promise<Record<string, HighScoreEntry>> {
  const [{ bests }, legacy] = await Promise.all([fetchEventsBestStatus(), fetchLegacyBest()]);
  return mergeBests(bests, legacy);
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
  // Celebration AND best display require positively-known prior bests: an
  // unknown leaderboard (fetch failure) must never read as "no record", or
  // stale scores get celebrated as NEW RECORDs with the current score shown
  // as the best. The row is still recorded; only the display is withheld.
  const [{ bests: evBests, ok }, legacy] = await Promise.all([
    fetchEventsBestStatus(),
    fetchLegacyBest(),
  ]);
  const logged = await postRpc('log_play', { sid: key, sc: rounded, rk: rank });
  if (!logged.ok && logged.status !== 404) {
    // Old backend without the 3-arg overload: use the legacy upsert RPC.
    const legacyPost = await postRpc('submit_high_score', { sid: key, sc: rounded, rk: rank });
    if (!legacyPost.ok) return null;
  }
  if (!ok) return null;
  const prev = mergeBests(evBests, legacy)[key];
  const prevBest = prev?.score ?? 0;
  return {
    best: rounded > prevBest ? { score: rounded, rank } : (prev ?? { score: prevBest, rank }),
    isRecord: rounded > prevBest,
  };
}
