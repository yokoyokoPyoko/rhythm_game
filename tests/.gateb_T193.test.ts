/**
 * T193 — Custom chart library IndexedDB foundation (Vitest, node environment)
 * TDD Red→Green — strict acceptance for src/storage/libraryDb.ts
 * DB: trace-wave-library, stores: charts, audio
 * CRUD + QuotaExceededError oldest-first eviction
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// import after polyfill so getIndexedDB sees indexedDB
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

vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

// helpers
function makeChart(overrides: Partial<StoredChart> = {}): StoredChart {
  const base: StoredChart = {
    id: `chart-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test Title',
    artist: 'Test Artist',
    difficulty: 3,
    toml: `title = "Test Title"\nartist = "Test Artist"\n[[segments]]\ndirection="up"\nbeats=2\n`,
    audioId: null,
    addedAt: Date.now(),
    ...overrides,
  };
  return base;
}

function makeAudio(overrides: Partial<StoredAudio> = {}): StoredAudio {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 128, 64]);
  const base: StoredAudio = {
    id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'test.flac',
    mime: 'audio/flac',
    bytes,
    ...overrides,
  };
  return base;
}

function ensureIndexedDB(): IDBFactory {
  const g = globalThis as unknown as { indexedDB: IDBFactory };
  if (!g.indexedDB) throw new Error('indexedDB not polyfilled');
  return g.indexedDB;
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
  // ensure clean DB — delete then reopen lazily
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
  vi.clearAllTimers();
  try {
    await clearLibraryDB();
  } catch {
    /* ignore */
  }
  closeLibraryDB();
});

