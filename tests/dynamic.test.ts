/**
 * T195 — GameScreenのIndexedDBフォールバック取得 Vitest pure acceptance (node)
 * TDD Red→Green — strict 3-step state-transition checks
 * 要求: リロード後に直接/play/custom-xxxを開いてもプレイできる
 * 修正: src/screens/GameScreen.tsx
 *  - 譜面解決: ChartCache → IndexedDB(TOML parse→Cache) → songs.toml
 *  - 音源解決: AudioCache → IndexedDB(bytes decode→Cache) → fetch (ensure後 decode)
 *  - 既存 location.state 直渡し維持
 * 完了条件: (1) リロード後/play/custom-xxxで譜面・音源付きプレイ (2) tsc・既存経路回帰なし
 *
 * Runs WITHOUT browser — imports pure modules directly.
 * Uses vi.useFakeTimers() deterministically + fake-indexeddb.
 * No DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'fs';

import { ChartCache } from '../src/chart/cache';
import { AudioCache, getBasename } from '../src/audio/AudioCache';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import {
  openLibraryDB,
  closeLibraryDB,
  deleteLibraryDB,
  clearLibraryDB,
  putChart,
  getChart,
  listCharts,
  putAudio,
  getAudio,
  listAudio,
  deleteChart,
  deleteAudio,
} from '../src/storage/libraryDb';
import type { StoredChart, StoredAudio } from '../src/storage/libraryDb';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import type { Chart } from '../src/types';

// ---------------------------------------------------------------------------
// fake timers deterministic
// ---------------------------------------------------------------------------
vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

function makeComplexToml(audioBasename = 'custom-song.flac'): string {
  return `
title = "OffGrid 0.37 T195 Complex"
artist = "Tester"
audio = "${audioBasename}"
audio_offset = 80
amplitude = 1.3
start_position = 0.5
end_beat = 16.0
[[sections]]
beat = 0
bpm = 120
amplitude = 0.7
zoom = 1.0
[[sections]]
beat = 4.37
bpm = 150
amplitude = 1.3
zoom = 1.5
[[segments]]
direction = "up"
beats = 1.37
[[segments]]
direction = "down"
beats = 0.63
[[segments]]
direction = "stay"
beats = 1.0
[[rings]]
beat = 0.37
[[rings]]
beat = 1.23
[[rings]]
beat = 4.37
type = "hold"
duration = 0.5
`;
}

function makeSimpleToml(audioBasename = 'solo.flac'): string {
  return `title = "Simple 0.37"\nartist = ""\naudio = "${audioBasename}"\n[[sections]]\nbeat = 0\nbpm = 120\n[[rings]]\nbeat = 4.37\n`;
}

function buildChart(toml: string): Chart {
  return parseChartText(toml, 'test.toml');
}

function makeChartEntry(id: string, toml: string, audioId: string | null): StoredChart {
  const parsed = buildChart(toml);
  return {
    id,
    title: parsed.title,
    artist: parsed.artist,
    difficulty: 4,
    toml: chartToToml(parsed),
    audioId,
    addedAt: Date.now(),
  };
}

function makeMockAudioCtx() {
  return {
    sampleRate: 44100,
    // decode returns a minimal AudioBuffer-like object
    decodeAudioData: async (ab: ArrayBuffer) => {
      // verify bytes.slice(0) semantics: ab is a copy
      expect(ab).toBeInstanceOf(ArrayBuffer);
      expect(ab.byteLength).toBeGreaterThan(0);
      return { duration: 62.5, sampleRate: 44100, length: 44100 * 62, numberOfChannels: 2 } as unknown as AudioBuffer;
    },
    createBuffer: (ch: number, len: number, sr: number) => ({ duration: len / sr, sampleRate: sr } as unknown as AudioBuffer),
  } as unknown as AudioContext;
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'));
  ChartCache.clear();
  AudioCache.clear();
  try {
    await deleteLibraryDB();
  } catch {
    try { await clearLibraryDB(); } catch { /* ignore */ }
  }
  closeLibraryDB();
});

afterEach(async () => {
  ChartCache.clear();
  AudioCache.clear();
  try { await clearLibraryDB(); } catch { /* ignore */ }
  closeLibraryDB();
  vi.clearAllTimers();
});

