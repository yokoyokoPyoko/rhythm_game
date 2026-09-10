/**
 * T225 — zipインポートの音声バイト未受渡し修正（Vitest node, TDD Red→Green）
 *
 * 要求: zip（例 maou.zip＋TOML）の曲を追加してプレイしても音楽が流れない。
 * 根本原因:
 *  (1) SelectScreen.tsx:189 が new Uint8Array([]) プレースホルダのまま
 *  (2) ID二重採番: zipImport.ts:241 baseTime と SelectScreen.tsx:162 Date.now() が別採番
 *
 * 修正:
 *  - handleZipFile のペア結果に audioBytes: Uint8Array と audioName を含める
 *  - SelectScreen は placeholder を廃止し pair.audioBytes で File化→decode→AudioCache/putAudio
 *  - ID は result.newSongs[i].id に統一、空バイト時はペア不成立
 *
 * 完了条件:
 *  (1) zip投入→プレイで音声付き再生（IDB bytes長が実サイズと一致）
 *  (2) カードIDとCache/IDBキーが一致、ms境界跨ぎでも譜面が見つかる
 *  (3) tsc --noEmit、T214/T194〜T196 回帰なし
 *
 * 実行: node 環境、純粋モジュールを直接 import。DOMなし。
 *  - fflate zipSync で有効な zip fixture を生成（TOML + audio を同一フォルダに）
 *  - unzipSync で検証してから handleZipFile に渡す
 *  - forbidden: 無効/破損/placeholder zip は使わない
 *  - 各 spec は 3-step: [Capture Initial] → [Perform] → [Assert Transition]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'fs';
import { zipSync, unzipSync } from 'fflate';

import { handleZipFile, pairZipEntries, generateCustomIds } from '../src/storage/zipImport';
import {
  putChart,
  getChart,
  listCharts,
  deleteChart,
  putAudio,
  getAudio,
  listAudio,
  deleteAudio,
  clearLibraryDB,
  closeLibraryDB,
  deleteLibraryDB,
} from '../src/storage/libraryDb';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { getBasename } from '../src/audio/AudioCache';
import { ChartCache } from '../src/chart/cache';
import { AudioCache } from '../src/audio/AudioCache';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine } from '../src/game/waveEngine';
import type { Chart } from '../src/types';

// fake timers for deterministic Date.now custom-xxx
vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function strToU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeChartToml(title: string, audioFileName: string, extra = ''): string {
  // off-grid beats (0.37 / 1.23 / 4.37) + complex amplitudes to keep T127 style
  return `title = "${title}"
artist = "Tester"
audio = "${audioFileName}"
audio_offset = 0
amplitude = 1.3
start_position = 0.0
[[sections]]
beat = 0
bpm = 120
amplitude = 1.3
zoom = 1.0
[[sections]]
beat = 4.37
bpm = 150
amplitude = 0.7
zoom = 1.2
[[segments]]
direction = "up"
beats = 1.5
[[segments]]
direction = "down"
beats = 0.5
[[rings]]
beat = 1.23
[[rings]]
beat = 4.37
type = "hold"
duration = 0.5
${extra}
`;
}

// minimal valid-ish audio bytes: 32 bytes with WAV-like header + non-zero payload
function makeAudioBytes(seed = 1): Uint8Array {
  const header = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 0x10, 0x00,
    0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x44, 0xac, 0x00, 0x00, 0x10, 0xb1, 0x02, 0x00,
  ]);
  const payload = new Uint8Array(16);
  for (let i = 0; i < payload.length; i++) payload[i] = (seed * 37 + i * 13) & 0xff;
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

function createValidZipBytes(entries: Record<string, Uint8Array>): Uint8Array {
  const obj: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(entries)) obj[path] = bytes;
  return zipSync(obj);
}

function createFileFromBytes(bytes: Uint8Array, name: string, type = 'application/zip'): File {
  // Node 20 has global File; fallback to Blob-like object if missing
  try {
    return new File([bytes as unknown as BlobPart], name, { type });
  } catch {
    const blob = bytes as unknown as BlobPart;
    const f = {
      name,
      type,
      size: bytes.length,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
      // minimal File-like for handleZipFile (which only needs arrayBuffer)
    } as unknown as File;
    // attach bytes for debug
    (f as unknown as { _bytes: Uint8Array })._bytes = bytes;
    return f;
  }
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
  ChartCache.clear();
  AudioCache.clear();
  try {
    await deleteLibraryDB();
  } catch {
    try {
      await clearLibraryDB();
    } catch {
      /* ignore */
    }
  }
  closeLibraryDB();
});

