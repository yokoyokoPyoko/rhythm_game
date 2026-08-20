import { parse } from 'smol-toml';
import type { BpmChange, Chart, RingDef, Segment } from '../types';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSegments(v: unknown): Segment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => (item.direction === 'up' || item.direction === 'down') && isFiniteNumber(item.beats) && item.beats > 0)
    .map((item) => ({ direction: item.direction as 'up' | 'down', beats: item.beats as number }));
}

function parseBpmChanges(v: unknown): BpmChange[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => isFiniteNumber(item.beat) && item.beat > 0 && isFiniteNumber(item.bpm) && item.bpm > 0)
    .map((item) => ({ beat: item.beat as number, bpm: item.bpm as number }));
}

function parseRings(v: unknown): RingDef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => isFiniteNumber(item.beat) && item.beat >= 0)
    .map((item) => ({ beat: item.beat as number }));
}

export async function loadChart(url: string): Promise<Chart> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`チャートの読み込みに失敗しました (${res.status}): ${url}`);
  }
  const text = await res.text();

  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`チャートのTOMLパースに失敗しました: ${url}`);
  }

  if (typeof raw.title !== 'string' || typeof raw.artist !== 'string') {
    throw new Error(`チャートに title / artist がありません: ${url}`);
  }
  if (!isFiniteNumber(raw.bpm) || raw.bpm <= 0) {
    throw new Error(`チャートの bpm が不正です: ${url}`);
  }
  if (typeof raw.audio !== 'string' || raw.audio.length === 0) {
    throw new Error(`チャートに audio がありません: ${url}`);
  }

  return {
    title: raw.title,
    artist: raw.artist,
    bpm: raw.bpm,
    audio: raw.audio,
    audio_offset: isFiniteNumber(raw.audio_offset) ? raw.audio_offset : 0,
    scroll_speed: isFiniteNumber(raw.scroll_speed) && raw.scroll_speed > 0 ? raw.scroll_speed : 110,
    amplitude: isFiniteNumber(raw.amplitude) && raw.amplitude > 0 ? raw.amplitude : 130,
    bpm_changes: parseBpmChanges(raw.bpm_changes),
    segments: parseSegments(raw.segments),
    rings: parseRings(raw.rings),
  };
}