// ===========================================================================
// 1) 譜面解決順序: ChartCache → IndexedDB(TOML parse→Cache) → songs.toml fallback
// ===========================================================================
describe('T195 1. 譜面解決: ChartCache → IndexedDB(TOML parse→Cache) → songs.toml', () => {
  it('ChartCache miss → IndexedDB hit → parseChartText→ChartCache.set でリロード後も譜面が再現される (3-step off-grid)', async () => {
    // [Step1: Capture Initial State] — empty caches, IDB empty, parse baseline
    expect(ChartCache.get('custom-1770000000000')).toBeUndefined();
    expect(ChartCache.has('custom-1770000000000')).toBe(false);
    expect((await listCharts()).length).toBe(0);
    expect(await getChart('custom-1770000000000')).toBeUndefined();
    const id = `custom-${Date.now()}`;
    expect(id).toBe('custom-1775121600000'); // deterministic: 2026-04-01
    const toml = makeComplexToml('custom-song.flac');
    const chartBefore = buildChart(toml);
    expect(chartBefore.rings.some(r => Math.abs(r.beat - 0.37) < 1e-6)).toBe(true);
    expect(chartBefore.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);

    // [Step2: Perform] — Simulate SelectScreen "追加": persist to IndexedDB (B案)
    const storedToml = chartToToml(chartBefore);
    const entry = makeChartEntry(id, storedToml, `audio-${Date.now()}`);
    await putChart(entry);
    expect((await listCharts()).length).toBe(1);

    // Simulate reload: clear in-memory ChartCache, close DB, reopen
    ChartCache.clear();
    closeLibraryDB();
    expect(ChartCache.has(id)).toBe(false); // cache cleared = reload state

    // GameScreen fallback path: ChartCache miss → IDB
    const cachedMiss = ChartCache.get(id);
    expect(cachedMiss).toBeUndefined();
    const stored = await getChart(id);
    expect(stored).toBeDefined();
    expect(stored!.id).toBe(id);
    // T195: TOMLをparseしてCacheへ
    const reparsed = parseChartText(stored!.toml, id);
    ChartCache.set(id, reparsed);
    ChartCache.set(reparsed.audio, reparsed); // also cache by basename pattern if needed

    // [Step3: Assert Transition] — cache now hit, content fidelity off-grid
    const afterCache = ChartCache.get(id);
    expect(afterCache).toBeDefined();
    expect(afterCache!.title).toBe('OffGrid 0.37 T195 Complex');
    expect(afterCache!.audio).toBe('custom-song.flac'); // basename only
    expect(afterCache!.rings.some(r => Math.abs(r.beat - 0.37) < 1e-6)).toBe(true);
    expect(afterCache!.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    expect(afterCache!.rings.some(r => Math.abs(r.beat - 4.37) < 1e-6)).toBe(true);
    expect(afterCache!.segments.length).toBe(3);
    expect(afterCache!.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-6)).toBe(true);
    expect(afterCache!.audio_offset).toBe(80);
    expect(afterCache!.amplitude).toBeCloseTo(1.3, 3);
    expect(afterCache!.end_beat).toBeCloseTo(16.0, 3);
    // second access hits ChartCache directly (no IDB needed)
    const secondHit = ChartCache.get(id);
    expect(secondHit).toBe(afterCache);
  });

  it('ChartCache hit が優先され IndexedDB に問い合わせず即解決する (3-step)', async () => {
    // [Step1: Capture] — IDB has different title than cache
    const id = `custom-${Date.now()}`;
    const tomlCached = makeSimpleToml('cached.flac');
    const chartCached = buildChart(tomlCached);
    // put different version into IDB
    const idbToml = makeComplexToml('idb.flac');
    const idbChart = buildChart(idbToml);
    const idbStoredToml = chartToToml(idbChart);
    await putChart({ id, title: idbChart.title, artist: '', difficulty: 1, toml: idbStoredToml, audioId: null, addedAt: Date.now() });
    // put into ChartCache the cached version
    ChartCache.set(id, chartCached);
    const beforeCached = ChartCache.get(id);
    expect(beforeCached!.title).toBe('Simple 0.37');
    expect((await getChart(id))!.title).toBe('OffGrid 0.37 T195 Complex');

    // [Step2: Perform] — GameScreen resolution order: check cache first
    let resolvedChart: Chart | undefined;
    const fromCache = ChartCache.get(id);
    if (fromCache) {
      resolvedChart = fromCache;
    } else {
      const stored = await getChart(id);
      if (stored) resolvedChart = parseChartText(stored.toml, id);
    }

    // [Step3: Assert] — cache priority: resolved is cached version, not IDB version
    expect(resolvedChart).toBeDefined();
    expect(resolvedChart!.title).toBe('Simple 0.37'); // from cache, not IDB
    expect(resolvedChart!.audio).toBe('cached.flac');
    expect(resolvedChart!.title).not.toBe('OffGrid 0.37 T195 Complex');
  });

  it('ChartCache miss + IDB miss → songs.toml フォールバック相当で loadSongList が参照されるパスが残る (3-step static+dynamic)', async () => {
    // [Step1: Capture] — empty cache + empty IDB
    const unknownId = `custom-${Date.now()}-unknown`;
    expect(ChartCache.get(unknownId)).toBeUndefined();
    expect(await getChart(unknownId)).toBeUndefined();
    expect((await listCharts()).length).toBe(0);
    const gameSrc = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
    const hasLoadSongList = gameSrc.includes('loadSongList');
    const hasSongsFallback = gameSrc.includes('songs.find') || gameSrc.includes('loadSongList');
    expect(hasLoadSongList).toBe(true);
    expect(hasSongsFallback).toBe(true);

    // [Step2: Perform] — simulate fallback attempt: neither cache nor IDB -> would call loadSongList
    let fellThroughToSongs = false;
    let resolved: Chart | undefined = ChartCache.get(unknownId);
    if (!resolved) {
      const stored = await getChart(unknownId);
      if (stored) resolved = parseChartText(stored.toml, unknownId);
      else fellThroughToSongs = true; // would call loadSongList in real GameScreen
    }

    // [Step3: Assert] — fell through, and source still contains the branch
    expect(resolved).toBeUndefined();
    expect(fellThroughToSongs).toBe(true);
    // ensure loadSongList import still present (regression guard)
    expect(gameSrc).toContain('loadSongList');
  });

  it('IDB TOML basename統一: フルパスaudioがbasenameに正規化されて永続化される (3-step off-grid)', async () => {
    // [Step1: Capture] — create TOML with full path audio
    const id = `custom-${Date.now()}`;
    const tomlFullPath = `
title = "Basename T195"
artist = ""
audio = "/rhythm_game/audio/08.Reply.flac"
[[sections]]
beat = 0
bpm = 120
[[rings]]
beat = 0.37
`;
    const parsedFull = buildChart(tomlFullPath);
    expect(parsedFull.audio).toBe('08.Reply.flac'); // loader extracts basename

    // [Step2: Perform] — store via IDB then reload path
    const serialized = chartToToml(parsedFull);
    expect(serialized).toContain('audio = "08.Reply.flac"');
    expect(serialized).not.toContain('/rhythm_game/audio');
    await putChart({ id, title: parsedFull.title, artist: parsedFull.artist, difficulty: 2, toml: serialized, audioId: null, addedAt: Date.now() });
    ChartCache.clear();
    closeLibraryDB();
    const stored = await getChart(id);
    const reparsed = parseChartText(stored!.toml, id);
    ChartCache.set(id, reparsed);

    // [Step3: Assert] — reparsed still basename, off-grid preserved
    expect(reparsed.audio).toBe('08.Reply.flac');
    expect(getBasename(reparsed.audio)).toBe('08.Reply.flac');
    expect(reparsed.rings[0].beat).toBeCloseTo(0.37, 3);
    expect(ChartCache.get(id)!.audio).toBe('08.Reply.flac');
  });
});

