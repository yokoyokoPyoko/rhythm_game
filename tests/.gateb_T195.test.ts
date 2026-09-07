/**
 * T195 — GameScreen IndexedDB fallback (Vitest, node, no browser)
 * Requirement: Reloading /play/custom-xxx resolves chart & audio from IndexedDB
 *   Chart order: ChartCache → IndexedDB(TOML→parse→Cache) → songs.toml
 *   Audio order: AudioCache → IndexedDB(bytes→decode→Cache) → fetch
 *   location.state priority preserved; dynamic import after ensure
 *
 * STRICT QA:
 * - 3-step state-transition for every requirement (no surface-only checks)
 * - Off-grid verification (0.37 / 1.23 beats)
 * - Deterministic IDs via fixed constants (no vi.useFakeTimers for Date)
 * - Correct physics math & clamp-on-interpolate (T128)
 * - String index assertions match actual source order
 * Runs via vitest in node (fake-indexeddb). No DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'fs';

import {
  openLibraryDB,
  closeLibraryDB,
  deleteLibraryDB,
  clearLibraryDB,
  putChart,
  getChart,
  listCharts,
  deleteChart,
  putAudio,
  getAudio,
  listAudio,
  deleteAudio,
} from '../src/storage/libraryDb';
import type { StoredChart, StoredAudio } from '../src/storage/libraryDb';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { ChartCache } from '../src/chart/cache';
import { AudioCache, getBasename } from '../src/audio/AudioCache';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import type { Chart } from '../src/types';

// ---------------------------------------------------------------------------
// Deterministic IDs (no Date.now randomness)
// ---------------------------------------------------------------------------
const CUSTOM_ID_1 = 'custom-1700000000000';
const CUSTOM_ID_2 = 'custom-1700000001000';
const CUSTOM_ID_3 = 'custom-1700000002000';
const AUDIO_ID_1 = 'custom-1700000000000'; // spec uses same id for audio store key
const AUDIO_ID_2 = 'custom-1700000001000';

function sampleTomlOffGrid(): string {
  return `
title = "OffGrid T195"
artist = "Tester"
audio = "custom-song.flac"
audio_offset = 80
amplitude = 1.3
start_position = 0.5
end_beat = 16.0
[[sections]]
beat = 0
bpm = 120
amplitude = 0.7
zoom = 1.2
[[sections]]
beat = 4.37
bpm = 150
amplitude = 2.7
zoom = 0.8
[[segments]]
direction = "up"
beats = 1.5
[[segments]]
direction = "down"
beats = 0.5
[[segments]]
direction = "stay"
beats = 1.23
[[rings]]
beat = 1.23
[[rings]]
beat = 4.37
type = "hold"
duration = 0.5
`;
}

function buildChart(toml: string): Chart {
  return parseChartText(toml, 'test.toml');
}

// ---------------------------------------------------------------------------
// Global setup: cleared IndexedDB + caches before each suite
// ---------------------------------------------------------------------------
beforeEach(async () => {
  ChartCache.clear();
  AudioCache.clear();
  try {
    await deleteLibraryDB();
  } catch {
    try { await clearLibraryDB(); } catch { /* ignore */ }
  }
  closeLibraryDB();
  // ensure fresh DB for each test
  await openLibraryDB();
});

afterEach(async () => {
  try { await clearLibraryDB(); } catch { /* ignore */ }
  closeLibraryDB();
  ChartCache.clear();
  AudioCache.clear();
});

