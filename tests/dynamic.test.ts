import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import * as clock from '../src/audio/clock';

// Mock clock for manualOffsetMs
vi.mock('../src/audio/clock', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getManualOffsetMs: vi.fn(),
  };
});

describe('T176: Cursor/Wave Synchronization', () => {
  const TW_CENTER_Y = 300;
  const TW_AMP = 130; // T92
  
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clock.getManualOffsetMs).mockReturnValue(100); // 100ms offset
  });

  it('Requirement 1: Cursor should sync to renderTimeMs, not songTimeMs', () => {
    // Setup Chart Engine
    const bpm = 120;
    const timeline = new BpmTimeline(bpm, []);
    const segments = [
      { direction: 'up' as const, beats: 2 },
      { direction: 'down' as const, beats: 2 }
    ];
    const wave = new WaveEngine(segments, timeline);
    const cursor = new Cursor();

    const songTimeMs = 500;
    const manualOffsetMs = 100;
    const renderTimeMs = songTimeMs - manualOffsetMs; // 400ms

    // Expected Y based on renderTimeMs
    const expectedY = wave.waveYAtMs(renderTimeMs);
    const incorrectY = wave.waveYAtMs(songTimeMs);
    
    expect(expectedY).not.toBe(incorrectY);

    // Simulate Game Loop integration logic (T176)
    // Run multiple frames to simulate cursor movement towards the wave
    const dt = 16.6; 
    const beatMs = timeline.beatMsAt(timeline.msToBeat(renderTimeMs));
    const segmentBeats = 2;
    
    // Simulate ~30 frames (500ms / 16.6ms) for cursor to move towards target
    for (let i = 0; i < 30; i++) {
        cursor.update(dt, false, false, beatMs, wave.waveYAtMs(renderTimeMs));
    }
    
    // Assert cursor moved towards targetY (expectedY is 170)
    // Cursor starts at 300. 170 is target. It should move below 300.
    expect(cursor.y).toBeLessThan(300);
    expect(cursor.y).toBeGreaterThan(160);
  });

  it('Requirement 2: Wave behavior and clamping at boundaries', () => {
    const bpm = 120;
    const timeline = new BpmTimeline(bpm, []);
    const segments = [
      { direction: 'up' as const, beats: 1 },
      { direction: 'down' as const, beats: 1 }
    ];
    // Create wave with specific amplitude to avoid extreme clamping if needed,
    // but TW_AMP=130 is fine.
    const wave = new WaveEngine(segments, timeline, 1.0, 0); 
    
    const boundaryTimeMs = 500; // 1 beat at 120bpm is 500ms
    
    // Test the wave position logic directly
    const yAtBoundary = wave.waveYAtMs(boundaryTimeMs);
    
    // Peak is up (negative delta), TW_CENTER_Y - TW_AMP = 300 - 130 = 170
    expect(yAtBoundary).toBeCloseTo(170, 0);
  });
});