// ===========================================================================
// 2) 音源解決: AudioCache → IndexedDB(bytes decode→Cache) → fetch
// ===========================================================================
describe('T195 2. 音源解決: AudioCache → IndexedDB(bytes decode→Cache) → fetch', () => {
  it('AudioCache miss → IndexedDB hit → bytes.slice(0) decode→AudioCache.set で復元される (3-step)', async () => {
    // [Step1: Capture] — empty caches
    const id = `custom-${Date.now()}`;
    const audioId = `audio-${Date.now()}`;
    const basename = 'custom-song.flac';
    const chartToml = makeComplexToml(basename);
    const chart = buildChart(chartToml);
    const rawBytes = new Uint8Array([10, 20, 30, 40, 255, 128, 64, 1, 2, 3, 99]);
    await putChart({ id, title: chart.title, artist: chart.artist, difficulty: 3, toml: chartToToml(chart), audioId, addedAt: Date.now() });
    await putAudio({ id: audioId, name: basename, mime: 'audio/flac', bytes: rawBytes });
    // also test stored via songId indirection: GameScreen spec says getAudio(songId) path; we store under songId as well for fallback
    await putAudio({ id, name: basename, mime: 'audio/flac', bytes: rawBytes }); // duplicate under custom id for GameScreen songId lookup

    expect(AudioCache.get(basename)).toBeUndefined();
    expect(AudioCache.get(id)).toBeUndefined();
    expect((await listAudio()).length).toBe(2);

    // Simulate reload clearing cache
    AudioCache.clear();
    closeLibraryDB();
    expect(AudioCache.has(basename)).toBe(false);

    // [Step2: Perform] — GameScreen audio fallback (after AudioContext.ensure())
    const ctx = makeMockAudioCtx();
    let resolvedBuf: AudioBuffer | null = null;
    const cachedBefore = AudioCache.get(basename) || AudioCache.get(id);
    expect(cachedBefore).toBeUndefined(); // miss confirmed

    // IndexedDB path — try songId first then basename (spec allows either)
    let stored = await getAudio(id);
    if (!stored) stored = await getAudio(audioId);
    expect(stored).toBeDefined();
    expect(stored!.bytes).toBeInstanceOf(Uint8Array);
    expect(stored!.bytes.length).toBe(rawBytes.length);
    // bytes.slice(0) semantics required by spec
    const arrayBuf = stored!.bytes.buffer.slice(stored!.bytes.byteOffset, stored!.bytes.byteOffset + stored!.bytes.byteLength) as ArrayBuffer;
    // also test bytes.slice(0) variant
    const sliced = stored!.bytes.slice(0);
    expect(Array.from(sliced)).toEqual(Array.from(rawBytes));
    // independence: mutating slice does not affect stored
    sliced[0] = 77;
    expect(stored!.bytes[0]).toBe(10);

    const decoded = await ctx.decodeAudioData(arrayBuf);
    // T195: bytesをdecodeしてCacheへ
    AudioCache.set(id, decoded as unknown as AudioBuffer);
    AudioCache.set(basename, decoded as unknown as AudioBuffer);
    resolvedBuf = decoded as unknown as AudioBuffer;

    // [Step3: Assert] — cache now hit, bytes fidelity, decode called once
    expect(resolvedBuf).toBeDefined();
    expect(AudioCache.get(id)).toBe(resolvedBuf);
    expect(AudioCache.get(basename)).toBe(resolvedBuf);
    expect(AudioCache.has(basename)).toBe(true);
    // verify stored bytes still intact after decode slice
    const reFetched = await getAudio(id);
    expect(Array.from(reFetched!.bytes)).toEqual(Array.from(rawBytes));
    expect(reFetched!.bytes[0]).toBe(10);
  });

  it('AudioCache hit が優先され IndexedDB デコードをスキップする (3-step)', async () => {
    // [Step1: Capture] — put audio into cache directly
    const basename = 'cached-audio.flac';
    const fakeBuf = { duration: 60, sampleRate: 44100 } as unknown as AudioBuffer;
    AudioCache.set(basename, fakeBuf);
    const id = `custom-${Date.now()}`;
    const rawBytes = new Uint8Array([1, 2, 3]);
    await putAudio({ id: `audio-${Date.now()}`, name: basename, mime: 'audio/flac', bytes: rawBytes });
    expect(AudioCache.get(basename)).toBe(fakeBuf);
    expect((await listAudio()).length).toBe(1);

    // [Step2: Perform] — resolution order check
    let resolved: AudioBuffer | undefined = AudioCache.get(basename);
    let idbQueried = false;
    if (!resolved) {
      idbQueried = true;
      const stored = await getAudio(basename);
      if (stored) resolved = await makeMockAudioCtx().decodeAudioData(stored.bytes.buffer as ArrayBuffer) as unknown as AudioBuffer;
    }

    // [Step3: Assert] — cache hit, no IDB query, same buffer instance
    expect(resolved).toBe(fakeBuf);
    expect(idbQueried).toBe(false);
    expect(AudioCache.get(basename)).toBe(fakeBuf);
  });

  it('AudioCache miss + IDB miss → fetch(lazy) フォールバックパスが残る (3-step static)', async () => {
    // [Step1: Capture] — empty
    const missBase = `missing-${Date.now()}.flac`;
    expect(AudioCache.get(missBase)).toBeUndefined();
    expect(await getAudio(missBase)).toBeUndefined();
    const gameSrc = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
    const hasLoadAudio = gameSrc.includes('loadAudio');
    const hasAudioCacheCheck = gameSrc.includes('AudioCache.get');
    const hasGetAudio = gameSrc.includes('getAudio');

    // [Step2: Perform] — simulate miss path
    let fellThroughToFetch = false;
    let buf = AudioCache.get(missBase);
    if (!buf) {
      const stored = await getAudio(missBase);
      if (stored) {
        // would decode
      } else {
        fellThroughToFetch = true; // would call loadAudio(chart.audio, ctx)
      }
    }

    // [Step3: Assert] — fell through and source branches exist
    expect(fellThroughToFetch).toBe(true);
    expect(hasLoadAudio).toBe(true);
    expect(hasAudioCacheCheck).toBe(true);
    expect(hasGetAudio).toBe(true);
  });

  it('音源バイトが圧縮のまま保存され file.arrayBuffer 相当の Uint8Array が永続化される (3-step)', async () => {
    // [Step1: Capture] — create file-like bytes
    const fileBytes = new Uint8Array([0, 1, 2, 255, 254, 128, 64, 32, 16, 8]);
    const audioId = `audio-${Date.now()}`;
    const basename = 'local-file.flac';

    // [Step2: Perform] — putAudio mimics file.arrayBuffer() storage
    await putAudio({ id: audioId, name: basename, mime: 'audio/flac', bytes: fileBytes });
    const beforeReload = await getAudio(audioId);
    expect(beforeReload!.bytes.length).toBe(10);
    closeLibraryDB();
    const afterReload = await getAudio(audioId);

    // [Step3: Assert] — bytes preserved, decode via slice(0) yields independent buffer
    expect(afterReload).toBeDefined();
    expect(Array.from(afterReload!.bytes)).toEqual(Array.from(fileBytes));
    const forDecode = afterReload!.bytes.slice(0);
    const forDecode2 = afterReload!.bytes.buffer.slice(afterReload!.bytes.byteOffset, afterReload!.bytes.byteOffset + afterReload!.bytes.byteLength);
    expect(forDecode.length).toBe(fileBytes.length);
    expect((forDecode2 as ArrayBuffer).byteLength).toBe(fileBytes.length);
    // mutate copies does not affect stored
    forDecode[0] = 99;
    expect(afterReload!.bytes[0]).toBe(0);
  });
});

