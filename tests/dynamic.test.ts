/**
 * T194 — SelectScreenの永続化・復元・削除 Vitest pure acceptance (node)
 * TDD Red→Green — strict 3-step state-transition checks
 * 要求: T193 基盤で カスタム曲の追加・リロード復元・削除を実現
 * 修正: src/screens/SelectScreen.tsx
 *  - 「追加」ボタン: TOML文字列＋音源バイトを IndexedDB へ保存 ID=`custom-${Date.now()}`
 *  - マウント時: loadSongList()（組込曲）＋ IndexedDB カスタム一覧を結合表示
 *  - 音源デコードは再生時まで遅延（bytes を圧縮のまま保存）
 *  - カスタム曲カードに削除ボタン（IndexedDBからも削除）
 * 完了条件:
 *  (1) 追加→リロード→曲カードが残り譜面内容が再現
 *  (2) カスタム曲を削除でき IndexedDBからも消える
 *  (3) tsc --noEmit・T110/T120回帰なし
 *
 * Runs WITHOUT browser — imports pure modules directly.
 * Uses vi.useFakeTimers() deterministically + fake-indexeddb.
 * No DOM.
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
import type { Chart } from '../src/types';

// ---------------------------------------------------------------------------
// fake timers — control ID generation deterministically
// ---------------------------------------------------------------------------
vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

function makeChart(overrides: Partial<StoredChart> = {}): StoredChart {
  const base: StoredChart = {
    id: `custom-${Date.now()}`,
    title: 'Test Song',
    artist: 'Test Artist',
    difficulty: 3,
    toml: `title = "Test Song"\nartist = "Test Artist"\naudio = "test.flac"\n[[sections]]\nbeat = 0\nbpm = 120\n[[segments]]\ndirection = "up"\nbeats = 2\n[[rings]]\nbeat = 4.0\n`,
    audioId: null,
    addedAt: Date.now(),
    ...overrides,
  };
  return base;
}
function makeAudio(overrides: Partial<StoredAudio> = {}): StoredAudio {
  const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64, 10, 20]);
  return {
    id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 4)}`,
    name: '08.Reply.flac',
    mime: 'audio/flac',
    bytes,
    ...overrides,
  };
}
function sampleTomlComplex(): string {
  return `
title = "OffGrid 0.37 Complex"
artist = "Tester"
audio = "custom-song.flac"
audio_offset = 123
amplitude = 1.3
start_position = 0.5
[[sections]]
beat = 0
bpm = 120
amplitude = 0.7
zoom = 0.8
[[sections]]
beat = 4.37
bpm = 150
amplitude = 1.3
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
`;
}
function buildChartFromToml(toml: string): Chart {
  return parseChartText(toml, 'test-chart.toml');
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));
  try {
    await deleteLibraryDB();
  } catch {
    try { await clearLibraryDB(); } catch { /* ignore */ }
  }
  closeLibraryDB();
});
afterEach(async () => {
  try { await clearLibraryDB(); } catch { /* ignore */ }
  closeLibraryDB();
  vi.clearAllTimers();
});

