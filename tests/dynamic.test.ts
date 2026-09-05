/**
 * @vitest-environment node
 * T164 Unit Tests: Ring opacity animation with power easing (Math.pow(1 - progress, 1.6)).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import type { RingState } from '../src/types';

function createMockCtx(strokeAlphas: number[]) {
  let currentAlpha = 1;
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(() => {
      strokeAlphas.push(currentAlpha);
    }),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 })),
    lineCap: 'butt',
    lineJoin: 'miter',
    set globalAlpha(val: number) {
      currentAlpha = val;
    },
    get globalAlpha() {
      return currentAlpha;
    },
  } as unknown as CanvasRenderingContext2D;
}

describe('T164: Ring opacity animation with power easing (Math.pow(1 - progress, 1.6))', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should render rings with low opacity (close to 0) at spawnTime (progress=1.0) using power easing', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    const spawnTime = 237.5;
    const hitTime = 1237.5;
    const rings: RingState[] = [
      { id: 1, spawnTime, hitTime, targetY: 300, resolved: false, hit: false }
    ];

    const strokeAlphas: number[] = [];
    const mockCtx = createMockCtx(strokeAlphas);

    renderer.render(mockCtx, {
      waveEngine,
      cursor,
      rings,
      score,
      songTimeMs: spawnTime,
      bpmTimeline,
    });

    const ringAlpha = strokeAlphas.find(a => a < 1.0) ?? strokeAlphas[0];
    expect(ringAlpha).toBeLessThan(0.05);
    expect(ringAlpha).toBeCloseTo(0, 2);
  });

  it('should follow power easing (Math.pow(1 - progress, 1.6)) progressively as ring approaches hitTime (off-grid timing)', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'down', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    const spawnTime = 100.0;
    const hitTime = 1100.0;
    const rings: RingState[] = [
      { id: 2, spawnTime, hitTime, targetY: 300, resolved: false, hit: false }
    ];

    const strokeAlphas: number[] = [];
    const mockCtx = createMockCtx(strokeAlphas);

    renderer.render(mockCtx, {
      waveEngine,
      cursor,
      rings,
      score,
      songTimeMs: 600.0,
      bpmTimeline,
    });

    const expectedAlpha = Math.pow(0.5, 1.6);
    const ringAlpha = strokeAlphas.find(a => Math.abs(a - expectedAlpha) < 0.01) ?? strokeAlphas[strokeAlphas.length - 2];
    expect(ringAlpha).toBeCloseTo(expectedAlpha, 2);
    expect(ringAlpha).toBeGreaterThan(0.2);
    expect(ringAlpha).toBeLessThan(0.5);
  });

  it('should reach full opacity (1.0) when songTimeMs reaches hitTime (progress = 0.0)', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    const spawnTime = 0.0;
    const hitTime = 1000.0;
    const rings: RingState[] = [
      { id: 3, spawnTime, hitTime, targetY: 300, resolved: false, hit: false }
    ];

    const strokeAlphas: number[] = [];
    const mockCtx = createMockCtx(strokeAlphas);

    renderer.render(mockCtx, {
      waveEngine,
      cursor,
      rings,
      score,
      songTimeMs: hitTime,
      bpmTimeline,
    });

    const ringAlpha = strokeAlphas[strokeAlphas.length - 2];
    expect(ringAlpha).toBeCloseTo(1.0, 2);
  });

  it('should independently calculate opacity for multiple dense/overlapping rings based on each ring spawnTime (off-grid timing)', () => {
    const renderer = new Renderer();
    const bpmTimeline = new BpmTimeline(120, []);
    const waveEngine = new WaveEngine([{ direction: 'up', beats: 4 }], bpmTimeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    const rings: RingState[] = [
      { id: 4, spawnTime: 100.0, hitTime: 1100.0, targetY: 300, resolved: false, hit: false },
      { id: 5, spawnTime: 450.3, hitTime: 1450.7, targetY: 300, resolved: false, hit: false }
    ];

    const strokeAlphas: number[] = [];
    const mockCtx = createMockCtx(strokeAlphas);

    renderer.render(mockCtx, {
      waveEngine,
      cursor,
      rings,
      score,
      songTimeMs: 750.5,
      bpmTimeline,
    });

    const ringStrokeAlphas = strokeAlphas.filter(a => a < 1.0);
    expect(ringStrokeAlphas.length).toBe(2);
    const alphaA = ringStrokeAlphas[0];
    const alphaB = ringStrokeAlphas[1];

    const expectedAlphaA = Math.pow(1 - 0.3495, 1.6);
    const expectedAlphaB = Math.pow(1 - 0.69992, 1.6); // (1450.7 - 750.5) / 1000.4 ≈ 0.69992

    expect(alphaA).toBeCloseTo(expectedAlphaA, 2);
    expect(alphaB).toBeCloseTo(expectedAlphaB, 2);
    expect(alphaA).toBeGreaterThan(alphaB);
  });
});
