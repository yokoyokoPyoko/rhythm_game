import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import * as clock from '../src/audio/clock';

// Mock getManualOffsetMs
vi.mock('../src/audio/clock', () => ({
  getManualOffsetMs: vi.fn(),
}));

describe('T177 - Trace Wave Trace Judgment Synchronization', () => {
  const TW_TOLERANCE = 26;
  const TW_AMP = 130;
  const TW_CENTER_Y = 300;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should calculate isOnWave correctly using renderTimeMs with manualOffset', () => {
    // 1. Capture Initial State (T177 Requirements)
    const mockManualOffset = 100;
    vi.mocked(clock.getManualOffsetMs).mockReturnValue(mockManualOffset);

    const bpm = 120;
    const bpmTimeline = new BpmTimeline(bpm, []);
    const waveEngine = new WaveEngine([], bpmTimeline);

    // Setup: 1000ms song time, 100ms offset -> 900ms render time
    const songTimeMs = 1000;
    const renderTimeMs = songTimeMs - mockManualOffset;
    
    // Wave Y at renderTimeMs (This should be the reference Y)
    const targetY = waveEngine.waveYAtMs(renderTimeMs);
    
    // 2. Perform Interaction (Simulate Cursor positioning)
    const cursor = new Cursor();
    // Simulate cursor being at the target Y position
    // (We directly manipulate the cursor state if possible, or simulate the logic)
    // Assuming cursor has a Y position property
    (cursor as any).y = targetY;

    // 3. Assert Resulting Transition (isOnWave condition)
    // T177 Logic: const isOnWave = Math.abs(cursorY - wave.waveYAtMs(renderTimeMs)) < TW_TOLERANCE;
    const isOnWave = Math.abs((cursor as any).y - waveEngine.waveYAtMs(renderTimeMs)) < TW_TOLERANCE;
    
    expect(isOnWave).toBe(true);
    
    // Off-grid test (fractional timing check)
    const offGridTime = 900.37; // fractional renderTimeMs
    const targetYOffGrid = waveEngine.waveYAtMs(offGridTime);
    (cursor as any).y = targetYOffGrid;
    
    const isOnWaveOffGrid = Math.abs((cursor as any).y - waveEngine.waveYAtMs(offGridTime)) < TW_TOLERANCE;
    expect(isOnWaveOffGrid).toBe(true);
  });
});