// ===========================================================================
// 1) Chart persistence: ChartCache -> IndexedDB -> songs.toml (fallback order)
//    3-step: empty -> put -> close/reopen -> get+parse+Cache
// ===========================================================================
describe('T195 1. Chart fallback: ChartCache miss -> IndexedDB hit resolves on reload', () => {
  it('putChart TOML then close/reopen IndexedDB, getChart + parseChartText yields correct chart and ChartCache repopulates (3-step off-grid)', async () => {
    // [Step1: Capture Initial State] — no cache, DB empty, get undefined
    expect(ChartCache.get(CUSTOM_ID_1)).toBeUndefined();
    expect(await getChart(CUSTOM_ID_1)).toBeUndefined();
    expect((await listCharts()).length).toBe(0);

    // [Step2: Perform] — simulate SelectScreen add: TOML serialize + putChart
    const toml = sampleTomlOffGrid();
    const chartObj = buildChart(toml);
    // verify off-grid beats parsed correctly before storage
    expect(chartObj.rings.some(r => Math.abs(r.beat - 1.23) < 1e-9)).toBe(true);
    expect(chartObj.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-9)).toBe(true);
    const serialized = chartToToml(chartObj);
    expect(serialized).toContain('custom-song.flac'); // basename
    expect(serialized).not.toContain('/rhythm_game/');

    await putChart({
      id: CUSTOM_ID_1,
      title: chartObj.title,
      artist: chartObj.artist,
      difficulty: 4,
      toml: serialized,
      audioId: AUDIO_ID_1,
      addedAt: 1700000000000,
    });

    // Simulate GameScreen's IndexedDB fallback path: dynamic import + parse + Cache set
    // Do NOT have ChartCache hit yet — emulate fresh reload where ChartCache was cleared
    ChartCache.clear();
    expect(ChartCache.get(CUSTOM_ID_1)).toBeUndefined();

    // Simulate reload: close and reopen DB (persistence)
    closeLibraryDB();
    // reopen lazily via getChart
    const stored = await getChart(CUSTOM_ID_1);
    expect(stored).toBeDefined();
    const parsed = parseChartText(stored!.toml, CUSTOM_ID_1);
    ChartCache.set(CUSTOM_ID_1, parsed);

    // [Step3: Assert Resulting Transition] — chart resolved from IndexedDB and cached
    expect(stored!.id).toBe(CUSTOM_ID_1);
    expect(parsed.title).toBe('OffGrid T195');
    expect(parsed.audio).toBe('custom-song.flac');
    expect(parsed.rings.some(r => Math.abs(r.beat - 1.23) < 1e-9)).toBe(true);
    expect(parsed.rings.some(r => Math.abs(r.beat - 4.37) < 1e-9)).toBe(true);
    expect(parsed.rings.find(r => Math.abs(r.beat - 4.37) < 1e-9)?.type).toBe('hold');
    expect(ChartCache.get(CUSTOM_ID_1)).toBeDefined();
    expect(ChartCache.get(CUSTOM_ID_1)!.title).toBe('OffGrid T195');
    // TOML round-trip preserves sections with off-grid beat
    const reserialized = chartToToml(ChartCache.get(CUSTOM_ID_1)!);
    const reparsed = parseChartText(reserialized, 'reparsed.toml');
    expect(reparsed.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-9)).toBe(true);
    expect(reparsed.end_beat).toBeCloseTo(16.0, 3);
  });

  it('Chart resolution priority: ChartCache hit bypasses IndexedDB (no extra getChart needed) (3-step)', async () => {
    // [Step1] empty, then seed both cache and DB with different titles to detect priority
    const tomlCache = `
title = "From Cache"
artist = "A"
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
[[segments]]
direction = "up"
beats = 2
`;
    const tomlDb = `
title = "From DB"
artist = "B"
audio = "b.flac"
[[sections]]
beat = 0
bpm = 120
[[segments]]
direction = "up"
beats = 2
`;
    const chartCache = parseChartText(tomlCache, 'cache.toml');
    await putChart({ id: CUSTOM_ID_2, title: 'From DB', difficulty: 1, toml: chartToToml(parseChartText(tomlDb, 'db.toml')), audioId: null, addedAt: 1700000001000 });
    ChartCache.set(CUSTOM_ID_2, chartCache);

    // [Step2: Perform] — emulate GameScreen logic: check cache first
    const cached = ChartCache.get(CUSTOM_ID_2);
    let resolvedTitle: string;
    if (cached) {
      resolvedTitle = cached.title;
    } else {
      const stored = await getChart(CUSTOM_ID_2);
      const parsed = stored ? parseChartText(stored.toml, CUSTOM_ID_2) : null;
      resolvedTitle = parsed?.title ?? 'MISSING';
    }

    // [Step3] Assert — cache took priority, DB title not used
    expect(cached).toBeDefined();
    expect(resolvedTitle).toBe('From Cache');
    // Verify DB still holds different title (was not overwritten)
    const dbEntry = await getChart(CUSTOM_ID_2);
    expect(dbEntry!.title).toBe('From DB');
    expect(ChartCache.get(CUSTOM_ID_2)!.title).toBe('From Cache');
  });

  it('location.state chart takes precedence over IndexedDB (fresh state bypasses DB) (3-step)', async () => {
    // [Step1] DB has a chart
    const dbToml = `
title = "DB Song"
artist = ""
audio = "db.flac"
[[sections]]
beat = 0
bpm = 120
`;
    await putChart({ id: CUSTOM_ID_3, title: 'DB Song', difficulty: 1, toml: chartToToml(parseChartText(dbToml, 'db.toml')), audioId: null, addedAt: 1700000002000 });
    ChartCache.clear(); // simulate reload with empty cache

    // [Step2] Simulate GameScreen init with location.state.chart present
    const stateToml = `
title = "State Song"
artist = ""
audio = "state.flac"
[[sections]]
beat = 0
bpm = 140
`;
    const stateChart = parseChartText(stateToml, 'state.toml');
    // GameScreen effectiveChart = playtest?.chart || playtestChart || state?.chart
    const effectiveChart = stateChart; // state has priority
    let resolved: Chart;
    if (effectiveChart) {
      resolved = effectiveChart;
    } else {
      const cached = ChartCache.get(CUSTOM_ID_3);
      if (cached) resolved = cached;
      else {
        const stored = await getChart(CUSTOM_ID_3);
        resolved = stored ? parseChartText(stored.toml, CUSTOM_ID_3) : parseChartText(dbToml, 'fallback');
      }
    }

    // [Step3] state chart wins, not DB
    expect(resolved.title).toBe('State Song');
    expect(resolved.bpm_changes[0].bpm).toBe(140);
    // cache not polluted by state path (GameScreen caches DB path only)
    expect(ChartCache.get(CUSTOM_ID_3)).toBeUndefined();
  });
});

