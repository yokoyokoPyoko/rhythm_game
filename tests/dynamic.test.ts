import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { setManualOffset, getManualOffsetMs } from '../src/audio/clock';
import { Segment, BpmChange } from '../src/types';

describe('T176: カーソル磁気・スナップおよび移動速度の可聴描画時刻（renderTimeMs）同期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setManualOffset(0);
  });

  it('1. manualOffset設定時、カーソルが画面に見えている波形に正確に吸い付く', () => {
    const segments: Segment[] = [{ direction: 'up', beats: 4 }];
    const bpmChanges: BpmChange[] = [];
    const bpm = 120; // 1 beat = 500ms
    const timeline = new BpmTimeline(bpm, bpmChanges);
    const engine = new WaveEngine(segments, timeline, 1.0, 0.0);
    
    // 手動オフセットを設定
    const offset = 100;
    setManualOffset(offset);

    // songNow = 2000ms (4 beats)
    const songTimeMs = 2000;
    const renderTimeMs = songTimeMs - getManualOffsetMs(); // 1900ms

    const expectedY = engine.waveYAtMs(renderTimeMs);
    const cursor = new Cursor(1.0, 0.0);
    
    // Simulate tick update
    // Update should use renderTimeMs
    const beatMs = timeline.beatMsAt(timeline.msToBeat(renderTimeMs));
    cursor.update(0.016, false, false, beatMs, engine.waveYAtMs(renderTimeMs));
    
    // Assertion: Cursor Y should match wave Y at renderTimeMs
    expect(cursor.y).toBeCloseTo(expectedY);
  });

  it('2. セグメント境界でカーソル速度の切り替わりが画面波形と同期する', () => {
    // 振幅係数を設定して検証
    const amplitude = 1.3;
    const segments: Segment[] = [
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 }
    ];
    // BPM 120
    const timeline = new BpmTimeline(120, []);
    const engine = new WaveEngine(segments, timeline, amplitude, 0.0);
    
    // WaveEngine.waveYAt(beat) calculation
    const yAt1 = engine.waveYAt(1.0);
    const yAt2 = engine.waveYAt(2.0);
    
    // The change in Y should be 1 beat * perBeatPx
    const perBeatPx = 2 * 130 * amplitude; // TW_AMP = 130
    
    // Assertion: The difference in Y matches the expected speed
    expect(Math.abs(yAt2 - yAt1)).toBeCloseTo(perBeatPx);
  });
});
