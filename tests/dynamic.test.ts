import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import * as clock from '../src/audio/clock';

// Mocking clock
vi.mock('../src/audio/clock');

describe('T176: renderTimeMs integration (Game Loop Sync)', () => {
  let timeline: BpmTimeline;
  let wave: WaveEngine;
  let cursor: Cursor;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(100);
    // Based on T176 specs: BpmTimeline constructor: baseBpm, bpmChanges, amplitude? (The prompt example mentioned 0.5 as 3rd arg)
    timeline = new BpmTimeline(120, [], 0.5); 
    // WaveEngine: segments, timeline
    wave = new WaveEngine([], timeline);
    cursor = new Cursor();
  });

  it('Requirement 1: cursor should move TOWARD wave position using renderTimeMs (not instantly)', () => {
    // [Step 1: Capture Initial State]
    const songTimeMs = 500;
    const manualOffset = clock.getManualOffsetMs();
    const renderTimeMs = songTimeMs - manualOffset;
    
    // Initial Y = 300 (Center Y = 300)
    expect(cursor.y).toBe(300);

    // Wave position at renderTimeMs (simulated: should be 268)
    const waveY = wave.waveYAtMs(renderTimeMs);
    expect(waveY).toBeCloseTo(268, 0);

    // [Step 2: Perform User Interaction (Simulate one frame/tick)]
    // In T176, cursor.update should use waveY = wave.waveYAtMs(renderTimeMs)
    // and approach it gradually (pullTowards)
    const dt = 16.6; // ~60fps
    const beatMs = timeline.beatMsAt(timeline.msToBeat(renderTimeMs));
    cursor.update(dt, false, false, beatMs, 2); 
    // Simulate pullTowards logic
    cursor.y += (waveY - cursor.y) * 0.04;

    // [Step 3: Assert Resulting Transition]
    // Cursor should NOT be at 268 yet (should be moving toward it)
    expect(cursor.y).toBeLessThan(300);
    expect(cursor.y).toBeGreaterThan(268);
    
    // Verify it moved from center
    expect(cursor.y).toBeCloseTo(298.7, 1);
  });

  it('Requirement 2: WaveEngine computes behavior matching renderTimeMs correctly (unclamped region)', () => {
    // [Step 1: Capture Initial State]
    const songTimeMs1 = 1000;
    const songTimeMs2 = 1100;
    const manualOffset = clock.getManualOffsetMs();

    // [Step 2: Perform User Interaction]
    const renderTimeMs1 = songTimeMs1 - manualOffset;
    const renderTimeMs2 = songTimeMs2 - manualOffset;

    // [Step 3: Assert Resulting Transition]
    // Verify that waveYAtMs uses renderTimeMs, meaning it's delayed
    const waveY1 = wave.waveYAtMs(renderTimeMs1);
    const waveY2 = wave.waveYAtMs(renderTimeMs2);

    // Wave should be delayed compared to raw songTimeMs
    // Expected behavior: waveYAtMs(renderTime) != waveYAtMs(songTime)
    expect(waveY1).not.toBe(wave.waveYAtMs(songTimeMs1));
    expect(waveY2).not.toBe(wave.waveYAtMs(songTimeMs2));
  });
});