afterEach(async () => {
  ChartCache.clear();
  AudioCache.clear();
  try {
    await clearLibraryDB();
  } catch {
    /* ignore */
  }
  closeLibraryDB();
  vi.clearAllTimers();
  vi.setSystemTime(new Date('2026-04-01T10:00:00.000Z'));
});

// ===========================================================================
// 0) fixture validity — valid zip generated by fflate, not corrupted/placeholder
// ===========================================================================
describe('T225 0. zip fixture validity (fflate zipSync → unzipSync round-trip)', () => {
  it('fflate zipSync で生成した zip が unzipSync で正しく展開でき TOML と audio を含む (3-step)', () => {
    // [Step1: Capture Initial] — known bytes before
    const audioBytes = makeAudioBytes(7);
    const toml = makeChartToml('Maou Song', 'maou.flac');
    expect(audioBytes.length).toBeGreaterThan(0);
    expect(toml).toContain('audio = "maou.flac"');
    // [Step2: Perform] — zipSync then unzipSync
    const zipBytes = createValidZipBytes({
      'maou/chart.toml': strToU8(toml),
      'maou/maou.flac': audioBytes,
    });
    expect(zipBytes.length).toBeGreaterThan(0);
    const unzipped = unzipSync(zipBytes);
    const keys = Object.keys(unzipped).sort();
    // [Step3: Assert Transition] — both entries present and bytes preserved
    expect(keys).toEqual(['maou/chart.toml', 'maou/maou.flac'].sort());
    expect(new TextDecoder().decode(unzipped['maou/chart.toml'])).toBe(toml);
    expect(unzipped['maou/maou.flac'].length).toBe(audioBytes.length);
    for (let i = 0; i < audioBytes.length; i++) expect(unzipped['maou/maou.flac'][i]).toBe(audioBytes[i]);
  });
});

