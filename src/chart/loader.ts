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
    .filter((item) => isFiniteNumber(item.beat) && item.beat >= 0 && isFiniteNumber(item.bpm) && item.bpm > 0)
    .map((item) => ({
      beat: item.beat as number,
      bpm: item.bpm as number,
      // T131: preserve per-entry amplitude (speed coefficient) when set
      amplitude: isFiniteNumber(item.amplitude) && (item.amplitude as number) > 0 ? (item.amplitude as number) : undefined,
      // T186: preserve per-section zoom when set
      zoom: isFiniteNumber(item.zoom) && (item.zoom as number) > 0 ? (item.zoom as number) : undefined,
    }))
    .sort((a, b) => a.beat - b.beat);
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
  // T93/T99/T120/T121/T122/T123/T124/T125/T126: loader supports audio_offset / amplitude (speed coefficient 0.1-5.0, physical height fixed at TW_AMP via waveEngine) — legacy px migration (>10 => /130) + basename handling

  if (typeof raw.title !== 'string' || typeof raw.artist !== 'string') {
    throw new Error(`チャートに title / artist がありません: ${source}`);
  }
  if (typeof raw.audio !== 'string' || raw.audio.length === 0) {
    throw new Error(`チャートに audio がありません: ${source}`);
  }

  // T186: sections are read from [[sections]]; legacy [[bpm_changes]] is aliased (beat/bpm/amplitude only).
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : raw.bpm_changes;

  // T186: allow a beat=0 entry in sections (base tempo section)
  let sections = parseBpmChanges(sectionsRaw);

  // T186: scroll_speed is read-and-discarded (no conversion). bpm (single value) is the legacy base tempo.
  const legacyBpm = isFiniteNumber(raw.bpm) && (raw.bpm as number) > 0 ? (raw.bpm as number) : undefined;

  // T186: migrate legacy bpm to beat=0 when legacy bpm single value exists but no beat=0 section
  if (legacyBpm !== undefined && !sections.some(s => s.beat === 0)) {
    sections.unshift({ beat: 0, bpm: legacyBpm });
  }
  // T186: fallback if completely empty (no sections, no legacy bpm)
  if (sections.length === 0) {
    sections = [{ beat: 0, bpm: 120 }];
  }

  return {
    title: raw.title,
    artist: raw.artist,
    audio: getBasename(raw.audio),
    // T93/T99/T120/T121/T122/T123/T124/T125/T126: audio_offset / amplitude (speed coefficient 0.1-5.0, height fixed at TW_AMP from waveEngine) legacy px migration (>10 => /130)
    audio_offset: isFiniteNumber(raw.audio_offset) ? (raw.audio_offset as number) : 0,
    amplitude: isFiniteNumber(raw.amplitude) && (raw.amplitude as number) > 0 ? ((raw.amplitude as number) > 10 ? (raw.amplitude as number) / 130 : (raw.amplitude as number)) : 1.0,
    start_position: isFiniteNumber(raw.start_position)
      ? Math.max(-1.0, Math.min(1.0, raw.start_position as number))
      : 0.0,
    end_beat: isFiniteNumber(raw.end_beat) && (raw.end_beat as number) >= 0 ? (raw.end_beat as number) : undefined,
    bpm_changes: sections,
    segments: parseSegments(raw.segments),
    rings: parseRings(raw.rings),
  };
}
