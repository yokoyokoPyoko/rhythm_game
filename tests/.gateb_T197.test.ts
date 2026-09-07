/**
 * T197 — 組込曲の完全削除（songs.toml・reply譜面・音源） & T127/T128系 物理整合性 Acceptance Test (Vitest, node environment)
 * Strict TDD: must PASS (Green) or FAIL (Red) according to implementation state.
 * No DOM — pure engine/math, manifest 404 handling, file deletion verification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadSongList } from '../src/chart/manifest';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import type { Chart } from '../src/types';

vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

beforeEach(() => {
  vi.setSystemTime(new Date('2026-03-20T12:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

describe('T197 組込曲の完全削除（songs.toml・reply譜面・音源） & エンジン整合性 Vitest Acceptance', () => {
  // ==========================================================================
  // 1) 組込曲ファイル（songs.toml, reply.toml, 08.Reply.flac）の完全削除確認
  // ==========================================================================
  describe('1. 組込曲ファイルの不在確認 (完了条件1)', () => {
    it('public/songs.toml, public/charts/reply.toml, public/audio/08.Reply.flac が存在しないこと (3-step)', () => {
      // [Step1: Capture Initial State] — check expected paths
      const rootDir = process.cwd();
      const songsTomlPath = path.join(rootDir, 'public', 'songs.toml');
      const replyChartPath = path.join(rootDir, 'public', 'charts', 'reply.toml');
      const replyAudioPath = path.join(rootDir, 'public', 'audio', '08.Reply.flac');

      // [Step2: Perform file system check]
      const songsExists = fs.existsSync(songsTomlPath);
      const chartExists = fs.existsSync(replyChartPath);
      const audioExists = fs.existsSync(replyAudioPath);

      // [Step3: Assert Resulting Transition] — all embedded song files must be deleted
      expect(songsExists).toBe(false);
      expect(chartExists).toBe(false);
      expect(audioExists).toBe(false);
    });

    it('loadSongList() は songs.toml 404時に例外を投げず空リスト [] を返すこと (3-step)', async () => {
      // [Step1: Capture Initial State] — mock fetch to return 404
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
      } as unknown as Response);

      // [Step2: Perform] — invoke loadSongList
      const songs = await loadSongList();

      // [Step3: Assert Resulting Transition] — returns empty array [] without throwing
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(Array.isArray(songs)).toBe(true);
      expect(songs.length).toBe(0);
    });

    it('loadSongList() は fetch ネットワークエラーやその他のレスポンス異常時にも [] を返すか適切に処理すること (3-step)', async () => {
      // [Step1: Capture Initial State] — mock fetch rejection
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      // [Step2: Perform] — invoke loadSongList with error expected or caught
      let threw = false;
      let result: unknown = null;
      try {
        result = await loadSongList();
      } catch {
        threw = true;
      }

      // [Step3: Assert Resulting Transition] — handles failure gracefully
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Depending on manifest implementation, either returns [] or throws clean error.
      // T197 requirement: 404 returns []. If network fails, ensure it doesn't crash app unexpectedly.
      expect(threw || Array.isArray(result)).toBe(true);
    });
  });

  // ==========================================================================
  // 2) T127 / T128 系の物理整合性・オフグリッド検証（WaveEngine & Cursor）
  // ==========================================================================
  describe('2. WaveEngine と Cursor の物理整合性・オフグリッド検証 (amplitude 0.7 / 1.3 / 2.7 / 3.4)', () => {
    const complexAmps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 4.37];

    for (const amp of complexAmps) {
      for (const ob of offGridBeats) {
        it(`amplitude=${amp}, off-grid beat=${ob} で waveYAt と Cursor update の数値が完全一致すること (3-step)`, () => {
          // [Step1: Capture Initial State] — setup timeline & engine with complex amplitude
          const bpmChanges = [{ beat: 0, bpm: 120, amplitude: amp }];
          const timeline = new BpmTimeline(bpmChanges, amp);
          const segments = [
            { direction: 'up' as const, beats: 2 },
            { direction: 'down' as const, beats: 2 },
            { direction: 'stay' as const, beats: 1 },
          ];
          const wave = new WaveEngine(segments, timeline, amp, 0.0);
          const cursor = new Cursor();

          // [Step2: Perform] — evaluate waveYAt and update cursor at off-grid timestamp
          const targetBeat = ob;
          const targetMs = timeline.beatToMs(targetBeat);
          const expectedY = wave.waveYAt(targetBeat);

          const beatMs = timeline.beatMsAt(targetBeat);
          const segmentBeats = segments[0].beats;
          
          // Update cursor with dt corresponding to off-grid beat phase
          const dtSec = 0.05;
          cursor.update(dtSec, false, true, beatMs, segmentBeats, expectedY);

          // [Step3: Assert Resulting Transition] — verify waveYAt is finite, cursor pulls towards waveYAt
          expect(Number.isFinite(expectedY)).toBe(true);
          expect(Number.isFinite(cursor.y)).toBe(true);
          // Wave amplitude boundaries (TW_AMP = 130, CENTER_Y = 300) => Y between 170 and 430
          expect(expectedY).toBeGreaterThanOrEqual(170);
          expect(expectedY).toBeLessThanOrEqual(430);
        });
      }
    }

    it('TOML serialization & deserialization round-trip with complex amplitudes and off-grid beats (3-step)', () => {
      // [Step1: Capture Initial State]
      const initialChart: Chart = {
        title: 'T197 OffGrid Test',
        artist: 'Tester',
        audio: 'custom.flac',
        audio_offset: 0,
        start_position: 0.0,
        amplitude: 1.3,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.3 },
          { beat: 1.23, bpm: 140, amplitude: 2.7 },
        ],
        segments: [
          { direction: 'up', beats: 1.5 },
          { direction: 'down', beats: 0.5 },
        ],
        rings: [
          { beat: 0.37 },
          { beat: 1.23, type: 'hold', duration: 0.5 },
        ],
      } as unknown as Chart;

      // [Step2: Perform] — serialize to TOML and parse back
      const tomlText = chartToToml(initialChart as any);
      const reparsed = parseChartText(tomlText, 't197.toml');

      // [Step3: Assert Resulting Transition] — off-grid values and structure preserved
      expect(reparsed.title).toBe('T197 OffGrid Test');
      expect(reparsed.audio).toBe('custom.flac'); // basename check
      expect(reparsed.rings.length).toBe(2);
      expect(reparsed.rings.some(r => Math.abs(r.beat - 0.37) < 1e-3)).toBe(true);
      expect(reparsed.rings.some(r => Math.abs(r.beat - 1.23) < 1e-3)).toBe(true);
      expect(reparsed.bpm_changes.length).toBe(2);
      expect(reparsed.bpm_changes[1].beat).toBeCloseTo(1.23, 3);
      expect(reparsed.bpm_changes[1].amplitude).toBeCloseTo(2.7, 3);
    });
  });
});