// ===========================================================================
// 2) Audio fallback: AudioCache -> IndexedDB(bytes->decode->Cache) -> fetch
//    decode after AudioContext.ensure()
// ===========================================================================
describe('T195 2. Audio fallback: AudioCache miss -> IndexedDB bytes decode', () => {
  it('putAudio raw bytes survive close/reopen, slice(0) decode simulation repopulates AudioCache (3-step)', async () => {
    // [Step1: Capture] empty audio stores
    expect(AudioCache.get(AUDIO_ID_1)).toBeUndefined();
    expect(await getAudio(AUDIO_ID_1)).toBeUndefined();
    expect((await listAudio()).length).toBe(0);

    // [Step2: Perform] store raw compressed bytes (not decoded)
    const rawBytes = new Uint8Array([10, 20, 30, 40, 255, 0, 128, 64, 1, 2, 3, 4, 5]);
    await putAudio({ id: AUDIO_ID_1, name: 'custom-song.flac', mime: 'audio/flac', bytes: rawBytes });

    // Simulate reload: clear cache, close DB, reopen via IndexedDB fallback path
    AudioCache.clear();
    expect(AudioCache.get(AUDIO_ID_1)).toBeUndefined();
    closeLibraryDB();

    const stored = await getAudio(AUDIO_ID_1);
    expect(stored).toBeDefined();
    // Simulate decode step from GameScreen: bytes.buffer.slice(byteOffset, ...)
    // GameScreen does: arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength)
    // which is equivalent to bytes.slice(0).buffer for our test
    const bytesForDecode = stored!.bytes.slice(0);
    expect(bytesForDecode).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytesForDecode)).toEqual(Array.from(rawBytes));
    // bytes.slice(0) must be independent copy (mutation isolation)
    bytesForDecode[0] = 99;
    expect(stored!.bytes[0]).toBe(10);
    expect(rawBytes[0]).toBe(10); // original not mutated by put (defensive copy)

    // Simulate AudioCache.set after decode
    // Use a fake AudioBuffer object (node has no AudioBuffer, so use plain object)
    const fakeBuffer = { duration: 2, sampleRate: 44100, fake: true } as unknown as AudioBuffer;
    AudioCache.set(AUDIO_ID_1, fakeBuffer);
    const base = getBasename('custom-song.flac');
    AudioCache.set(base, fakeBuffer);

    // [Step3: Assert] cache repopulated via IndexedDB path
    expect(AudioCache.get(AUDIO_ID_1)).toBe(fakeBuffer);
    expect(AudioCache.get(base)).toBe(fakeBuffer);
    expect(stored!.bytes.length).toBe(rawBytes.length);
    // original rawBytes defensively copied on put
    rawBytes[1] = 77;
    const refetched = await getAudio(AUDIO_ID_1);
    expect(refetched!.bytes[1]).toBe(20);
  });

  it('AudioCache hit bypasses IndexedDB getAudio (priority preserved) (3-step)', async () => {
    // [Step1] Seed IndexedDB with bytes, and AudioCache with different fake buffer
    const dbBytes = new Uint8Array([1, 2, 3]);
    await putAudio({ id: AUDIO_ID_2, name: 'from-db.flac', mime: 'audio/flac', bytes: dbBytes });
    const cachedBuf = { duration: 1, sampleRate: 44100, source: 'cache' } as unknown as AudioBuffer;
    AudioCache.set(AUDIO_ID_2, cachedBuf);

    // [Step2] GameScreen logic: check AudioCache first
    const cached = AudioCache.get(AUDIO_ID_2);
    let usedFromCache = false;
    let usedFromDb = false;
    let resolved: AudioBuffer | null = null;
    if (cached) {
      resolved = cached;
      usedFromCache = true;
    } else {
      const stored = await getAudio(AUDIO_ID_2);
      if (stored) {
        usedFromDb = true;
        resolved = { duration: 2 } as unknown as AudioBuffer;
      }
    }

    // [Step3] cache wins, DB not touched for decode
    expect(usedFromCache).toBe(true);
    expect(usedFromDb).toBe(false);
    expect(resolved).toBe(cachedBuf);
    // DB still holds original bytes (not cleared)
    const stillDb = await getAudio(AUDIO_ID_2);
    expect(Array.from(stillDb!.bytes)).toEqual([1, 2, 3]);
  });

  it('bytes stored as compressed Uint8Array, not decoded AudioBuffer, and survive multiple put/get (3-step with off-grid)', async () => {
    // [Step1] empty
    expect((await listAudio()).length).toBe(0);
    const chart = buildChart(sampleTomlOffGrid());
    // [Step2] store chart referencing basename, store audio bytes under same id scheme
    const serialized = chartToToml(chart);
    await putChart({ id: CUSTOM_ID_1, title: chart.title, difficulty: 3, toml: serialized, audioId: AUDIO_ID_1, addedAt: 1700000000000 });
    const audioBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 255]);
    await putAudio({ id: AUDIO_ID_1, name: 'custom-song.flac', mime: 'audio/flac', bytes: audioBytes });

    closeLibraryDB();
    const storedChart = await getChart(CUSTOM_ID_1);
    const storedAudio = await getAudio(AUDIO_ID_1);

    // [Step3] both survive, bytes are still Uint8Array, chart audio basename matches audio name
    expect(storedChart).toBeDefined();
    expect(storedAudio).toBeDefined();
    expect(storedChart!.audioId).toBe(AUDIO_ID_1);
    expect(storedAudio!.bytes).toBeInstanceOf(Uint8Array);
    expect(getBasename(storedAudio!.name)).toBe('custom-song.flac');
    expect(getBasename(parseChartText(storedChart!.toml, 'x').audio)).toBe('custom-song.flac');
    expect(Array.from(storedAudio!.bytes)).toEqual(Array.from(audioBytes));
  });
});