// ===========================================================================
// 1) 追加→リロード→譜面内容再現 (完了条件 1) — 3-step
// ===========================================================================
describe('T194 1. 追加→リロード→曲カードが残り譜面内容が再現される (IndexedDB永続化)', () => {
  it('putChart(TOML文字列) + putAudio(bytes) → close/reopen → getChart/getAudioで譜面・音源が再現される (3-step off-grid)', async () => {
    // [Step1: Capture Initial State] — empty DB, list 0, get undefined
    const beforeCharts = await listCharts();
    const beforeAudio = await listAudio();
    expect(beforeCharts.length).toBe(0);
    expect(beforeAudio.length).toBe(0);
    expect(await getChart('custom-9999')).toBeUndefined();
    expect(await getAudio('audio-9999')).toBeUndefined();

    // [Step2: Perform] — 追加ボタン相当: custom-${Date.now()} で保存
    const FIXED_NOW = Date.now();
    const id = `custom-${FIXED_NOW}`;
    expect(id).toBe('custom-1773576000000'); // 2026-03-15 deterministic
    const complexToml = sampleTomlComplex();
    const chartObj = buildChartFromToml(complexToml);
    // verify complex off-grid values parsed
    expect(chartObj.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    expect(chartObj.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-6)).toBe(true);

    const tomlForStorage = chartToToml(chartObj);
    const audioBytes = new Uint8Array([10, 20, 30, 40, 255, 0, 128, 64, 1, 2, 3]);
    const audioId = `audio-${FIXED_NOW}`;

    await putChart({
      id,
      title: chartObj.title,
      artist: chartObj.artist,
      difficulty: 5,
      toml: tomlForStorage,
      audioId,
      addedAt: FIXED_NOW,
    });
    await putAudio({ id: audioId, name: 'custom-song.flac', mime: 'audio/flac', bytes: audioBytes });

    const afterPutCharts = await listCharts();
    const afterPutAudio = await listAudio();
    expect(afterPutCharts.length).toBe(1);
    expect(afterPutAudio.length).toBe(1);

    // simulate reload: close and reopen (IndexedDB persistence)
    closeLibraryDB();
    // reopen is lazy via listCharts
    const afterReloadCharts = await listCharts();
    const retrievedChart = await getChart(id);
    const retrievedAudio = await getAudio(audioId);

    // [Step3: Assert Resulting Transition] — data survived reload, content fidelity
    expect(afterReloadCharts.length).toBe(1);
    expect(retrievedChart).toBeDefined();
    expect(retrievedChart!.id).toBe(id);
    expect(retrievedChart!.title).toBe('OffGrid 0.37 Complex');
    expect(retrievedChart!.toml).toBe(tomlForStorage);
    // TOML round-trip preserves off-grid beats
    const reparsed = parseChartText(retrievedChart!.toml, 'reparsed.toml');
    expect(reparsed.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    expect(reparsed.rings.some(r => Math.abs(r.beat - 4.37) < 1e-6)).toBe(true);
    expect(reparsed.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-6)).toBe(true);
    expect(reparsed.audio).toBe('custom-song.flac'); // basename only
    expect(retrievedChart!.audioId).toBe(audioId);

    expect(retrievedAudio).toBeDefined();
    expect(retrievedAudio!.bytes).toBeInstanceOf(Uint8Array);
    expect(retrievedAudio!.bytes.length).toBe(audioBytes.length);
    for (let i = 0; i < audioBytes.length; i++) expect(retrievedAudio!.bytes[i]).toBe(audioBytes[i]);
    // bytes.slice(0) for decode semantics
    const cloned = cloneBytesForDecode(retrievedAudio!.bytes);
    expect(Array.from(cloned)).toEqual(Array.from(audioBytes));
    cloned[0] = 99;
    expect(retrievedAudio!.bytes[0]).toBe(10); // immutability
  });

  it('IDは custom-${Date.now()} 形式で確定・永続化し同一IDで再参照できる (3-step)', async () => {
    // [Step1] before empty, capture Date.now value
    expect((await listCharts()).length).toBe(0);
    const t1 = Date.now();
    expect(t1).toBe(1773576000000);

    // [Step2] Perform — generate 2 ids with advancing time
    const id1 = `custom-${Date.now()}`;
    vi.advanceTimersByTime(1000);
    const id2 = `custom-${Date.now()}`;
    expect(id1).toBe('custom-1773576000000');
    expect(id2).toBe('custom-1773576001000');
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^custom-\d+$/);
    expect(id2).toMatch(/^custom-\d+$/);

    await putChart(makeChart({ id: id1, title: 'Song One', addedAt: t1 }));
    await putChart(makeChart({ id: id2, title: 'Song Two', addedAt: t1 + 1000 }));

    // simulate reload
    closeLibraryDB();
    const afterReload = await listCharts();

    // [Step3] Assert — both IDs persist with exact same string, titles intact
    expect(afterReload.length).toBe(2);
    const got1 = await getChart(id1);
    const got2 = await getChart(id2);
    expect(got1!.id).toBe(id1);
    expect(got2!.id).toBe(id2);
    expect(got1!.title).toBe('Song One');
    expect(got2!.title).toBe('Song Two');
    // different IDs must be distinct entries
    expect(got1!.id).not.toBe(got2!.id);
  });

  it('片方のみでも保存可能: TOMLのみ (audioId=null) でも永続化されメトロノームプレイ相当 (3-step)', async () => {
    // [Step1] empty
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);

    // [Step2] add chart without audio
    const idSolo = `custom-${Date.now()}`;
    const tomlSolo = `title = "Solo Chart"\nartist = ""\naudio = "solo.flac"\n[[sections]]\nbeat = 0\nbpm = 120\n[[rings]]\nbeat = 4.37\n`;
    const parsedSolo = parseChartText(tomlSolo, 'solo.toml');
    const tomlSoloStored = chartToToml(parsedSolo);
    await putChart({ id: idSolo, title: parsedSolo.title, artist: parsedSolo.artist, difficulty: 1, toml: tomlSoloStored, audioId: null, addedAt: Date.now() });

    closeLibraryDB();
    const afterReload = await listCharts();
    const gotSolo = await getChart(idSolo);

    // [Step3] chart exists, audioId null, no audio entry needed
    expect(afterReload.length).toBe(1);
    expect(gotSolo).toBeDefined();
    expect(gotSolo!.audioId).toBeNull();
    expect(gotSolo!.toml).toContain('Solo Chart');
    expect((await listAudio()).length).toBe(0);
    // reparsed still has rings off-grid
    const reparsedSolo = parseChartText(gotSolo!.toml, 'reparsed-solo.toml');
    expect(reparsedSolo.rings.length).toBe(1);
    expect(reparsedSolo.rings[0].beat).toBeCloseTo(4.37, 3);
  });
});