// ===========================================================================
// 1) 音声バイト未受渡し修正 — handleZipFile が audioBytes を非空で返す
// ===========================================================================
describe('T225 1. 音声バイト未受渡し修正: handleZipFile returns non-empty audioBytes', () => {
  it('単一フォルダ zip から audioBytes が実サイズで返り placeholder 空配列でない (3-step)', async () => {
    // [Step1: Capture Initial] — empty IDB and no audioBytes yet
    const beforeCharts = await listCharts();
    const beforeAudio = await listAudio();
    expect(beforeCharts.length).toBe(0);
    expect(beforeAudio.length).toBe(0);
    const audioBytes = makeAudioBytes(11);
    const toml = makeChartToml('Maou Single', 'maou.flac');
    const zipBytes = createValidZipBytes({
      'maou/chart.toml': strToU8(toml),
      'maou/maou.flac': audioBytes,
    });
    // verify zip itself is valid before handleZipFile
    const probe = unzipSync(zipBytes);
    expect(probe['maou/maou.flac'].length).toBe(audioBytes.length);

    // [Step2: Perform] — call handleZipFile
    const file = createFileFromBytes(zipBytes, 'maou.zip');
    const result = await handleZipFile(file as unknown as File);
    // [Step3: Assert Transition] — pairs contain audioBytes non-empty and equals original
    expect(result.pairs.length).toBe(1);
    expect(result.newSongs.length).toBe(1);
    const pair: unknown = result.pairs[0];
    const audioBytesReturned = (pair as { audioBytes?: Uint8Array }).audioBytes;
    expect(audioBytesReturned).toBeDefined();
    expect(audioBytesReturned instanceof Uint8Array).toBe(true);
    expect(audioBytesReturned!.length).toBe(audioBytes.length);
    expect(audioBytesReturned!.length).toBeGreaterThan(0);
    for (let i = 0; i < audioBytes.length; i++) expect(audioBytesReturned![i]).toBe(audioBytes[i]);
    // ensure not placeholder empty
    expect(audioBytesReturned!.length).not.toBe(0);
    // chart basename must match audio basename (pairing within folder)
    const chartBase = getBasename((pair as { chart: Chart }).chart.audio);
    expect(chartBase).toBe('maou.flac');
    // skipped should be empty for valid single pair
    expect(result.skipped.length).toBe(0);
  });

  it('複数フォルダ zip (2曲) で各ペアの audioBytes がそれぞれ実サイズと一致 (3-step off-grid)', async () => {
    // [Step1: Capture Initial] — timers fixed, empty
    const fixedNow = Date.now();
    expect(fixedNow).toBe(1775037600000);
    expect((await listCharts()).length).toBe(0);
    const aBytes = makeAudioBytes(21);
    const bBytes = makeAudioBytes(33);
    // make second audio distinguishable length-wise (add 1 byte)
    const bBytesExtended = new Uint8Array(bBytes.length + 1);
    bBytesExtended.set(bBytes, 0);
    bBytesExtended[bBytesExtended.length - 1] = 0x99;
    const tomlA = makeChartToml('Song A 0.37', 'songA.flac');
    const tomlB = makeChartToml('Song B 1.23', 'songB.flac');
    const zipBytes = createValidZipBytes({
      'songA/chart.toml': strToU8(tomlA),
      'songA/songA.flac': aBytes,
      'songB/chart.toml': strToU8(tomlB),
      'songB/songB.flac': bBytesExtended,
    });
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).length).toBe(4);
    // [Step2: Perform] — handleZipFile
    const file = createFileFromBytes(zipBytes, 'multi.zip');
    const result = await handleZipFile(file as unknown as File);
    // [Step3: Assert] — 2 pairs, each audioBytes equals its folder audio
    expect(result.pairs.length).toBe(2);
    expect(result.newSongs.length).toBe(2);
    for (const p of result.pairs) {
      const b = (p as { audioBytes?: Uint8Array }).audioBytes;
      expect(b).toBeDefined();
      expect(b!.length).toBeGreaterThan(0);
    }
    // map by folder to verify per-folder size
    const byPath = new Map(result.pairs.map((p) => [(p as { tomlPath: string }).tomlPath, p] as const));
    const pairA = byPath.get('songA/chart.toml') as unknown as { audioBytes: Uint8Array; chart: Chart };
    const pairB = byPath.get('songB/chart.toml') as unknown as { audioBytes: Uint8Array; chart: Chart };
    expect(pairA).toBeDefined();
    expect(pairB).toBeDefined();
    expect(pairA.audioBytes.length).toBe(aBytes.length);
    expect(pairB.audioBytes.length).toBe(bBytesExtended.length);
    // ensure off-grid beats survived parse
    expect(pairA.chart.rings.some((r) => Math.abs(r.beat - 1.23) < 1e-9)).toBe(true);
    // IDs are custom-${Date.now()}-${index} with same base
    const ids = result.newSongs.map((s) => s.id);
    expect(ids[0]).toBe(`custom-${fixedNow}-0`);
    expect(ids[1]).toBe(`custom-${fixedNow}-1`);
    expect(new Set(ids).size).toBe(2);
  });

  it('IndexedDB に putAudio した bytes 長が実ファイルサイズと一致し GameScreenフォールバックで復元できる (3-step)', async () => {
    // [Step1: Capture Initial] — empty IDB, cache empty
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);
    expect(ChartCache.get('custom-xxx')).toBeUndefined();
    const audioBytes = makeAudioBytes(42);
    const toml = makeChartToml('Persist Song', 'persist.flac');
    const zipBytes = createValidZipBytes({
      'persist/chart.toml': strToU8(toml),
      'persist/persist.flac': audioBytes,
    });
    const file = createFileFromBytes(zipBytes, 'persist.zip');
    // [Step2: Perform] — handleZipFile then simulate SelectScreen's corrected flow:
    // use result.newSongs[i].id and pair.audioBytes (not placeholder, not second Date.now)
    const result = await handleZipFile(file as unknown as File);
    expect(result.pairs.length).toBe(1);
    const pair = result.pairs[0] as unknown as { audioBytes: Uint8Array; chart: Chart; tomlPath: string; audioPath: string };
    expect(pair.audioBytes.length).toBe(audioBytes.length);
    const unifiedId = result.newSongs[0].id; // single source of truth
    const chart = pair.chart;
    const id = unifiedId;
    const tomlStored = chartToToml(chart);
    // store to ChartCache/AudioCache + IndexedDB using unified ID and real bytes
    ChartCache.set(id, chart);
    const fakeBuf = { duration: 90, sampleRate: 44100, length: 44100 * 90, numberOfChannels: 2 } as unknown as AudioBuffer;
    AudioCache.set(id, fakeBuf);
    AudioCache.set(getBasename(chart.audio), fakeBuf);
    await putChart({ id, title: chart.title, artist: chart.artist, difficulty: 3, toml: tomlStored, audioId: id, addedAt: Date.now() });
    await putAudio({ id, name: getBasename(pair.audioPath), mime: 'audio/flac', bytes: pair.audioBytes });
    const afterPutCharts = await listCharts();
    const afterPutAudio = await listAudio();
    expect(afterPutCharts.length).toBe(1);
    expect(afterPutAudio.length).toBe(1);
    // simulate reload: clear caches + close DB (page reload)
    ChartCache.clear();
    AudioCache.clear();
    closeLibraryDB();
    expect(ChartCache.get(id)).toBeUndefined();
    expect(AudioCache.get(id)).toBeUndefined();
    // [Step3: Assert Transition] — IndexedDB bytes length equals original, GameScreen fallback can rehydrate
    const storedAudio = await getAudio(id);
    expect(storedAudio).toBeDefined();
    expect(storedAudio!.bytes.length).toBe(audioBytes.length);
    for (let i = 0; i < audioBytes.length; i++) expect(storedAudio!.bytes[i]).toBe(audioBytes[i]);
    // simulate GameScreen fallback: ChartCache miss → getChart → parse → put to cache
    const cached = ChartCache.get(id);
    expect(cached).toBeUndefined();
    const storedChart = await getChart(id);
    expect(storedChart).toBeDefined();
    const parsed = parseChartText(storedChart!.toml, id);
    ChartCache.set(id, parsed);
    expect(ChartCache.get(id)!.title).toBe(chart.title);
    // audio fallback: getAudio → bytes → decode (mock) → AudioCache
    const storedAudio2 = await getAudio(id);
    expect(storedAudio2!.bytes.length).toBeGreaterThan(0);
    // bytes.slice(0) copy semantics for decode
    const copy = storedAudio2!.bytes.slice(0);
    expect(copy.length).toBe(audioBytes.length);
    copy[0] = 0xff;
    expect(storedAudio2!.bytes[0]).toBe(audioBytes[0]); // stored not mutated
    // BpmTimeline/WaveEngine still constructible from persisted chart (off-grid)
    const timeline = new BpmTimeline(parsed.bpm_changes, parsed.amplitude);
    const wave = new WaveEngine(parsed.segments, timeline, parsed.amplitude, parsed.start_position);
    expect(timeline.msToBeat(timeline.beatToMs(1.23))).toBeCloseTo(1.23, 4);
    expect(timeline.msToBeat(timeline.beatToMs(4.37))).toBeCloseTo(4.37, 4);
    expect(wave.getPoints().length).toBe(parsed.segments.length + 1);
  });

  it('空バイトの音声ファイルはペア不成立として skipped に報告され空保存されない (3-step)', async () => {
    // [Step1: Capture Initial] — empty
    expect((await listCharts()).length).toBe(0);
    const emptyBytes = new Uint8Array([]);
    const toml = makeChartToml('Empty Audio', 'empty.flac');
    // Create zip with empty audio file; fflate will store it as 0-length
    const zipBytes = createValidZipBytes({
      'empty/chart.toml': strToU8(toml),
      'empty/empty.flac': emptyBytes,
    });
    const probe = unzipSync(zipBytes);
    expect(probe['empty/empty.flac'].length).toBe(0);
    const file = createFileFromBytes(zipBytes, 'empty.zip');
    // [Step2: Perform] — handleZipFile should not yield a valid audioBytes (skipped or filtered)
    const result = await handleZipFile(file as unknown as File);
    // The spec says empty bytes → pair not established, reported, not saved
    // Implementation may either return 0 pairs+skipped or a pair with empty bytes that caller must reject.
    // Our assertions enforce that caller would NOT store empty bytes.
    let wouldStoreEmpty = false;
    if (result.pairs.length === 1) {
      const b = (result.pairs[0] as unknown as { audioBytes?: Uint8Array }).audioBytes;
      // if pair exists but bytes empty, that is still buggy — treat as wouldStoreEmpty
      if (b && b.length === 0) wouldStoreEmpty = true;
    }
    // [Step3: Assert Transition] — either pairs is 0+skipped, or if pair exists caller must not store
    if (wouldStoreEmpty) {
      // Simulate corrected SelectScreen guard: skip empty bytes
      expect(result.pairs.length).toBe(0);
      // force failure if buggy code would store empty
    }
    expect(result.pairs.length === 0 || result.skipped.length > 0).toBe(true);
    // ensure no audio with 0 length was persisted in this test (we didn't put)
    expect((await listAudio()).length).toBe(0);
    // If implementation incorrectly returns pair with empty bytes, the guard above fails
    if (result.pairs.length > 0) {
      const firstPair = result.pairs[0] as unknown as { audioBytes?: Uint8Array };
      // audioBytes should be undefined or non-empty if paired; empty must be treated as not paired
      if (firstPair.audioBytes) expect(firstPair.audioBytes.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 2) ID二重採番修正 — カードIDとCache/IDBキーが一致、ms境界跨ぎでも譜面が見つかる
// ===========================================================================
describe('T225 2. ID二重採番修正: カードIDとCache/IDBキーが一致、ms境界対応', () => {
  it('zip 3曲の newSongs IDs が custom-${baseTime}-${index} で Cache/IDB と一致 (3-step)', async () => {
    // [Step1: Capture Initial] — fixed time, empty
    const baseTime = Date.now();
    expect(baseTime).toBe(1775037600000);
    expect((await listCharts()).length).toBe(0);
    const aBytes = makeAudioBytes(10);
    const bBytes = makeAudioBytes(20);
    const cBytes = makeAudioBytes(30);
    const zipBytes = createValidZipBytes({
      'a/chart.toml': strToU8(makeChartToml('A', 'a.flac')),
      'a/a.flac': aBytes,
      'b/chart.toml': strToU8(makeChartToml('B', 'b.flac')),
      'b/b.flac': bBytes,
      'c/chart.toml': strToU8(makeChartToml('C', 'c.flac')),
      'c/c.flac': cBytes,
    });
    // [Step2: Perform] — handleZipFile + store using unified IDs (not second Date.now)
    const file = createFileFromBytes(zipBytes, 'trip.zip');
    const result = await handleZipFile(file as unknown as File);
    expect(result.pairs.length).toBe(3);
    const newSongs = result.newSongs;
    expect(newSongs.length).toBe(3);
    expect(newSongs[0].id).toBe(`custom-${baseTime}-0`);
    expect(newSongs[1].id).toBe(`custom-${baseTime}-1`);
    expect(newSongs[2].id).toBe(`custom-${baseTime}-2`);
    // Simulate corrected SelectScreen: use result.newSongs[i].id for both caches and IDB
    for (let i = 0; i < result.pairs.length; i++) {
      const p = result.pairs[i] as unknown as { audioBytes: Uint8Array; chart: Chart; audioPath: string };
      const id = newSongs[i].id;
      const chart = p.chart;
      ChartCache.set(id, chart);
      AudioCache.set(id, { duration: 60 } as unknown as AudioBuffer);
      await putChart({ id, title: chart.title, artist: chart.title, difficulty: 3, toml: chartToToml(chart), audioId: id, addedAt: baseTime + i });
      await putAudio({ id, name: getBasename(p.audioPath), mime: 'audio/flac', bytes: p.audioBytes });
    }
    // [Step3: Assert Transition] — each card ID resolves via Cache and via IDB fallback
    for (let i = 0; i < 3; i++) {
      const id = `custom-${baseTime}-${i}`;
      expect(ChartCache.get(id)).toBeDefined();
      expect(AudioCache.get(id)).toBeDefined();
      expect(await getChart(id)).toBeDefined();
      expect(await getAudio(id)).toBeDefined();
      expect((await getAudio(id))!.bytes.length).toBeGreaterThan(0);
    }
    // card IDs (newSongs) equal IDB keys
    const storedIds = (await listCharts()).map((c) => c.id).sort();
    const cardIds = newSongs.map((s) => s.id).sort();
    expect(storedIds).toEqual(cardIds);
  });

  it('ms境界を跨いでもカードID(統一ID)と譜面キャッシュが一致し、別採番のズレが起きない (3-step)', async () => {
    // [Step1: Capture Initial] — time T, create zip
    const t0 = Date.now();
    expect(t0).toBe(1775037600000);
    const audioBytes = makeAudioBytes(77);
    const toml = makeChartToml('Boundary', 'bound.flac');
    const zipBytes = createValidZipBytes({
      'bound/chart.toml': strToU8(toml),
      'bound/bound.flac': audioBytes,
    });
    const file = createFileFromBytes(zipBytes, 'bound.zip');
    const resultAtT0 = await handleZipFile(file as unknown as File);
    expect(resultAtT0.newSongs.length).toBe(1);
    const unifiedId = resultAtT0.newSongs[0].id;
    expect(unifiedId).toBe(`custom-${t0}-0`);
    // Simulate old buggy SelectScreen: it would generate id via Date.now() again AFTER handling
    // Advance time by 2ms to cross ms boundary (T0 -> T0+2)
    vi.setSystemTime(new Date(t0 + 2));
    const buggyNow = Date.now();
    expect(buggyNow).toBe(t0 + 2);
    const buggyId = `custom-${buggyNow}-0`;
    // buggyId differs from unifiedId by 2ms
    expect(buggyId).not.toBe(unifiedId);
    // [Step2: Perform] — store using CORRECT unifiedId (not buggyId), then simulate reload
    const pair = resultAtT0.pairs[0] as unknown as { audioBytes: Uint8Array; chart: Chart; audioPath: string };
    const chart = pair.chart;
    ChartCache.set(unifiedId, chart);
    AudioCache.set(unifiedId, { duration: 30 } as unknown as AudioBuffer);
    await putChart({ id: unifiedId, title: chart.title, difficulty: 3, toml: chartToToml(chart), audioId: unifiedId, addedAt: t0 });
    await putAudio({ id: unifiedId, name: 'bound.flac', mime: 'audio/flac', bytes: pair.audioBytes });
    // Simulate page reload: clear caches, close DB
    ChartCache.clear();
    AudioCache.clear();
    closeLibraryDB();
    // [Step3: Assert Transition] — unifiedId still resolves, buggyId does NOT
    const storedUnified = await getChart(unifiedId);
    expect(storedUnified).toBeDefined();
    expect(storedUnified!.id).toBe(unifiedId);
    const storedBuggy = await getChart(buggyId);
    expect(storedBuggy).toBeUndefined();
    // Also AudioCache/IDB audio with unifiedId has real bytes, buggyId has nothing
    const audioUnified = await getAudio(unifiedId);
    expect(audioUnified).toBeDefined();
    expect(audioUnified!.bytes.length).toBe(audioBytes.length);
    const audioBuggy = await getAudio(buggyId);
    expect(audioBuggy).toBeUndefined();
    // ChartCache fallback via unifiedId would succeed
    const parsed = parseChartText(storedUnified!.toml, unifiedId);
    expect(parsed.title).toBe(chart.title);
    const tl = new BpmTimeline(parsed.bpm_changes, parsed.amplitude);
    expect(tl.msToBeat(tl.beatToMs(1.23))).toBeCloseTo(1.23, 4);
  });

  it('generateCustomIds(baseTime,count) が custom-${baseTime}-${index} 形式で冪等 (3-step)', () => {
    // [Step1: Capture Initial] — baseTime known
    const base = Date.now();
    expect(base).toBe(1775037600000);
    // [Step2: Perform] — generate
    const ids = generateCustomIds(base, 3);
    // [Step3: Assert Transition] — format and uniqueness
    expect(ids).toEqual([`custom-${base}-0`, `custom-${base}-1`, `custom-${base}-2`]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^custom-\d+-\d+$/);
    // second call same base produces same sequence (idempotent)
    const ids2 = generateCustomIds(base, 3);
    expect(ids2).toEqual(ids);
  });
});

// ===========================================================================
// 3) 静的コード検証: placeholder 廃止 & ID統一がソースに反映されている
// ===========================================================================
describe('T225 3. 静的コード検証: placeholder廃止とID統一がソースに反映', () => {
  it('SelectScreen.tsx が placeholder new Uint8Array([]) を含まず pair.audioBytes を使う (3-step)', () => {
    // [Step1: Capture Initial] — read file
    const src = fs.readFileSync('src/screens/SelectScreen.tsx', 'utf-8');
    const beforeHasPlaceholder = src.includes('new Uint8Array([])');
    // handleZipFile section inside SelectScreen (lines ~186-212) previously contained placeholder
    const zipSection = src.slice(src.indexOf('const handleZipFile'), src.indexOf('const handleFiles'));
    // [Step2: Perform] — check for corrected patterns
    const hasPlaceholderInZipSection = zipSection.includes('new Uint8Array([])');
    const usesAudioBytes = src.includes('audioBytes') || src.includes('pair.audioBytes') || src.includes('result.pairs');
    const usesUnifiedId = src.includes('result.newSongs') && src.includes('newSongs');
    // [Step3: Assert Transition] — placeholder removed from zip flow, audioBytes used, unified ID used
    // Before fix: hasPlaceholderInZipSection === true, after fix false → this test fails Red before fix
    expect(hasPlaceholderInZipSection).toBe(false);
    expect(usesAudioBytes).toBe(true);
    expect(usesUnifiedId).toBe(true);
    // overall file may still have other Uint8Array([]) usage elsewhere? but not in zip import flow
    // we enforce that the specific buggy comment placeholder is gone
    expect(zipSection).not.toMatch(/const audioBytes\s*=\s*new Uint8Array\(\[\]\)/);
    expect(zipSection).not.toContain('placeholder - actual implementation would extract');
  });

  it('zipImport.ts の handleZipFile ペア型が audioBytes: Uint8Array を含む (3-step)', () => {
    // [Step1: Capture Initial] — read file
    const src = fs.readFileSync('src/storage/zipImport.ts', 'utf-8');
    const hasPairInterface = src.includes('ZipPairResult') || src.includes('interface');
    // [Step2: Perform] — check audioBytes field in pairs
    const hasAudioBytesField = src.includes('audioBytes');
    const hasAudioNameField = src.includes('audioName') || src.includes('audioPath');
    // handleZipFile must populate audioBytes from files map
    const handleBody = src.slice(src.indexOf('export async function handleZipFile'));
    const populatesFromFiles = handleBody.includes('files[') || handleBody.includes('groups[') || handleBody.includes('audioBytes');
    // [Step3: Assert Transition] — audioBytes is part of pair result for backward compat
    expect(hasPairInterface).toBe(true);
    expect(hasAudioBytesField).toBe(true);
    expect(hasAudioNameField).toBe(true);
    expect(populatesFromFiles).toBe(true);
    expect(handleBody).not.toContain('new Uint8Array([]) // placeholder');
  });

  it('pairZipEntries / groupEntriesByFolder がフォルダ単位で basename 一致を維持 (3-step static)', () => {
    // [Step1: Capture] — verify module exports expected helpers (T214 regression)
    const zipSrc = fs.readFileSync('src/storage/zipImport.ts', 'utf-8');
    expect(zipSrc).toContain('groupEntriesByFolder');
    expect(zipSrc).toContain('pairTomlAudioInFolder');
    expect(zipSrc).toContain('pairZipEntries');
    // [Step2: Perform] — live check with real entries
    const entries = [
      { path: 'songA/chart.toml', bytes: strToU8(makeChartToml('Live A', 'a.flac')) },
      { path: 'songA/a.flac', bytes: makeAudioBytes(1) },
      { path: 'songA/__MACOSX/._chart.toml', bytes: strToU8('garbage') },
    ];
    // filterZipEntries is exported; if not, pairZipEntries should internally filter
    // use pairZipEntries directly
    const result = pairZipEntries(entries as unknown as { path: string; bytes: Uint8Array }[]);
    // [Step3: Assert] — valid pair still found, __MACOSX excluded
    expect(result.pairs.length).toBe(1);
    expect(result.pairs[0].tomlPath).toBe('songA/chart.toml');
  });
});

// ===========================================================================
// 4) 回帰なし: T214 (フォルダペア/ID形式) / T194〜T196 (IndexedDB永続/フォールバック)
// ===========================================================================
describe('T225 4. 回帰なし: T214フォルダペア/ID形式, T193〜T196 IndexedDB永続', () => {
  it('T214 回帰: TOMLと音声が別フォルダならペア不成立で skipped 報告 (3-step)', () => {
    // [Step1: Capture] — empty pair before
    const before = pairZipEntries([]);
    expect(before.pairs.length).toBe(0);
    // [Step2: Perform] — cross-folder entries
    const entries = [
      { path: 'songA/chart.toml', bytes: strToU8(makeChartToml('Cross', 'cross.flac')) },
      { path: 'songB/cross.flac', bytes: makeAudioBytes(5) },
    ];
    const result = pairZipEntries(entries as unknown as { path: string; bytes: Uint8Array }[]);
    // [Step3: Assert] — no pairs, at least one skipped
    expect(result.pairs.length).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('T194〜T196 回帰: 追加→リロード→削除 の一連フローが音声付きでも破綻しない (3-step)', async () => {
    // [Step1: Capture] — empty
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);
    const audioBytes = makeAudioBytes(88);
    const toml = makeChartToml('Regression Flow', 'reg.flac');
    const zipBytes = createValidZipBytes({
      'reg/chart.toml': strToU8(toml),
      'reg/reg.flac': audioBytes,
    });
    const file = createFileFromBytes(zipBytes, 'reg.zip');
    const result = await handleZipFile(file as unknown as File);
    expect(result.pairs.length).toBe(1);
    const pair = result.pairs[0] as unknown as { audioBytes: Uint8Array; chart: Chart; audioPath: string };
    const id = result.newSongs[0].id;
    await putChart({ id, title: pair.chart.title, difficulty: 3, toml: chartToToml(pair.chart), audioId: id, addedAt: Date.now() });
    await putAudio({ id, name: getBasename(pair.audioPath), mime: 'audio/flac', bytes: pair.audioBytes });
    expect((await listCharts()).length).toBe(1);
    expect((await listAudio()).length).toBe(1);
    // [Step2: Perform] — reload (clear + reopen) + delete
    ChartCache.clear();
    AudioCache.clear();
    closeLibraryDB();
    expect((await listCharts()).length).toBe(1);
    expect((await getAudio(id))!.bytes.length).toBe(audioBytes.length);
    // delete
    await deleteChart(id);
    await deleteAudio(id);
    // [Step3: Assert] — 0に戻る、再取得不可
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);
    expect(await getChart(id)).toBeUndefined();
    expect(await getAudio(id)).toBeUndefined();
    closeLibraryDB();
    expect((await listCharts()).length).toBe(0);
  });

  it('T110/T186 回帰: getBasename と loader が basename のみ保存、serialize が basename 出力 (3-step)', () => {
    // [Step1: Capture] — basename cases
    expect(getBasename('/rhythm_game/audio/08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('')).toBe('');
    // [Step2: Perform] — parse full path chart
    const fullPathToml = `title = "Base Test"\nartist = ""\naudio = "/rhythm_game/audio/08.Reply.flac"\n[[sections]]\nbeat = 0\nbpm = 120\n[[rings]]\nbeat = 4.0\n`;
    const parsedFull = parseChartText(fullPathToml, 'full.toml');
    // [Step3: Assert] — basename extracted, serialize outputs basename only
    expect(parsedFull.audio).toBe('08.Reply.flac');
    const serialized = chartToToml(parsedFull);
    expect(serialized).toContain('audio = "08.Reply.flac"');
    expect(serialized).not.toContain('/rhythm_game/audio');
  });

  it('T186〜T188 回帰: BpmTimeline先頭セクション基準と zoomAt ステップが維持 (3-step off-grid)', () => {
    // [Step1: Capture] — chart with sections including zoom
    const chart = parseChartText(makeChartToml('ZoomReg', 'zoom.flac'), 'zoom.toml');
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    // [Step2: Perform] — check zoom steps
    expect(tl.zoomAt(0)).toBe(1.0);
    expect(tl.zoomAt(1.23)).toBe(1.0);
    // chart2 with explicit zoom change at 2.0
    const chart2 = parseChartText(
      `title="Z"\nartist=""\naudio="z.flac"\n[[sections]]\nbeat=0\nbpm=120\nzoom=1.0\n[[sections]]\nbeat=2.0\nbpm=150\nzoom=2.0\n[[rings]]\nbeat=1.23\n`,
      'z.toml',
    );
    const tl2 = new BpmTimeline(chart2.bpm_changes, chart2.amplitude);
    expect(tl2.zoomAt(0.37)).toBe(1.0);
    expect(tl2.zoomAt(2.0)).toBe(2.0);
    expect(tl2.zoomAt(2.5)).toBe(2.0);
    // [Step3: Assert] — beatToMs reflects first section bpm (120 → 500ms/beat)
    expect(tl.beatToMs(1.0)).toBeCloseTo(500, 1);
    expect(tl.msToBeat(tl.beatToMs(0.37))).toBeCloseTo(0.37, 4);
    expect(tl.msToBeat(tl.beatToMs(4.37))).toBeCloseTo(4.37, 4);
  });
});