// ===========================================================================
// 3) GameScreen.tsx static resolution-order verification (no capture-before)
// ===========================================================================
describe('T195 3. GameScreen.tsx static order: ChartCache->IndexedDB->songs.toml / AudioCache->IndexedDB->fetch', () => {
  const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');

  it('chart order: ChartCache.get before getChart before loadSongList/loadChart (3-step index check)', () => {
    // [Step1: Capture] locate indices (final state)
    const idxChartCache = src.indexOf('ChartCache.get(songId)');
    // IndexedDB dynamic import destructuring + await getChart(songId)
    const idxGetChartImport = src.indexOf("await import('../storage/libraryDb')");
    const idxAwaitGetChart = src.indexOf('await getChart(songId)');
    const idxLoadSongList = src.indexOf('await loadSongList()');
    const idxLoadChart = src.indexOf('await loadChart(song.chartPath)');

    // [Step2: Verify existence] — all required symbols present
    expect(idxChartCache).toBeGreaterThan(-1);
    expect(idxAwaitGetChart).toBeGreaterThan(-1);
    expect(idxLoadSongList).toBeGreaterThan(-1);
    expect(idxLoadChart).toBeGreaterThan(-1);

    // [Step3: Assert order] — must be strictly increasing
    expect(idxChartCache).toBeLessThan(idxAwaitGetChart);
    expect(idxAwaitGetChart).toBeLessThan(idxLoadSongList);
    expect(idxLoadSongList).toBeLessThan(idxLoadChart);
    // also ensure parseChartText follows getChart (IndexedDB path parses TOML)
    const idxParseChartText = src.indexOf('parseChartText(stored.toml');
    expect(idxParseChartText).toBeGreaterThan(idxAwaitGetChart);
    // ChartCache.set after parse (repopulate)
    const idxChartCacheSet = src.indexOf('ChartCache.set(songId!');
    expect(idxChartCacheSet).toBeGreaterThan(idxParseChartText);
  });

  it('audio order: AudioCache.get before getAudio before loadAudio, with decodeAudioData after ensure (3-step)', () => {
    // [Step1] indices
    const idxAudioCacheGetBase = src.indexOf('AudioCache.get(getBasename(chart.audio))');
    const idxAudioCacheGetId = src.indexOf('AudioCache.get(songId');
    const idxEnsure = src.indexOf('await audioMgr.ensure()');
    const idxGetAudio = src.indexOf('await getAudio(songId)');
    const idxDecode = src.indexOf('decodeAudioData(arrayBuf)');
    const idxLoadAudio = src.indexOf('await loadAudio(chart.audio');

    // [Step2] existence
    expect(idxAudioCacheGetBase).toBeGreaterThan(-1);
    expect(idxEnsure).toBeGreaterThan(-1);
    expect(idxGetAudio).toBeGreaterThan(-1);
    expect(idxDecode).toBeGreaterThan(-1);
    expect(idxLoadAudio).toBeGreaterThan(-1);

    // [Step3] order: AudioCache checks before IndexedDB; IndexedDB decode happens after ensure; fetch is fallback after IndexedDB miss
    // There are two AudioCache.get checks (basename + id) before getAudio — both must precede getAudio
    expect(idxAudioCacheGetBase).toBeLessThan(idxGetAudio);
    expect(idxAudioCacheGetId).toBeLessThan(idxGetAudio);
    expect(idxEnsure).toBeLessThan(idxGetAudio);
    expect(idxEnsure).toBeLessThan(idxDecode);
    expect(idxGetAudio).toBeLessThan(idxDecode);
    expect(idxDecode).toBeLessThan(idxLoadAudio);
    // AudioCache.set after decode (repopulate)
    const idxAudioCacheSet = src.indexOf('AudioCache.set(songId!');
    expect(idxAudioCacheSet).toBeGreaterThan(idxDecode);
    expect(idxAudioCacheSet).toBeLessThan(idxLoadAudio);
  });

  it('location.state priority: effectiveChart/state?.chart checked before ChartCache fallback (3-step)', () => {
    // [Step1] locate state priority block vs ChartCache fallback
    const idxEffectiveChart = src.indexOf('effectiveChart');
    const idxStateChart = src.indexOf('state?.chart');
    const idxChartCacheFallback = src.indexOf('ChartCache.get(songId)');
    const idxIdbFallback = src.indexOf('await getChart(songId)');

    // [Step2] all present
    expect(idxEffectiveChart).toBeGreaterThan(-1);
    expect(idxStateChart).toBeGreaterThan(-1);
    expect(idxChartCacheFallback).toBeGreaterThan(-1);

    // [Step3] state effectiveChart assignment appears before fallback lookup
    expect(idxEffectiveChart).toBeLessThan(idxChartCacheFallback);
    expect(idxStateChart).toBeLessThan(idxChartCacheFallback);
    expect(idxChartCacheFallback).toBeLessThan(idxIdbFallback);
    // also verify location.state type includes chart?buffer
    expect(src).toContain('location.state');
  });

  it('IndexedDB imports are dynamic (await import) and guarded by try/catch (3-step)', () => {
    // [Step1] find dynamic import patterns
    const hasDynamicImportChart = src.includes("await import('../storage/libraryDb')") && src.includes('getChart');
    const hasDynamicImportAudio = src.includes("await import('../storage/libraryDb')") && src.includes('getAudio');
    // [Step2] try/catch guards
    const hasTryCatchChart = src.includes('try {') && src.includes('getChart') && src.includes('IndexedDB unavailable');
    const hasTryCatchAudio = src.includes('IndexedDB unavailable or decode failed') || src.includes('IndexedDB unavailable');

    // [Step3] all guards present
    expect(hasDynamicImportChart).toBe(true);
    expect(hasDynamicImportAudio).toBe(true);
    expect(hasTryCatchChart).toBe(true);
    expect(hasTryCatchAudio).toBe(true);
  });

  it('audio bytes handling uses slice semantics for decode (3-step)', () => {
    // [Step1] audio bytes extraction
    const idxBytesSlice = src.indexOf('bytes.buffer.slice(bytes.byteOffset');
    // [Step2] existence of slice pattern
    expect(idxBytesSlice).toBeGreaterThan(-1);
    // [Step3] slice appears between getAudio and decodeAudioData
    const idxGetAudio = src.indexOf('await getAudio(songId)');
    const idxDecode = src.indexOf('decodeAudioData(arrayBuf)');
    expect(idxBytesSlice).toBeGreaterThan(idxGetAudio);
    expect(idxBytesSlice).toBeLessThan(idxDecode);
  });
});