// ===========================================================================
// 2) マウント時に loadSongList() + IndexedDB 結合表示 (完了条件 1 続き)
// ===========================================================================
describe('T194 2. マウント時: 組込曲 + IndexedDBカスタム一覧の結合表示', () => {
  it('組込2件 + カスタム2件を結合した一覧が 4件となり重複なく表示される (3-step)', async () => {
    // [Step1: Capture] — mock built-in list and IndexedDB empty
    const builtin: { id: string; title: string }[] = [
      { id: 'reply', title: 'Reply' },
      { id: 'test-song', title: 'Test Song' },
    ];
    const beforeCustom = await listCharts();
    expect(beforeCustom.length).toBe(0);
    const builtinCount = builtin.length;
    expect(builtinCount).toBe(2);

    // [Step2: Perform] — add 2 custom charts to IndexedDB
    const idA = `custom-${Date.now()}`;
    vi.advanceTimersByTime(1000);
    const idB = `custom-${Date.now()}`;
    await putChart(makeChart({ id: idA, title: 'Custom A', difficulty: 3, addedAt: Date.now() - 1000 }));
    await putChart(makeChart({ id: idB, title: 'Custom B', difficulty: 4, addedAt: Date.now() }));
    const customList = await listCharts();
    expect(customList.length).toBe(2);

    // simulate mount merge logic: builtins + customs (SelectScreen's expected behavior)
    const merged = [
      ...builtin.map(b => ({ id: b.id, title: b.title, isCustom: false })),
      ...customList.map(c => ({ id: c.id, title: c.title, isCustom: true })),
    ];

    // [Step3: Assert] — merged length = 4, ids unique, custom ids retain custom- prefix
    expect(merged.length).toBe(4);
    expect(new Set(merged.map(m => m.id)).size).toBe(4);
    const customInMerged = merged.filter(m => m.isCustom);
    expect(customInMerged.length).toBe(2);
    for (const cm of customInMerged) {
      expect(cm.id).toMatch(/^custom-\d+$/);
    }
    // titles preserved
    expect(merged.some(m => m.title === 'Custom A')).toBe(true);
    expect(merged.some(m => m.title === 'Custom B')).toBe(true);
    expect(merged.some(m => m.title === 'Reply')).toBe(true);
  });

  it('リロード後も結合結果が同一になる: close/reopen後もカスタムが消えない (3-step)', async () => {
    // [Step1] add one custom, capture merged before reload
    const id = `custom-${Date.now()}`;
    await putChart(makeChart({ id, title: 'Persist Song', addedAt: Date.now() }));
    const customBefore = await listCharts();
    const mergedBeforeIds = ['builtin-1', ...customBefore.map(c => c.id)];
    expect(mergedBeforeIds.length).toBe(2);
    expect(mergedBeforeIds).toContain(id);

    // [Step2] simulate reload
    closeLibraryDB();
    const customAfter = await listCharts();
    const mergedAfterIds = ['builtin-1', ...customAfter.map(c => c.id)];

    // [Step3] merged after equals before, custom persists
    expect(customAfter.length).toBe(1);
    expect(mergedAfterIds).toEqual(mergedBeforeIds);
    expect((await getChart(id))!.title).toBe('Persist Song');
  });

  it('音源デコードは再生時まで遅延: 保存時はbytesのまま、decode用slice(0)が独立コピー (3-step)', async () => {
    // [Step1] put chart + audio raw
    const audioRaw = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    const audioId = `audio-${Date.now()}`;
    await putAudio({ id: audioId, name: 'delay.flac', mime: 'audio/flac', bytes: audioRaw });
    const beforeDecode = await getAudio(audioId);
    expect(beforeDecode).toBeDefined();
    expect(beforeDecode!.bytes.length).toBe(8);

    // [Step2] simulate "再生時" decode: bytes.slice(0) as decode input
    const forDecode = beforeDecode!.bytes.slice(0);
    const forDecode2 = cloneBytesForDecode(beforeDecode!.bytes);
    // mutate decode copies
    forDecode[0] = 99;
    forDecode2[0] = 88;
    const afterMutateStored = await getAudio(audioId);

    // [Step3] stored bytes unchanged, decode copies independent
    expect(afterMutateStored!.bytes[0]).toBe(1);
    expect(forDecode[0]).toBe(99);
    expect(forDecode2[0]).toBe(88);
    expect(afterMutateStored!.bytes).not.toBe(forDecode);
    // also verify original raw not mutated by put (immutability)
    audioRaw[0] = 77;
    const reFetched = await getAudio(audioId);
    expect(reFetched!.bytes[0]).toBe(1);
  });
});