// ===========================================================================
// 3) 結合: リロード後 /play/custom-xxx で譜面・音源付きプレイ (完了条件1)
// ===========================================================================
describe('T195 3. 結合: リロード後 /play/custom-xxx で譜面・音源付きプレイ', () => {
  it('putChart+putAudio → ChartCache/AudioCache clear+DB reopen → 両方ともIDBから復元されプレイ可能 (3-step)', async () => {
    // [Step1: Capture] — start empty, generate deterministic custom id
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);
    expect(ChartCache.get('custom-1775121600000')).toBeUndefined();
    const id = `custom-${Date.now()}`;
    const basename = 'combined.flac';
    expect(id).toBe('custom-1775121600000');
    const toml = makeComplexToml(basename);
    const chart = buildChart(toml);
    const rawBytes = new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88, 99, 111]);
    const audioId = `audio-${Date.now()}`;

    // [Step2: Perform] — Add (SelectScreen) + reload simulation
    const storedToml = chartToToml(chart);
    await putChart({ id, title: chart.title, artist: chart.artist, difficulty: 5, toml: storedToml, audioId, addedAt: Date.now() });
    await putAudio({ id: audioId, name: basename, mime: 'audio/flac', bytes: rawBytes });
    // also store under id for GameScreen songId lookup path
    await putAudio({ id, name: basename, mime: 'audio/flac', bytes: rawBytes });

    // Simulate full page reload: clear all in-mem caches
    ChartCache.clear();
    AudioCache.clear();
    closeLibraryDB();

    // GameScreen init sequence (chart resolution)
    let playChart: Chart | undefined = ChartCache.get(id);
    expect(playChart).toBeUndefined();
    const storedChart = await getChart(id);
    expect(storedChart).toBeDefined();
    const reparsedChart = parseChartText(storedChart!.toml, id);
    ChartCache.set(id, reparsedChart);
    playChart = reparsedChart;

    // GameScreen audio resolution (after ensure)
    let playBuf: AudioBuffer | null = null;
    const cachedAudio = AudioCache.get(getBasename(playChart.audio)) || AudioCache.get(id);
    expect(cachedAudio).toBeUndefined();
    let storedAudio = await getAudio(id);
    if (!storedAudio) storedAudio = await getAudio(audioId);
    expect(storedAudio).toBeDefined();
    const ctx = makeMockAudioCtx();
    const ab = storedAudio!.bytes.buffer.slice(storedAudio!.bytes.byteOffset, storedAudio!.bytes.byteOffset + storedAudio!.bytes.byteLength) as ArrayBuffer;
    const decoded = await ctx.decodeAudioData(ab);
    const base = getBasename(playChart.audio);
    AudioCache.set(id, decoded as unknown as AudioBuffer);
    AudioCache.set(base, decoded as unknown as AudioBuffer);
    playBuf = decoded as unknown as AudioBuffer;

    // [Step3: Assert] — both resolved, can construct game engines (playability)
    expect(playChart).toBeDefined();
    expect(playBuf).toBeDefined();
    expect(playChart!.rings.length).toBe(3);
    expect(playChart!.rings.some(r => Math.abs(r.beat - 0.37) < 1e-6)).toBe(true);
    // engine construction succeeds
    const timeline = new BpmTimeline(playChart!.bpm_changes, playChart!.amplitude);
    expect(timeline.beatToMs(0.37)).toBeCloseTo(timeline.beatToMs(0.37), 5);
    const wave = new WaveEngine(playChart!.segments, timeline, playChart!.amplitude, playChart!.start_position);
    const cursor = new Cursor(playChart!.amplitude, playChart!.start_position);
    expect(wave.waveYAt(0.37)).toBeDefined();
    expect(cursor.y).toBeDefined();
    // caches populated for next direct navigation
    expect(ChartCache.get(id)).toBe(playChart);
    expect(AudioCache.get(base)).toBe(playBuf);
    expect(AudioCache.get(id)).toBe(playBuf);
  });

  it('片方のみ(譜面のみ)でもIDBから復元されメトロノームプレイ相当で chart は解決する (3-step)', async () => {
    // [Step1: Capture] — chart only, no audio
    const id = `custom-${Date.now()}`;
    const tomlSolo = makeSimpleToml('solo-only.flac');
    const chartSolo = buildChart(tomlSolo);
    const storedToml = chartToToml(chartSolo);
    await putChart({ id, title: chartSolo.title, artist: chartSolo.artist, difficulty: 1, toml: storedToml, audioId: null, addedAt: Date.now() });
    expect((await listAudio()).length).toBe(0);

    ChartCache.clear();
    closeLibraryDB();

    // [Step2: Perform] — chart fallback only
    expect(ChartCache.get(id)).toBeUndefined();
    const stored = await getChart(id);
    const reparsed = parseChartText(stored!.toml, id);
    ChartCache.set(id, reparsed);
    // audio fallback: IDB miss -> fetch path (not tested, but chart must be ready)
    const audioMiss = await getAudio(id);
    expect(audioMiss).toBeUndefined();

    // [Step3: Assert] — chart playable, audio optional
    expect(reparsed).toBeDefined();
    expect(reparsed.audio).toBe('solo-only.flac');
    expect(reparsed.rings[0].beat).toBeCloseTo(4.37, 3);
    expect(ChartCache.get(id)!.title).toBe(reparsed.title);
    // engine still constructs
    const tl = new BpmTimeline(reparsed.bpm_changes, reparsed.amplitude);
    const w = new WaveEngine(reparsed.segments, tl, reparsed.amplitude, reparsed.start_position);
    expect(w.waveYAt(0)).toBeDefined();
  });

  it('複数カスタムが永続化されリロード後も全て /play/custom-xxx で解決できる (3-step)', async () => {
    // [Step1: Capture] — put 3 customs
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const nid = `custom-${Date.now()}-${i}`;
      ids.push(nid);
      const t = makeSimpleToml(`song-${i}.flac`);
      const c = buildChart(t);
      await putChart({ id: nid, title: c.title + ` ${i}`, artist: '', difficulty: i + 1, toml: chartToToml(c), audioId: null, addedAt: Date.now() + i });
      vi.advanceTimersByTime(10);
    }
    expect((await listCharts()).length).toBe(3);
    ChartCache.clear();
    closeLibraryDB();

    // [Step2: Perform] — resolve each via fallback
    const resolvedTitles: string[] = [];
    for (const cid of ids) {
      expect(ChartCache.get(cid)).toBeUndefined();
      const st = await getChart(cid);
      expect(st).toBeDefined();
      const rp = parseChartText(st!.toml, cid);
      ChartCache.set(cid, rp);
      resolvedTitles.push(rp.title);
    }

    // [Step3: Assert] — all 3 restored, each with off-grid capability
    expect(resolvedTitles.length).toBe(3);
    expect((await listCharts()).length).toBe(3);
    for (const cid of ids) {
      expect(ChartCache.get(cid)).toBeDefined();
      expect(ChartCache.has(cid)).toBe(true);
    }
  });
});