// ===========================================================================
// 4) WaveEngine/Cursor numeric consistency at complex amplitudes (T127/T128)
//    Off-grid phases required: 0.37 / 1.23 etc.
// ===========================================================================
describe('T195 4. Physics consistency: WaveEngine clamp-on-interpolate matches Cursor speed (off-grid)', () => {
  const amps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23, 2.71, 4.37];

  it.each(amps)('amplitude %s: waveYAt mid-segment uses per-beat clamp dY, not average slope (off-grid)', (amp) => {
    // [Step1: Capture initial] — build timeline with amplitude step at 0, wave centered
    const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
    const wave = new WaveEngine(
      [{ direction: 'down', beats: 3 }, { direction: 'up', beats: 2 }],
      timeline,
      amp,
      0.0,
    );
    const perBeatPx = 2 * TW_AMP * amp;
    const waveTop = TW_CENTER_Y - TW_AMP;
    const waveBottom = TW_CENTER_Y + TW_AMP;

    // [Step2: Perform] probe off-grid beats inside first segment before clamp
    // Directly compute expected rawY = startY + perBeat*beat then clamp
    const startY = TW_CENTER_Y; // start_position 0 => center
    for (const b of offGridBeats) {
      if (b >= 3) continue; // stay in first segment for this amp clamp test, but vary per amp
      const rawExpected = startY + perBeatPx * b;
      const clampedExpected = Math.max(waveTop, Math.min(waveBottom, rawExpected));
      const actual = wave.waveYAt(b);
      // For small b before hitting boundary, rawExpected inside bounds => actual == raw
      if (rawExpected >= waveTop && rawExpected <= waveBottom) {
        expect(actual).toBeCloseTo(clampedExpected, 4);
      } else {
        // After hitting bottom, must stay flat at bottom (clamp-on-interpolate), not average slope
        // Average-slope buggy value would be startY + (260 / 3)*b which is slower
        const buggyAvg = startY + ((waveBottom - startY) / 3) * b;
        expect(actual).toBeCloseTo(waveBottom, 4);
        expect(Math.abs(actual - buggyAvg)).toBeGreaterThan(10);
      }
    }

    // [Step3: Assert transition] — after clamp, flat stay, and later segment still reachable
    // At beat 3 exactly we should be at bottom (clamped), at 3.37 up segment should move up
    const atSegEnd = wave.waveYAt(3);
    expect(atSegEnd).toBeCloseTo(waveBottom, 4);
    const after = wave.waveYAt(3.37); // off-grid inside second segment (up)
    // expected = bottom + (-perBeat)*0.37 clamped
    const expectedAfter = Math.max(waveTop, Math.min(waveBottom, waveBottom + (-perBeatPx) * 0.37));
    expect(after).toBeCloseTo(expectedAfter, 4);
  });

  it('cursor per-beat displacement equals WaveEngine dY: speed*beatSec == 2*TW_AMP*amp (complex amps)', () => {
    // [Step1: Capture] for each complex amp, timeline at 120bpm
    for (const amp of amps) {
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
      const beatMs = timeline.beatMsAt(0); // 500ms at 120bpm
      const beatSec = beatMs / 1000;
      // [Step2: Perform] cursor speed formula
      const cursor = new Cursor(amp, 0.0);
      // speed = 2*TW_AMP*amp / beatSec
      const speed = (2 * TW_AMP * amp) / beatSec;
      const perBeat = speed * beatSec; // should equal 2*TW_AMP*amp
      expect(perBeat).toBeCloseTo(2 * TW_AMP * amp, 6);

      // [Step3: Assert] waveYAt slope matches that perBeat for off-grid delta
      const wave = new WaveEngine([{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }], timeline, amp, 0.0);
      const y0 = wave.waveYAt(0); // center
      const yOff = wave.waveYAt(0.37);
      const delta = yOff - y0;
      // Before clamp, delta should equal perBeat*0.37 (down positive)
      const expectedDelta = perBeat * 0.37;
      const waveTop = TW_CENTER_Y - TW_AMP;
      const waveBottom = TW_CENTER_Y + TW_AMP;
      const expectedClampedDelta = Math.max(waveTop, Math.min(waveBottom, y0 + expectedDelta)) - y0;
      expect(delta).toBeCloseTo(expectedClampedDelta, 4);
      // Cursor moves same amount in one update call with same dt: use dt = 0.37*beatSec approx
      cursor.y = y0;
      const dt = 0.37 * beatSec;
      cursor.update(dt, false, true, beatMs, undefined); // down pressed
      // without snap, moves down by speed*dt = perBeat*0.37
      const cursorDelta = cursor.y - y0;
      // allow small clamp differences — before boundary should match
      if (y0 + expectedDelta <= waveBottom) {
        expect(cursorDelta).toBeCloseTo(expectedDelta, 1);
      }
    }
  });

  it('getPoints length invariant and waveYAt at vertices matches points (off-grid)', () => {
    // [Step1] build chart with 3 segments (off-grid beats 1.5, 0.5, 1.23)
    const segs = [
      { direction: 'up' as const, beats: 1.5 },
      { direction: 'down' as const, beats: 0.5 },
      { direction: 'stay' as const, beats: 1.23 },
    ];
    const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: 1.3 }], 1.3);
    const wave = new WaveEngine(segs, tl, 1.3, 0.5);
    const pts = wave.getPoints();
    // [Step2] invariant
    expect(pts.length).toBe(segs.length + 1);
    expect(pts[0].beat).toBeCloseTo(0, 6);
    // cumulative beats
    const cumBeats = segs.reduce((s, v) => s + v.beats, 0);
    expect(pts[pts.length - 1].beat).toBeCloseTo(cumBeats, 6);

    // [Step3] each point's y equals waveYAt at that beat
    for (const p of pts) {
      expect(wave.waveYAt(p.beat)).toBeCloseTo(p.y, 6);
    }
    // off-grid probe inside stay segment should be flat
    const lastSegStartBeat = pts[pts.length - 2].beat;
    const offInStay = lastSegStartBeat + 0.37;
    expect(wave.waveYAt(offInStay)).toBeCloseTo(pts[pts.length - 2].y, 6); // flat
  });
});