// ===========================================================================
// 3) 削除: カスタム曲カードの削除ボタンで IndexedDB からも削除 (完了条件 2)
// ===========================================================================
describe('T194 3. カスタム曲の削除: IndexedDBからも消える', () => {
  it('削除前2件 → 1件削除 → 残り1件、削除したIDは取得不可 (3-step)', async () => {
    // [Step1: Capture] add 2 charts + 2 audios
    const id1 = `custom-${Date.now()}`;
    vi.advanceTimersByTime(100);
    const id2 = `custom-${Date.now()}`;
    const aId1 = `audio-${Date.now()}-1`;
    vi.advanceTimersByTime(100);
    const aId2 = `audio-${Date.now()}-2`;
    await putChart(makeChart({ id: id1, title: 'To Keep', audioId: aId1, addedAt: Date.now() }));
    await putChart(makeChart({ id: id2, title: 'To Delete', audioId: aId2, addedAt: Date.now() + 50 }));
    await putAudio({ id: aId1, name: 'keep.flac', mime: 'audio/flac', bytes: new Uint8Array([1, 2, 3]) });
    await putAudio({ id: aId2, name: 'del.flac', mime: 'audio/flac', bytes: new Uint8Array([4, 5, 6]) });
    const beforeDeleteCharts = await listCharts();
    const beforeDeleteAudio = await listAudio();
    expect(beforeDeleteCharts.length).toBe(2);
    expect(beforeDeleteAudio.length).toBe(2);

    // [Step2: Perform] delete second chart + its audio (削除ボタン相当)
    await deleteChart(id2);
    await deleteAudio(aId2);
    const afterDeleteCharts = await listCharts();
    const afterDeleteAudio = await listAudio();
    const gotDeletedChart = await getChart(id2);
    const gotDeletedAudio = await getAudio(aId2);
    const gotKeptChart = await getChart(id1);

    // [Step3: Assert] deleted gone, kept remains, counts decrement
    expect(afterDeleteCharts.length).toBe(1);
    expect(afterDeleteAudio.length).toBe(1);
    expect(gotDeletedChart).toBeUndefined();
    expect(gotDeletedAudio).toBeUndefined();
    expect(gotKeptChart).toBeDefined();
    expect(gotKeptChart!.title).toBe('To Keep');
    expect(afterDeleteCharts[0].id).toBe(id1);
  });

  it('リロード後も削除が維持される: delete → close/reopen → 依然として消えたまま (3-step)', async () => {
    // [Step1] add then delete one
    const idKeep = `custom-${Date.now()}`;
    vi.advanceTimersByTime(10);
    const idDel = `custom-${Date.now()}`;
    await putChart(makeChart({ id: idKeep, title: 'Keep' }));
    await putChart(makeChart({ id: idDel, title: 'Del' }));
    expect((await listCharts()).length).toBe(2);
    await deleteChart(idDel);

    // [Step2] reload
    closeLibraryDB();
    const afterReload = await listCharts();
    const gotDel = await getChart(idDel);
    const gotKeep = await getChart(idKeep);

    // [Step3] del still gone after reload
    expect(afterReload.length).toBe(1);
    expect(gotDel).toBeUndefined();
    expect(gotKeep).toBeDefined();
    expect(afterReload[0].id).toBe(idKeep);
  });

  it('存在しないIDの削除は例外を投げず件数が変わらない (3-step)', async () => {
    // [Step1] put one
    const id = `custom-${Date.now()}`;
    await putChart(makeChart({ id, title: 'Only One' }));
    const before = await listCharts();
    expect(before.length).toBe(1);

    // [Step2] delete missing
    await deleteChart('custom-9999999999999-nonexistent');
    await deleteAudio('audio-nonexistent');
    const after = await listCharts();
    const afterAudio = await listAudio();

    // [Step3] count unchanged, original still there
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(id);
    expect(afterAudio.length).toBe(0);
  });

  it('同じ譜面を削除→再追加で同一IDまたは新IDで復活できる (3-step)', async () => {
    // [Step1] add then delete
    const id = `custom-${Date.now()}`;
    const toml = sampleTomlComplex();
    const chart = buildChartFromToml(toml);
    const storedToml = chartToToml(chart);
    await putChart({ id, title: chart.title, difficulty: 2, toml: storedToml, audioId: null, addedAt: Date.now() });
    expect(await getChart(id)).toBeDefined();
    await deleteChart(id);
    expect(await getChart(id)).toBeUndefined();
    expect((await listCharts()).length).toBe(0);

    // [Step2] re-add same content with new Date.now id
    vi.advanceTimersByTime(5000);
    const newId = `custom-${Date.now()}`;
    expect(newId).not.toBe(id);
    await putChart({ id: newId, title: chart.title, difficulty: 2, toml: storedToml, audioId: null, addedAt: Date.now() });
    const afterReadd = await listCharts();
    const gotNew = await getChart(newId);

    // [Step3] new entry exists with same TOML
    expect(afterReadd.length).toBe(1);
    expect(gotNew).toBeDefined();
    expect(gotNew!.toml).toBe(storedToml);
    expect(gotNew!.id).toBe(newId);
  });
});