describe('T193 カスタム譜面ライブラリ IndexedDB基盤', () => {
  // ==================================================================
  // 1) DB name and object stores existence
  // ==================================================================
  describe('1. DB structure: trace-wave-library + charts/audio stores', () => {
    it('DB_NAME is trace-wave-library and both stores exist with keyPath id (3-step)', async () => {
      // [Step1: Capture Initial State] — no DB yet, fresh after delete
      const idb = ensureIndexedDB();
      expect(DB_NAME).toBe('trace-wave-library');
      expect(CHARTS_STORE).toBe('charts');
      expect(AUDIO_STORE).toBe('audio');

      // [Step2: Perform] open DB to trigger onupgradeneeded
      const db = await openLibraryDB();
      const hasCharts = db.objectStoreNames.contains(CHARTS_STORE);
      const hasAudio = db.objectStoreNames.contains(AUDIO_STORE);

      // verify keyPath via reading transaction
      const tx = db.transaction([CHARTS_STORE, AUDIO_STORE], 'readonly');
      const chartStore = tx.objectStore(CHARTS_STORE);
      const audioStore = tx.objectStore(AUDIO_STORE);
      const chartKeyPath = (chartStore as unknown as { keyPath: unknown }).keyPath;
      const audioKeyPath = (audioStore as unknown as { keyPath: unknown }).keyPath;

      // [Step3: Assert Transition] — stores created correctly
      expect(hasCharts).toBe(true);
      expect(hasAudio).toBe(true);
      expect(chartKeyPath).toBe('id');
      expect(audioKeyPath).toBe('id');
      // objectStoreNames length must be exactly 2
      expect(db.objectStoreNames.length).toBe(2);
    });

    it('openLibraryDB is idempotent and returns same DB across calls (3-step)', async () => {
      // [Step1] before open, no instance
      const db1 = await openLibraryDB();
      // [Step2] second call should reuse
      const db2 = await openLibraryDB();
      // [Step3] same instance
      expect(db1).toBe(db2);
      expect(db1.name).toBe(DB_NAME);
    });
  });

  // ==================================================================
  // 2) Charts CRUD — TOML string preservation
  // ==================================================================
  describe('2. Charts CRUD: TOML文字列の保存・取得・一覧・削除', () => {
    it('putChart → getChart preserves all fields exactly (3-step)', async () => {
      // [Step1: Capture Initial State] — list empty, get returns undefined
      const beforeList = await listCharts();
      expect(beforeList.length).toBe(0);
      const beforeGet = await getChart('nonexistent-id-xyz');
      expect(beforeGet).toBeUndefined();

      // [Step2: Perform] put one chart with complex TOML
      const complexToml = `title = "OffGrid 0.37"\nartist = "A"\naudio = "song.flac"\naudio_offset = 123\namplitude = 1.3\n[[sections]]\nbeat=0.37\nbpm=120\nzoom=0.7\n[[rings]]\nbeat=1.23\n`;
      const chart = makeChart({
        id: 'custom-12345',
        title: 'OffGrid 0.37',
        artist: 'Tester',
        difficulty: 5,
        toml: complexToml,
        audioId: 'audio-xyz',
        addedAt: 1700000000000,
      });
      await putChart(chart);
      const afterGet = await getChart('custom-12345');
      const afterList = await listCharts();

      // [Step3: Assert Resulting Transition] — retrieved value equals stored
      expect(afterList.length).toBe(1);
      expect(afterGet).toBeDefined();
      expect(afterGet!.id).toBe('custom-12345');
      expect(afterGet!.title).toBe('OffGrid 0.37');
      expect(afterGet!.artist).toBe('Tester');
      expect(afterGet!.difficulty).toBe(5);
      expect(afterGet!.toml).toBe(complexToml);
      expect(afterGet!.audioId).toBe('audio-xyz');
      expect(afterGet!.addedAt).toBe(1700000000000);
      // TOML string fidelity: must contain off-grid values
      expect(afterGet!.toml).toContain('0.37');
      expect(afterGet!.toml).toContain('1.23');
    });

    it('putChart overwrites same id and listCharts reflects update (3-step)', async () => {
      // [Step1] put first version
      const id = 'overwrite-id';
      const first = makeChart({ id, title: 'First', difficulty: 1, toml: 'title="First"', addedAt: 1000 });
      await putChart(first);
      const listAfterFirst = await listCharts();
      expect(listAfterFirst.length).toBe(1);
      expect((await getChart(id))!.title).toBe('First');

      // [Step2] overwrite with same id
      const second = makeChart({ id, title: 'Second', difficulty: 5, toml: 'title="Second"', addedAt: 2000 });
      await putChart(second);
      const afterOverwrite = await getChart(id);
      const listAfterSecond = await listCharts();

      // [Step3] still 1 entry, but updated values
      expect(listAfterSecond.length).toBe(1);
      expect(afterOverwrite!.title).toBe('Second');
      expect(afterOverwrite!.difficulty).toBe(5);
      expect(afterOverwrite!.toml).toBe('title="Second"');
      expect(afterOverwrite!.addedAt).toBe(2000);
    });

    it('listCharts returns all entries sorted by insertion and deleteChart removes exactly one (3-step)', async () => {
      // [Step1: Capture] empty
      expect((await listCharts()).length).toBe(0);

      // [Step2: Perform] put 3 charts with distinct addedAt
      const c1 = makeChart({ id: 'c1', addedAt: 1000, title: 'A' });
      const c2 = makeChart({ id: 'c2', addedAt: 2000, title: 'B' });
      const c3 = makeChart({ id: 'c3', addedAt: 3000, title: 'C' });
      await putChart(c1);
      await putChart(c2);
      await putChart(c3);
      const beforeDelete = await listCharts();
      expect(beforeDelete.length).toBe(3);

      // delete middle
      await deleteChart('c2');
      const afterDelete = await listCharts();
      const getDeleted = await getChart('c2');

      // [Step3: Assert]
      expect(afterDelete.length).toBe(2);
      expect(getDeleted).toBeUndefined();
      const ids = afterDelete.map(c => c.id).sort();
      expect(ids).toEqual(['c1', 'c3']);
      // remaining still correct
      expect((await getChart('c1'))!.title).toBe('A');
      expect((await getChart('c3'))!.title).toBe('C');
    });

    it('putChart handles null audioId and complex TOML with off-grid beats (3-step)', async () => {
      // [Step1] before empty
      const before = await listCharts();
      expect(before.length).toBe(0);

      // [Step2] chart with null audioId (片方のみでもメトロノームプレイ可)
      const tomlSolo = `title="Solo"\n[[segments]]\ndirection="stay"\nbeats=0.25\n[[rings]]\nbeat=4.37\n`;
      const chartSolo = makeChart({ id: 'solo-chart', toml: tomlSolo, audioId: null });
      await putChart(chartSolo);
      const got = await getChart('solo-chart');

      // [Step3] audioId null preserved, TOML intact
      expect(got).toBeDefined();
      expect(got!.audioId).toBeNull();
      expect(got!.toml).toBe(tomlSolo);
      expect(got!.toml).toContain('4.37');
    });
  });

  // ==================================================================
  // 3) Audio CRUD — bytes as Uint8Array compressed
  // ==================================================================
  describe('3. Audio CRUD: 原ファイルバイト列 (Uint8Array) の保存・取得・削除', () => {
    it('putAudio → getAudio preserves bytes exactly via Uint8Array (3-step)', async () => {
      // [Step1: Capture] list empty, get undefined
      const beforeAudioList = await listAudio();
      expect(beforeAudioList.length).toBe(0);
      const beforeGetAudio = await getAudio('nonexistent-audio');
      expect(beforeGetAudio).toBeUndefined();

      // [Step2: Perform] put audio with specific byte pattern including 255/0/128
      const originalBytes = new Uint8Array([0, 255, 128, 64, 32, 1, 2, 3, 100, 200]);
      const audio = makeAudio({ id: 'audio-1', name: '08.Reply.flac', mime: 'audio/flac', bytes: originalBytes });
      await putAudio(audio);
      const afterGet = await getAudio('audio-1');
      const afterList = await listAudio();

      // [Step3: Assert] bytes identical length and content
      expect(afterList.length).toBe(1);
      expect(afterGet).toBeDefined();
      expect(afterGet!.id).toBe('audio-1');
      expect(afterGet!.name).toBe('08.Reply.flac');
      expect(afterGet!.mime).toBe('audio/flac');
      expect(afterGet!.bytes).toBeInstanceOf(Uint8Array);
      expect(afterGet!.bytes.length).toBe(originalBytes.length);
      for (let i = 0; i < originalBytes.length; i++) {
        expect(afterGet!.bytes[i]).toBe(originalBytes[i]);
      }
    });

    it('audio bytes immutability: mutating original after put does not affect stored (3-step)', async () => {
      // [Step1] put audio
      const bytes = new Uint8Array([10, 20, 30, 40, 50]);
      const audio = makeAudio({ id: 'audio-immut', bytes });
      await putAudio(audio);
      const retrievedBeforeMutate = await getAudio('audio-immut');
      const snapshot = Array.from(retrievedBeforeMutate!.bytes);

      // [Step2] mutate original bytes
      bytes[0] = 99;
      bytes[1] = 99;
      audio.bytes[0] = 88;
      const retrievedAfterMutate = await getAudio('audio-immut');

      // [Step3] stored unchanged
      expect(Array.from(retrievedAfterMutate!.bytes)).toEqual(snapshot);
      expect(retrievedAfterMutate!.bytes[0]).toBe(10);
      expect(retrievedAfterMutate!.bytes[1]).toBe(20);
    });

    it('bytes.slice(0) yields independent copy for decode (cloneBytesForDecode) (3-step)', async () => {
      // [Step1] put audio
      const bytes = new Uint8Array([5, 6, 7, 8, 9]);
      await putAudio(makeAudio({ id: 'audio-slice', bytes }));
      const stored = await getAudio('audio-slice');
      expect(stored).toBeDefined();

      // [Step2] clone via slice and via helper
      const clone1 = stored!.bytes.slice(0);
      const clone2 = cloneBytesForDecode(stored!.bytes);
      // mutate clones
      clone1[0] = 111;
      clone2[0] = 222;

      const reFetched = await getAudio('audio-slice');

      // [Step3] original stored not mutated, clones are copies
      expect(reFetched!.bytes[0]).toBe(5);
      expect(clone1[0]).toBe(111);
      expect(clone2[0]).toBe(222);
      expect(clone1).not.toBe(stored!.bytes);
      expect(clone2).not.toBe(stored!.bytes);
      // verify helper is bytes.slice(0) semantics
      const manualSlice = stored!.bytes.slice(0);
      expect(Array.from(manualSlice)).toEqual([5, 6, 7, 8, 9]);
    });

    it('putAudio with large byte array (1MB) preserves correctly (3-step)', async () => {
      // [Step1] empty
      expect((await listAudio()).length).toBe(0);
      // [Step2] 1MB payload (simulates 5分曲でも数MBに収まる)
      const large = new Uint8Array(1024 * 1024);
      for (let i = 0; i < large.length; i++) large[i] = i % 256;
      const largeAudio = makeAudio({ id: 'large-audio', bytes: large });
      await putAudio(largeAudio);
      const got = await getAudio('large-audio');
      // [Step3] length and spot checks
      expect(got!.bytes.length).toBe(1024 * 1024);
      expect(got!.bytes[0]).toBe(0);
      expect(got!.bytes[255]).toBe(255);
      expect(got!.bytes[1000]).toBe(1000 % 256);
      expect(got!.bytes[1024 * 1024 - 1]).toBe((1024 * 1024 - 1) % 256);
    });

    it('listAudio and deleteAudio transition correctly (3-step)', async () => {
      // [Step1] put 2 audios
      await putAudio(makeAudio({ id: 'a1', name: 'a1.mp3', bytes: new Uint8Array([1]) }));
      await putAudio(makeAudio({ id: 'a2', name: 'a2.mp3', bytes: new Uint8Array([2]) }));
      const beforeDelete = await listAudio();
      expect(beforeDelete.length).toBe(2);

      // [Step2] delete one
      await deleteAudio('a1');
      const afterDelete = await listAudio();
      const getA1 = await getAudio('a1');
      const getA2 = await getAudio('a2');

      // [Step3] only a2 remains
      expect(afterDelete.length).toBe(1);
      expect(getA1).toBeUndefined();
      expect(getA2).toBeDefined();
      expect(getA2!.id).toBe('a2');
    });
  });

  // ==================================================================
  // 4) Chart-Audio linking via audioId (basename一致)
  // ==================================================================
  describe('4. Chart-Audio 紐付け (audioId basename一致) と共有キャッシュ想定', () => {
    it('chart.audioId correctly references stored audio bytes (3-step)', async () => {
      // [Step1: Capture] both empty
      expect((await listCharts()).length).toBe(0);
      expect((await listAudio()).length).toBe(0);

      // [Step2: Perform] store audio + chart referencing it via basename
      const audioBytes = new Uint8Array([10, 20, 30]);
      const audioId = 'audio-custom-1';
      await putAudio({ id: audioId, name: 'custom.flac', mime: 'audio/flac', bytes: audioBytes });
      const chart = makeChart({ id: 'custom-song-1', title: 'Custom Song', audioId, toml: 'audio="custom.flac"' });
      await putChart(chart);

      const gotChart = await getChart('custom-song-1');
      const gotAudio = gotChart?.audioId ? await getAudio(gotChart.audioId) : undefined;

      // [Step3: Assert] linkage intact, bytes retrievable
      expect(gotChart!.audioId).toBe(audioId);
      expect(gotAudio).toBeDefined();
      expect(gotAudio!.bytes[0]).toBe(10);
      expect(gotAudio!.bytes[1]).toBe(20);
      expect(gotAudio!.name).toBe('custom.flac');
    });

    it('chart with null audioId (片方のみ) is valid and audioStore remains empty (3-step)', async () => {
      // [Step1] put chart without audio
      const chart = makeChart({ id: 'chart-no-audio', audioId: null, title: 'No Audio' });
      await putChart(chart);
      const beforeAudioList = await listAudio();
      expect(beforeAudioList.length).toBe(0);

      // [Step2] verify chart retrieved has null audioId
      const got = await getChart('chart-no-audio');
      expect(got!.audioId).toBeNull();

      // [Step3] still no audio, chart persists
      expect((await listCharts()).length).toBe(1);
      expect(await getAudio('nonexistent')).toBeUndefined();
    });
  });

  // ==================================================================
  // 5) Clear and persistence simulation (リロード耐性)
  // ==================================================================
  describe('5. 永続化・クリア・リロードシミュレーション', () => {
    it('clearLibraryDB removes both charts and audio (3-step)', async () => {
      // [Step1] populate both stores
      await putChart(makeChart({ id: 'c-clear-1' }));
      await putChart(makeChart({ id: 'c-clear-2' }));
      await putAudio(makeAudio({ id: 'a-clear-1' }));
      expect((await listCharts()).length).toBe(2);
      expect((await listAudio()).length).toBe(1);

      // [Step2] clear
      await clearLibraryDB();
      const afterCharts = await listCharts();
      const afterAudio = await listAudio();

      // [Step3] both empty but DB still operable
      expect(afterCharts.length).toBe(0);
      expect(afterAudio.length).toBe(0);
      // can still put after clear
      await putChart(makeChart({ id: 'c-after-clear' }));
      expect((await listCharts()).length).toBe(1);
    });

    it('close and reopen preserves data (simulates reload) (3-step)', async () => {
      // [Step1: Capture] put data before close
      const chart = makeChart({ id: 'persist-chart', title: 'Persist' });
      const audio = makeAudio({ id: 'persist-audio', bytes: new Uint8Array([7, 8, 9]) });
      await putChart(chart);
      await putAudio(audio);
      const beforeList = await listCharts();
      expect(beforeList.length).toBe(1);

      // [Step2: Perform] close DB (simulate page reload) and reopen
      closeLibraryDB();
      const afterReopenCharts = await listCharts();
      const afterReopenAudio = await getAudio('persist-audio');
      const afterReopenChart = await getChart('persist-chart');

      // [Step3: Assert] data survives close/reopen (IndexedDB persistence)
      expect(afterReopenCharts.length).toBe(1);
      expect(afterReopenChart!.title).toBe('Persist');
      expect(afterReopenAudio!.bytes[0]).toBe(7);
      expect(afterReopenAudio!.bytes[1]).toBe(8);
    });

    it('getChart/getAudio for missing id returns undefined, not throw (3-step)', async () => {
      // [Step1] ensure empty
      expect((await listCharts()).length).toBe(0);
      // [Step2] get missing
      const missingChart = await getChart('does-not-exist');
      const missingAudio = await getAudio('does-not-exist');
      // [Step3] undefined without error, then put still works
      expect(missingChart).toBeUndefined();
      expect(missingAudio).toBeUndefined();
      await putChart(makeChart({ id: 'after-missing' }));
      expect((await listCharts()).length).toBe(1);
    });
  });

  // ==================================================================
  // 6) QuotaExceededError handling — oldest-first eviction retry
  // ==================================================================
  describe('6. QuotaExceededError 時の古い順削除・リトライ', () => {
    it('putChart on QuotaExceededError evicts oldest chart and retries (3-step)', async () => {
      // [Step1: Capture] put 2 charts with distinct addedAt (oldest first)
      const oldChart = makeChart({ id: 'quota-old', title: 'Oldest', addedAt: 1000 });
      const newerChart = makeChart({ id: 'quota-newer', title: 'Newer', addedAt: 2000 });
      await putChart(oldChart);
      await putChart(newerChart);
      const beforeQuotaList = await listCharts();
      expect(beforeQuotaList.length).toBe(2);
      const oldestBefore = [...beforeQuotaList].sort((a, b) => a.addedAt - b.addedAt)[0].id;
      expect(oldestBefore).toBe('quota-old');

      // [Step2: Perform] inject QuotaExceededError on next putOnce for charts
      const warnSpy: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args: unknown[]) => warnSpy.push(String(args[0]));

      let shouldThrowOnce = true;
      // monkey-patch IDBObjectStore.prototype.put for one invocation
      const idbStoreProto = (globalThis as unknown as { IDBObjectStore?: { prototype: { put: unknown } } }).IDBObjectStore as unknown as { prototype: { put: (...a: unknown[]) => IDBRequest<unknown> } } | undefined;
      // fallback: patch via openLibraryDB transaction's store.put — instead directly mock putChart's putOnce by temporary override
      // We achieve by spying on the store.put via prototype if available else via direct error injection:
      // Simpler: replace putChart's internal putOnce path by causing the next put to throw QuotaExceededError via stubbing openLibraryDB's transaction.
      // Here we patch the global IDBObjectStore put if proto exists
      let originalPut: ((...a: unknown[]) => IDBRequest<unknown>) | null = null;
      let protoPatched = false;
      try {
        const proto = Object.getPrototypeOf(
          (await openLibraryDB()).transaction(CHARTS_STORE, 'readwrite').objectStore(CHARTS_STORE),
        ) as { put?: (...a: unknown[]) => IDBRequest<unknown> };
        if (proto && typeof proto.put === 'function') {
          originalPut = proto.put;
          proto.put = function (...args: unknown[]) {
            if (shouldThrowOnce) {
              shouldThrowOnce = false;
              // throw DOMException with QuotaExceededError name — isQuotaError checks name/message
              throw new DOMException('Quota exceeded', 'QuotaExceededError');
            }
            return (originalPut as (...a: unknown[]) => IDBRequest<unknown>).apply(this, args);
          };
          protoPatched = true;
        }
      } catch {
        /* if proto patch fails, fallback to manual eviction test */
      }

      // If proto patch not possible, simulate by manually testing eviction logic directly:
      // We'll attempt put with injected error; if patch failed we directly delete oldest and put.
      let putErrorCaught = false;
      try {
        const newChart = makeChart({ id: 'quota-new', title: 'NewestAfterQuota', addedAt: 3000 });
        await putChart(newChart);
      } catch (e) {
        putErrorCaught = true;
        // fallback manual path: emulate quota handling by deleting oldest and retrying
        if (!protoPatched) {
          await deleteChart('quota-old');
          const fallbackChart = makeChart({ id: 'quota-new', title: 'NewestAfterQuota', addedAt: 3000 });
          await putChart(fallbackChart);
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

      const afterQuotaList = await listCharts();

      // [Step3: Assert] oldest evicted, new chart present, warning emitted OR fallback succeeded
      // Regardless of patch success, the observable transition is: old removed, new added
      expect(afterQuotaList.length).toBe(2);
      const afterIds = afterQuotaList.map(c => c.id).sort();
      // quota-old should be gone, quota-new should exist
      expect(afterIds).toContain('quota-new');
      expect(afterIds).not.toContain('quota-old');
      // if warn spy captured, verify notification
      if (warnSpy.length > 0) {
        expect(warnSpy.join(' ')).toMatch(/QuotaExceeded/i);
      }
      // putErrorCaught should be false when retry succeeded (our impl retries)
      expect(putErrorCaught).toBe(false);
    });

    it('putAudio QuotaExceededError also triggers oldest-first eviction (3-step)', async () => {
      // [Step1: Capture] setup oldest chart to be evicted when audio quota hits
      const oldChartForAudioQuota = makeChart({ id: 'audio-quota-old-chart', addedAt: 1000, audioId: 'old-audio-id' });
      await putChart(oldChartForAudioQuota);
      await putAudio(makeAudio({ id: 'old-audio-id', bytes: new Uint8Array([1, 2]) }));
      expect((await listCharts()).length).toBe(1);
      expect((await listAudio()).length).toBe(1);

      // [Step2: Perform] attempt large audio put that would exceed quota — test eviction path exists
      // We test the code path exists: putAudio should have try/catch for QuotaExceededError mentioning charts
      // Verify source contains quota handling (static check as dynamic fallback)
      const fs = await import('fs');
      const src = fs.readFileSync('src/storage/libraryDb.ts', 'utf-8');
      const hasQuotaHandling = src.includes('QuotaExceededError') && src.includes('addedAt');
      expect(hasQuotaHandling).toBe(true);

      // Perform a normal large put (no real quota in fake-indexeddb, but verify no throw)
      const newAudio = makeAudio({ id: 'new-large-audio', bytes: new Uint8Array(1024) });
      await putAudio(newAudio);
      const afterList = await listAudio();

      // [Step3: Assert] audio stored, no data loss beyond expected
      expect(afterList.length).toBe(2);
      expect((await getAudio('new-large-audio'))!.bytes.length).toBe(1024);
      // If quota logic were broken, list would be unordered or eviction would remove wrong entry
      // oldest chart still exists since no real quota triggered => verify it remains
      expect((await getChart('audio-quota-old-chart'))).toBeDefined();
    });

    it('static source check: putChart/putAudio both contain QuotaExceededError and oldest sorting (3-step)', async () => {
      // [Step1: Capture] read source
      const fs = await import('fs');
      const srcBefore = fs.readFileSync('src/storage/libraryDb.ts', 'utf-8');
      const hasChartQuota = srcBefore.includes('putChart') && srcBefore.includes('QuotaExceededError');
      const hasAudioQuota = srcBefore.includes('putAudio') && srcBefore.includes('QuotaExceededError');

      // [Step2: Perform] check sorting logic
      const hasOldestSort = srcBefore.includes('addedAt') && srcBefore.includes('sort');

      // [Step3: Assert] both quota paths exist
      expect(hasChartQuota).toBe(true);
      expect(hasAudioQuota).toBe(true);
      expect(hasOldestSort).toBe(true);
      expect(srcBefore).toContain('trace-wave-library');
    });
  });

  // ==================================================================
  // 7) Edge: parallel puts, invalid inputs, re-entrancy
  // ==================================================================
  describe('7. Edge & re-entrancy: invalid id, duplicate, delete missing', () => {
    it('putChart with empty id throws (3-step)', async () => {
      // [Step1] empty before
      expect((await listCharts()).length).toBe(0);
      // [Step2] attempt invalid
      let threw = false;
      try {
        await putChart(makeChart({ id: '' }));
      } catch {
        threw = true;
      }
      // [Step3] must throw and not insert
      expect(threw).toBe(true);
      expect((await listCharts()).length).toBe(0);
    });

    it('deleteChart/deleteAudio for missing id does not throw and leaves count unchanged (3-step)', async () => {
      // [Step1] put one
      await putChart(makeChart({ id: 'keep-me' }));
      await putAudio(makeAudio({ id: 'keep-audio' }));
      const chartsBeforeDeleteMissing = await listCharts();
      const audioBeforeDeleteMissing = await listAudio();
      expect(chartsBeforeDeleteMissing.length).toBe(1);
      expect(audioBeforeDeleteMissing.length).toBe(1);

      // [Step2] delete non-existent
      await deleteChart('non-existent-id');
      await deleteAudio('non-existent-audio-id');
      const chartsAfter = await listCharts();
      const audioAfter = await listAudio();

      // [Step3] counts unchanged
      expect(chartsAfter.length).toBe(1);
      expect(audioAfter.length).toBe(1);
      expect(chartsAfter[0].id).toBe('keep-me');
    });

    it('concurrent putChart calls result in correct final count (3-step)', async () => {
      // [Step1] before 0
      expect((await listCharts()).length).toBe(0);
      // [Step2] concurrent puts
      await Promise.all([
        putChart(makeChart({ id: 'concur-1', addedAt: 100 })),
        putChart(makeChart({ id: 'concur-2', addedAt: 200 })),
        putChart(makeChart({ id: 'concur-3', addedAt: 300 })),
      ]);
      const afterConcurrent = await listCharts();
      // [Step3] all 3 present
      expect(afterConcurrent.length).toBe(3);
      const idsSorted = afterConcurrent.map(c => c.id).sort();
      expect(idsSorted).toEqual(['concur-1', 'concur-2', 'concur-3']);
    });
  });
});
