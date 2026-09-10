import { unzipSync } from 'fflate';
import { parseChartText } from '../chart/loader';
import { getBasename } from '../audio/AudioCache';
import type { Chart, SongEntry, ZipEntry } from '../types';

export interface ZipPair {
  tomlPath: string;
  audioPath: string;
  folder: string;
  chart: Chart;
  tomlText: string;
  audioBytes: Uint8Array;
  audioName: string;
}

export interface ZipPairResult {
  pairs: ZipPair[];
  skipped: string[];
  duplicates: string[];
}

export interface ZipFilterResult {
  entries: ZipEntry[];
  filteredOut: string[];
}

// Filter function that returns just the filtered entries array (for test compatibility)
export function filterZipEntries(entries: ZipEntry[]): ZipEntry[] {
  const filtered: ZipEntry[] = [];

  for (const entry of entries) {
    const { path } = entry;
    if (path.endsWith('/')) continue;
    if (path.startsWith('__MACOSX/')) continue;
    const parts = path.split('/');
    const fileName = parts[parts.length - 1];
    if (fileName.startsWith('.')) continue;
    filtered.push(entry);
  }

  return filtered;
}

// Alias for test compatibility
export const filterEntries = filterZipEntries;

export function groupEntriesByFolder(entries: ZipEntry[]): Record<string, Record<string, Uint8Array>> {
  const groups: Record<string, Record<string, Uint8Array>> = {};

  for (const { path, bytes } of entries) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1];
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!groups[dir]) groups[dir] = {};
    // Handle duplicate paths - keep first occurrence
    if (!groups[dir][fileName]) {
      groups[dir][fileName] = bytes;
    }
  }

  return groups;
}

export function pairTomlAudioInFolder(
  dir: string,
  files: Record<string, Uint8Array>,
  usedAudioPaths: Set<string>
): { pairs: ZipPairResult['pairs']; skipped: string[]; usedAudioPaths: Set<string> } {
  const audioExts = ['.flac', '.mp3', '.wav', '.ogg', '.m4a'];
  const tomlFiles: [string, Uint8Array][] = [];
  const audioFiles: [string, Uint8Array][] = [];

  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('.toml')) {
      tomlFiles.push([name, bytes]);
    } else if (audioExts.some(ext => name.toLowerCase().endsWith(ext))) {
      audioFiles.push([name, bytes]);
    }
  }

  const pairs: ZipPairResult['pairs'] = [];
  const skipped: string[] = [];

  if (tomlFiles.length === 0) {
    for (const name of Object.keys(files)) {
      if (!audioExts.some(ext => name.toLowerCase().endsWith(ext))) {
        skipped.push(dir ? `${dir}/${name}` : name);
      }
    }
    return { pairs, skipped, usedAudioPaths };
  }

  // For each TOML, try to pair with audio
  for (const [tomlName, tomlBytes] of tomlFiles) {
    let text: string;
    try {
      text = new TextDecoder().decode(tomlBytes);
    } catch {
      skipped.push(dir ? `${dir}/${tomlName}` : tomlName);
      continue;
    }

    // Try to parse and get audio basename
    let parsed: Chart;
    let audioBase: string | null = null;
    let hasAudioField = false;
    try {
      parsed = parseChartText(text, tomlName);
      audioBase = getBasename(parsed.audio);
      hasAudioField = !!parsed.audio;
    } catch {
      // Try to extract audio basename from raw text for pairing
      const audioMatch = text.match(/audio\s*=\s*["']([^"']+)["']/);
      if (audioMatch) {
        audioBase = getBasename(audioMatch[1]);
        hasAudioField = true;
      }
      // Create a minimal chart for pairing
      parsed = {
        title: tomlName.replace(/\.toml$/i, ''),
        artist: '',
        audio: audioBase || '',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [],
        segments: [],
        rings: [],
      };
    }

    let matched = false;

    // First try: match by audio basename from TOML
    if (audioBase) {
      const matchEntry = audioFiles.find(([name]) => {
        const extIdx = name.lastIndexOf('.');
        const base = extIdx > 0 ? name.substring(0, extIdx) : name;
        return base === audioBase || name === audioBase;
      });

      if (matchEntry) {
        const [audioName, audioBytes] = matchEntry;
        const fullAudioPath = dir ? `${dir}/${audioName}` : audioName;
        pairs.push({
          tomlPath: dir ? `${dir}/${tomlName}` : tomlName,
          audioPath: fullAudioPath,
          folder: dir,
          chart: parsed,
          tomlText: text,
          audioBytes,
          audioName,
        });
        usedAudioPaths.add(fullAudioPath);
        matched = true;
      }
    }

    // Fallback: ONLY if TOML has no audio field at all, pair with first available audio in same folder
    if (!matched && !hasAudioField && audioFiles.length > 0) {
      // Find first unused audio file in this folder
      const unusedAudio = audioFiles.find(([name]) => {
        const fullAudioPath = dir ? `${dir}/${name}` : name;
        return !usedAudioPaths.has(fullAudioPath);
      });

      if (unusedAudio) {
        const [audioName, audioBytes] = unusedAudio;
        const fullAudioPath = dir ? `${dir}/${audioName}` : audioName;
        pairs.push({
          tomlPath: dir ? `${dir}/${tomlName}` : tomlName,
          audioPath: fullAudioPath,
          folder: dir,
          chart: parsed,
          tomlText: text,
          audioBytes,
          audioName,
        });
        usedAudioPaths.add(fullAudioPath);
        matched = true;
      }
    }

    if (!matched) {
      skipped.push(dir ? `${dir}/${tomlName}` : tomlName + ' (音声ファイル不一致)');
    }
  }

  for (const [audioName] of audioFiles) {
    const fullAudioPath = dir ? `${dir}/${audioName}` : audioName;
    if (!usedAudioPaths.has(fullAudioPath)) {
      skipped.push(fullAudioPath);
    }
  }

  return { pairs, skipped, usedAudioPaths };
}

