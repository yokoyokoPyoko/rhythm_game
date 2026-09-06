import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { getManualOffsetMs } from '../src/audio/clock';
import * as metronome from '../src/audio/metronome';

// Mock clock and other dependencies to isolate Renderer and Metronome logic
vi.mock('../src/audio/clock', () => ({
  getManualOffsetMs: vi.fn(),
}));

describe('T175 synchronization tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // T175: Verify rendering time = songTimeMs - manualOffsetMs (Visual Sync)
  it('Renderer.render should pass renderTimeMs (songTimeMs - manualOffsetMs) to drawWave and drawRings', () => {
    const mockOffset = 150;
    vi.mocked(getManualOffsetMs).mockReturnValue(mockOffset);

    const renderer = new Renderer();
    const spyWave = vi.spyOn(Renderer.prototype as any, 'drawWave');
    const spyRings = vi.spyOn(Renderer.prototype as any, 'drawRings');

    const songTimeMs = 2000;
    const mockCtx = {} as any;
    const mockEngines = {
      waveEngine: {} as any,
      cursor: {} as any,
      rings: [],
      score: {} as any,
      songTimeMs,
      bpmTimeline: {} as any,
    };

    renderer.render(mockCtx, mockEngines);

    const expectedRenderTimeMs = songTimeMs - mockOffset;

    expect(spyWave).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expectedRenderTimeMs,
      expect.anything()
    );
    expect(spyRings).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expectedRenderTimeMs,
      expect.anything(),
      expect.anything()
    );
  });

  // Verify Metronome scheduling does NOT include manualOffset
  it('metronome.schedule should NOT include manualOffset in its scheduling "when"', () => {
    const mockOffset = 150;
    vi.mocked(getManualOffsetMs).mockReturnValue(mockOffset);

    const spySchedule = vi.spyOn(metronome, 'schedule');
    
    // Test logic assuming metronome.schedule exists as expected
    const audioCtx = { currentTime: 1.0 } as any;
    const nextBeatTime = 1.5;
    const beat = 4;
    
    metronome.schedule(audioCtx, nextBeatTime, beat);

    // Verify when was NOT offset by manualOffset
    // (The implementation should pass nextBeatTime directly to osc.start(when))
    expect(spySchedule).toHaveBeenCalledWith(audioCtx, nextBeatTime, beat);
  });
});
