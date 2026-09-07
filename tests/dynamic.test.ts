/**
 * @vitest-environment node
 * T185 Unit Tests: 録音カーソルの上下端突き抜け修正（クランプ無条件化）
 *
 * 根本原因: Cursor.update が nowWaveY 有限時のみクランプするため、
 * 録音ループ (update without 5th arg) で無制限発散する。
 * 修正: クランプを無条件化 (nowWaveY の有無に関わらず常に [waveTop, waveBottom] に収める)。
 * T163 スナップ自体は nowWaveY 有限時のみ従来通り。録音側は第5引数を渡さない。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cursor } from '../src/game/cursor';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';

const WAVE_TOP = TW_CENTER_Y - TW_AMP; // 170
const WAVE_BOTTOM = TW_CENTER_Y + TW_AMP; // 430

// helper: run cursor update for many frames without nowWaveY (recording mode)
function runRecordingFrames(
  cursor: Cursor,
  frames: number,
  up: boolean,
  down: boolean,
  beatMs: number,
  dt = 1 / 60,
) {
  for (let i = 0; i < frames; i++) {
    // recording: intentionally NO 5th arg (nowWaveY omitted)
    cursor.update(dt, up, down, beatMs);
  }
}

function runGameFrames(
  cursor: Cursor,
  frames: number,
  up: boolean,
  down: boolean,
  beatMs: number,
  nowWaveY: number,
  dt = 1 / 60,
) {
  for (let i = 0; i < frames; i++) {
    cursor.update(dt, up, down, beatMs, nowWaveY);
  }
}

describe('T185: 録音カーソルの上下端突き抜け修正（クランプ無条件化）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('録音モード: nowWaveY なしでも上下限クランプされること (Redテスト)', () => {
    it('Step1-3: 上キー押し続けでも Y が WAVE_TOP を突き抜けない (recording, no snap)', () => {
      // Step1: Capture initial state (center)
      const cursor = new Cursor(1.0, 0); // y = 300 CENTER
      expect(cursor.y).toBe(TW_CENTER_Y);
      const initialY = cursor.y;

      // Step2: Perform interaction — hold UP for many frames without nowWaveY
      // beatMs 500ms (120 BPM), amplitude 1.0 => speed 520 px/s
      runRecordingFrames(cursor, 300, true, false, 500);

      // Step3: Assert resulting transition — must stay clamped, not fly off-screen
      // Before fix: y = 300 - 520*(300/60) = -2300 -> FAIL
      // After fix: y == WAVE_TOP (170)
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cursor.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 5);
      expect(cursor.y).not.toBeLessThan(WAVE_TOP - 1);
      // ensure it actually moved towards top
      expect(cursor.y).toBeLessThan(initialY);
    });

    it('Step1-3: 下キー押し続けでも Y が WAVE_BOTTOM を突き抜けない (recording)', () => {
      const cursor = new Cursor(1.0, 0);
      expect(cursor.y).toBe(TW_CENTER_Y);
      const initialY = cursor.y;

      runRecordingFrames(cursor, 300, false, true, 500);

      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cursor.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
      expect(cursor.y).toBeCloseTo(WAVE_BOTTOM, 5);
      expect(cursor.y).toBeGreaterThan(initialY);
    });

    it('複雑な振幅 0.7/1.3/2.7/3.4 と端数 dt でも上下限を突き抜けない (off-grid)', () => {
      const amplitudes = [0.7, 1.3, 2.7, 3.4];
      const beatMss = [500, 400, 333.333, 600]; // 120,150,180,100 BPM
      const dts = [0.037, 0.016666, 0.123, 1 / 60];

      for (let idx = 0; idx < amplitudes.length; idx++) {
        const amp = amplitudes[idx];
        const beatMs = beatMss[idx];
        const dt = dts[idx];

        // up direction
        const cUp = new Cursor(amp, 0);
        for (let i = 0; i < 500; i++) {
          cUp.update(dt, true, false, beatMs); // no nowWaveY
        }
        expect(cUp.y, `amp=${amp} up should clamp to TOP`).toBeCloseTo(WAVE_TOP, 4);
        expect(cUp.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
        expect(cUp.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);

        // down direction
        const cDown = new Cursor(amp, 0);
        for (let i = 0; i < 500; i++) {
          cDown.update(dt, false, true, beatMs); // no nowWaveY
        }
        expect(cDown.y, `amp=${amp} down should clamp to BOTTOM`).toBeCloseTo(WAVE_BOTTOM, 4);
        expect(cDown.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
        expect(cDown.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
      }
    });

    it('明示的に undefined / NaN を渡してもクランプされる (録音モードの呼び出しバリエーション)', () => {
      const cursor = new Cursor(1.0, 0);

      // simulate EditorScreen.tsx:547 style — 4 args only, or 5th undefined
      for (let i = 0; i < 300; i++) {
        cursor.update(1 / 60, true, false, 500, undefined);
      }
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 4);
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);

      const cursor2 = new Cursor(1.0, 0);
      for (let i = 0; i < 300; i++) {
        cursor2.update(1 / 60, false, true, 500, NaN);
      }
      expect(cursor2.y).toBeCloseTo(WAVE_BOTTOM, 4);
      expect(cursor2.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
    });

    it('既に上限/下限付近から更に外側へ押しても突き抜けず留まる (境界安定性)', () => {
      // Step1: start at top
      const cTop = new Cursor(1.0, 1.0); // startPosition 1.0 => y = TOP=170
      expect(cTop.y).toBeCloseTo(WAVE_TOP, 5);
      const initTop = cTop.y;
      // Step2: keep pressing UP (should stay at TOP)
      runRecordingFrames(cTop, 100, true, false, 500);
      // Step3: still at TOP, not below
      expect(cTop.y).toBeCloseTo(WAVE_TOP, 5);
      expect(cTop.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cTop.y).toBe(initTop);

      // Bottom
      const cBottom = new Cursor(1.0, -1.0); // y = 430 BOTTOM
      expect(cBottom.y).toBeCloseTo(WAVE_BOTTOM, 5);
      runRecordingFrames(cBottom, 100, false, true, 500);
      expect(cBottom.y).toBeCloseTo(WAVE_BOTTOM, 5);
      expect(cBottom.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
    });

    it('録音モードでは T163 スナップ (nowWaveY への引き寄せ) が発生しないこと', () => {
      // Step1: cursor away from wave center
      const cursorRec = new Cursor(1.0, 0);
      // move it to 250 manually via updates without snap
      // then check that without nowWaveY it does NOT drift towards wave
      cursorRec.y = 200;
      const beforeY = cursorRec.y;

      // Step2: call update with no keys and NO nowWaveY — should stay exactly at 200 (no pull)
      cursorRec.update(1 / 60, false, false, 500);
      // Step3: Y unchanged (no snap), but if clamp-only is correct it stays
      expect(cursorRec.y).toBeCloseTo(beforeY, 5);

      // contrast: with nowWaveY=300, same situation should pull slightly towards 300
      const cursorGame = new Cursor(1.0, 0);
      cursorGame.y = 200;
      cursorGame.update(1 / 60, false, false, 500, 300);
      // pull strength 0.045 => delta = (300-200)*0.045 = 4.5
      expect(cursorGame.y).toBeCloseTo(200 + 4.5, 4);
      expect(cursorGame.y).toBeGreaterThan(beforeY);
    });

    it('長時間無入力でも範囲外へ発散しない (no keys, large dt accumulation)', () => {
      const cursor = new Cursor(2.7, 0);
      // simulate 10 seconds of no input with off-grid dt
      for (let i = 0; i < 1000; i++) {
        cursor.update(0.01, false, false, 333.333);
      }
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cursor.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
      // no movement without keys or snap, should stay at center
      expect(cursor.y).toBeCloseTo(TW_CENTER_Y, 4);
    });
  });

  describe('ゲーム本編回帰: nowWaveY ありの挙動は不変 (clamp + T163 snap 維持)', () => {
    it('Step1-3: ゲーム本編 (nowWaveY あり) でも上下限クランプが維持されること', () => {
      const cursor = new Cursor(1.0, 0);
      expect(cursor.y).toBe(TW_CENTER_Y);
      // Step2: hold UP with nowWaveY supplied (game mode)
      runGameFrames(cursor, 300, true, false, 500, TW_CENTER_Y);
      // Step3: still clamped to TOP (not below)
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cursor.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
      // With snap pulling towards center (300) the final clamped value will be
      // slightly above TOP due to pull fighting, but must never exceed bounds
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 0); // within ~1px of TOP
    });

    it('T163 継続スナップ: 毎tick wave へ 0.045 だけ寄り続ける (フレームレート独立)', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.y = 250;
      const waveY = 300;
      const before = cursor.y;

      // single tick no keys, with waveY
      cursor.update(1 / 60, false, false, 500, waveY);
      const PULL = 0.045;
      const expected = before + (waveY - before) * PULL;
      // clampedTarget = 300 within bounds, so pull is simple
      expect(cursor.y).toBeCloseTo(expected, 5);

      // repeat second tick, should continue towards wave
      const before2 = cursor.y;
      cursor.update(1 / 60, false, false, 500, waveY);
      const expected2 = before2 + (waveY - before2) * PULL;
      expect(cursor.y).toBeCloseTo(expected2, 5);
      expect(cursor.y).toBeGreaterThan(before2);
    });

    it('off-grid 位相 0.37拍/1.23拍 相当の端数 dt でもゲーム本編クランプ+スナップが一致', () => {
      const amp = 1.3;
      const beatMs = 500;
      const waveY = 220; // off-grid target
      const dt = 0.037; // off-grid dt

      const cursor = new Cursor(amp, 0);
      cursor.y = 400;
      const before = cursor.y;
      // hold UP (negative delta) with snap
      cursor.update(dt, true, false, beatMs, waveY);
      // should have moved up significantly but not below TOP and snap applied after clamp
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cursor.y).toBeLessThan(before);
      // snap after movement should nudge towards waveY
      // raw movement: speed=2*130*1.3/0.5=676, delta= -676*0.037 ≈ -25.0
      // raw = 400-25=375, then pull towards 220: 375+(220-375)*0.045 ≈ 368
      expect(cursor.y).toBeLessThan(375);
      expect(cursor.y).toBeGreaterThan(300);
    });

    it('上下同時押しは delta 0 で移動せず、スナップのみ効く (回帰)', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.y = 200;
      cursor.update(1 / 60, true, true, 500, 300);
      // up and down cancel, delta 0, then pull towards 300
      const expected = 200 + (300 - 200) * 0.045;
      expect(cursor.y).toBeCloseTo(expected, 4);

      const cursorRec = new Cursor(1.0, 0);
      cursorRec.y = 200;
      cursorRec.update(1 / 60, true, true, 500); // no nowWaveY
      // no movement, no pull
      expect(cursorRec.y).toBeCloseTo(200, 5);
    });

    it('pullTowards (T119) と併用時も上下限クランプが維持される', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.y = WAVE_BOTTOM;
      // pull towards far outside should clamp target first
      cursor.pullTowards(WAVE_TOP - 1000, 1.0);
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 5);
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);

      cursor.y = WAVE_TOP;
      cursor.pullTowards(WAVE_BOTTOM + 1000, 0.5);
      expect(cursor.y).toBeGreaterThan(WAVE_TOP);
      expect(cursor.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
    });

    it('WaveEngine との整合: 画面に見えている波形高さ内でカーソルが留まる (record vs game 同一境界)', () => {
      const timeline = new BpmTimeline(120, []);
      const engine = new WaveEngine([{ direction: 'up', beats: 4 }], timeline);
      // wave bounds are same constants
      expect(engine.waveYAt(0)).toBeCloseTo(WAVE_TOP, 5);
      // cursor start at TOP, try to go further up without wave ref
      const cRec = new Cursor(1.0, 1.0);
      runRecordingFrames(cRec, 200, true, false, 500);
      expect(cRec.y).toBeCloseTo(WAVE_TOP, 5);
      // game cursor with wave ref also stays within same bounds
      const cGame = new Cursor(1.0, 1.0);
      runGameFrames(cGame, 200, true, false, 500, engine.waveYAt(0));
      expect(cGame.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cGame.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
    });
  });

  describe('境界定数と例外入力 (堅牢性)', () => {
    it('TW_CENTER_Y/TW_AMP 定数が期待通り 300/130 で上下幅 170-430 である', () => {
      expect(TW_CENTER_Y).toBe(300);
      expect(TW_AMP).toBe(130);
      expect(WAVE_TOP).toBe(170);
      expect(WAVE_BOTTOM).toBe(430);
    });

    it('beatMs が極端に小さい/大きい場合でもクランプが機能する', () => {
      const cursor = new Cursor(1.0, 0);
      // very fast BPM (300 BPM => beatMs 200)
      runRecordingFrames(cursor, 200, true, false, 200);
      expect(cursor.y).toBeCloseTo(WAVE_TOP, 3);

      const cursor2 = new Cursor(3.4, 0);
      runRecordingFrames(cursor2, 200, false, true, 200);
      expect(cursor2.y).toBeCloseTo(WAVE_BOTTOM, 3);
    });

    it('dt=0 や負の dt でも範囲外へ飛ばない', () => {
      const cursor = new Cursor(1.0, 0);
      cursor.update(0, true, false, 500);
      expect(cursor.y).toBeCloseTo(TW_CENTER_Y, 5);
      cursor.update(-0.1, true, false, 500);
      // negative dt will move opposite direction but still clamped
      expect(cursor.y).toBeGreaterThanOrEqual(WAVE_TOP - 0.001);
      expect(cursor.y).toBeLessThanOrEqual(WAVE_BOTTOM + 0.001);
    });
  });
});
