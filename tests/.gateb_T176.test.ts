
import { describe, it, expect, vi } from 'vitest';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import * as clock from '../src/audio/clock';

vi.mock('../src/audio/clock', () => ({
    getManualOffsetMs: vi.fn(),
}));

describe('T176: renderTimeMs synchronization in engine integration', () => {
    it('should correctly calculate and use renderTimeMs for wave tracking and cursor update', () => {
        const manualOffsetMs = 100;
        const songTimeMs = 1000;
        const expectedRenderTimeMs = 900;

        vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(manualOffsetMs);

        const timeline = new BpmTimeline(120, []);
        const engine = new WaveEngine([], timeline);
        const cursor = new Cursor();
        const spy = vi.spyOn(engine, 'waveYAtMs');

        // Simulate the integration logic (GameScreen's loop tick)
        // 1. Calculate renderTimeMs
        const renderTimeMs = songTimeMs - clock.getManualOffsetMs();
        
        // 2. Use renderTimeMs for wave position tracking
        const waveY = engine.waveYAtMs(renderTimeMs);

        // 3. Use renderTimeMs for cursor update
        cursor.update(0.016, false, false, 500, waveY);

        // Assertions
        expect(renderTimeMs).toBe(expectedRenderTimeMs);
        expect(spy).toHaveBeenCalledWith(expectedRenderTimeMs);
        expect(spy).not.toHaveBeenCalledWith(songTimeMs);
    });

    it('should handle off-grid fractional timing correctly', () => {
        const manualOffsetMs = 37.5; // Fractional offset
        const songTimeMs = 1234.567;
        const expectedRenderTimeMs = 1197.067;

        vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(manualOffsetMs);

        const timeline = new BpmTimeline(120, []);
        const engine = new WaveEngine([], timeline);
        const spy = vi.spyOn(engine, 'waveYAtMs');

        const renderTimeMs = songTimeMs - clock.getManualOffsetMs();
        engine.waveYAtMs(renderTimeMs);

        expect(renderTimeMs).toBeCloseTo(expectedRenderTimeMs, 3);
        expect(spy).toHaveBeenCalledWith(expect.closeTo(expectedRenderTimeMs, 3));
    });
});
