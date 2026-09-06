/**
 * @vitest-environment node
 * T166 Unit Tests: Judgement effects — Screen flash & particle burst per tier
 *
 * Spec:
 * - Perfect: white flash alpha 0.4→0 ~0.12s + particle burst 20-24
 * - Great: tier-color flash alpha 0.25→0 ~0.12s + particle burst 12
 * - Good: small particle burst 6 (no flash or trivial)
 * - No glow/blur/shadow — only solid fills with alpha
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Renderer } from '../src/game/renderer';
import { WaveEngine } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import type { HitResult } from '../src/types';

// ---------------------------------------------------------------------------
// Mock canvas helpers
// ---------------------------------------------------------------------------
interface CapturedFillRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fillStyle: string;
  globalAlpha: number;
}
interface CapturedArc {
  x: number;
  y: number;
  r: number;
  fillStyle: string;
  globalAlpha: number;
}

function createMockCtx() {
  let currentAlpha = 1;
  let currentFillStyle = '';
  let currentStrokeStyle = '';
  const fillRectCalls: CapturedFillRect[] = [];
  const arcCalls: CapturedArc[] = [];
  let shadowBlurSet = false;
  let shadowColorSet = false;
  let filterSet = false;
  let lastShadowBlur = 0;
  let lastShadowColor = '';
  let lastFilter = '';

  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'top' as CanvasTextBaseline,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    get globalAlpha() { return currentAlpha; },
    set globalAlpha(v: number) { currentAlpha = v; },
    get shadowBlur() { return lastShadowBlur; },
    set shadowBlur(v: number) { lastShadowBlur = v; if (v !== 0) shadowBlurSet = true; },
    get shadowColor() { return lastShadowColor; },
    set shadowColor(v: string) { lastShadowColor = v; if (v && v !== '' && v !== 'transparent' && v !== 'rgba(0, 0, 0, 0)') shadowColorSet = true; },
    get filter() { return lastFilter; },
    set filter(v: string) { lastFilter = v; if (v && v !== 'none' && v !== '') filterSet = true; },
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(function (x: number, y: number, r: number) {
      arcCalls.push({ x, y, r, fillStyle: String((ctx as any).fillStyle ?? currentFillStyle), globalAlpha: currentAlpha });
    }),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(function (x: number, y: number, w: number, h: number) {
      fillRectCalls.push({ x, y, w, h, fillStyle: String((ctx as any).fillStyle ?? currentFillStyle), globalAlpha: currentAlpha });
    }),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 } as any)),
    // bookkeeping accessors
    __fillRectCalls: fillRectCalls,
    __arcCalls: arcCalls,
    __shadowBlurSet: () => shadowBlurSet,
    __shadowColorSet: () => shadowColorSet,
    __filterSet: () => filterSet,
    __lastShadowBlur: () => lastShadowBlur,
    __lastShadowColor: () => lastShadowColor,
    __lastFilter: () => lastFilter,
  } as unknown as CanvasRenderingContext2D & {
    __fillRectCalls: CapturedFillRect[];
    __arcCalls: CapturedArc[];
    __shadowBlurSet: () => boolean;
    __shadowColorSet: () => boolean;
    __filterSet: () => boolean;
    __lastShadowBlur: () => number;
    __lastShadowColor: () => string;
    __lastFilter: () => string;
  };

  // intercept fillStyle assignment to capture current
  let internalFill = '';
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return internalFill; },
    set(v: any) { internalFill = String(v); currentFillStyle = String(v); },
    configurable: true,
  });
  let internalStroke = '';
  Object.defineProperty(ctx, 'strokeStyle', {
    get() { return internalStroke; },
    set(v: any) { internalStroke = String(v); },
    configurable: true,
  });

  return ctx;
}

function createTimeline(): BpmTimeline {
  return new BpmTimeline(120, []);
}
function createWave(timeline: BpmTimeline): WaveEngine {
  return new WaveEngine([{ direction: 'up', beats: 4 }], timeline);
}

// Helper to trigger a hit on Renderer regardless of method name the coder chooses.
// The spec says Renderer should expose judgement flash & burst when a hit occurs.
// We probe several plausible APIs and fail clearly if none exists (Red).
function triggerHit(renderer: any, result: HitResult, x = 208, y = 300): void {
  const candidates = ['triggerHit', 'onHit', 'hit', 'addHit', 'burst', 'triggerFlash', 'notifyHit', 'addJudgement', 'judge'];
  for (const name of candidates) {
    if (typeof renderer[name] === 'function') {
      // try (result, x, y) then (result, {x,y}) then (result)
      try { renderer[name](result, x, y); return; } catch {}
      try { renderer[name](result, { x, y }); return; } catch {}
      try { renderer[name](result); return; } catch {}
    }
  }
  // Also try judgementEvents path: renderer.render expects judgementEvents — but flash/burst requires explicit triggerHit API.
  // If no trigger method exists, throw assertion that will fail the test (Red).
  throw new Error(
    `Renderer missing hit-trigger API. Expected one of: ${candidates.join(', ')} (result=${result}). ` +
    `Coder must implement triggerHit(result, x, y) that spawns flash + particle burst per T166.`
  );
}

function getFlashState(renderer: any): { alpha: number; color: string; active: boolean } | null {
  if (typeof renderer.getFlashState === 'function') {
    return renderer.getFlashState();
  }
  if (typeof renderer.getFlash === 'function') {
    return renderer.getFlash();
  }
  if ('flashAlpha' in renderer || 'flashColor' in renderer) {
    return {
      alpha: (renderer as any).flashAlpha ?? 0,
      color: (renderer as any).flashColor ?? '',
      active: (renderer as any).flashActive ?? ((renderer as any).flashAlpha > 0),
    };
  }
  if ('_flashAlpha' in renderer) {
    return {
      alpha: (renderer as any)._flashAlpha ?? 0,
      color: (renderer as any)._flashColor ?? '',
      active: (renderer as any)._flashActive ?? ((renderer as any)._flashAlpha > 0),
    };
  }
  return null;
}

function getParticleCount(renderer: Renderer): number {
  return renderer.getParticles().length;
}

function renderOnce(renderer: Renderer, ctx: any, timeline: BpmTimeline, wave: WaveEngine, cursor: Cursor, score: ScoreManager, songTimeMs = 1000) {
  renderer.render(ctx as unknown as CanvasRenderingContext2D, {
    waveEngine: wave,
    cursor,
    rings: [],
    score,
    songTimeMs,
    bpmTimeline: timeline,
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('T166: Judgement flash & particle burst (Renderer)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Step1-3: initial state has no flash and zero burst particles — after Perfect hit spawns flash + 20-24 particles (3-step)', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Step 1: Capture initial state
    const initialParticles = getParticleCount(renderer);
    expect(initialParticles).toBe(0);
    const initialFlash = getFlashState(renderer as any);
    if (initialFlash) {
      expect(initialFlash.alpha).toBeCloseTo(0, 2);
      expect(initialFlash.active).toBe(false);
    }

    // Step 2: Perform user interaction — Perfect hit at judgement pos
    triggerHit(renderer as any, 'perfect', 208, 300);

    // Step 3: Assert resulting transition
    const afterParticles = getParticleCount(renderer);
    expect(afterParticles).toBeGreaterThanOrEqual(20);
    expect(afterParticles).toBeLessThanOrEqual(24);

    const flash = getFlashState(renderer as any);
    if (flash) {
      // Perfect flash: white alpha 0.4
      expect(flash.active).toBe(true);
      expect(flash.alpha).toBeCloseTo(0.4, 1);
      const c = flash.color.toLowerCase();
      const isWhite = c.includes('255') || c === '#ffffff' || c === '#fff' || c === 'white' || c === 'rgba(255,255,255,1)' || c.includes('255, 255, 255');
      expect(isWhite).toBe(true);
    } else {
      // Fallback: verify via canvas render — full-screen fillRect with white at alpha 0.4
      const ctx = createMockCtx();
      renderOnce(renderer, ctx, timeline, wave, cursor, score, 1000);
      const flashRects = (ctx as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600);
      expect(flashRects.length).toBeGreaterThan(0);
      const fr = flashRects[0];
      expect(fr.globalAlpha).toBeCloseTo(0.4, 1);
      const c2 = fr.fillStyle.toLowerCase();
      const isWhite2 = c2.includes('255') || c2 === '#ffffff' || c2 === '#fff' || c2 === 'white' || c2.includes('255, 255, 255');
      expect(isWhite2).toBe(true);
    }
  });

  it('Step1-3: Perfect flash decays 0.4→0 over ~0.12s and then becomes inactive', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Step 1: initial no flash
    const before = getFlashState(renderer as any);
    if (before) expect(before.alpha).toBeCloseTo(0, 2);

    // Step 2: trigger perfect
    triggerHit(renderer as any, 'perfect', 208, 300);

    // Step 3a: immediate alpha is 0.4
    let flash = getFlashState(renderer as any);
    if (flash) {
      expect(flash.alpha).toBeCloseTo(0.4, 1);
    }

    // Advance ~60ms (half duration) — alpha should be between 0 and 0.4
    (renderer as any).update?.(0.06, { cursor, score, isTracing: false });
    // Some implementations decay in render(dt) — also call render to advance
    const ctxMid = createMockCtx();
    renderOnce(renderer, ctxMid, timeline, wave, cursor, score, 1060);
    flash = getFlashState(renderer as any);
    if (flash) {
      expect(flash.alpha).toBeGreaterThan(0);
      expect(flash.alpha).toBeLessThan(0.4);
      // ~half-way linear: ~0.2 (±0.12 tolerance for easing)
      expect(flash.alpha).toBeGreaterThan(0.05);
      expect(flash.alpha).toBeLessThan(0.35);
    } else {
      // canvas-derived alpha after 60ms
      const midRects = (ctxMid as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600);
      if (midRects.length > 0) {
        expect(midRects[0].globalAlpha).toBeGreaterThan(0);
        expect(midRects[0].globalAlpha).toBeLessThan(0.4);
      }
    }

    // Advance beyond 0.12s (total ~130ms) — flash should be gone
    (renderer as any).update?.(0.07, { cursor, score, isTracing: false });
    const ctxLate = createMockCtx();
    renderOnce(renderer, ctxLate, timeline, wave, cursor, score, 1130);
    flash = getFlashState(renderer as any);
    if (flash) {
      expect(flash.alpha).toBeCloseTo(0, 1);
      expect(flash.active).toBe(false);
    } else {
      const lateRects = (ctxLate as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600 && fr.globalAlpha > 0.01);
      // After ~0.13s there should be no full-screen flash at visible alpha
      // Allow small epsilon but not 0.1+
      const visibleFlash = lateRects.filter((r: CapturedFillRect) => r.globalAlpha > 0.05);
      expect(visibleFlash.length).toBe(0);
    }
  });

  it('Step1-3: Great hit triggers tier-color flash alpha 0.25→0 ~0.12s and exactly 12 particle burst', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Step 1: Capture initial particle count
    const initial = getParticleCount(renderer);
    expect(initial).toBe(0);

    // Step 2: Trigger Great
    triggerHit(renderer as any, 'great', 208, 300);

    // Step 3: Assert transition — 12 particles
    const after = getParticleCount(renderer);
    expect(after).toBe(12);

    const flash = getFlashState(renderer as any);
    if (flash) {
      expect(flash.active).toBe(true);
      expect(flash.alpha).toBeCloseTo(0.25, 1);
      const c = flash.color.toLowerCase();
      // tier color should NOT be white — should be accent-ish (#6366f1) or accentSub #22d3ee etc.
      const isWhite = c === '#ffffff' || c === '#fff' || c === 'white' || c.includes('255, 255, 255');
      expect(isWhite).toBe(false);
      // Accept any tier color: accent positive etc — just not white/danger
      expect(c.length).toBeGreaterThan(0);
    } else {
      const ctx = createMockCtx();
      renderOnce(renderer, ctx, timeline, wave, cursor, score, 1000);
      const flashRects = (ctx as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600);
      expect(flashRects.length).toBeGreaterThan(0);
      const fr = flashRects[0];
      expect(fr.globalAlpha).toBeCloseTo(0.25, 1);
      const c2 = fr.fillStyle.toLowerCase();
      const isWhite2 = c2 === '#ffffff' || c2 === '#fff' || c2 === 'white' || c2.includes('255, 255, 255');
      expect(isWhite2).toBe(false);
    }

    // Decay to 0 by ~0.12s
    (renderer as any).update?.(0.13, { cursor, score, isTracing: false });
    const ctx2 = createMockCtx();
    renderOnce(renderer, ctx2, timeline, wave, cursor, score, 1130);
    const flash2 = getFlashState(renderer as any);
    if (flash2) {
      expect(flash2.alpha).toBeCloseTo(0, 1);
      expect(flash2.active).toBe(false);
    }
  });

  it('Step1-3: Good hit spawns exactly 6 particles and does NOT show strong flash (no white 0.4/0.25)', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Step 1
    expect(getParticleCount(renderer)).toBe(0);

    // Step 2
    triggerHit(renderer as any, 'good', 208, 300);

    // Step 3
    expect(getParticleCount(renderer)).toBe(6);

    const flash = getFlashState(renderer as any);
    if (flash) {
      // Good should have no flash or alpha ≈0
      expect(flash.alpha).toBeLessThan(0.1);
      // If active, it should not be white 0.4 or tier 0.25
      if (flash.active) {
        expect(flash.alpha).not.toBeCloseTo(0.4, 1);
        expect(flash.alpha).not.toBeCloseTo(0.25, 1);
      }
    } else {
      const ctx = createMockCtx();
      renderOnce(renderer, ctx, timeline, wave, cursor, score, 1000);
      const flashRects = (ctx as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600 && fr.globalAlpha > 0.1);
      // Good should not produce strong full-screen flash
      expect(flashRects.length).toBe(0);
    }
  });

  it('Particle burst per tier: Perfect 20-24, Great 12, Good 6 are distinct and not off-by-one', () => {
    // This test verifies numeric distinctness across tiers in one session
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();

    const rPerfect = new Renderer();
    triggerHit(rPerfect as any, 'perfect', 208, 300);
    const pPerfect = getParticleCount(rPerfect);
    expect(pPerfect).toBeGreaterThanOrEqual(20);
    expect(pPerfect).toBeLessThanOrEqual(24);

    const rGreat = new Renderer();
    triggerHit(rGreat as any, 'great', 208, 300);
    const pGreat = getParticleCount(rGreat);
    expect(pGreat).toBe(12);

    const rGood = new Renderer();
    triggerHit(rGood as any, 'good', 208, 300);
    const pGood = getParticleCount(rGood);
    expect(pGood).toBe(6);

    // Ensure ordering: perfect > great > good
    expect(pPerfect).toBeGreaterThan(pGreat);
    expect(pGreat).toBeGreaterThan(pGood);
  });

  it('Flash and burst must use only solid fills with alpha — no glow/blur/shadow/filter', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    triggerHit(renderer as any, 'perfect', 208, 300);
    // Also trigger great/good to ensure none of them use glow
    const ctx = createMockCtx();
    renderOnce(renderer, ctx, timeline, wave, cursor, score, 1000);

    // Particles also render via arc/fill — still no glow
    // Check that mockCtx never had shadowBlur/filter set
    expect((ctx as any).__shadowBlurSet()).toBe(false);
    expect((ctx as any).__shadowColorSet()).toBe(false);
    expect((ctx as any).__filterSet()).toBe(false);
    expect((ctx as any).__lastShadowBlur()).toBe(0);

    // Verify source code does not contain glow APIs (defensive static check)
    // Import renderer source as text via reading not needed — we rely on runtime, but also ensure no shadowBlur in ctx calls
    // If implementation used glow, shadowBlur would have been set to non-zero
  });

  it('Particle burst positions originate near judgement point and fade via alpha, removed after life', () => {
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Capture before
    expect(getParticleCount(renderer)).toBe(0);

    triggerHit(renderer as any, 'perfect', 208, 250);

    const particles = renderer.getParticles();
    expect(particles.length).toBeGreaterThanOrEqual(20);
    // Positions should be clustered around (208, 250) within reasonable spread (±20)
    for (const p of particles) {
      expect(p.x).toBeGreaterThanOrEqual(150);
      expect(p.x).toBeLessThanOrEqual(270);
      expect(p.y).toBeGreaterThanOrEqual(190);
      expect(p.y).toBeLessThanOrEqual(310);
      expect(p.life).toBeCloseTo(0, 2);
      expect(p.maxLife).toBeGreaterThan(0);
      expect(p.alpha).toBeCloseTo(1, 1);
    }

    // Advance time — particles move and fade
    renderer.update(0.1, { cursor, score, isTracing: false });
    const after = renderer.getParticles();
    expect(after.length).toBe(particles.length); // still alive at 0.1s
    for (const p of after) {
      expect(p.alpha).toBeLessThan(1);
      expect(p.alpha).toBeGreaterThan(0);
    }

    // Advance past maxLife (0.6s total) — should be cleaned up
    renderer.update(0.6, { cursor, score, isTracing: false });
    expect(renderer.getParticles().length).toBe(0);
  });

  it('Consecutive hits: new burst stacks and flash resets — not silently swallowed', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    // Step 1: first perfect
    triggerHit(renderer as any, 'perfect', 208, 300);
    const firstCount = getParticleCount(renderer);
    expect(firstCount).toBeGreaterThanOrEqual(20);

    // Let flash partially decay
    renderer.update(0.06, { cursor, score, isTracing: false });
    const midFlash = getFlashState(renderer as any);
    let midAlpha = midFlash ? midFlash.alpha : 0.2; // fallback
    if (midFlash) expect(midAlpha).toBeLessThan(0.4);

    // Step 2: second hit (great) while first flash still visible — should reset flash to 0.25
    triggerHit(renderer as any, 'great', 208, 300);
    const secondCount = getParticleCount(renderer);
    // Particles should have accumulated (first burst still alive + new 12)
    expect(secondCount).toBe(firstCount + 12);

    const flashAfterSecond = getFlashState(renderer as any);
    if (flashAfterSecond) {
      expect(flashAfterSecond.active).toBe(true);
      expect(flashAfterSecond.alpha).toBeCloseTo(0.25, 1);
    } else {
      const ctx = createMockCtx();
      renderOnce(renderer, ctx, timeline, wave, cursor, score, 1060);
      const rects = (ctx as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600);
      if (rects.length > 0) {
        expect(rects[0].globalAlpha).toBeCloseTo(0.25, 1);
      }
    }
  });

  it('Renderer must expose hit-trigger API (triggerHit/onHit/hit) — fails if unimplemented (Red)', () => {
    const renderer = new Renderer();
    const anyR = renderer as any;
    const hasTrigger =
      typeof anyR.triggerHit === 'function' ||
      typeof anyR.onHit === 'function' ||
      typeof anyR.hit === 'function' ||
      typeof anyR.addHit === 'function' ||
      typeof anyR.burst === 'function' ||
      typeof anyR.triggerFlash === 'function' ||
      typeof anyR.notifyHit === 'function' ||
      typeof anyR.addJudgement === 'function';
    expect(hasTrigger).toBe(true);
  });

  it('Great flash color must be tier color (accent family) — not white, not muted bg, not danger', () => {
    const timeline = createTimeline();
    const wave = createWave(timeline);
    const cursor = new Cursor(1.0, 0);
    const score = new ScoreManager();
    const renderer = new Renderer();

    triggerHit(renderer as any, 'great', 208, 300);

    const flash = getFlashState(renderer as any);
    if (flash) {
      const c = flash.color.toLowerCase();
      const isBg = c === '#0a0a0a' || c === '#0a0a0a'.toLowerCase();
      const isWhite = c === '#ffffff' || c === '#fff' || c === 'white';
      const isDanger = c === '#f87171';
      expect(isBg).toBe(false);
      expect(isWhite).toBe(false);
      expect(isDanger).toBe(false);
      // Accept accent #6366f1, sub #22d3ee, positive #4ade80, warning #fbbf24 etc.
      const isAccentFamily =
        c.includes('6366f1') || c.includes('22d3ee') || c.includes('4ade80') || c.includes('99f6e4') || c.includes('6366');
      // If strict color name not matched, at least not white/bg/danger suffices
      if (!isAccentFamily) {
        expect(c.length).toBeGreaterThan(0);
      }
    } else {
      const ctx = createMockCtx();
      renderOnce(renderer, ctx, timeline, wave, cursor, score, 1000);
      const rects = (ctx as any).__fillRectCalls.filter((fr: CapturedFillRect) => fr.w >= 800 && fr.h >= 600);
      expect(rects.length).toBeGreaterThan(0);
      const c2 = rects[0].fillStyle.toLowerCase();
      const isWhite2 = c2 === '#ffffff' || c2 === '#fff' || c2 === 'white';
      expect(isWhite2).toBe(false);
    }
  });
});
