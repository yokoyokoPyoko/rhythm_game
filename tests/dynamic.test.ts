/**
 * @vitest-environment node
 * T165 Unit Tests: Cursor particles during wave tracing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';

describe('T165: Cursor particles during wave tracing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should generate particles behind cursor when tracing wave (isOnWave = true) with appropriate frequency (0.05-0.08s interval, 1-2 particles)', () => {
    // [Step1] Capture initial state (0 particles)
    const renderer = new Renderer();
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);

    const initialParticleCount = (renderer as any).getParticles?.()?.length ?? 0;
    expect(initialParticleCount).toBe(0);

    // [Step2] Simulate tracing update over time interval (e.g. 0.07s with isOnWave = true)
    renderer.update?.(0.07, { cursor, score, isTracing: true, songTimeMs: 1000 });

    // [Step3] Assert resulting transition: particles are generated (1 to 2 particles)
    const particles = (renderer as any).getParticles?.() ?? [];
    expect(particles.length).toBeGreaterThanOrEqual(1);
    expect(particles.length).toBeLessThanOrEqual(2);
  });

  it('should not generate particles when not tracing wave (isOnWave = false or off-wave)', () => {
    // [Step1] Initial state
    const renderer = new Renderer();
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);

    // [Step2] Simulate update with isTracing = false
    renderer.update?.(0.07, { cursor, score, isTracing: false, songTimeMs: 1000 });

    // [Step3] Assert no particles generated
    const particles = (renderer as any).getParticles?.() ?? [];
    expect(particles.length).toBe(0);
  });

  it('should generate particles within ±3px of cursor coordinate origin and move in reverse direction with lifespan 0.3-0.5s', () => {
    // [Step1] Initial setup with off-grid phase and complex amplitude (e.g. 1.37)
    const renderer = new Renderer();
    const cursor = new Cursor(1.37, 0);
    cursor.y = 250;
    const score = new ScoreManager();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'down', beats: 4 }], bpmTimeline);

    // [Step2] Trigger particle generation with off-grid songTimeMs (e.g. 1234.56ms)
    renderer.update?.(0.065, { cursor, score, isTracing: true, songTimeMs: 1234.56, cursorVelocity: { x: 12.5, y: -4.2 } });

    const particles = (renderer as any).getParticles?.() ?? [];
    expect(particles.length).toBeGreaterThan(0);

    // [Step3] Assert particle position offset (±3px), lifespan (0.3 - 0.5s), and reverse movement
    for (const p of particles) {
      expect(Math.abs(p.x - 208)).toBeLessThanOrEqual(3); // TW_JUDGE_X = 208 (800 * 0.26)
      expect(Math.abs(p.y - 250)).toBeLessThanOrEqual(3);
      expect(p.maxLife >= 0.3 && p.maxLife <= 0.5).toBe(true);
      expect(p.vx * 12.5 <= 0).toBe(true); // reverse direction of cursor velocity x
    }
  });

  it('should fade out particles over their lifespan and remove expired particles', () => {
    // [Step1] Generate particles
    const renderer = new Renderer();
    const cursor = new Cursor(2.7, 0);
    const score = new ScoreManager();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);

    renderer.update?.(0.06, { cursor, score, isTracing: true, songTimeMs: 1000 });
    const initialParticles = (renderer as any).getParticles?.() ?? [];
    expect(initialParticles.length).toBeGreaterThan(0);
    const initialAlpha = initialParticles[0].alpha;

    // [Step2] Update time by 0.35 seconds (fading out)
    renderer.update?.(0.35, { cursor, score, isTracing: false, songTimeMs: 1350 });

    // [Step3] Assert alpha faded or particles expired/removed
    const remainingParticles = (renderer as any).getParticles?.() ?? [];
    for (const p of remainingParticles) {
      expect(p.alpha).toBeLessThan(initialAlpha);
    }
  });
});
