import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Renderer } from '../src/game/renderer';
import * as clock from '../src/audio/clock';

describe('T175: Renderer offset synchronization', () => {
  let renderer: Renderer;
  let mockCtx: any;
  let mockData: any;

  beforeEach(() => {
    renderer = new Renderer();
    mockCtx = {
        fillStyle: '',
        fillRect: vi.fn(),
        strokeStyle: '',
        lineWidth: 0,
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        globalAlpha: 0,
        textAlign: '',
        textBaseline: '',
        font: '',
        fillText: vi.fn(),
    } as any;
    mockData = {
      waveEngine: { waveYAtMs: vi.fn().mockReturnValue(300) },
      cursor: { y: 300 },
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) },
      songTimeMs: 1000,
      bpmTimeline: {},
      judgementEvents: []
    };
    vi.restoreAllMocks();
  });

  it('should apply manual offset to renderTimeMs', () => {
    // Spying on private prototype methods is possible in JS/Vitest
    const spyWave = vi.spyOn(Renderer.prototype as any, 'drawWave').mockImplementation(() => {});
    const spyRings = vi.spyOn(Renderer.prototype as any, 'drawRings').mockImplementation(() => {});
    const spyOffset = vi.spyOn(clock, 'getManualOffsetMs');

    // 1. Initial State (Offset = 0)
    spyOffset.mockReturnValue(0);
    renderer.render(mockCtx, mockData);
    // Expect renderTimeMs = songTimeMs - offset = 1000 - 0 = 1000
    expect(spyWave).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1000, expect.anything());
    expect(spyRings).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1000, expect.anything(), expect.anything());

    // 2. Interaction: Update manual offset to 100ms
    spyOffset.mockReturnValue(100);

    // 3. Assert Result: Expect renderTimeMs = songTimeMs - offset = 1000 - 100 = 900
    renderer.render(mockCtx, mockData);
    expect(spyWave).toHaveBeenCalledWith(expect.anything(), expect.anything(), 900, expect.anything());
    expect(spyRings).toHaveBeenCalledWith(expect.anything(), expect.anything(), 900, expect.anything(), expect.anything());
  });
});
