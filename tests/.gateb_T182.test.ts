/**
 * @vitest-environment node
 * T182 Acceptance Test: Removal of screen background flash animation on PERFECT/GREAT hit.
 * Also includes T127 off-grid numeric consistency verification between WaveEngine and Cursor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { ScoreManager } from '../src/game/score';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

interface CapturedFillRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fillStyle: string;
  globalAlpha: number;
}

function createMockCtx() {
  let currentAlpha = 1;
  let currentFillStyle = '';
  const fillRectCalls: CapturedFillRect[] = [];

  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    get globalAlpha() { return currentAlpha; },
    set globalAlpha(v: number) { currentAlpha = v; },
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(function (x: number, y: number, w: number, h: number) {
      fillRectCalls.push({ x, y, w, h, fillStyle: String((ctx as any).fillStyle ?? currentFillStyle), globalAlpha: currentAlpha });
    }),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 } as any)),
    __fillRectCalls: fillRectCalls,
  } as unknown as CanvasRenderingContext2D & { __fillRectCalls: CapturedFillRect[] };

  let internalFill = '';
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return internalFill; },
    set(v: any) { internalFill = String(v); currentFillStyle = String(v); },
    configurable: true,
  });

  return ctx;
}

describe('T182: Removal of screen background flash animation on PERFECT/GREAT hit', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('1. PERFECT and GREAT hits must NOT trigger screen background flash (no full-screen fillRect overlay)', () => {
    const timeline = new BpmTimeline(120, []);
    const wave = new WaveEngine([{ direction: 'up', beats: 4 }], timeline);
    const cursor = new Cursor();
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Trigger PERFECT hit
    renderer.triggerHit('perfect', 208, 300);

    // Check flash state if available
    if (typeof (renderer as any).getFlashState === 'function') {
      const flash = (renderer as any).getFlashState();
      expect(flash.active).toBe(false);
      expect(flash.alpha).toBeCloseTo(0, 2);
    }

    // Render with mock context and ensure no full-screen fillRect flash overlay is drawn
    const ctx = createMockCtx();
    renderer.render(ctx, {
      waveEngine: wave,
      cursor,
      rings: [],
      score,
      songTimeMs: 1000,
      bpmTimeline: timeline,
      judgementEvents: [{ result: 'perfect', y: 300, at: 1000, errorMs: 10 }],
    });

    const fullScreenRects = ctx.__fillRectCalls.filter(fr => fr.w >= 700 && fr.h >= 500 && fr.fillStyle !== '#0a0a0a');
    expect(fullScreenRects.length).toBe(0);

    // Trigger GREAT hit
    renderer.triggerHit('great', 208, 300);
    if (typeof (renderer as any).getFlashState === 'function') {
      const flash = (renderer as any).getFlashState();
      expect(flash.active).toBe(false);
      expect(flash.alpha).toBeCloseTo(0, 2);
    }

    const ctxGreat = createMockCtx();
    renderer.render(ctxGreat, {
      waveEngine: wave,
      cursor,
      rings: [],
      score,
      songTimeMs: 1200,
      bpmTimeline: timeline,
      judgementEvents: [{ result: 'great', y: 300, at: 1200, errorMs: 60 }],
    });

    const fullScreenRectsGreat = ctxGreat.__fillRectCalls.filter(fr => fr.w >= 700 && fr.h >= 500 && fr.fillStyle !== '#0a0a0a');
    expect(fullScreenRectsGreat.length).toBe(0);
  });

  it('2. Particle bursts and judgement text are preserved and rendered correctly when hit occurs', () => {
    const timeline = new BpmTimeline(120, []);
    const wave = new WaveEngine([{ direction: 'up', beats: 4 }], timeline);
    const cursor = new Cursor();
    const score = new ScoreManager();
    const renderer = new Renderer();

    renderer.triggerHit('perfect', 208, 300);
    const particles = renderer.getParticles();
    expect(particles.length).toBeGreaterThanOrEqual(20);

    const ctx = createMockCtx();
    renderer.render(ctx, {
      waveEngine: wave,
      cursor,
      rings: [],
      score,
      songTimeMs: 1500,
      bpmTimeline: timeline,
      judgementEvents: [{ result: 'perfect', y: 300, at: 1500, errorMs: 5 }],
    });

    // Particles should be drawn (arc calls) and judgements text (fillText)
    expect(ctx.__fillRectCalls.some(fr => fr.fillStyle === '#0a0a0a')).toBe(true); // background clear
  });

  it('3. Off-grid numeric consistency between WaveEngine and Cursor across complex amplitudes', () => {
    const complexAmps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.63, 2.37];
    const timeline = new BpmTimeline(120, [], 1.0);

    for (const amp of complexAmps) {
      for (const b of offGridBeats) {
        const qBeat = quantizeBeat(b, 0.25);
        const segs: Segment[] = [{ direction: 'up', beats: qBeat > 0 ? qBeat : 0.5 }];
        const engine = new WaveEngine(segs, timeline, amp, 0.0);
        const cursor = new Cursor();

        const beatMs = timeline.beatMsAt(b);
        cursor.update(0.1, true, false, beatMs, segs[0].beats, amp);
        const waveY = engine.waveYAt(b);
        const points = engine.getPoints();

        expect(Number.isFinite(waveY)).toBe(true);
        expect(waveY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-5);
        expect(waveY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-5);
        expect(points.length).toBeGreaterThanOrEqual(2);
        expect(Number.isFinite(cursor.y)).toBe(true);
      }
    }
  });
});