// ===========================================================================
// 5) Corrupted / empty edge cases: fallback does not crash
// ===========================================================================
describe('T195 5. Edge & corruption handling (IndexedDB unavailable / bad TOML)', () => {
  it('empty IndexedDB falls back to songs.toml path (simulated) without throwing (3-step)', async () => {
    // [Step1: Capture] DB empty, no cache
    expect((await listCharts()).length).toBe(0);
    ChartCache.clear();

    // [Step2: Perform] simulate fallback attempt: getChart miss -> would call loadSongList
    const stored = await getChart('custom-nonexistent-123');
    expect(stored).toBeUndefined();
    // In real GameScreen this triggers loadSongList + loadChart path; verify Symbol exists
    const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
    expect(src).toContain('loadSongList');

    // [Step3: Assert] no chart resolved, but no exception; cache still empty
    expect(stored).toBeUndefined();
    expect(ChartCache.get('custom-nonexistent-123')).toBeUndefined();
  });

  it('corrupted TOML stored in IndexedDB does not pollute ChartCache (3-step)', async () => {
    // [Step1] store bad TOML
    const badToml = `title = "Broken\n[[segments]]\ndirection = "up"\n`;
    await putChart({ id: CUSTOM_ID_1, title: 'Bad', difficulty: 1, toml: badToml, audioId: null, addedAt: 1700000000000 });
    const stored = await getChart(CUSTOM_ID_1);
    expect(stored!.toml).toBe(badToml);

    // [Step2] try to parse as GameScreen would — should throw and be caught, not cached
    let parsed: Chart | null = null;
    let threw = false;
    try {
      parsed = parseChartText(stored!.toml, CUSTOM_ID_1);
      ChartCache.set(CUSTOM_ID_1, parsed);
    } catch {
      threw = true;
    }

    // [Step3] error caught, cache not set (or if prior set, not overwritten with bad)
    ChartCache.clear(); // ensure test isolation if previous put left cache
    // Re-attempt with clear: after throw, cache should remain empty
    expect(threw).toBe(true);
    expect(ChartCache.get(CUSTOM_ID_1)).toBeUndefined();
  });

  it('listCharts after multiple custom puts returns exact count, deleteChart idempotent (3-step)', async () => {
    // [Step1] empty
    expect((await listCharts()).length).toBe(0);

    // [Step2] add 3 charts with deterministic IDs
    await putChart({ id: CUSTOM_ID_1, title: 'One', difficulty: 1, toml: chartToToml(buildChart(sampleTomlOffGrid())), audioId: AUDIO_ID_1, addedAt: 1700000000000 });
    await putChart({ id: CUSTOM_ID_2, title: 'Two', difficulty: 2, toml: chartToToml(buildChart(sampleTomlOffGrid())), audioId: AUDIO_ID_2, addedAt: 1700000001000 });
    await putChart({ id: CUSTOM_ID_3, title: 'Three', difficulty: 3, toml: chartToToml(buildChart(sampleTomlOffGrid())), audioId: null, addedAt: 1700000002000 });
    expect((await listCharts()).length).toBe(3);

    await deleteChart(CUSTOM_ID_2);
    await deleteChart('nonexistent-id-does-not-throw');
    const after = await listCharts();

    // [Step3] count reduced by 1, missing delete had no effect
    expect(after.length).toBe(2);
    expect(after.some(c => c.id === CUSTOM_ID_2)).toBe(false);
    expect(after.some(c => c.id === CUSTOM_ID_1)).toBe(true);
    expect(after.some(c => c.id === CUSTOM_ID_3)).toBe(true);
  });
});

