/**
 * T196 — カスタム譜面ライブラリの結合・回帰 (Vitest, node environment)
 * TDD Red → Green — strict acceptance for src/storage/libraryDb.ts + SelectScreen + GameScreen integration
 *
 * 要求: T193〜T195の結合仕上げ
 * 修正:
 *   - 追加→リロード→一覧表示→プレイ(音あり)→削除 の一連フロー確認
 *   - 容量上限・破損データ時の異常系ハンドリング
 * 完了条件:
 *   1) 一連フローが破綻なく完了すること
 *   2) 異常系でクラッシュせず分かりやすいエラーになること
 *   3) tsc --noEmit・T110/T120/T194/T195 回帰なし
 *
 * Runs WITHOUT browser — imports pure modules directly.
 * Uses fake-indexeddb/auto + vi.useFakeTimers() deterministically.
 * Verifies COMPUTED values / engine math / IndexedDB state deltas, not surface DOM.
 * Every spec follows MANDATORY 3-Step: [Capture Initial State] → [Perform Interaction] → [Assert Transition].
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import * as fs from 'fs';

import {
  DB_NAME,
  CHARTS_STORE,
  AUDIO_STORE,
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
  cloneBytesForDecode,
} from '../src/storage/libraryDb';
import type { StoredChart, StoredAudio } from '../src/storage/libraryDb';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { getBasename } from '../src/audio/AudioCache';
import { AudioCache } from '../src/audio/AudioCache';
import { ChartCache } from '../src/chart/cache';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine } from '../src/game/waveEngine';
import type { Chart } from '../src/types';

// ---------------------------------------------------------------------------
// fake timers — control ID generation deterministically (custom-${Date.now()})
// ---------------------------------------------------------------------------
vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function makeStoredChart(overrides: Partial<StoredChart> = {}): StoredChart {
  const base: StoredChart = {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: 'T196 Test Song',
    artist: 'T196 Artist',
    difficulty: 3,
    toml: `title = "T196 Test Song"\nartist = "T196 Artist"\naudio = "test-audio.flac"\n[[sections]]\nbeat = 0\nbpm = 120\n[[segments]]\ndirection = "up"\nbeats = 2\n[[rings]]\nbeat = 4.0\n`,
    audioId: null,
    addedAt: Date.now(),
    ...overrides,
  };
  return base;
}

function makeStoredAudio(overrides: Partial<StoredAudio> = {}): StoredAudio {
  const bytes = new Uint8Array([0, 1, 2, 255, 128, 64, 10, 20, 30, 100, 200]);
  return {
    id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`,
    name: 'test-audio.flac',
    mime: 'audio/flac',
    bytes,
    ...overrides,
  };
}

function sampleTomlOffGrid(): string {
  return `
title = "T196 OffGrid 1.23"
artist = "Tester"
audio = "custom-song.flac"
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
[[segments]]
direction = "stay"
beats = 1.0
[[rings]]
beat = 1.23
[[rings]]
beat = 4.37
type = "hold"
duration = 0.5
`;
}

function buildChart(toml: string): Chart {
  return parseChartText(toml, 't196-sample.toml');
}

function ensureIndexedDB(): IDBFactory {
  const g = globalThis as unknown as { indexedDB: IDBFactory };
  if (!g.indexedDB) throw new Error('indexedDB not polyfilled');
  return g.indexedDB;
}

// simulate SelectScreen "追加" button logic: id=`custom-${Date.now()}`, putChart+putAudio, set Caches
async function simulateAddFlow(chart: Chart, fileName: string, audioFile: { name: string; type: string; bytes: Uint8Array }): Promise<{ id: string; toml: string; base: string }> {
  const id = `custom-${Date.now()}`;
  const title = chart.title || fileName.replace(/\.toml$/i, '') || 'Untitled';
  const toml = chartToToml(chart);
  const base = getBasename(chart.audio);
  // ChartCache + AudioCache (in-memory) — actual SelectScreen does this synchronously
  ChartCache.set(id, chart);
  ChartCache.set(fileName, chart);
  // Simulate AudioBuffer creation — use a mock buffer object
  const fakeBuffer = {
    duration: 120,
    sampleRate: 44100,
    length: 44100 * 120,
    numberOfChannels: 2,
    getChannelData: () => new Float32Array(44100 * 2),
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
  AudioCache.set(base, fakeBuffer);
  AudioCache.set(id, fakeBuffer);

  // Persist to IndexedDB (async fire-and-forget in real code, we await here)
  await putChart({ id, title, artist: chart.artist || '', difficulty: 3, toml, audioId: id, addedAt: Date.now() });
  await putAudio({ id, name: audioFile.name || base, mime: audioFile.type || 'audio/flac', bytes: audioFile.bytes });
  return { id, toml, base };
}

// simulate GameScreen fallback resolution: ChartCache → IndexedDB → loadSongList
async function resolveChartForPlay(songId: string): Promise<Chart | null> {
  const cached = ChartCache.get(songId);
  if (cached) return cached;
  const stored = await getChart(songId);
  if (stored) {
    const parsed = parseChartText(stored.toml, songId);
    ChartCache.set(songId, parsed);
    return parsed;
  }
  return null;
}

async function resolveAudioForPlay(songId: string, chart: Chart, decodeFn: (ab: ArrayBuffer) => Promise<AudioBuffer | null>): Promise<AudioBuffer | null> {
  const cached = AudioCache.get(getBasename(chart.audio)) || AudioCache.get(songId);
  if (cached) return cached;
  const stored = await getAudio(songId);
  if (stored && stored.bytes) {
    try {
      const bytes = stored.bytes;
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const buf = await decodeFn(ab);
      if (buf) {
        const base = getBasename(chart.audio);
        AudioCache.set(songId, buf);
        AudioCache.set(base, buf);
        return buf;
      }
    } catch {
      // decode failed → fallback to null (metronome-only)
    }
  }
  return null;
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
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
});

// ===========================================================================
// 1) 一連フロー: 追加→リロード→一覧表示→プレイ(音あり)→削除 (完了条件 1)
// ===========================================================================
describe('T196 1. 一連フロー: 追加→リロード→一覧表示→プレイ(音あり)→削除 が破綻なく完了 (IndexedDB件数 0→1→1→0)', () => {
  it('追加→リロード→一覧表示→プレイ(音あり)→削除 の全件数遷移が 0→1→1→1(リロード維持)→0 になる (3-step)', async () => {
    // [Step1: Capture Initial State] — empty DB + empty caches
    const beforeCharts = await listCharts();
    const beforeAudio = await listAudio();
    expect(beforeCharts.length).toBe(0);
    expect(beforeAudio.length).toBe(0);
    expect(ChartCache.get('custom-9999')).toBeUndefined();
    expect(AudioCache.get('custom-9999')).toBeUndefined();

    // [Step2: Perform] — 追加: TOML + 音声を "投入" 相当で保存
    const tomlText = sampleTomlOffGrid();
    const chart = buildChart(tomlText);
    // off-grid values must be parsed correctly (precondition)
    expect(chart.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    expect(chart.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-6)).toBe(true);
    const audioBytes = new Uint8Array([10, 20, 30, 40, 255, 0, 128, 64, 1, 2, 3]);
    const { id, toml } = await simulateAddFlow(chart, 'custom-song.toml', { name: 'custom-song.flac', type: 'audio/flac', bytes: audioBytes });

    const afterAddCharts = await listCharts();
    const afterAddAudio = await listAudio();
    expect(afterAddCharts.length).toBe(1);
    expect(afterAddAudio.length).toBe(1);
    expect(id).toMatch(/^custom-\d+$/);

    // simulate reload: close DB + clear in-memory caches (page reload wipes state)
    ChartCache.clear();
    AudioCache.clear();
    closeLibraryDB();

    // [Step3: Assert — 中間] 一覧表示: リロード後も IndexedDB に残る
    const afterReloadCharts = await listCharts();
    const afterReloadChart = await getChart(id);
    const afterReloadAudio = await getAudio(id);
    expect(afterReloadCharts.length).toBe(1);
    expect(afterReloadChart).toBeDefined();
    expect(afterReloadChart!.id).toBe(id);
    expect(afterReloadChart!.title).toBe(chart.title);
    expect(afterReloadChart!.toml).toBe(toml);
    expect(afterReloadAudio).toBeDefined();
    expect(afterReloadAudio!.bytes.length).toBe(audioBytes.length);
    for (let i = 0; i < audioBytes.length; i++) expect(afterReloadAudio!.bytes[i]).toBe(audioBytes[i]);

    // プレイ(音あり): GameScreen 解決順序 ChartCache → IndexedDB が hit する
    // キャッシュはクリア済みなので IndexedDB fallback が発動し再キャッシュされる
    expect(ChartCache.get(id)).toBeUndefined();
    expect(AudioCache.get(id)).toBeUndefined();
    const resolvedChart = await resolveChartForPlay(id);
    expect(resolvedChart).not.toBeNull();
    expect(resolvedChart!.title).toBe(chart.title);
    // off-grid beats survive round-trip
    const reparsed = parseChartText((await getChart(id))!.toml, 'reparsed.toml');
    expect(reparsed.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    // BpmTimeline + WaveEngine can be constructed from recovered chart
    const timeline = new BpmTimeline(reparsed.bpm_changes, reparsed.amplitude);
    const wave = new WaveEngine(reparsed.segments, timeline, reparsed.amplitude, reparsed.start_position);
    expect(timeline.msToBeat(timeline.beatToMs(1.23))).toBeCloseTo(1.23, 4);
    expect(wave.getPoints().length).toBe(reparsed.segments.length + 1);

    // 音あり: IndexedDB bytes → decode (bytes.slice(0) semantics, immutability)
    const storedAudio = await getAudio(id);
    const cloneForDecode = cloneBytesForDecode(storedAudio!.bytes);
    expect(Array.from(cloneForDecode)).toEqual(Array.from(audioBytes));
    cloneForDecode[0] = 99;
    expect(storedAudio!.bytes[0]).toBe(10); // immutability
    // simulate decodeAudioData that would be called in GameScreen
    const fakeDecode = async (ab: ArrayBuffer): Promise<AudioBuffer | null> => {
      // mimic AudioContext.decodeAudioData — return mock buffer if bytes non-empty
      if (ab.byteLength === 0) return null;
      return {
        duration: 90,
        sampleRate: 44100,
        length: 44100 * 90,
        numberOfChannels: 2,
        getChannelData: () => new Float32Array(44100 * 2),
        copyFromChannel: () => {},
        copyToChannel: () => {},
      } as unknown as AudioBuffer;
    };
    const decoded = await resolveAudioForPlay(id, resolvedChart!, fakeDecode);
    expect(decoded).not.toBeNull();
    expect(decoded!.duration).toBe(90);
    // caches repopulated
    expect(ChartCache.get(id)).toBeDefined();
    expect(AudioCache.get(id)).toBeDefined();

    // 削除: SelectScreen 削除ボタン相当
    const countBeforeDelete = (await listCharts()).length;
    expect(countBeforeDelete).toBe(1);
    await deleteChart(id);
    await deleteAudio(id);
    ChartCache.clear();
    AudioCache.clear();
    const afterDeleteCharts = await listCharts();
    const afterDeleteAudio = await listAudio();
    expect(afterDeleteCharts.length).toBe(0);
    expect(afterDeleteAudio.length).toBe(0);
    expect(await getChart(id)).toBeUndefined();
    expect(await getAudio(id)).toBeUndefined();

    // リロード後も消えたまま
    closeLibraryDB();
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);
  });

  it('複数曲の追加→リロード→一覧結合 (組込曲 + カスタム) で重複なく4件表示される (3-step)', async () => {
    // [Step1: Capture] built-in 2 + IndexedDB empty = 2 total
    const builtin: { id: string; title: string }[] = [
      { id: 'reply', title: 'Reply' },
      { id: 'test-song', title: 'Test Song' },
    ];
    const beforeCustom = await listCharts();
    expect(beforeCustom.length).toBe(0);
    const mergedBefore = [...builtin.map(b => ({ id: b.id })), ...beforeCustom.map(c => ({ id: c.id }))];
    expect(mergedBefore.length).toBe(2);

    // [Step2: Perform] add 2 customs
    const c1 = buildChart(sampleTomlOffGrid());
    const c2 = buildChart(sampleTomlOffGrid());
    c2.title = 'Second Custom';
    const id1 = `custom-${Date.now()}`;
    await simulateAddFlow(c1, 'c1.toml', { name: 'c1.flac', type: 'audio/flac', bytes: new Uint8Array([1, 2, 3]) });
    // second uses explicit put to keep id2 deterministic
    vi.setSystemTime(new Date(Date.now() + 1000));
    const id2 = `custom-${Date.now()}`;
    const toml2 = chartToToml(c2);
    await putChart({ id: id2, title: c2.title, artist: c2.artist, difficulty: 2, toml: toml2, audioId: id2, addedAt: Date.now() });
    await putAudio({ id: id2, name: 'c2.flac', mime: 'audio/flac', bytes: new Uint8Array([4, 5, 6]) });
    // reload
    ChartCache.clear();
    AudioCache.clear();
    closeLibraryDB();
    const customAfter = await listCharts();
    expect(customAfter.length).toBe(2);

    // [Step3: Assert] merged = built-ins + customs = 4, ids unique
    const mergedAfter = [...builtin.map(b => ({ id: b.id })), ...customAfter.map(c => ({ id: c.id }))];
    expect(mergedAfter.length).toBe(4);
    expect(new Set(mergedAfter.map(m => m.id)).size).toBe(4);
    for (const cm of customAfter) expect(cm.id).toMatch(/^custom-\d+/);
  });

  it('IDは custom-${Date.now()} 形式で確定・永続化し close/reopen後も同一IDで参照できる (3-step)', async () => {
    // [Step1: Capture] deterministic Date.now
    expect((await listCharts()).length).toBe(0);
    const t1 = Date.now();
    expect(t1).toBe(1774008000000);
    // [Step2: Perform] generate 2 ids with time advance
    const id1 = `custom-${Date.now()}`;
    vi.setSystemTime(new Date(Date.now() + 1000));
    const id2 = `custom-${Date.now()}`;
    expect(id1).toBe('custom-1774008000000');
    expect(id2).toBe('custom-1774008001000');
    expect(id1).not.toBe(id2);
    await putChart(makeStoredChart({ id: id1, title: 'Song One', addedAt: t1 }));
    await putChart(makeStoredChart({ id: id2, title: 'Song Two', addedAt: t1 + 1000 }));
    closeLibraryDB();
    const after = await listCharts();
    // [Step3: Assert] both persist with exact same id string
    expect(after.length).toBe(2);
    expect((await getChart(id1))!.title).toBe('Song One');
    expect((await getChart(id2))!.title).toBe('Song Two');
    expect((await getChart(id1))!.id).toBe(id1);
    expect((await getChart(id2))!.id).toBe(id2);
  });
});

// ===========================================================================
// 2) プレイ時のフォールバック取得: ChartCache → IndexedDB → fetch 相当
// ===========================================================================
describe('T196 2. プレイ時の解決順序: ChartCache → IndexedDB (永続) → fetch のフォールバック', () => {
  it('ChartCache miss時に IndexedDB から復元し ChartCache に再投入される (3-step)', async () => {
    // [Step1: Capture] store chart in IDB, cache empty
    const chart = buildChart(sampleTomlOffGrid());
    const id = `custom-${Date.now()}`;
    const toml = chartToToml(chart);
    await putChart({ id, title: chart.title, artist: chart.artist, difficulty: 3, toml, audioId: id, addedAt: Date.now() });
    ChartCache.clear();
    expect(ChartCache.get(id)).toBeUndefined();
    // [Step2: Perform] resolve (GameScreen init path)
    const resolved = await resolveChartForPlay(id);
    // [Step3: Assert] resolved from IDB and cached
    expect(resolved).not.toBeNull();
    expect(resolved!.title).toBe(chart.title);
    expect(ChartCache.get(id)).toBeDefined();
    expect(ChartCache.get(id)!.title).toBe(chart.title);
  });

  it('IndexedDB bytesから AudioBuffer デコードに成功し AudioCache に再投入される (3-step)', async () => {
    // [Step1: Capture] store audio bytes, cache empty
    const chart = buildChart(sampleTomlOffGrid());
    const id = `custom-${Date.now()}`;
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    await putAudio({ id, name: 'x.flac', mime: 'audio/flac', bytes });
    AudioCache.clear();
    expect(AudioCache.get(id)).toBeUndefined();
    // [Step2: Perform] decode via slice(0) semantics
    const stored = await getAudio(id);
    expect(stored).toBeDefined();
    const ab = stored!.bytes.buffer.slice(stored!.bytes.byteOffset, stored!.bytes.byteOffset + stored!.bytes.byteLength) as ArrayBuffer;
    expect(ab.byteLength).toBe(10);
    // cloneBytesForDecode must be independent copy
    const clone = cloneBytesForDecode(stored!.bytes);
    expect(Array.from(clone)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    clone[0] = 123;
    expect(stored!.bytes[0]).toBe(9);
    // via resolver
    let decodeCalled = false;
    const fakeDecode = async (buf: ArrayBuffer) => {
      decodeCalled = true;
      expect(buf.byteLength).toBe(10);
      return { duration: 60 } as unknown as AudioBuffer;
    };
    const decoded = await resolveAudioForPlay(id, chart, fakeDecode);
    // [Step3: Assert] decode called, result cached
    expect(decodeCalled).toBe(true);
    expect(decoded).not.toBeNull();
    expect(AudioCache.get(id)).toBe(decoded);
    expect(AudioCache.get(getBasename(chart.audio))).toBe(decoded);
  });

  it('decodeAudioData rejection時は null を返しクラッシュせずメトロノームのみで続行可能 (3-step)', async () => {
    // [Step1: Capture] store chart + audio that will fail decode
    const chart = buildChart(sampleTomlOffGrid());
    const id = `custom-${Date.now()}`;
    const toml = chartToToml(chart);
    await putChart({ id, title: chart.title, artist: chart.artist, difficulty: 3, toml, audioId: id, addedAt: Date.now() });
    await putAudio({ id, name: 'bad.flac', mime: 'audio/flac', bytes: new Uint8Array([1, 2, 3]) });
    // [Step2: Perform] decode rejects
    const failingDecode = async (_: ArrayBuffer) => {
      throw new Error('decodeAudioData failed: corrupted file');
    };
    let threw = false;
    let result: AudioBuffer | null = null;
    try {
      result = await resolveAudioForPlay(id, chart, failingDecode);
    } catch {
      threw = true;
    }
    // [Step3: Assert] does not throw outward, returns null (metronome fallback)
    expect(threw).toBe(false);
    expect(result).toBeNull();
    // chart still resolvable even though audio failed
    const c = await resolveChartForPlay(id);
    expect(c).not.toBeNull();
  });

  it('音源が無いカスタム (audioId=null) でも譜面は解決し音はnullでプレイ可能 (3-step)', async () => {
    // [Step1: Capture] chart with null audioId
    const tomlSolo = `title = "Solo No Audio"\nartist = ""\naudio = "solo.flac"\n[[sections]]\nbeat = 0\nbpm = 120\n[[rings]]\nbeat = 4.37\n`;
    const chart = buildChart(tomlSolo);
    const tomlStored = chartToToml(chart);
    const id = `custom-${Date.now()}`;
    await putChart({ id, title: chart.title, difficulty: 1, toml: tomlStored, audioId: null, addedAt: Date.now() });
    // [Step2: Perform] resolve chart + audio (audio should be null)
    const resolvedChart = await resolveChartForPlay(id);
    const audioRes = await resolveAudioForPlay(id, resolvedChart!, async () => { throw new Error('should not be called'); });
    const storedChart = await getChart(id);
    // [Step3: Assert] chart exists, audioId null, audio resolve returns null without calling decode
    expect(resolvedChart).not.toBeNull();
    expect(storedChart!.audioId).toBeNull();
    expect(audioRes).toBeNull();
    expect((await listAudio()).length).toBe(0);
  });
});

// ===========================================================================
// 3) 容量上限・QuotaExceededError の graceful handling (完了条件 2)
// ===========================================================================
describe('T196 3. 容量上限: QuotaExceededError 時に古い順削除・再試行しクラッシュしない', () => {
  it('putChart が QuotaExceededError で最も古い chart を削除して再試行し件数が不変で新曲が入る (3-step)', async () => {
    // [Step1: Capture] put 2 charts with distinct addedAt (oldest first)
    const oldChart = makeStoredChart({ id: 'quota-old', title: 'Oldest', addedAt: 1000 });
    const newerChart = makeStoredChart({ id: 'quota-newer', title: 'Newer', addedAt: 2000 });
    await putChart(oldChart);
    await putChart(newerChart);
    const beforeList = await listCharts();
    expect(beforeList.length).toBe(2);
    const oldestBefore = [...beforeList].sort((a, b) => a.addedAt - b.addedAt)[0].id;
    expect(oldestBefore).toBe('quota-old');
    // [Step2: Perform] inject QuotaExceededError on next putOnce for charts
    let shouldThrowOnce = true;
    let originalPut: ((...a: unknown[]) => IDBRequest<unknown>) | null = null;
    let protoPatched = false;
    let warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnMessages.push(String(args[0]));
    try {
      const proto = Object.getPrototypeOf(
        (await openLibraryDB()).transaction(CHARTS_STORE, 'readwrite').objectStore(CHARTS_STORE),
      ) as { put?: (...a: unknown[]) => IDBRequest<unknown> };
      if (proto && typeof proto.put === 'function') {
        originalPut = proto.put;
        const orig = originalPut;
        proto.put = function (...args: unknown[]) {
          if (shouldThrowOnce) {
            shouldThrowOnce = false;
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          }
          return (orig as (...a: unknown[]) => IDBRequest<unknown>).apply(this, args);
        };
        protoPatched = true;
      }
    } catch {
      /* ignore */
    }

    let putErrorCaught = false;
    try {
      const newChart = makeStoredChart({ id: 'quota-new', title: 'NewestAfterQuota', addedAt: 3000 });
      await putChart(newChart);
    } catch (e) {
      putErrorCaught = true;
      if (!protoPatched) {
        // fallback manual path when proto patch not possible
        await deleteChart('quota-old');
        const fallbackChart = makeStoredChart({ id: 'quota-new', title: 'NewestAfterQuota', addedAt: 3000 });
        await putChart(fallbackChart);
        putErrorCaught = false;
      } else {
        throw e;
      }
    }

    // restore
    if (protoPatched && originalPut) {
      try {
        const proto2 = Object.getPrototypeOf(
          (await openLibraryDB()).transaction(CHARTS_STORE, 'readwrite').objectStore(CHARTS_STORE),
        ) as { put?: (...a: unknown[]) => IDBRequest<unknown> };
        if (proto2) proto2.put = originalPut;
      } catch {
        /* ignore */
      }
    }
    console.warn = origWarn;
    const afterList = await listCharts();
    // [Step3: Assert] oldest evicted, new chart present, warning emitted or fallback succeeded
    expect(afterList.length).toBe(2);
    const afterIds = afterList.map(c => c.id).sort();
    expect(afterIds).toContain('quota-new');
    expect(afterIds).not.toContain('quota-old');
    if (warnMessages.length > 0) expect(warnMessages.join(' ')).toMatch(/QuotaExceeded/i);
    expect(putErrorCaught).toBe(false);
  });

  it('容量超過の静的証跡: putChart/putAudio が QuotaExceededError と addedAt ソートで古い順削除する (3-step)', async () => {
    // [Step1: Capture] read source before
    const src = fs.readFileSync('src/storage/libraryDb.ts', 'utf-8');
    const hasChartQuota = src.includes('putChart') && src.includes('QuotaExceededError');
    const hasAudioQuota = src.includes('putAudio') && src.includes('QuotaExceededError');
    // [Step2: Perform] check sorting logic exists
    const hasOldestSort = src.includes('addedAt') && src.includes('sort');
    // [Step3: Assert] both quota paths exist (graceful error handling)
    expect(hasChartQuota).toBe(true);
    expect(hasAudioQuota).toBe(true);
    expect(hasOldestSort).toBe(true);
    expect(src).toContain('trace-wave-library');
  });

  it('大量エントリ (20件) でも list/get/delete が破綻せず半分削除後も整合 (3-step)', async () => {
    // [Step1: Capture] empty
    expect((await listCharts()).length).toBe(0);
    // [Step2: Perform] put 20 charts with off-grid beats varying
    for (let i = 0; i < 20; i++) {
      const cid = `custom-${Date.now()}-${i}`;
      const toml = `title = "Bulk ${i}"\nartist = ""\naudio = "bulk.flac"\n[[sections]]\nbeat = 0\nbpm = 120\n[[rings]]\nbeat = ${4 + i * 0.37}\n`;
      const chart = buildChart(toml);
      const storedToml = chartToToml(chart);
      await putChart(makeStoredChart({ id: cid, title: `Bulk ${i}`, difficulty: (i % 5) + 1, toml: storedToml, addedAt: Date.now() + i }));
      vi.advanceTimersByTime(10);
    }
    const afterBulk = await listCharts();
    expect(afterBulk.length).toBe(20);
    const toDelete = afterBulk.slice(0, 10).map(c => c.id);
    for (const did of toDelete) await deleteChart(did);
    const afterHalfDelete = await listCharts();
    // [Step3: Assert] 10 remain, all retrievable, deleted gone
    expect(afterHalfDelete.length).toBe(10);
    for (const c of afterHalfDelete) {
      const g = await getChart(c.id);
      expect(g).toBeDefined();
      expect(g!.id).toBe(c.id);
    }
    for (const did of toDelete) expect(await getChart(did)).toBeUndefined();
  });
});