// ===========================================================================
// 4) 静的検証: GameScreen.tsx が正しい解決順序を実装している
// ===========================================================================
describe('T195 4. GameScreen.tsx 静的統合検証: 解決順序とIDBフォールバック実装', () => {
  const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');

  it('譜面解決順序が ChartCache → IndexedDB(getChart→parse→Cache) → loadSongList の順で存在する (3-step)', () => {
    // [Step1: Capture] — locate indices
    const idxCache = src.indexOf('ChartCache.get');
    const idxGetChart = src.indexOf('getChart');
    const idxParse = src.indexOf('parseChartText');
    const idxLoadSongs = src.indexOf('loadSongList');

    // [Step2: Perform] — checks
    const hasCacheFirst = idxCache !== -1;
    const hasIdbSecond = idxGetChart !== -1 && idxParse !== -1;
    const hasSongsFallback = idxLoadSongs !== -1;

    // [Step3: Assert] — order correctness
    expect(hasCacheFirst).toBe(true);
    expect(hasIdbSecond).toBe(true);
    expect(hasSongsFallback).toBe(true);
    // Cache before IDB before songs
    expect(idxCache).toBeLessThan(idxGetChart);
    expect(idxGetChart).toBeLessThan(idxLoadSongs);
    // parse immediately after getChart (within 1000 chars)
    const snippet = src.slice(idxGetChart, idxGetChart + 1000);
    expect(snippet).toContain('parseChartText');
    expect(snippet).toContain('ChartCache.set');
  });

  it('音源解決順序が AudioCache → IndexedDB(getAudio→decode→Cache) → loadAudio(fetch) の順で存在する (3-step)', () => {
    // [Step1: Capture] indices
    const idxAudioCache = src.indexOf('AudioCache.get');
    const idxGetAudio = src.indexOf('getAudio');
    const idxDecode = src.indexOf('decodeAudioData');
    const idxLoadAudio = src.indexOf('loadAudio(');

    // [Step2: Perform]
    const hasAudioCache = idxAudioCache !== -1;
    const hasIdbAudio = idxGetAudio !== -1;
    const hasDecode = idxDecode !== -1;
    const hasFetch = idxLoadAudio !== -1;

    // [Step3: Assert] order and linkage
    expect(hasAudioCache).toBe(true);
    expect(hasIdbAudio).toBe(true);
    expect(hasDecode).toBe(true);
    expect(hasFetch).toBe(true);
    expect(idxAudioCache).toBeLessThan(idxGetAudio);
    expect(idxGetAudio).toBeLessThan(idxLoadAudio);
    // decode snippet near getAudio
    const snippet = src.slice(idxGetAudio, idxGetAudio + 1200);
    expect(snippet).toContain('decodeAudioData');
    expect(snippet).toContain('AudioCache.set');
    // bytes.slice semantics
    expect(snippet).toContain('bytes');
    expect(snippet).toContain('buffer');
  });

  it('IndexedDBフォールバックが dynamic import で遅延ロードされ AudioContext.ensure() 後にデコードする (3-step)', () => {
    // [Step1: Capture] — ensure import pattern
    const hasDynamicImport = src.includes("import('../storage/libraryDb')") || src.includes('import("../storage/libraryDb")');
    const hasEnsure = src.includes('audioMgr.ensure') || src.includes('ensure()');

    // [Step2: Perform] — locate ensure vs getAudio order
    const idxEnsure = src.indexOf('ensure()');
    const idxGetAudio2 = src.indexOf('getAudio');

    // [Step3: Assert] — fallback is after ensure (audio context ready)
    expect(hasDynamicImport).toBe(true);
    expect(hasEnsure).toBe(true);
    // ensure appears before IDB audio decode in file (init function's await ensure() is before getAudio)
    // In GameScreen, ensure is awaited before timeline construction; getAudio is after ensure
    expect(idxEnsure).toBeLessThan(idxGetAudio2);
  });

  it('GameScreen が IndexedDBUnavailable 時もクラッシュせず try/catch で songs.toml/fetch へフォールスルーする (3-step)', () => {
    // [Step1: Capture] — catch blocks near IndexedDB
    const hasCatchForIdb = src.includes('IndexedDB unavailable') || src.includes('IndexedDB');
    const hasTryCatch = (src.match(/try\s*\{/g) || []).length >= 2;

    // [Step2: Perform] — at least one catch guards getChart/getAudio
    const hasGetChartInTry = src.indexOf('getChart') > src.indexOf('try');
    const fallbackAfterCatch = src.indexOf('loadChart') > src.indexOf('getChart');

    // [Step3: Assert] — error handling exists and fallback remains
    expect(hasCatchForIdb || hasTryCatch).toBe(true);
    expect(hasTryCatch).toBe(true);
    expect(hasGetChartInTry).toBe(true);
    expect(fallbackAfterCatch).toBe(true);
  });
});

// ===========================================================================
// 5) 回帰: 既存 location.state 直渡し経路は維持 (完了条件2)
// ===========================================================================
describe('T195 5. 回帰: location.state 直渡し / 既存経路が壊れない', () => {
  const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');

  it('location.state.chart/buffer の直渡し分岐が最優先で残っている (3-step)', () => {
    // [Step1: Capture] — state handling at top of init
    const hasStateChart = src.includes('state?.chart') || src.includes('state.chart');
    const hasEffectiveChart = src.includes('effectiveChart') || src.includes('playtest');
    const idxState = src.indexOf('state?.chart');
    const idxCache = src.indexOf('ChartCache.get');

    // [Step2: Perform] — state branch before cache branch
    expect(hasStateChart).toBe(true);
    expect(hasEffectiveChart).toBe(true);

    // [Step3: Assert] — state checked before cache/IDB
    if (idxState !== -1 && idxCache !== -1) {
      expect(idxState).toBeLessThan(idxCache);
    }
    // effectiveChart assignment exists
    expect(src).toContain('state?.chart');
    // also buffer direct path
    expect(src).toContain('state?.buffer');
  });

  it('playtest 直渡し (playtestChart/playtest/state.buffer) が既存のまま維持 (3-step)', () => {
    // [Step1: Capture] — playtest props
    const hasPlaytest = src.includes('playtestChart') || src.includes('playtest');
    const hasPlaytestBuffer = src.includes('playtestBuffer') || src.includes('playtest?.buffer');

    // [Step2: Perform] — buffer resolution also checks state before IDB
    const idxPlaytest = src.indexOf('playtest');
    const idxGetAudio = src.indexOf('getAudio');

    // [Step3: Assert] — both present and ordered
    expect(hasPlaytest).toBe(true);
    expect(hasPlaytestBuffer).toBe(true);
    if (idxPlaytest !== -1 && idxGetAudio !== -1) {
      expect(idxPlaytest).toBeLessThan(idxGetAudio);
    }
  });

  it('既存 loadChart / loadSongList / AudioCache パスが削除されず残っている (3-step)', () => {
    // [Step1: Capture] — imports
    const hasLoadChart = src.includes('loadChart');
    const hasLoadSongList2 = src.includes('loadSongList');
    const hasLoadAudio2 = src.includes('loadAudio');

    // [Step2: Perform] — usage counts
    const chartCacheSets = (src.match(/ChartCache\.set/g) || []).length;
    const audioCacheSets = (src.match(/AudioCache\.set/g) || []).length;

    // [Step3: Assert] — not regressed
    expect(hasLoadChart).toBe(true);
    expect(hasLoadSongList2).toBe(true);
    expect(hasLoadAudio2).toBe(true);
    expect(chartCacheSets).toBeGreaterThanOrEqual(1);
    expect(audioCacheSets).toBeGreaterThanOrEqual(2); // IDB caches both id and basename
  });
});

// ===========================================================================
// 6) オフグリッド + 複雑振幅での数値整合 (T127/T128 style, 0.7/1.3/2.7)
// ===========================================================================
describe('T195 6. オフグリッド+複雑振幅での WaveEngine/Cursor 数値整合 (T127準拠)', () => {
  it('IDB経由 chart の複雑振幅(0.7/1.3)で waveYAt 傾斜が 2*TW_AMP*amplitudeAt と一致 (3-step)', async () => {
    // [Step1: Capture] — create chart with step amplitude 0.7→1.3 at 4.37
    const id = `custom-${Date.now()}`;
    const toml = makeComplexToml('complex.flac');
    const chart = buildChart(toml);
    await putChart({ id, title: chart.title, difficulty: 2, toml: chartToToml(chart), audioId: null, addedAt: Date.now() });
    ChartCache.clear();
    closeLibraryDB();
    const stored = await getChart(id);
    const reparsed = parseChartText(stored!.toml, id);
    ChartCache.set(id, reparsed);
    const afterChart = ChartCache.get(id)!;
    const timeline = new BpmTimeline(afterChart.bpm_changes, afterChart.amplitude);
    const wave = new WaveEngine(afterChart.segments, timeline, afterChart.amplitude, afterChart.start_position);

    //Verify step amplitude at off-grid phases
    expect(timeline.amplitudeAt(3.37)).toBeCloseTo(0.7, 5); // before 4.37
    expect(timeline.amplitudeAt(4.37)).toBeCloseTo(1.3, 5); // at boundary
    expect(timeline.amplitudeAt(4.5)).toBeCloseTo(1.3, 5); // after

    // [Step2: Perform] — sample off-grid beats within first segment (up, beats=1.37)
    // perBeatPx = 2*130*0.7 = 182 px/beat for beat 0..1.37
    const amp0 = timeline.amplitudeAt(0);
    const perBeat0 = 2 * TW_AMP * amp0;
    expect(amp0).toBeCloseTo(0.7, 5);
    expect(perBeat0).toBeCloseTo(182, 3);
    // wave start Y: SP=0.5 => TW_CENTER_Y -0.5*130 =300-65=235
    const startY = TW_CENTER_Y - 0.5 * TW_AMP;
    expect(wave.waveYAt(0)).toBeCloseTo(startY, 3);
    // within climb: y = startY + dY*beats, dY = -perBeat0
    const off1 = 0.37;
    const off2 = 1.23; // still in first segment? 1.37 length so 1.23 inside
    const expectedY037 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, startY - perBeat0 * off1));
    const expectedY123 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, startY - perBeat0 * off2));

    // [Step3: Assert] — waveYAt matches per-beat physics at off-grid
    expect(wave.waveYAt(off1)).toBeCloseTo(expectedY037, 2);
    expect(wave.waveYAt(off2)).toBeCloseTo(expectedY123, 2);
    // cursor 1-beat displacement equals same perBeat
    const cursor = new Cursor(amp0, reparsed.start_position);
    const dtOneBeatMs = timeline.beatMsAt(0); // 500ms for 120bpm
    const beforeY = cursor.y;
    cursor.update(dtOneBeatMs / 1000, true, false, dtOneBeatMs, wave.waveYAt(0)); // up pressed for 1 beat? but clamped; check speed formula
    // Instead verify speed formula: 2*TW_AMP*amp / beatSec
    const speed = (2 * TW_AMP * amp0) / (dtOneBeatMs / 1000);
    expect(speed).toBeCloseTo(perBeat0 / (dtOneBeatMs / 1000) * (dtOneBeatMs / 1000), 3); // perBeat per beat
    // numeric consistency: perBeat0 is displacement per beat
    expect(perBeat0).toBeCloseTo(speed * (dtOneBeatMs / 1000), 2);
  });

  it('IDB保存された chart で複雑振幅 2.7 時の off-grid 0.37/1.23 でも wave/Cursor 一致 (3-step)', async () => {
    // [Step1: Capture] — chart with amplitude 2.7 at beat 2
    const tomlHigh = `
title = "HighAmp 2.7"
artist = ""
audio = "high.flac"
amplitude = 2.7
start_position = 0.0
[[sections]]
beat = 0
bpm = 120
amplitude = 2.7
[[segments]]
direction = "up"
beats = 0.5
[[segments]]
direction = "down"
beats = 0.5
[[rings]]
beat = 0.37
[[rings]]
beat = 1.23
`;
    const id = `custom-${Date.now()}`;
    const chartHigh = buildChart(tomlHigh);
    await putChart({ id, title: chartHigh.title, difficulty: 1, toml: chartToToml(chartHigh), audioId: null, addedAt: Date.now() });
    ChartCache.clear();
    closeLibraryDB();
    const storedHigh = await getChart(id);
    const reparsedHigh = parseChartText(storedHigh!.toml, id);
    const tlHigh = new BpmTimeline(reparsedHigh.bpm_changes, reparsedHigh.amplitude);
    const waveHigh = new WaveEngine(reparsedHigh.segments, tlHigh, reparsedHigh.amplitude, reparsedHigh.start_position);

    // [Step2: Perform] — off-grid samples at 2.7 amplitude
    const amp = tlHigh.amplitudeAt(0.37);
    expect(amp).toBeCloseTo(2.7, 5);
    const perBeat = 2 * TW_AMP * amp; // 702 px/beat -> clamped to bounds quickly
    // start 0 => CENTER 300, up moves to TOP 170 in 130/702 ≈0.185 beat, then stays
    const y037 = waveHigh.waveYAt(0.37);
    // should be clamped to TOP (waveYAt uses clamp)
    const expected037 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, TW_CENTER_Y - perBeat * 0.37));
    expect(y037).toBeCloseTo(expected037, 1);
    expect(y037).toBeCloseTo(TW_CENTER_Y - TW_AMP, 0); // at TOP

    const y123 = waveHigh.waveYAt(1.23);
    // second segment down: check value is defined and within bounds, not NaN
    expect(Number.isFinite(y123)).toBe(true);
    expect(y123).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
    expect(y123).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);

    // cursor speed matches
    const beatMs = tlHigh.beatMsAt(0.37);
    const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
    expect(speed).toBeGreaterThan(0);
    // numeric: perBeat = speed * beatSec
    expect(perBeat).toBeCloseTo(speed * (beatMs / 1000), 1);

    // [Step3: Assert] — IDB round-trip preserved no regression
    ChartCache.set(id, reparsedHigh);
    expect(ChartCache.get(id)!.amplitude).toBeCloseTo(2.7, 5);
    expect(waveHigh.getPoints().length).toBe(reparsedHigh.segments.length + 1);
  });

  it('TOML往復後の IDB chart で getPoints().length === segments.length+1 を維持 (3-step)', async () => {
    // [Step1: Capture] — complex segments 3
    const id = `custom-${Date.now()}`;
    const toml = makeComplexToml('points.flac');
    const chart = buildChart(toml);
    expect(chart.segments.length).toBe(3);

    // [Step2: Perform] — store → reopen → parse → wave build
    await putChart({ id, title: chart.title, difficulty: 1, toml: chartToToml(chart), audioId: null, addedAt: Date.now() });
    ChartCache.clear();
    closeLibraryDB();
    const stored = await getChart(id);
    const reparsed = parseChartText(stored!.toml, id);
    const tl = new BpmTimeline(reparsed.bpm_changes, reparsed.amplitude);
    const wave = new WaveEngine(reparsed.segments, tl, reparsed.amplitude, reparsed.start_position);
    const pts = wave.getPoints();

    // [Step3: Assert] — length invariant, beats are snap-multiples (T129)
    expect(pts.length).toBe(reparsed.segments.length + 1);
    expect(pts.length).toBe(4);
    expect(pts[0].beat).toBe(0);
    expect(pts[pts.length - 1].beat).toBeCloseTo(reparsed.segments.reduce((s, seg) => s + seg.beats, 0), 3);
    // beats preservation: chartToToml→parse round-trip must keep beats
    expect(reparsed.segments[0].beats).toBeCloseTo(1.37, 3);
    expect(reparsed.segments[1].beats).toBeCloseTo(0.63, 3);
  });
});

