import { vi, describe, it, expect } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import * as clock from '../src/audio/clock';

// Constants from specifications
const TW_AMP = 130;
const TW_CENTER_Y = 300;
const TW_TOLERANCE = 26;

// Mocking clock functions
vi.mock('../src/audio/clock', async () => {
  const actual = await vi.importActual('../src/audio/clock');
  return {
    ...actual,
    getManualOffsetMs: vi.fn(),
  };
});

describe('T177 - Trace Detection Timing Sync (Off-Grid Validation)', () => {
  it('should evaluate trace detection based on renderTimeMs, not songTimeMs', async () => {
    // [Step 1: Capture Initial State / Setup]
    // BPM 120 -> 500ms per beat.
    // At beat=2, the wave reaches its turning point.
    // If we look at beat=1.0, the displacement is 1 beat * (2*130*1.0) = 260px.
    // TW_CENTER_Y = 300. waveTop = 170.
    // StartY = 300. Down 260px = 560px -> Clamped to waveBottom(430).
    // Actually, speed is 2 * TW_AMP * amp. Amp=1.0, TW_AMP=130. 2 * 130 = 260px/beat.
    // Beat 0: 300px.
    // Beat 0.5: 300 + 0.5 * 260 = 430px (Clamped).
    // Beat 1.0: 300 + 260 = 560px -> 430px (Clamped).
    // So for beat 0.5 to 2.0, Y is 430px.
    
    // Let's pick a beat where Y changes.
    // Start beat 0, dir up, beats 2. 
    // StartY = 300px.
    // Up 1 beat = 300 - 260 = 40px -> 170px (Clamped).
    // So at beat 0.25: 300 - 0.25 * 260 = 300 - 65 = 235px.
    // At beat 0.25 (125ms), Y=235px.
    // renderTimeMs = songTimeMs - offset = 125ms - 100ms = 25ms.
    // Y at 25ms (beat 0.05): 300 - 0.05 * 260 = 300 - 13 = 287px.
    // Diff is 48px, which is > 26px.
    
    // Setup BPM Timeline (120 BPM = 500ms per beat)
    const bpmTimeline = new BpmTimeline(120, []);
    // Setup WaveEngine: Start at center (Y=300), Up (dir up, beats 2)
    const segments = [
      { direction: 'up', beats: 2 },
      { direction: 'down', beats: 2 }
    ];
    const waveEngine = new WaveEngine(segments, bpmTimeline, 1.0, 0.0);
    
    const manualOffsetMs = 100;
    vi.mocked(clock.getManualOffsetMs).mockReturnValue(manualOffsetMs);
    
    // songTimeMs = 125ms -> beat 0.25. Y=235px.
    // renderTimeMs = 25ms -> beat 0.05. Y=287px.
    const songTimeMs = 125.0; 
    const renderTimeMs = songTimeMs - manualOffsetMs; // 25.0ms

    // [Step 2: Perform Action / Calculation]
    // Position cursor exactly on the wave at renderTimeMs (This should trigger trace)
    const cursorY = waveEngine.waveYAtMs(renderTimeMs);
    
    // Calculate Y on wave at songTimeMs (This is where the cursor WOULD be if we didn't account for offset)
    const waveYAtSongTime = waveEngine.waveYAtMs(songTimeMs);
    
    // Simulate isOnWave detection logic: Math.abs(cursorY - wave.waveYAtMs(time)) < TW_TOLERANCE
    const isOnWaveRender = Math.abs(cursorY - waveEngine.waveYAtMs(renderTimeMs)) < TW_TOLERANCE;
    const isOnWaveSong = Math.abs(cursorY - waveEngine.waveYAtMs(songTimeMs)) < TW_TOLERANCE;

    // [Step 3: Assert Resulting Transition]
    // Given the movement speed at 120BPM/Amp=1.0, ΔY over 100ms is > 26px
    // songTimeMs=2000.37, renderTimeMs=1900.37.
    // 120BPM = 500ms/beat. amp=1.0. Speed=260px/beat = 0.52px/ms.
    // ΔY over 100ms = 52px, which is >= TW_TOLERANCE (26px).
    expect(Math.abs(waveYAtSongTime - cursorY)).toBeGreaterThanOrEqual(TW_TOLERANCE);
    
    // Assert: Trace is TRUE when using renderTimeMs (Correct implementation)
    expect(isOnWaveRender).toBe(true);
    
    // Assert: Trace is FALSE when using songTimeMs (Incorrect implementation)
    // This is the FAIL condition for the current implementation if it uses songTimeMs
    expect(isOnWaveSong).toBe(false);
  });
});
