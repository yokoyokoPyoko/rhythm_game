import { parse } from 'smol-toml';
import type { SongEntry } from '../types';

const SONGS_URL = '/rhythm_game/songs.toml';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSongs(v: unknown): SongEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter(
      (item) =>
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        typeof item.title === 'string' &&
        item.title.length > 0 &&
        typeof item.chartPath === 'string' &&
        item.chartPath.length > 0 &&
        (item.artist === undefined || typeof item.artist === 'string') &&
        (item.difficulty === undefined || isFiniteNumber(item.difficulty)),
    )
    .map((item) => ({
      id: item.id as string,
      title: item.title as string,
      artist: (item.artist as string | undefined) ?? '',
      chartPath: item.chartPath as string,
      difficulty: (item.difficulty as number | undefined) ?? 1,
    }));
}

export async function loadSongList(): Promise<SongEntry[]> {
  const res = await fetch(SONGS_URL);
  if (!res.ok) {
    // 組込曲は削除済みのため、404（songs.toml 欠如）は空リストとして扱う
    return [];
  }
  const text = await res.text();

  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch {
    // SPAフォールバック（Vite dev等）が存在しないパスにHTMLを200で返す場合がある。
    // songs.toml自体は廃止済みのため、HTML応答は「空リスト」とみなす。
    const trimmed = text.trimStart().toLowerCase();
    if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')) {
      return [];
    }
    throw new Error(`曲リストの読み込みに失敗しました: ${SONGS_URL}`);
  }

  return parseSongs(raw.songs);
}