// ===========================================================================
// 4) 破損データ: TOML/bytes が壊れてもクラッシュせず分かりやすいエラー (完了条件 2)
// ===========================================================================
describe('T196 4. 破損データ時の異常系ハンドリング: クラッシュせず分かりやすいエラー', () => {
  it('破損TOML文字列でも putChart/getChart はクラッシュせず文字列を保存し parse は投げる (3-step)', async () => {
    // [Step1: Capture] empty
    expect((await listCharts()).length).toBe(0);
    // [Step2: Perform] store chart with malformed TOML (閉じ引用符なし)
    const brokenToml = `title = "Broken\n[[segments]]\ndirection = "up"\nbeats = 2\n`;
    const id = `custom-${Date.now()}`;
    await putChart({ id, title: 'Broken', difficulty: 1, toml: brokenToml, audioId: null, addedAt: Date.now() });
    const gotBroken = await getChart(id);
    // [Step3: Assert] stored verbatim, not thrown at storage layer; parsing throws with readable message
    expect(gotBroken).toBeDefined();
    expect(gotBroken!.toml).toBe(brokenToml);
    let threw = false;
    let errMsg = '';
    try {
      parseChartText(gotBroken!.toml, 'broken.toml');
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toBe(true);
    expect(errMsg).toMatch(/パース|parse|TOML/i);
    // list still works, other entries unaffected
    expect((await listCharts()).length).toBe(1);
  });

  it('破損bytes (空/不正ヘッダ) でも getAudio は返し decode 失敗は null でスキップされる (3-step)', async () => {
    // [Step1: Capture] store audio with zero-length and with random bytes
    const idEmpty = `audio-empty-${Date.now()}`;
    vi.advanceTimersByTime(10);
    const idRandom = `audio-random-${Date.now()}`;
    await putAudio({ id: idEmpty, name: 'empty.flac', mime: 'audio/flac', bytes: new Uint8Array([]) });
    await putAudio({ id: idRandom, name: 'random.bin', mime: 'application/octet-stream', bytes: new Uint8Array([255, 255, 255, 0, 1, 2]) });
    const beforeList = await listAudio();
    expect(beforeList.length).toBe(2);
    // [Step2: Perform] attempt decode that fails for empty
    const gotEmpty = await getAudio(idEmpty);
    expect(gotEmpty).toBeDefined();
    expect(gotEmpty!.bytes.length).toBe(0);
    const gotRandom = await getAudio(idRandom);
    expect(gotRandom!.bytes.length).toBe(6);
    // simulate GameScreen's IndexedDB audio fallback with decode that fails on empty
    const chartDummy: Chart = { title: 'X', artist: '', audio: 'empty.flac', audio_offset: 0, amplitude: 1.0, start_position: 0, bpm_changes: [{ beat: 0, bpm: 120 }], segments: [], rings: [] };
    const failOnEmpty = async (ab: ArrayBuffer): Promise<AudioBuffer | null> => {
      if (ab.byteLength === 0) throw new Error('decode failed: empty buffer');
      return { duration: 10 } as unknown as AudioBuffer;
    };
    let resultEmpty: AudioBuffer | null = null;
    let crashed = false;
    try {
      resultEmpty = await resolveAudioForPlay(idEmpty, chartDummy, failOnEmpty);
    } catch {
      crashed = true;
    }
    // [Step3: Assert] not crashed, returns null (skip), list still valid
    expect(crashed).toBe(false);
    expect(resultEmpty).toBeNull();
    expect((await listAudio()).length).toBe(2);
    // random bytes with a decoder that checks header could also be handled
    const failOnFF = async (ab: ArrayBuffer): Promise<AudioBuffer | null> => {
      const u8 = new Uint8Array(ab);
      if (u8[0] === 255 && u8[1] === 255) throw new Error('unsupported format');
      return { duration: 5 } as unknown as AudioBuffer;
    };
    let resultRandom: AudioBuffer | null = null;
    let crashed2 = false;
    try {
      resultRandom = await resolveAudioForPlay(idRandom, chartDummy, failOnFF);
    } catch {
      crashed2 = true;
    }
    expect(crashed2).toBe(false);
    expect(resultRandom).toBeNull();
  });

  it('IndexedDB内に破損エントリが混在しても正常エントリの list/get/play がスキップして継続できる (3-step)', async () => {
    // [Step1: Capture] put one good + one broken chart
    const goodToml = sampleTomlOffGrid();
    const goodChart = buildChart(goodToml);
    const goodId = `custom-${Date.now()}`;
    vi.advanceTimersByTime(10);
    const badId = `custom-${Date.now()}`;
    const brokenToml = `title = "Broken\n[[rings]]\nbeat = 4.0\n`;
    await putChart({ id: goodId, title: goodChart.title, difficulty: 3, toml: chartToToml(goodChart), audioId: null, addedAt: Date.now() });
    await putChart({ id: badId, title: 'Broken', difficulty: 1, toml: brokenToml, audioId: null, addedAt: Date.now() + 1 });
    const all = await listCharts();
    expect(all.length).toBe(2);
    // [Step2: Perform] try to resolve both; broken should fail parse but not affect good
    const goodResolved = await resolveChartForPlay(goodId);
    let badThrew = false;
    let badResolved: Chart | null = null;
    try {
      badResolved = await resolveChartForPlay(badId);
    } catch {
      badThrew = true;
    }
    // resolveChartForPlay should propagate parse error (GameScreen catches and shows error UI)
    // but listCharts must still return both, good still playable
    const goodTimeline = new BpmTimeline(goodResolved!.bpm_changes, goodResolved!.amplitude);
    expect(goodTimeline.beatToMs(1.23)).toBeGreaterThan(0);
    // [Step3: Assert] broken entry causes parse error but does not corrupt good entry or crash list
    expect(badThrew).toBe(true);
    expect(badResolved).toBeNull();
    expect(goodResolved).not.toBeNull();
    expect((await getChart(goodId))!.title).toBe(goodChart.title);
    expect((await listCharts()).length).toBe(2);
    // after deleting broken, good remains (recovery)
    await deleteChart(badId);
    expect((await listCharts()).length).toBe(1);
    expect((await getChart(goodId))!.title).toBe(goodChart.title);
  });

  it('bytes の防御的コピー: put後に元配列を破壊しても stored bytes は不変 (3-step)', async () => {
    // [Step1: Capture] put audio with specific pattern
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const id = `audio-immut-${Date.now()}`;
    await putAudio({ id, name: 'immut.flac', mime: 'audio/flac', bytes });
    const beforeMutate = await getAudio(id);
    const snapshot = Array.from(beforeMutate!.bytes);
    // [Step2: Perform] mutate original
    bytes[0] = 99;
    bytes[1] = 99;
    const afterMutate = await getAudio(id);
    // [Step3: Assert] stored unchanged
    expect(Array.from(afterMutate!.bytes)).toEqual(snapshot);
    expect(afterMutate!.bytes[0]).toBe(10);
    expect(afterMutate!.bytes[1]).toBe(20);
  });
});

// ===========================================================================
// 5) 競合・リロード・cache vs IndexedDB 優先度 (回帰)
// ===========================================================================
describe('T196 5. 競合・リロード挙動: IndexedDB 永続が cache より優先され一貫する', () => {
  it('cache を改変してもリロード(IndexedDB再取得)で正しい永続値が勝つ (3-step)', async () => {
    // [Step1: Capture] add chart via IDB, cache initially same
    const chart = buildChart(sampleTomlOffGrid());
    const id = `custom-${Date.now()}`;
    const toml = chartToToml(chart);
    await putChart({ id, title: chart.title, difficulty: 3, toml, audioId: null, addedAt: Date.now() });
    ChartCache.set(id, chart);
    const beforeCacheTitle = ChartCache.get(id)!.title;
    expect(beforeCacheTitle).toBe(chart.title);
    // modify cache to different value (simulates user editing in-memory but not persisted)
    const modifiedChart: Chart = { ...chart, title: 'Modified In Memory' };
    ChartCache.set(id, modifiedChart);
    expect(ChartCache.get(id)!.title).toBe('Modified In Memory');
    // [Step2: Perform] simulate reload: clear cache, re-resolve from IDB
    ChartCache.clear();
    closeLibraryDB();
    const resolvedAfterReload = await resolveChartForPlay(id);
    // [Step3: Assert] IndexedDB value wins, modified in-memory is gone
    expect(resolvedAfterReload).not.toBeNull();
    expect(resolvedAfterReload!.title).toBe(chart.title);
    expect(resolvedAfterReload!.title).not.toBe('Modified In Memory');
    expect(ChartCache.get(id)!.title).toBe(chart.title);
  });

  it('並行 putChart でも最終件数が正しく重複なく3件になる (3-step)', async () => {
    // [Step1: Capture] empty
    expect((await listCharts()).length).toBe(0);
    // [Step2: Perform] concurrent puts
    await Promise.all([
      putChart(makeStoredChart({ id: 'concur-1', addedAt: 100 })),
      putChart(makeStoredChart({ id: 'concur-2', addedAt: 200 })),
      putChart(makeStoredChart({ id: 'concur-3', addedAt: 300 })),
    ]);
    const after = await listCharts();
    // [Step3: Assert] all 3 present, ids sorted unique
    expect(after.length).toBe(3);
    expect(after.map(c => c.id).sort()).toEqual(['concur-1', 'concur-2', 'concur-3']);
  });

  it('存在しないIDの削除は例外なく件数不変 (3-step)', async () => {
    // [Step1: Capture] put one
    const id = `custom-${Date.now()}`;
    await putChart(makeStoredChart({ id, title: 'Only One' }));
    expect((await listCharts()).length).toBe(1);
    // [Step2: Perform] delete missing
    await deleteChart('custom-9999999999999-nonexistent');
    await deleteAudio('audio-nonexistent');
    const after = await listCharts();
    // [Step3: Assert] count unchanged
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(id);
  });

  it('close/reopen の永続性: put → close → reopen でデータが消えない (3-step)', async () => {
    // [Step1: Capture] put before close
    const chart = buildChart(sampleTomlOffGrid());
    const id = `custom-${Date.now()}`;
    await putChart({ id, title: chart.title, difficulty: 3, toml: chartToToml(chart), audioId: id, addedAt: Date.now() });
    await putAudio({ id, name: 'persist.flac', mime: 'audio/flac', bytes: new Uint8Array([7, 8, 9]) });
    expect((await listCharts()).length).toBe(1);
    // [Step2: Perform] close (simulate reload) and reopen lazily
    closeLibraryDB();
    const afterCharts = await listCharts();
    const afterAudio = await getAudio(id);
    const afterChart = await getChart(id);
    // [Step3: Assert] data survives
    expect(afterCharts.length).toBe(1);
    expect(afterChart!.title).toBe(chart.title);
    expect(afterAudio!.bytes[0]).toBe(7);
  });
});

// ===========================================================================
// 6) T110 / T120 / T194 / T195 回帰 (basename, serialize, scroll/zoom, play fallback)
// ===========================================================================
describe('T196 6. T110/T120/T194/T195 回帰なし: basename / cache / TOML往復 / zoom置換', () => {
  it('T110: getBasename がフルパスからbasename抽出、loaderはbasenameのみ保存 (3-step)', async () => {
    // [Step1: Capture] basename cases
    expect(getBasename('/rhythm_game/audio/08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('audio/test.mp3')).toBe('test.mp3');
    expect(getBasename('')).toBe('');
    // [Step2: Perform] parse full path chart, serialize, store
    const tomlFullPath = `
title = "Basename Test"
artist = ""
audio = "/rhythm_game/audio/08.Reply.flac"
[[sections]]
beat = 0
bpm = 120
[[rings]]
beat = 4.0
`;
    const parsedFull = buildChart(tomlFullPath);
    expect(parsedFull.audio).toBe('08.Reply.flac'); // loader extracts basename
    const serialized = chartToToml(parsedFull);
    expect(serialized).toContain('audio = "08.Reply.flac"');
    expect(serialized).not.toContain('/rhythm_game/audio');
    const id = `custom-${Date.now()}`;
    await putChart({ id, title: parsedFull.title, difficulty: 1, toml: serialized, audioId: `audio-${Date.now()}`, addedAt: Date.now() });
    const got = await getChart(id);
    const reparsedStored = buildChart(got!.toml);
    // [Step3: Assert] basename preserved after IDB round-trip
    expect(reparsedStored.audio).toBe('08.Reply.flac');
    expect(got!.toml).toContain('audio = "08.Reply.flac"');
  });

  it('T110/T120: TOML往復で off-grid beats (0.37/1.23/4.37) と hold ring が保持される (3-step)', () => {
    // [Step1: Capture] build with off-grid and hold
    const toml = sampleTomlOffGrid();
    const chart = buildChart(toml);
    expect(chart.rings.find(r => r.type === 'hold')).toBeDefined();
    // [Step2: Perform] serialize → store → retrieve → reparse
    const serialized = chartToToml(chart);
    const reparsedDirect = buildChart(serialized);
    expect(reparsedDirect.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    expect(reparsedDirect.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-6)).toBe(true);
    // [Step3: Assert] hold type/duration preserved
    const holdRing = reparsedDirect.rings.find(r => r.type === 'hold');
    expect(holdRing).toBeDefined();
    expect(holdRing!.beat).toBeCloseTo(4.37, 3);
    expect(holdRing!.duration).toBeCloseTo(0.5, 3);
    expect(holdRing!.type).toBe('hold');
  });

  it('T194: SelectScreen が libraryDb の import と listCharts/putChart/deleteChart を持つ (3-step static)', async () => {
    // [Step1: Capture] read source
    const src = fs.readFileSync('src/screens/SelectScreen.tsx', 'utf-8');
    const hasImport = src.includes('libraryDb') || src.includes('storage/libraryDb');
    const hasListCharts = src.includes('listCharts');
    const hasPutChart = src.includes('putChart');
    // [Step2: Perform] check specific patterns
    const hasCustomId = src.includes('custom-${Date.now()}') || (src.includes('custom-') && src.includes('Date.now()'));
    const hasDelete = src.includes('deleteChart');
    // [Step3: Assert] all required for persist/restore/delete
    expect(hasImport).toBe(true);
    expect(hasListCharts).toBe(true);
    expect(hasPutChart).toBe(true);
    expect(hasCustomId).toBe(true);
    expect(hasDelete).toBe(true);
  });

  it('T195: GameScreen が ChartCache miss時に IndexedDB fallback (getChart/getAudio + decodeAudioData) を持つ (3-step static)', async () => {
    // [Step1: Capture] read GameScreen source
    const src = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
    const hasChartCacheCheck = src.includes('ChartCache.get');
    const hasGetChart = src.includes('getChart');
    // [Step2: Perform] audio fallback checks
    const hasGetAudio = src.includes('getAudio');
    const hasDecode = src.includes('decodeAudioData');
    const hasFallbackComment = src.includes('IndexedDB') || src.includes('T195');
    // [Step3: Assert] fallback chain present
    expect(hasChartCacheCheck).toBe(true);
    expect(hasGetChart).toBe(true);
    expect(hasGetAudio).toBe(true);
    expect(hasDecode).toBe(true);
    expect(hasFallbackComment).toBe(true);
  });

  it('T186〜T188 回帰: BpmTimeline基準は先頭セクションのbpm、zoomAtが step で切り替わる (3-step)', async () => {
    // [Step1: Capture] chart with sections including zoom
    const chart = buildChart(sampleTomlOffGrid());
    const timeline = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const beatBefore = 1.23;
    const beatAfter = 4.37;
    const zoomBefore = timeline.zoomAt(beatBefore);
    const zoomAfter = timeline.zoomAt(beatAfter);
    // [Step2: Perform] verify zoom step at 4.37 and beatToMs reflects first section bpm
    expect(timeline.zoomAt(0)).toBe(1.0);
    expect(zoomBefore).toBe(1.0);
    expect(zoomAfter).toBeCloseTo(1.2, 3);
    // beatToMs(4) with base 120bpm should be 2000ms
    const msAt4 = timeline.beatToMs(4.0);
    expect(msAt4).toBeCloseTo(2000, 0);
    // [Step3: Assert] scroll speed uses zoomAt in GameScreen (static check)
    const gameSrc = fs.readFileSync('src/screens/GameScreen.tsx', 'utf-8');
    expect(gameSrc).toContain('zoomAt');
    expect(gameSrc).toContain('scrollSpeed');
    // no legacy chart.bpm direct reference for timeline base (T188)
    // allow chart.bpm_changes but not chart.bpm as base param
    expect(gameSrc).not.toMatch(/new BpmTimeline\(chart\.bpm(?!_)/);
  });

  it('T193 静的: DB名 trace-wave-library, stores charts/audio, keyPath id (3-step)', async () => {
    // [Step1: Capture] constants
    expect(DB_NAME).toBe('trace-wave-library');
    expect(CHARTS_STORE).toBe('charts');
    expect(AUDIO_STORE).toBe('audio');
    // [Step2: Perform] open DB to trigger onupgradeneeded
    const db = await openLibraryDB();
    const hasCharts = db.objectStoreNames.contains(CHARTS_STORE);
    const hasAudio = db.objectStoreNames.contains(AUDIO_STORE);
    const tx = db.transaction([CHARTS_STORE, AUDIO_STORE], 'readonly');
    const chartKeyPath = (tx.objectStore(CHARTS_STORE) as unknown as { keyPath: unknown }).keyPath;
    const audioKeyPath = (tx.objectStore(AUDIO_STORE) as unknown as { keyPath: unknown }).keyPath;
    // [Step3: Assert] stores created correctly with keyPath id, exactly 2 stores
    expect(hasCharts).toBe(true);
    expect(hasAudio).toBe(true);
    expect(chartKeyPath).toBe('id');
    expect(audioKeyPath).toBe('id');
    expect(db.objectStoreNames.length).toBe(2);
  });
});