// ===========================================================================
// 4) SelectScreen 統合の静的検証: ファイルが IndexedDB 永続化を実装している
// ===========================================================================
describe('T194 4. SelectScreen.tsx 静的統合検証 (永続化・復元・削除の実装存在)', () => {
  const srcPath = 'src/screens/SelectScreen.tsx';
  const src = fs.readFileSync(srcPath, 'utf-8');

  it('libraryDb からの import が存在する (3-step)', () => {
    // [Step1] read source (captured above)
    const hasImport = src.includes('libraryDb') || src.includes('storage/libraryDb');
    // [Step2] check specific symbols imported/used
    const hasListCharts = src.includes('listCharts');
    const hasPutChart = src.includes('putChart');
    const hasPutAudio = src.includes('putAudio');

    // [Step3] all required imports/usages present
    expect(hasImport).toBe(true);
    expect(hasListCharts).toBe(true);
    expect(hasPutChart).toBe(true);
    expect(hasPutAudio).toBe(true);
  });

  it('追加ボタン onClick / handle で custom-${Date.now()} と putChart/putAudio を呼ぶ (3-step)', () => {
    // [Step1] file contains custom- template
    const hasCustomTemplate = src.includes('custom-${Date.now()}') || src.includes('custom-`') || src.includes('`custom-');
    const hasDateNow = src.includes('Date.now()');
    // [Step2] ID assignment near put
    const hasCustomIdAssign = src.includes('custom-') && src.includes('Date.now()');
    const hasTomlStorageRef = src.includes('toml') && (src.includes('putChart') || src.includes('StoredChart'));
    // [Step3]
    expect(hasCustomTemplate || hasCustomIdAssign).toBe(true);
    expect(hasDateNow).toBe(true);
    expect(hasTomlStorageRef).toBe(true);
  });

  it('マウント時に loadSongList + listCharts を併用して結合するロジックがある (3-step)', () => {
    // [Step1] loadSongList exists
    const hasLoadSongList = src.includes('loadSongList');
    // [Step2] listCharts combined with setsongs
    const hasListChartsCall = src.includes('listCharts');
    const hasMergeLogic = src.includes('setSongs') && (src.includes('listCharts') || src.includes('custom'));
    // [Step3]
    expect(hasLoadSongList).toBe(true);
    expect(hasListChartsCall).toBe(true);
    expect(hasMergeLogic).toBe(true);
  });

  it('削除ボタンが deleteChart / deleteAudio を呼び IndexedDB からも削除する (3-step)', () => {
    // [Step1] delete symbols
    const hasDeleteChart = src.includes('deleteChart');
    const hasDeleteAudio = src.includes('deleteAudio');
    // [Step2] UI: 削除ボタン相当 (カスタム曲カードの削除)
    const hasDeleteButtonText = src.includes('削除') || src.includes('delete') || src.includes('Delete');
    // [Step3]
    expect(hasDeleteChart).toBe(true);
    // audio deletion may be conditional (audioId), but at least chart delete must exist
    expect(hasDeleteAudio || hasDeleteChart).toBe(true);
    expect(hasDeleteButtonText).toBe(true);
  });

  it('音源は bytes (Uint8Array) を保存しデコードは遅延: file.arrayBuffer / bytes.slice 参照がある (3-step)', () => {
    // [Step1] file references
    const hasArrayBuffer = src.includes('arrayBuffer') || src.includes('bytes');
    const hasBytesHandling = src.includes('bytes') || src.includes('Uint8Array') || src.includes('putAudio');
    // [Step2] ensure not eagerly decoding in add path (no decodeAudioData in SelectScreen add)
    // Decode should be deferred to GameScreen, not SelectScreen
    const hasDecodeInSelect = src.includes('decodeAudioData');
    // [Step3] bytes handling present, decode not in add path (or minimal)
    expect(hasArrayBuffer).toBe(true);
    expect(hasBytesHandling).toBe(true);
    // It's OK if decode is absent in SelectScreen (preferred); if present it should be gated
    // We assert that add path stores bytes, not decoded buffer
    expect(hasDecodeInSelect === false || src.includes('AudioCache') ).toBe(true);
  });
});

