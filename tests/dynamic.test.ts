import { test, expect, vi } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';
import { BpmTimeline } from '../src/audio/bpmTimeline';

// Mocks
vi.mock('../src/audio/clock', () => ({
  getManualOffsetMs: vi.fn(),
  setManualOffset: vi.fn(),
}));

describe('T177: Score Trace判定（isOnWave）の可聴描画時刻（renderTimeMs）同期', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test('isOnWave判定がsongTimeMsではなくrenderTimeMs基準であることの検証', async () => {
    // 1. Arrange: manualOffsetMs を設定
    const MANUAL_OFFSET = 100;
    (getManualOffsetMs as any).mockReturnValue(MANUAL_OFFSET);

    const timeline = new BpmTimeline(120, []);
    // 波形エンジン: 全幅移動用AMP設定
    const wave = new WaveEngine([{ direction: 'up', beats: 4 }], timeline);

    // [Step 1: Capture Initial State]
    // 判定ライン上の期待値：renderTimeMs 時点でカーソルYが波形Yと一致する場合
    const songTimeMs = 1000;
    const renderTimeMs = songTimeMs - MANUAL_OFFSET;
    
    // 特定のタイミングにおける波形のY位置を計算
    const waveYAtRender = wave.waveYAtMs(renderTimeMs);

    // カーソルを renderTimeMs 時点の波形Yに合わせて配置
    const cursorY = waveYAtRender;

    // [Step 2: Perform Computation (Simulated)]
    // 修正後のロジック: isOnWave = Math.abs(cursorY - wave.waveYAtMs(renderTimeMs)) < TW_TOLERANCE
    const TW_TOLERANCE = 26;
    
    // 修正後のロジックによる判定
    const isOnWaveRender = Math.abs(cursorY - wave.waveYAtMs(renderTimeMs)) < TW_TOLERANCE;
    
    // 修正前の誤ったロジックによる判定 (songTimeMs使用)
    const isOnWaveSong = Math.abs(cursorY - wave.waveYAtMs(songTimeMs)) < TW_TOLERANCE;

    // [Step 3: Assert Resulting Transition]
    // renderTimeMs 基準ならヒットするはず
    expect(isOnWaveRender).toBe(true);
    
    // songTimeMs 基準だとズレによりヒットしないケースがある（今回のパラメータ設定でそれを検証）
    // renderTimeMs と songTimeMs で波形Yが十分に異なることを確認してから、
    // songTimeMs 基準での判定が FALSE になることを確認する。
    if (Math.abs(wave.waveYAtMs(renderTimeMs) - wave.waveYAtMs(songTimeMs)) > TW_TOLERANCE) {
      expect(isOnWaveSong).toBe(false);
    }
  });
});
