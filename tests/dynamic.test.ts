/**
 * @vitest-environment node
 * T183 Unit Tests: Cursor and Hit Particles Leftward Inertia (Renderer particle system).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';

describe('T183: Cursor and Hit Particles Leftward Inertia (vx < 0)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should generate hit particles with strictly negative initial X velocity (vx < 0) for leftward flow', () => {
    const renderer = new Renderer();

    // Step 1: Capture initial state (no particles)
    const initialParticles = renderer.getParticles();
    expect(initialParticles.length).toBe(0);

    // Step 2: Trigger hit event (simulating perfect hit)
    renderer.triggerHit('perfect', 208, 300);

    // Step 3: Assert resulting transition (particles generated and all have vx < 0)
    const particles = renderer.getParticles();
    expect(particles.length).toBeGreaterThan(0);
    for (const p of particles) {
      expect(p.vx).toBeLessThan(0);
    }
  });

  it('should generate tracing particles with strictly negative initial X velocity (vx < 0) during wave tracing', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    // Step 1: Capture initial state
    expect(renderer.getParticles().length).toBe(0);

    // Step 2: Trigger update with isTracing = true
    vi.spyOn(Math, 'random').mockReturnValue(0.2);
    renderer.update(0.06, {
      cursor,
      score,
      isTracing: true,
      cursorVelocity: { x: 50, y: 10 },
    });

    // Step 3: Assert resulting transition (tracing particles have vx < 0)
    const particles = renderer.getParticles();
    expect(particles.length).toBeGreaterThan(0);
    for (const p of particles) {
      expect(p.vx).toBeLessThan(0);
    }
  });
});
