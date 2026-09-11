// Global high scores (shared across PCs, keyed by song title).
// Backend: Supabase `high_scores` table. Empty object when unconfigured/offline.

import { COUNTER_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from './counterConfig';
import { isCountingPaused } from './playCounts';

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

/** Fetch all global bests keyed by song title. */
export async function fetchBestScores(): Promise<Record<string, HighScoreEntry>> {
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
    const out: Record<string, HighScoreEntry> = {};
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { song_id?: unknown }).song_id === 'string' &&
        typeof (row as { score?: unknown }).score === 'number'
      ) {
        const r = row as { song_id: string; score: number; rank?: unknown };
        out[r.song_id] = {
          score: r.score,
          rank: typeof r.rank === 'string' ? r.rank : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Submit a score. Updates the global best only when beaten (atomic).
 * Returns { best, isRecord } or null when skipped (paused / unconfigured /
 * offline / missing title). Never throws.
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
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/rpc/submit_high_score`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sid: key, sc: Math.round(score), rk: rank }),
      },
    );
    if (!res.ok) return null;
    const val = (await res.json()) as unknown;
    // RPC returns { best: int, beaten: bool }.
    if (typeof val === 'object' && val !== null) {
      const v = val as { best?: unknown; beaten?: unknown };
      if (typeof v.best === 'number' && Number.isFinite(v.best)) {
        return { best: { score: v.best, rank }, isRecord: v.beaten === true };
      }
    }
    return null;
  } catch {
    return null;
  }
}