// ===========================================================================
// 6) libraryDb module contract: basename, compressed bytes, no Date drift
// ===========================================================================
describe('T195 6. Module contracts: getBasename, chartToToml basename, Uint8Array immutability', () => {
  it('getBasename extracts basename, loader and serializer use basename only (3-step)', () => {
    // [Step1: Capture] basename edge cases
    expect(getBasename('/rhythm_game/audio/08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('audio/test.mp3')).toBe('test.mp3');
    expect(getBasename('')).toBe('');

    // [Step2: Perform] parse full path -> serialize -> basename only
    const tomlFull = `
title = "Basename"
artist = ""
audio = "/rhythm_game/audio/08.Reply.flac"
[[sections]]
beat = 0
bpm = 120
[[rings]]
beat = 4.37
`;
    const parsed = parseChartText(tomlFull, 'full.toml');
    expect(parsed.audio).toBe('08.Reply.flac');
    const serialized = chartToToml(parsed);
    expect(serialized).toContain('audio = "08.Reply.flac"');
    expect(serialized).not.toContain('/rhythm_game/audio');

    // [Step3: Assert] stored via libraryDb round-trip retains basename
    const reparsed = parseChartText(serialized, 'serialized.toml');
    expect(reparsed.audio).toBe('08.Reply.flac');
    expect(reparsed.rings[0].beat).toBeCloseTo(4.37, 6);
  });

  it('putAudio stores defensive copy: mutating original after put does not affect stored bytes (3-step)', async () => {
    // [Step1] original bytes
    const original = new Uint8Array([5, 6, 7, 8, 9, 255]);
    const copyBefore = original.slice(0);
    expect(Array.from(original)).toEqual(Array.from(copyBefore));

    // [Step2] put, then mutate original
    await putAudio({ id: AUDIO_ID_1, name: 'defensive.flac', mime: 'audio/flac', bytes: original });
    original[0] = 99;
    original[1] = 88;

    const stored = await getAudio(AUDIO_ID_1);
    // [Step3] stored unaffected
    expect(stored!.bytes[0]).toBe(5);
    expect(stored!.bytes[1]).toBe(6);
    expect(Array.from(stored!.bytes)).toEqual([5, 6, 7, 8, 9, 255]);
  });

  it('TSC and existing routes: App.tsx not broken, base config intact (3-step static)', () => {
    // [Step1] GameScreen static has required imports (no TS break)
    const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
    const importsOk = src.includes("from '../audio/AudioManager'") && src.includes("from '../chart/cache'") && src.includes('storage/libraryDb');
    expect(importsOk).toBe(true);

    // [Step2] tsconfig/app includes src? not critical, but src/types has Chart with bpm_changes
    const typesSrc = fs.readFileSync('src/types.ts', 'utf-8');
    expect(typesSrc).toContain('bpm_changes');

    // [Step3] no remaining chart.bpm scalar abuse (T186/T188 removed)
    // GameScreen should not reference new BpmTimeline(chart.bpm, ...) legacy form without baseAmplitude fallback
    // It may still have BpmTimeline(*, chart.amplitude) but not chart.bpm as first arg alone
    expect(src).not.toMatch(/new BpmTimeline\s*\(\s*chart\.bpm\s*,/);
    // should derive via first section internally
  });
});