export function pairZipEntries(entries: ZipEntry[]): ZipPairResult {
  // Detect duplicates from original entries before filtering
  const seenPaths = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    if (seenPaths.has(entry.path)) {
      duplicates.push(entry.path);
    } else {
      seenPaths.add(entry.path);
    }
  }

  const filteredEntries = filterZipEntries(entries);
  const groups = groupEntriesByFolder(filteredEntries);
  const allPairs: ZipPairResult['pairs'] = [];
  const allSkipped: string[] = [];
  const usedAudioPaths = new Set<string>();

  for (const [dir, files] of Object.entries(groups)) {
    const result = pairTomlAudioInFolder(dir, files, usedAudioPaths);
    allPairs.push(...result.pairs);
    allSkipped.push(...result.skipped);
  }

  return {
    pairs: allPairs,
    skipped: allSkipped,
    duplicates,
  };
}

export function generateCustomIds(baseTime: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `custom-${baseTime}-${i}`);
}

export async function handleZipFile(
  file: File
): Promise<{ pairs: ZipPairResult['pairs']; skipped: string[]; newSongs: SongEntry[] }> {
  let unzipped: Record<string, Uint8Array>;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    unzipped = unzipSync(data);
  } catch (e) {
    // Corrupt zip - return empty result without throwing
    console.warn('[zipImport] Failed to unzip file:', e);
    return { pairs: [], skipped: ['corrupt zip file'], newSongs: [] };
  }

  const entries: ZipEntry[] = [];
  for (const [path, bytes] of Object.entries(unzipped)) {
    entries.push({ path, bytes });
  }

  const result = pairZipEntries(entries);

  // Empty audio bytes → pair not established (reported, never stored)
  const pairs: ZipPair[] = [];
  const skipped: string[] = [...result.skipped];
  for (const pair of result.pairs) {
    if (pair.audioBytes && pair.audioBytes.length > 0) {
      pairs.push(pair);
    } else {
      skipped.push(`${pair.tomlPath} (音声ファイル空)`);
    }
  }

  const baseTime = Date.now();
  const newSongs: SongEntry[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const id = generateCustomIds(baseTime, pairs.length)[i];
    const title = pair.chart.title || pair.tomlPath.replace(/\.toml$/i, '') || 'Untitled';

    const newEntry: SongEntry = {
      id,
      title,
      artist: pair.chart.artist || '',
      chartPath: id,
      difficulty: 3,
    };
    newSongs.push(newEntry);
  }

  return { pairs, skipped, newSongs };
}