/**
 * @vitest-environment node
 * T165 Unit Tests: Cursor particles during wave tracing (Renderer particle system).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';

function createMockCtx() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    shadowBlur: 0,
    shadowColor: '',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
}

describe('T165: Cursor particles during wave tracing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should spawn particles around cursor origin and opposite to cursor motion when tracing', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    // Step 1: Capture initial state (0 particles)
    const initialParticles = renderer.getParticles();
    expect(initialParticles.length).toBe(0);

    // Mock Math.random for deterministic spawn timing and offsets
    vi.spyOn(Math, 'random').mockReturnValue(0.0);

    // Step 2: Trigger update with isTracing = true and dt >= spawn interval (0.05s)
    renderer.update(0.06, {
      cursor,
      score,
      isTracing: true,
      cursorVelocity: { x: 100, y: 50 },
    });

    // Step 3: Assert resulting transition (particles spawned, positioned near cursor, moving in opposite direction)
    const spawnedParticles = renderer.getParticles();
    expect(spawnedParticles.length).toBeGreaterThan(0);

    const p = spawnedParticles[0];
    // Position check: within ±3px of cursor.y (300) and TW_JUDGE_X (208)
    expect(p.x).toBeGreaterThanOrEqual(205);
    expect(p.x).toBeLessThanOrEqual(211);
    expect(p.y).toBeGreaterThanOrEqual(297);
    expect(p.y).toBeLessThanOrEqual(303);

    // Velocity check: opposite to cursorVelocity (dot product with negative velocity vector should be positive)
    expect(p.vx).toBeLessThan(0);
    const dot = p.vx * (-100) + p.vy * (-50);
    expect(dot).toBeGreaterThan(0);

    // Lifetime check: maxLife between 0.3 and 0.5
    expect(p.maxLife).toBeGreaterThanOrEqual(0.3);
    expect(p.maxLife).toBeLessThanOrEqual(0.5);
  });

  it('should update particle life, position, and fade out alpha over time, and remove expired particles', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'down', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // Spawn particles
    renderer.update(0.08, {
      cursor,
      score,
      isTracing: true,
      cursorVelocity: { x: 0, y: 0 },
    });

    const initialCount = renderer.getParticles().length;
    expect(initialCount).toBeGreaterThan(0);

    const p0 = renderer.getParticles()[0];
    const initialLife = p0.life;
    const initialAlpha = p0.alpha;

    // Advance time by 0.1s
    renderer.update(0.1, {
      cursor,
      score,
      isTracing: false, // Stop spawning to test decay
    });

    expect(p0.life).toBeCloseTo(initialLife + 0.1, 5);
    expect(p0.alpha).toBeLessThan(initialAlpha);

    // Advance time past maxLife (e.g. 0.6s total)
    renderer.update(0.5, {
      cursor,
      score,
      isTracing: false,
    });

    // Expired particles should be removed
    expect(renderer.getParticles().length).toBe(0);
  });

  it('should render particles without glow/blur properties set on canvas context', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    vi.spyOn(Math, 'random').mockReturnValue(0.0);

    // Spawn particles
    renderer.update(0.06, {
      cursor,
      score,
      isTracing: true,
    });

    const mockCtx = createMockCtx();
    renderer.render(mockCtx, {
      waveEngine,
      cursor,
      rings: [],
      score,
      songTimeMs: 1000,
      bpmTimeline,
      isTracing: true,
    });

    // Ensure no shadowBlur or shadowColor is used (no glowing)
    expect(mockCtx.shadowBlur).toBe(0);
    expect(mockCtx.shadowColor).toBeFalsy();
  });
});