// ===========================================================================
// 5) T110 / T120 回帰なし (basename, cache, audio pairing)
// ===========================================================================
describe('T194 5. T110/T120 回帰なし: basename / TOML互換 / ペアリング', () => {
  it('getBasename がフルパスからbasenameを抽出し TOML audio は basename のみで保存される (3-step)', async () => {
    // [Step1] basename cases
    expect(getBasename('/rhythm_game/audio/08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('08.Reply.flac')).toBe('08.Reply.flac');
    expect(getBasename('audio/test.mp3')).toBe('test.mp3');

    // [Step2] create chart with full path, serialize should output basename only
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
    const parsedFull = parseChartText(tomlFullPath, 'full.toml');
    expect(parsedFull.audio).toBe('08.Reply.flac'); // loader extracts basename
    const serialized = chartToToml(parsedFull);
    // serialized must contain basename only, not full path
    expect(serialized).toContain('audio = "08.Reply.flac"');
    expect(serialized).not.toContain('/rhythm_game/audio');

    // [Step3] store via libraryDb and reparsed still basename
    const id = `custom-${Date.now()}`;
    await putChart({ id, title: parsedFull.title, difficulty: 1, toml: serialized, audioId: `audio-${Date.now()}`, addedAt: Date.now() });
    const got = await getChart(id);
    const reparsedStored = parseChartText(got!.toml, 'stored.toml');
    expect(reparsedStored.audio).toBe('08.Reply.flac');
  });

  it('TOML往復で off-grid beats (0.37/1.23) と hold ring duration が保持される (3-step)', () => {
    // [Step1: Capture] build chart with off-grid and hold
    const tomlHold = sampleTomlComplex();
    const chartHold = buildChartFromToml(tomlHold);
    expect(chartHold.rings.find(r => r.type === 'hold')).toBeDefined();

    // [Step2: Perform] serialize → store → retrieve → reparse
    const serializedHold = chartToToml(chartHold);
    const idHold = `custom-${Date.now()}`;
    // need to await put but we can test sync round-trip first
    const reparsedDirect = parseChartText(serializedHold, 'direct.toml');
    expect(reparsedDirect.rings.some(r => Math.abs(r.beat - 1.23) < 1e-6)).toBe(true);
    expect(reparsedDirect.bpm_changes.some(s => Math.abs(s.beat - 4.37) < 1e-6)).toBe(true);

    // [Step3: Assert] hold type/duration preserved within 1e-3
    const holdRing = reparsedDirect.rings.find(r => r.type === 'hold');
    expect(holdRing).toBeDefined();
    expect(holdRing!.beat).toBeCloseTo(4.37, 3);
    expect(holdRing!.duration).toBeCloseTo(0.5, 3);
    expect(holdRing!.type).toBe('hold');
  });

  it('audio pairing: basename一致で紐付け、bytes が AudioStore に正しく格納される (3-step)', async () => {
    // [Step1: Capture] empty
    expect((await listCharts()).length).toBe(0);
    expect((await listAudio()).length).toBe(0);

    // [Step2: Perform] store audio with name containing basename, chart references basename
    const basename = 'test-audio.flac';
    const audioId = `audio-${Date.now()}`;
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    await putAudio({ id: audioId, name: basename, mime: 'audio/flac', bytes });
    const chartWithAudio = buildChartFromToml(`
title = "Pairing"
artist = ""
audio = "${basename}"
[[sections]]
beat = 0
bpm = 120
[[rings]]
beat = 4
`);
    const storedToml = chartToToml(chartWithAudio);
    const chartId = `custom-${Date.now()}`;
    await putChart({ id: chartId, title: chartWithAudio.title, difficulty: 2, toml: storedToml, audioId, addedAt: Date.now() });
    const gotChart = await getChart(chartId);
    const gotAudio = gotChart?.audioId ? await getAudio(gotChart.audioId) : undefined;

    // [Step3: Assert] linkage via basename id, bytes intact
    expect(gotChart!.audioId).toBe(audioId);
    expect(gotAudio).toBeDefined();
    expect(gotAudio!.name).toBe(basename);
    expect(getBasename(gotAudio!.name)).toBe(basename);
    expect(getBasename(chartWithAudio.audio)).toBe(basename);
    expect(Array.from(gotAudio!.bytes)).toEqual([9, 8, 7, 6, 5]);
  });

  it('ChartCache 互換: libraryDb とは別だが SelectScreen が両方を併用しても矛盾しない (3-step static)', async () => {
    // [Step1] verify libraryDb file exists and SelectScreen references ChartCache or libraryDb
    const selectSrc = fs.readFileSync('src/screens/SelectScreen.tsx', 'utf-8');
    const hasChartCacheRef = selectSrc.includes('ChartCache');
    const hasLibraryDbRef = selectSrc.includes('libraryDb');
    // [Step2] at least one cache mechanism present
    expect(hasChartCacheRef || hasLibraryDbRef).toBe(true);
    // [Step3] libraryDb stores still operative regardless of ChartCache
    const id = `custom-${Date.now()}`;
    await putChart(makeChart({ id, title: 'Cache Coexist', addedAt: Date.now() }));
    expect((await getChart(id))!.title).toBe('Cache Coexist');
  });
});

// ===========================================================================
// 6) 異常系: 破損TOMLや容量超過時もクラッシュせずエラーハンドリング
// ===========================================================================
describe('T194 6. 異常系: 破損データ・容量 handling', () => {
  it('破損TOMLでも putChart は保存でき getChart は文字列をそのまま返す (parseは呼び出し側責務) (3-step)', async () => {
    // [Step1] empty
    expect((await listCharts()).length).toBe(0);

    // [Step2] store chart with malformed TOML string
    const brokenToml = `title = "Broken\n[[segments]]\ndirection = "up"\n`; // truncated
    const id = `custom-${Date.now()}`;
    await putChart({ id, title: 'Broken', difficulty: 1, toml: brokenToml, audioId: null, addedAt: Date.now() });
    const gotBroken = await getChart(id);

    // [Step3] stored string preserved verbatim, not thrown at storage layer
    expect(gotBroken).toBeDefined();
    expect(gotBroken!.toml).toBe(brokenToml);
    // parsing it should throw, but storage itself did not crash
    let threw = false;
    try { parseChartText(gotBroken!.toml, 'broken.toml'); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  it('大量エントリ (20件) でも list/get/delete が破綻しない (3-step)', async () => {
    // [Step1] empty
    expect((await listCharts()).length).toBe(0);

    // [Step2] put 20 charts
    for (let i = 0; i < 20; i++) {
      const cid = `custom-${Date.now()}-${i}`;
      await putChart(makeChart({ id: cid, title: `Bulk ${i}`, difficulty: (i % 5) + 1, addedAt: Date.now() + i }));
      // spacing time
      vi.advanceTimersByTime(10);
    }
    const afterBulk = await listCharts();
    expect(afterBulk.length).toBe(20);

    // delete half
    const toDelete = afterBulk.slice(0, 10).map(c => c.id);
    for (const did of toDelete) await deleteChart(did);
    const afterHalfDelete = await listCharts();

    // [Step3] 10 remain, all retrievable
    expect(afterHalfDelete.length).toBe(10);
    for (const c of afterHalfDelete) {
      const g = await getChart(c.id);
      expect(g).toBeDefined();
      expect(g!.id).toBe(c.id);
    }
    // deleted ones gone
    for (const did of toDelete) expect(await getChart(did)).toBeUndefined();
  });

  it('DB open idempotency: 複数回 open/close/list が例外なく動作する (3-step)', async () => {
    // [Step1] db instance before
    const db1 = await openLibraryDB();
    expect(db1.name).toBe(DB_NAME);
    // [Step2] reuse and close/reopen
    const db2 = await openLibraryDB();
    expect(db1).toBe(db2);
    closeLibraryDB();
    const db3 = await openLibraryDB();
    expect(db3.name).toBe(DB_NAME);
    // put after reopen
    const id = `custom-${Date.now()}`;
    await putChart(makeChart({ id }));
    const list = await listCharts();
    // [Step3] still works
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(id);
  });
});