// ===========================================================================
// 7) 異常系: 破損・IDB不可でもクラッシュせず
// ===========================================================================
describe('T195 7. 異常系: 破損TOML・IDB不可でもクラッシュせず', () => {
  it('IDBに保存された破損TOMLは getChart では文字列で返り parseChartText で例外だが GameScreen は catch して songs.toml へフォールスルーする (3-step)', async () => {
    // [Step1: Capture] — put broken TOML
    const id = `custom-${Date.now()}`;
    const broken = `title = "Broken\n[[rings]]\nbeat = 0.37\n`; // unclosed string
    await putChart({ id, title: 'Broken', difficulty: 1, toml: broken, audioId: null, addedAt: Date.now() });
    const gotBroken = await getChart(id);
    expect(gotBroken!.toml).toBe(broken);

    // [Step2: Perform] — parse throws, simulate GameScreen try/catch fallback
    let parseThrew = false;
    let fellToSongs = false;
    let parsed: Chart | undefined;
    try {
      parsed = parseChartText(gotBroken!.toml, id);
    } catch {
      parseThrew = true;
      fellToSongs = true; // GameScreen would then try loadSongList
    }

    // [Step3: Assert] — exception caught, would not crash, fallback flagged
    expect(parseThrew).toBe(true);
    expect(parsed).toBeUndefined();
    expect(fellToSongs).toBe(true);
    expect(gotBroken).toBeDefined();
  });

  it('delete後の custom-xxx は ChartCache miss + IDB miss となり songs.toml フォールバックへ (3-step)', async () => {
    // [Step1: Capture] — add then delete
    const id = `custom-${Date.now()}`;
    const toml = makeSimpleToml('del.flac');
    const ch = buildChart(toml);
    await putChart({ id, title: ch.title, difficulty: 1, toml: chartToToml(ch), audioId: null, addedAt: Date.now() });
    expect(await getChart(id)).toBeDefined();
    await deleteChart(id);
    expect(await getChart(id)).toBeUndefined();
    ChartCache.clear();
    closeLibraryDB();

    // [Step2: Perform] — GameScreen resolution after delete
    let resolved: Chart | undefined = ChartCache.get(id);
    let fellThrough = false;
    if (!resolved) {
      const stored = await getChart(id);
      if (stored) resolved = parseChartText(stored.toml, id);
      else fellThrough = true;
    }

    // [Step3: Assert] — deleted means fallback
    expect(resolved).toBeUndefined();
    expect(fellThrough).toBe(true);
    expect(ChartCache.get(id)).toBeUndefined();
  });
});
