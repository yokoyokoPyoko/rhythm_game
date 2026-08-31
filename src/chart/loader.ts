import { parse } from 'smol-toml';
import type { BpmChange, Chart, RingDef, Segment } from '../types';
import { getBasename } from '../audio/AudioCache';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseSegments(v: unknown): Segment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => (item.direction === 'up' || item.direction === 'down' || item.direction === 'stay') && isFiniteNumber(item.beats) && item.beats > 0)
    .map((item) => ({ direction: item.direction as 'up' | 'down' | 'stay', beats: item.beats as number }));
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
    .map((item) => ({
      beat: item.beat as number,
      duration: isFiniteNumber(item.duration) && (item.duration as number) > 0 ? (item.duration as number) : undefined,
      type: item.type === 'hold' ? ('hold' as const) : ('single' as const),
    }));
}

export async function loadChart(url: string): Promise<Chart> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`チャートの読み込みに失敗しました (${res.status}): ${url}`);
  }
  const text = await res.text();
  return parseChartText(text, url);
}

export function parseChartText(text: string, source = 'chart'): Chart {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`チャートのTOMLパースに失敗しました: ${source}`);
  }
  // T93/T99/T120/T121/T122/T123/T124: loader must support audio_offset / scroll_speed / amplitude (speed coefficient, physical height fixed at TW_AMP) — keep legacy px migration (>10 => /130) and basename handling

  if (typeof raw.title !== 'string' || typeof raw.artist !== 'string') {
    throw new Error(`チャートに title / artist がありません: ${source}`);
  }
  if (!isFiniteNumber(raw.bpm) || raw.bpm <= 0) {
    throw new Error(`チャートの bpm が不正です: ${source}`);
  }
  if (typeof raw.audio !== 'string' || raw.audio.length === 0) {
    throw new Error(`チャートに audio がありません: ${source}`);
  }

  return {
    title: raw.title,
    artist: raw.artist,
    bpm: raw.bpm,
    audio: getBasename(raw.audio),
    // T93/T99/T120/T121/T122/T123/T124: audio_offset / scroll_speed / amplitude (speed coefficient 0.1-5.0, height fixed at TW_AMP) with legacy px migration (>10 => /130)
    audio_offset: isFiniteNumber(raw.audio_offset) ? (raw.audio_offset as number) : 0,
    scroll_speed: isFiniteNumber(raw.scroll_speed) && (raw.scroll_speed as number) > 0 ? (raw.scroll_speed as number) : 110,
    amplitude: isFiniteNumber(raw.amplitude) && (raw.amplitude as number) > 0 ? ((raw.amplitude as number) > 10 ? (raw.amplitude as number) / 130 : (raw.amplitude as number)) : 1.0,
    start_position: isFiniteNumber(raw.start_position)
      ? Math.max(-1.0, Math.min(1.0, raw.start_position as number))
      : 0.0,
    bpm_changes: parseBpmChanges(raw.bpm_changes),
    segments: parseSegments(raw.segments),
    rings: parseRings(raw.rings),
  };
}
