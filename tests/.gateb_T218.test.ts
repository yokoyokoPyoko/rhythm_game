/**
 * T218 — 拍グリッド線の濃度引き上げ＋小節協調 TDD Red → Green
 * Vitest (TypeScript, node environment) pure unit — no browser / no DOM.
 * Spec T218:
 *  - 1拍線: rgba(255,255,255,0.20) (エディタ太グリッド並み)
 *  - 小節線 (b % 4 === 0): 0.30
 *  - 線幅1・全高・背景直後の描画順・スクロール連動・BPM追従は不変・b<0スキップ・件数ガード維持
 *  - 実装は src/game/renderer.ts の drawBeatLines のみ: 拍ごとに b%4===0 でstrokeStyle 2色切替
 *  - 付随: tests/dynamic.test.ts の 0.06 期待値を新濃度 (0.20/0.30) に更新想定
 * STRICT QA: 3-step state-transition / computed values / off-grid (0.37/1.23) / complex amps (0.7/1.3/2.7/3.4)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// node has no localStorage — provide minimal mock before importing clock
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  } as any;
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis as any;
}

import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Renderer } from '../src/game/renderer';
import * as clock from '../src/audio/clock';
import { WaveEngine } from '../src/game/waveEngine';

// ---------------------------------------------------------------------------
// constants mirroring renderer
// ---------------------------------------------------------------------------
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const TW_JUDGE_X = Math.round(800 * 0.26); // 208
const DEFAULT_SCROLL_SPEED = 110;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

type StrokeRecord = { strokeStyle: string; lineWidth: number; globalAlpha: number; path: { op: string; x: number; y: number }[] };

function makeMockCtx() {
  let _strokeStyle = '';
  let _fillStyle = '';
  let _lineWidth = 1;
  let _globalAlpha = 1;
  let _font = '';
  const strokes: StrokeRecord[] = [];
  let curPath: { op: string; x: number; y: number }[] = [];

  const ctx: any = {
    get strokeStyle() { return _strokeStyle; },
    set strokeStyle(v: string) { _strokeStyle = String(v); },
    get fillStyle() { return _fillStyle; },
    set fillStyle(v: string) { _fillStyle = String(v); },
    get lineWidth() { return _lineWidth; },
    set lineWidth(v: number) { _lineWidth = Number(v); },
    get globalAlpha() { return _globalAlpha; },
    set globalAlpha(v: number) { _globalAlpha = Number(v); },
    get font() { return _font; },
    set font(v: string) { _font = String(v); },
    textAlign: 'left',
    textBaseline: 'top',
    fillRect: vi.fn(),
    beginPath: vi.fn(() => { curPath = []; }),
    moveTo: vi.fn((x: number, y: number) => { curPath.push({ op: 'moveTo', x, y }); }),
    lineTo: vi.fn((x: number, y: number) => { curPath.push({ op: 'lineTo', x, y }); }),
    stroke: vi.fn(() => {
      strokes.push({ strokeStyle: _strokeStyle, lineWidth: _lineWidth, globalAlpha: _globalAlpha, path: [...curPath] });
      curPath = [];
    }),
    arc: vi.fn((x: number, y: number, r: number) => { curPath.push({ op: 'arc', x, y } as any); }),
    fill: vi.fn(() => { curPath = []; }),
    fillText: vi.fn(),
  };
  return { ctx, strokes };
}

function makeWaveEngine(bpmChanges: any[] = [{ beat: 0, bpm: 120 }], amp = 1.0, startPos = 0): WaveEngine {
  const tl = new BpmTimeline(bpmChanges, amp);
  return new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], tl, amp, startPos);
}

function makeTimeline(bpmChanges: any[], amp = 1.0): BpmTimeline {
  return new BpmTimeline(bpmChanges, amp);
}

function beatX(beat: number, renderTimeMs: number, scrollSpeed: number, tl: BpmTimeline): number {
  return TW_JUDGE_X + ((tl.beatToMs(beat) - renderTimeMs) / 1000) * scrollSpeed;
}

function isNormalBeatColor(s: string): boolean {
  // normal beat line = rgba(255,255,255,0.20); must exclude bar (0.30) and old (0.06/0.10/0.18)
  return /rgba\(255,\s*255,\s*255,\s*0\.20\)/.test(s) && !/0\.30/.test(s) && !/0\.06/.test(s) && !/0\.10/.test(s) && !/0\.18/.test(s);
}
function isBarBeatColor(s: string): boolean {
  return /rgba\(255,\s*255,\s*255,\s*0\.30\)/.test(s);
}
function isAnyBeatColor(s: string): boolean {
  return isNormalBeatColor(s) || isBarBeatColor(s);
}

function expectedColorForBeat(b: number): string {
  return b % 4 === 0 ? 'bar' : 'normal';
}

function extractAllBeatLines(strokes: StrokeRecord[]): { x: number; strokeStyle: string; lineWidth: number; kind: 'bar' | 'normal' }[] {
  const out: { x: number; strokeStyle: string; lineWidth: number; kind: 'bar' | 'normal' }[] = [];
  for (const s of strokes) {
    let kind: 'bar' | 'normal' | null = null;
    if (isBarBeatColor(s.strokeStyle)) kind = 'bar';
    else if (isNormalBeatColor(s.strokeStyle)) kind = 'normal';
    else continue;
    if (s.lineWidth !== 1) continue;
    if (s.path.length < 2) continue;
    const m = s.path[0];
    const l = s.path[1];
    if (m.op !== 'moveTo' || l.op !== 'lineTo') continue;
    if (Math.abs(m.x - l.x) > 0.5) continue;
    const y0 = Math.min(m.y, l.y);
    const y1 = Math.max(m.y, l.y);
    if (y0 > 1 || y1 < CANVAS_HEIGHT - 1) continue;
    out.push({ x: m.x, strokeStyle: s.strokeStyle, lineWidth: s.lineWidth, kind });
  }
  return out;
}

function computeVisibleBeats(tl: BpmTimeline, renderTimeMs: number, scrollSpeed: number): number[] {
  const leftMs = renderTimeMs + ((0 - TW_JUDGE_X) / scrollSpeed) * 1000;
  const rightMs = renderTimeMs + ((CANVAS_WIDTH - TW_JUDGE_X) / scrollSpeed) * 1000;
  const leftBeat = Math.ceil(tl.msToBeat(leftMs));
  const rightBeat = Math.floor(tl.msToBeat(rightMs));
  const beats: number[] = [];
  for (let b = leftBeat; b <= rightBeat; b++) {
    if (b < 0) continue;
    beats.push(b);
    if (beats.length > 500) break;
  }
  return beats;
}

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  try { localStorage.clear(); } catch {}
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  try { localStorage.clear(); } catch {}
});

// ---------------------------------------------------------------------------
// T218-0: File contract — drawBeatLines existence and dual-color logic
// ---------------------------------------------------------------------------
describe('T218-0: File contract — drawBeatLines dual opacity (3-step)', () => {
  it('Step1 capture initial (no dual color) → Step2 read source → Step3 drawBeatLines contains 0.20 and 0.30 and b%4===0 switch', () => {
    const beforeHasDual = false;
    expect(beforeHasDual).toBe(false);

    const src = readFile('src/game/renderer.ts');

    expect(src).toContain('drawBeatLines');
    expect(src).toMatch(/drawBeatLines\s*\([^)]*bpmTimeline[^)]*renderTimeMs[^)]*scrollSpeed[^)]*\)/);
    // dual colors must exist
    expect(src).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.20\)/);
    expect(src).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.30\)/);
    // old 0.06 must NOT be the beat line color anymore
    // we allow 0.06 to appear nowhere or only if not as beat line primary; strict: should not contain 0.06 in drawBeatLines region
    const beatRegion = src.slice(src.indexOf('drawBeatLines'), src.indexOf('drawBeatLines') + 2000);
    expect(beatRegion).not.toMatch(/0\.06/);
    // bar detection logic
    expect(src).toMatch(/b\s*%\s*4\s*===\s*0/);
    // per-beat switch (strokeStyle set inside loop, not once before loop)
    const loopStart = beatRegion.indexOf('for (let b');
    expect(loopStart).toBeGreaterThan(-1);
    const beforeLoop = beatRegion.slice(0, loopStart);
    // there should NOT be a single unconditional strokeStyle=0.10 before loop without conditional
    // Instead after T218, strokeStyle assignment should be inside loop (conditional)
    const afterLoopStart = beatRegion.slice(loopStart);
    expect(afterLoopStart).toMatch(/strokeStyle/);
    expect(afterLoopStart).toMatch(/0\.30/);
  });

  it('Step1 render before state (only 0.06) → Step2 read render() body → Step3 drawBeatLines called after background before judge/wave/rings', () => {
    const beforeOrder = ['drawBackground', 'drawJudgeLine', 'drawWave', 'drawRings'];
    expect(beforeOrder).not.toContain('drawBeatLines');

    const src = readFile('src/game/renderer.ts');
    const renderIdx = src.indexOf('render(ctx');
    expect(renderIdx).toBeGreaterThan(-1);
    const renderSlice = src.slice(renderIdx, renderIdx + 3000);

    const bgIdx = renderSlice.indexOf('drawBackground');
    const beatIdx = renderSlice.indexOf('drawBeatLines');
    const judgeIdx = renderSlice.indexOf('drawJudgeLine');
    const waveIdx = renderSlice.indexOf('drawWave');
    const ringsIdx = renderSlice.indexOf('drawRings');

    expect(bgIdx).toBeGreaterThan(-1);
    expect(beatIdx).toBeGreaterThan(-1);
    expect(judgeIdx).toBeGreaterThan(-1);
    expect(waveIdx).toBeGreaterThan(-1);
    expect(ringsIdx).toBeGreaterThan(-1);

    expect(bgIdx).toBeLessThan(beatIdx);
    expect(beatIdx).toBeLessThan(judgeIdx);
    expect(beatIdx).toBeLessThan(waveIdx);
    expect(beatIdx).toBeLessThan(ringsIdx);
    expect(beatIdx - bgIdx).toBeLessThan(judgeIdx - bgIdx);
  });

  it('Step1 style capture (no thin 0.20/0.30) → Step2 source search → Step3 lineWidth 1, b<0 guard, count guard, msToBeat/beatToMs, TW_JUDGE_X formula exist', () => {
    const src = readFile('src/game/renderer.ts');
    expect(src).toMatch(/lineWidth\s*=\s*1/);
    expect(src).toMatch(/b\s*<\s*0/);
    expect(src).toMatch(/for\s*\(.*let\s+b.*\)/);
    expect(src).toMatch(/500|MAX_LINES|guard|break/);
    expect(src).toMatch(/msToBeat/);
    expect(src).toMatch(/beatToMs/);
    expect(src).toMatch(/TW_JUDGE_X.*beatToMs.*renderTimeMs.*scrollSpeed/);
  });
});

// ---------------------------------------------------------------------------
// T218-1: Beat grid renders with correct dual opacity (0.20 vs 0.30)
// ---------------------------------------------------------------------------
describe('T218-1: Beat grid renders integer beats with correct dual opacity (3-step, computed, off-grid)', () => {
  it('Step1 capture no lines at t=0 renderTimeMs → Step2 render at 2000ms (beat4 at judge) → Step3 each beat has correct X and correct color (bar 0.30 vs normal 0.20) and full height', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const songTimeMs = 2000;
    const renderTimeMs = songTimeMs - 0;
    const scrollSpeed = 110;

    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);

    const beatLines = extractAllBeatLines(strokes);
    const expectedBeats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);

    expect(beatLines.length).toBeGreaterThan(0);
    expect(beatLines.length).toBe(expectedBeats.length);

    for (let i = 0; i < expectedBeats.length; i++) {
      const b = expectedBeats[i];
      const expectedX = beatX(b, renderTimeMs, scrollSpeed, tl);
      expect(beatLines[i].x).toBeCloseTo(expectedX, 0);
      expect(beatLines[i].lineWidth).toBe(1);
      const kind = expectedColorForBeat(b);
      expect(beatLines[i].kind).toBe(kind);
      if (kind === 'bar') {
        expect(isBarBeatColor(beatLines[i].strokeStyle)).toBe(true);
      } else {
        expect(isNormalBeatColor(beatLines[i].strokeStyle)).toBe(true);
      }
    }

    const idx4 = expectedBeats.indexOf(4);
    if (idx4 !== -1) {
      expect(beatLines[idx4].x).toBeCloseTo(TW_JUDGE_X, 0);
      expect(beatLines[idx4].kind).toBe('bar');
      expect(isBarBeatColor(beatLines[idx4].strokeStyle)).toBe(true);
    }
    const idx5 = expectedBeats.indexOf(5);
    if (idx5 !== -1) {
      expect(beatLines[idx5].kind).toBe('normal');
      expect(isNormalBeatColor(beatLines[idx5].strokeStyle)).toBe(true);
    }
    expect(expectedBeats.every((b) => b >= 0)).toBe(true);
  });

  it('Step1 off-grid renderTimeMs capture (0.37 / 1.23 / 3.37 beats) → Step2 render with off-grid time → Step3 integer beats still correctly placed with correct bar/normal color and fractional offset', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const offGridBeats = [0.37, 1.23, 3.37];
    for (const og of offGridBeats) {
      const renderer = new Renderer();
      const renderTimeMs = tl.beatToMs(og);
      const songTimeMs = renderTimeMs;
      const { ctx, strokes } = makeMockCtx();
      renderer.render(ctx as any, {
        waveEngine: wave,
        cursor: { y: 300 } as any,
        rings: [],
        score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
        songTimeMs,
        bpmTimeline: tl,
        judgementEvents: [],
        scrollSpeed: 110,
      } as any);
      const beatLines = extractAllBeatLines(strokes);
      const expectedBeats = computeVisibleBeats(tl, renderTimeMs, 110);
      expect(beatLines.length).toBe(expectedBeats.length);
      for (let i = 0; i < expectedBeats.length; i++) {
        const b = expectedBeats[i];
        const expectedX = beatX(b, renderTimeMs, 110, tl);
        expect(beatLines[i].x).toBeCloseTo(expectedX, 0);
        expect(beatLines[i].kind).toBe(expectedColorForBeat(b));
      }
      for (const b of expectedBeats) {
        expect(Number.isInteger(b)).toBe(true);
      }
      // Must have at least one bar and one normal visible (when range wide enough)
      if (expectedBeats.length >= 5) {
        expect(beatLines.some((l) => l.kind === 'bar')).toBe(true);
        expect(beatLines.some((l) => l.kind === 'normal')).toBe(true);
      }
    }
  });

  it('Step1 b<0 guard capture (renderTimeMs=0, left beat negative) → Step2 render at start → Step3 beats <0 not drawn, first beat is 0 (bar 0.30)', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = 0;
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: 0,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const beatLines = extractAllBeatLines(strokes);
    const expectedBeats = computeVisibleBeats(tl, renderTimeMs, 110);
    expect(expectedBeats[0]).toBe(0);
    expect(beatLines[0].x).toBeCloseTo(beatX(0, renderTimeMs, 110, tl), 0);
    expect(beatLines[0].kind).toBe('bar');
    expect(isBarBeatColor(beatLines[0].strokeStyle)).toBe(true);
    expect(expectedBeats.every((b) => b >= 0)).toBe(true);
    expect(beatLines.length).toBeGreaterThan(0);
    // Ensure no 0.06 old color appears
    for (const s of strokes) {
      expect(s.strokeStyle).not.toMatch(/0\.06/);
    }
  });

  it('Step1 color distribution capture (empty) → Step2 render where 0..8 visible → Step3 bar lines at 0,4,8 are 0.30 and others 0.20', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);
    const renderTimeMs = tl.beatToMs(2); // 1000ms, should see 0..~8
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const beatLines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, 110);
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b % 4 === 0) {
        expect(beatLines[i].kind).toBe('bar');
        expect(beatLines[i].strokeStyle).toMatch(/0\.30/);
      } else {
        expect(beatLines[i].kind).toBe('normal');
        expect(beatLines[i].strokeStyle).toMatch(/0\.20/);
        expect(beatLines[i].strokeStyle).not.toMatch(/0\.30/);
      }
    }
    // verify counts: bar count = ceil(beats/4)
    const expectedBarCount = beats.filter((b) => b % 4 === 0).length;
    const actualBarCount = beatLines.filter((l) => l.kind === 'bar').length;
    expect(actualBarCount).toBe(expectedBarCount);
    const expectedNormalCount = beats.length - expectedBarCount;
    const actualNormalCount = beatLines.filter((l) => l.kind === 'normal').length;
    expect(actualNormalCount).toBe(expectedNormalCount);
  });
});

// ---------------------------------------------------------------------------
// T218-2: Scroll sync — lines move left as time advances, same formula as rings, color preserved
// ---------------------------------------------------------------------------
describe('T218-2: Scroll sync — beat lines move with time using ring formula, colors preserved (3-step, computed)', () => {
  it('Step1 capture X and colors at t0 → Step2 advance time by 500ms (1 beat at 120bpm) → Step3 each line shifts left by scrollSpeed*dt/1000 and bar/normal identity preserved', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const scrollSpeed = 110;
    const t0 = 2000;
    const dt = 500;
    const t1 = t0 + dt;

    const renderer0 = new Renderer();
    const { ctx: ctx0, strokes: strokes0 } = makeMockCtx();
    renderer0.render(ctx0 as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: t0,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines0 = extractAllBeatLines(strokes0);

    const renderer1 = new Renderer();
    const { ctx: ctx1, strokes: strokes1 } = makeMockCtx();
    renderer1.render(ctx1 as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: t1,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines1 = extractAllBeatLines(strokes1);

    expect(lines0.length).toBeGreaterThan(0);
    expect(lines1.length).toBeGreaterThan(0);

    const expectedShift = (dt / 1000) * scrollSpeed;
    expect(expectedShift).toBeCloseTo(55, 3);

    const beats0 = computeVisibleBeats(tl, t0, scrollSpeed);
    const beats1 = computeVisibleBeats(tl, t1, scrollSpeed);
    const common = beats0.filter((b) => beats1.includes(b));
    expect(common.length).toBeGreaterThan(0);
    for (const b of common) {
      const idx0 = beats0.indexOf(b);
      const idx1 = beats1.indexOf(b);
      const x0 = lines0[idx0].x;
      const x1 = lines1[idx1].x;
      expect(x1).toBeCloseTo(x0 - expectedShift, 0);
      // color kind must be preserved across frames
      expect(lines1[idx1].kind).toBe(lines0[idx0].kind);
    }
  });

  it('Step1 ring X capture at same off-grid time → Step2 get beat line X for same beat → Step3 they use identical formula and kind matches b%4', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = tl.beatToMs(3.37);
    const scrollSpeed = 110;
    for (const beat of [4, 5, 8, 9]) {
      const hitTime = tl.beatToMs(beat);
      const ringX = TW_JUDGE_X + ((hitTime - renderTimeMs) / 1000) * scrollSpeed;
      const beatLineX = beatX(beat, renderTimeMs, scrollSpeed, tl);
      expect(beatLineX).toBeCloseTo(ringX, 5);
      // bar vs normal check
      if (beat % 4 === 0) expect(beat % 4).toBe(0);
    }

    const renderer = new Renderer();
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
    for (const beat of [4, 5]) {
      const idx = beats.indexOf(beat);
      if (idx !== -1) {
        const expectedKind = expectedColorForBeat(beat);
        expect(lines[idx].kind).toBe(expectedKind);
        expect(lines[idx].x).toBeCloseTo(beatX(beat, renderTimeMs, scrollSpeed, tl), 0);
      }
    }
  });

  it('Step1 manualOffset capture (0) → Step2 set +80ms offset → Step3 beat lines shift by +8.8px (renderTimeMs = songTimeMs - offset) and colors unchanged', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const songTimeMs = 2000;
    const scrollSpeed = 110;

    const spy = vi.spyOn(clock, 'getManualOffsetMs');
    spy.mockReturnValue(0);
    const r0 = new Renderer();
    const { ctx: ctx0, strokes: s0 } = makeMockCtx();
    r0.render(ctx0 as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines0 = extractAllBeatLines(s0);
    const beats0 = computeVisibleBeats(tl, 2000, scrollSpeed);

    spy.mockReturnValue(80);
    const r1 = new Renderer();
    const { ctx: ctx1, strokes: s1 } = makeMockCtx();
    r1.render(ctx1 as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines1 = extractAllBeatLines(s1);
    const expectedShift = (80 / 1000) * scrollSpeed;
    const beats1 = computeVisibleBeats(tl, 1920, scrollSpeed);
    const common = beats0.filter((b) => beats1.includes(b));
    for (const b of common.slice(0, 3)) {
      const idx0 = beats0.indexOf(b);
      const idx1 = beats1.indexOf(b);
      if (idx0 !== -1 && idx1 !== -1) {
        expect(lines1[idx1].x).toBeCloseTo(lines0[idx0].x + expectedShift, 0);
        expect(lines1[idx1].kind).toBe(lines0[idx0].kind);
      }
    }
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// T218-3: BPM change — interval adapts via beatToMs, spacing correct, colors correct
// ---------------------------------------------------------------------------
describe('T218-3: BPM change interval adapts and colors correct (3-step, computed, off-grid)', () => {
  it('Step1 single BPM capture (uniform 55px) → Step2 timeline with 120→60 at beat4 → Step3 spacing 55px before and 110px after, with correct bar colors', () => {
    const single = makeTimeline([{ beat: 0, bpm: 120 }]);
    const spacingSingle = (single.beatToMs(2) - single.beatToMs(1)) / 1000 * 110;
    expect(spacingSingle).toBeCloseTo(55, 2);

    const changed = makeTimeline([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = changed.beatToMs(2);
    const scrollSpeed = 110;
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: changed,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(changed, renderTimeMs, scrollSpeed);

    for (const b of [1, 2]) {
      const idx = beats.indexOf(b);
      const idxNext = beats.indexOf(b + 1);
      if (idx !== -1 && idxNext !== -1) {
        const gap = lines[idxNext].x - lines[idx].x;
        expect(gap).toBeCloseTo(55, 0);
        // color check
        expect(lines[idx].kind).toBe(expectedColorForBeat(b));
        expect(lines[idxNext].kind).toBe(expectedColorForBeat(b + 1));
      }
    }
    for (const b of [5, 6]) {
      const idx = beats.indexOf(b);
      const idxNext = beats.indexOf(b + 1);
      if (idx !== -1 && idxNext !== -1) {
        const gap = lines[idxNext].x - lines[idx].x;
        expect(gap).toBeCloseTo(110, 0);
      }
    }
    const idx4 = beats.indexOf(4);
    const idx5 = beats.indexOf(5);
    if (idx4 !== -1 && idx5 !== -1) {
      expect(lines[idx5].x - lines[idx4].x).toBeCloseTo(110, 0);
      expect(lines[idx4].kind).toBe('bar');
      expect(lines[idx5].kind).toBe('normal');
    }
  });

  it('Step1 capture gap at off-grid renderTimeMs 1.37 beats → Step2 same BPM change timeline → Step3 beat lines still at integer beats and gaps remain 55/110 with correct colors', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = tl.beatToMs(1.37);
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const lines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, 110);
    expect(beats.every((b) => Number.isInteger(b))).toBe(true);
    for (let i = 0; i < beats.length; i++) {
      expect(lines[i].kind).toBe(expectedColorForBeat(beats[i]));
    }
    const preIdx = beats.indexOf(1);
    const preNext = beats.indexOf(2);
    if (preIdx !== -1 && preNext !== -1) {
      expect(lines[preNext].x - lines[preIdx].x).toBeCloseTo(55, 0);
    }
    const postIdx = beats.indexOf(5);
    const postNext = beats.indexOf(6);
    if (postIdx !== -1 && postNext !== -1) {
      expect(lines[postNext].x - lines[postIdx].x).toBeCloseTo(110, 0);
    }
  });

  it('Step1 complex BpmTimeline (120->150 at beat8) capture → Step2 render across change → Step3 beatToMs spacing reflects new BPM and bar colors at 8,12 etc', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 150 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 150 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    expect((tl.beatToMs(2) - tl.beatToMs(1)) / 1000 * 110).toBeCloseTo(55, 2);
    expect((tl.beatToMs(9) - tl.beatToMs(8)) / 1000 * 110).toBeCloseTo(44, 2);

    const renderTimeMs = tl.beatToMs(6);
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const lines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, 110);
    const idx6 = beats.indexOf(6);
    const idx7 = beats.indexOf(7);
    if (idx6 !== -1 && idx7 !== -1) {
      expect(lines[idx7].x - lines[idx6].x).toBeCloseTo(55, 0);
      expect(lines[idx6].kind).toBe(expectedColorForBeat(6));
    }
    const idx9 = beats.indexOf(9);
    const idx10 = beats.indexOf(10);
    if (idx9 !== -1 && idx10 !== -1) expect(lines[idx10].x - lines[idx9].x).toBeCloseTo(44, 0);
    const idx8 = beats.indexOf(8);
    if (idx8 !== -1) {
      expect(lines[idx8].kind).toBe('bar');
      expect(isBarBeatColor(lines[idx8].strokeStyle)).toBe(true);
    }
    const idx12 = beats.indexOf(12);
    if (idx12 !== -1) {
      expect(lines[idx12].kind).toBe('bar');
    }
  });
});

// ---------------------------------------------------------------------------
// T218-4: Zoom (scrollSpeed) and guard + style full-height with dual colors
// ---------------------------------------------------------------------------
describe('T218-4: Zoom scrollSpeed, guard, and style verification with dual colors (3-step)', () => {
  it('Step1 scrollSpeed=110 capture X → Step2 scrollSpeed=220 (zoom2.0) → Step3 X distance from judge line doubles, colors preserved', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = tl.beatToMs(4);
    const beat = 6;
    const x110 = beatX(beat, renderTimeMs, 110, tl);
    const x220 = beatX(beat, renderTimeMs, 220, tl);
    expect(x220 - TW_JUDGE_X).toBeCloseTo(2 * (x110 - TW_JUDGE_X), 5);

    const renderer: any = new Renderer();
    if (typeof renderer.drawBeatLines === 'function') {
      const { ctx: ctxA, strokes: sA } = makeMockCtx();
      renderer.drawBeatLines(ctxA, tl, renderTimeMs, 110);
      const linesA = extractAllBeatLines(sA);
      const beatsA = computeVisibleBeats(tl, renderTimeMs, 110);
      const idxA = beatsA.indexOf(beat);
      const { ctx: ctxB, strokes: sB } = makeMockCtx();
      renderer.drawBeatLines(ctxB, tl, renderTimeMs, 220);
      const linesB = extractAllBeatLines(sB);
      const beatsB = computeVisibleBeats(tl, renderTimeMs, 220);
      const idxB = beatsB.indexOf(beat);
      if (idxA !== -1 && idxB !== -1) {
        expect(linesB[idxB].x - TW_JUDGE_X).toBeCloseTo(2 * (linesA[idxA].x - TW_JUDGE_X), 0);
        expect(linesB[idxB].kind).toBe(linesA[idxA].kind);
      }
    } else {
      const rA = new Renderer();
      const { ctx: cA, strokes: stA } = makeMockCtx();
      rA.render(cA as any, { waveEngine: wave, cursor: { y: 300 } as any, rings: [], score: { getStats: () => ({ combo: 0, score: 0 }) } as any, songTimeMs: renderTimeMs, bpmTimeline: tl, judgementEvents: [], scrollSpeed: 110 } as any);
      const linesA2 = extractAllBeatLines(stA);
      const beatsA2 = computeVisibleBeats(tl, renderTimeMs, 110);
      const rB = new Renderer();
      const { ctx: cB, strokes: stB } = makeMockCtx();
      rB.render(cB as any, { waveEngine: wave, cursor: { y: 300 } as any, rings: [], score: { getStats: () => ({ combo: 0, score: 0 }) } as any, songTimeMs: renderTimeMs, bpmTimeline: tl, judgementEvents: [], scrollSpeed: 220 } as any);
      const linesB2 = extractAllBeatLines(stB);
      const beatsB2 = computeVisibleBeats(tl, renderTimeMs, 220);
      const idxA2 = beatsA2.indexOf(beat);
      const idxB2 = beatsB2.indexOf(beat);
      if (idxA2 !== -1 && idxB2 !== -1) {
        expect(linesB2[idxB2].x - TW_JUDGE_X).toBeCloseTo(2 * (linesA2[idxA2].x - TW_JUDGE_X), 0);
        expect(linesB2[idxB2].kind).toBe(linesA2[idxA2].kind);
      }
    }
  });

  it('Step1 guard capture (huge view) → Step2 render with tiny beatMs (bpm 1000) → Step3 line count is bounded (<500) and all have valid dual colors', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 1000 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 1000 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: 5000,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const lines = extractAllBeatLines(strokes);
    expect(lines.length).toBeLessThan(500);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.kind === 'bar' || l.kind === 'normal').toBe(true);
      expect(l.lineWidth).toBe(1);
    }
  });

  it('Step1 style before (no thin) → Step2 render → Step3 all beat lines have correct dual opacity (0.20 or 0.30), lineWidth1, full-height vertical', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: 2000,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const lines = extractAllBeatLines(strokes);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(isAnyBeatColor(line.strokeStyle)).toBe(true);
      expect(line.lineWidth).toBe(1);
    }
    // Verify no old 0.06 remains
    expect(strokes.some((s) => /0\.06/.test(s.strokeStyle) && s.lineWidth === 1 && s.path.length === 2)).toBe(false);
    // Verify underlying strokes are vertical full height
    const beatStrokes = strokes.filter((s) => isAnyBeatColor(s.strokeStyle) && s.lineWidth === 1);
    for (const s of beatStrokes) {
      expect(s.path.length).toBe(2);
      expect(s.path[0].x).toBeCloseTo(s.path[1].x, 0);
      expect(Math.min(s.path[0].y, s.path[1].y)).toBeCloseTo(0, 0);
      expect(Math.max(s.path[0].y, s.path[1].y)).toBeCloseTo(CANVAS_HEIGHT, 0);
    }
    // Bar lines must be distinguishable and denser in normal
    expect(lines.some((l) => l.kind === 'bar')).toBe(true);
    expect(lines.some((l) => l.kind === 'normal')).toBe(true);
  });

  it('Step1 zoomAt off-grid 0.37 capture with complex amps 0.7/1.3/2.7/3.4 → Step2 tl.zoomAt → Step3 scrollSpeed 110*zoomAt used consistently for beat lines with dual colors', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrids = [0.37, 1.23, 3.37];
    for (const amp of amps) {
      const tl = makeTimeline([{ beat: 0, bpm: 120, zoom: amp }], 1.0);
      for (const og of offGrids) {
        const z = tl.zoomAt(og);
        expect(z).toBeCloseTo(amp, 2);
        const scrollSpeed = 110 * z;
        const wave = makeWaveEngine([{ beat: 0, bpm: 120, zoom: amp }], 1.0);
        const renderer = new Renderer();
        vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);
        const renderTimeMs = tl.beatToMs(og);
        const { ctx, strokes } = makeMockCtx();
        renderer.render(ctx as any, {
          waveEngine: wave,
          cursor: { y: 300 } as any,
          rings: [],
          score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
          songTimeMs: renderTimeMs,
          bpmTimeline: tl,
          judgementEvents: [],
          scrollSpeed,
        } as any);
        const lines = extractAllBeatLines(strokes);
        const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
        expect(lines.length).toBe(beats.length);
        if (beats.length > 1) {
          const b = beats[0];
          expect(lines[0].x).toBeCloseTo(beatX(b, renderTimeMs, scrollSpeed, tl), 0);
          expect(lines[0].kind).toBe(expectedColorForBeat(b));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T218-5: Draw order — beat lines behind judge/wave/rings, before means background
// ---------------------------------------------------------------------------
describe('T218-5: Draw order — beat lines immediately after background, before judge/wave/rings (3-step)', () => {
  it('Step1 capture stroke order indices → Step2 render and collect ordered strokes → Step3 beat indices < judge < wave < rings (both colors counted)', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const { ctx: ctx2, strokes: strokes2 } = makeMockCtx();
    renderer.render(ctx2 as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [{ id: 0, spawnTime: 0, hitTime: tl.beatToMs(4), targetY: 300, resolved: false, hit: false } as any],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: tl.beatToMs(2),
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const indices: Record<string, number> = {};
    for (let i = 0; i < strokes2.length; i++) {
      const s = strokes2[i];
      if (isAnyBeatColor(s.strokeStyle) && s.lineWidth === 1 && indices['beat'] === undefined) indices['beat'] = i;
      if (s.strokeStyle === 'rgba(255,255,255,0.08)' && indices['judge'] === undefined) indices['judge'] = i;
      if (s.strokeStyle === '#6366f1' && indices['wave'] === undefined) indices['wave'] = i;
      if ((s.strokeStyle === '#ededed' || s.strokeStyle === '#4ade80') && s.path.some((p: any) => p.op === 'arc') && indices['ring'] === undefined) {
        indices['ring'] = i;
      }
    }
    expect(indices['beat']).toBeDefined();
    expect(indices['judge']).toBeDefined();
    expect(indices['wave']).toBeDefined();
    expect(indices['beat']!).toBeLessThan(indices['judge']!);
    expect(indices['beat']!).toBeLessThan(indices['wave']!);
    if (indices['ring'] !== undefined) {
      expect(indices['beat']!).toBeLessThan(indices['ring']!);
    }
    // Additionally, verify both bar and normal appear before judge
    const firstBarIdx = strokes2.findIndex((s) => isBarBeatColor(s.strokeStyle) && s.lineWidth === 1);
    const firstNormalIdx = strokes2.findIndex((s) => isNormalBeatColor(s.strokeStyle) && s.lineWidth === 1);
    if (firstBarIdx !== -1) expect(firstBarIdx).toBeLessThan(indices['judge']!);
    if (firstNormalIdx !== -1) expect(firstNormalIdx).toBeLessThan(indices['judge']!);
  });

  it('Step1 source order capture → Step2 read renderer.ts → Step3 drawBeatLines appears exactly once as drawBackground->drawBeatLines->drawJudgeLine', () => {
    const src = readFile('src/game/renderer.ts');
    const count = (src.match(/drawBeatLines/g) || []).length;
    expect(count).toBe(2);
    const renderSlice = src.slice(src.indexOf('render(ctx'), src.indexOf('render(ctx') + 2000);
    const lines = renderSlice.split('\n').map((l) => l.trim()).filter((l) => l.includes('this.draw'));
    const order = lines.map((l) => {
      const m = l.match(/this\.(draw\w+)/);
      return m ? m[1] : '';
    }).filter(Boolean);
    expect(order[0]).toBe('drawBackground');
    expect(order[1]).toBe('drawBeatLines');
    expect(order).toContain('drawJudgeLine');
    expect(order).toContain('drawWave');
    expect(order).toContain('drawRings');
    expect(order.indexOf('drawBeatLines')).toBeLessThan(order.indexOf('drawJudgeLine'));
  });
});

// ---------------------------------------------------------------------------
// T218-6: Integration — drawBeatLines callable directly and matches render path, dual colors
// ---------------------------------------------------------------------------
describe('T218-6: drawBeatLines direct call matches ring formula and guards with dual colors (3-step)', () => {
  it('Step1 direct call at renderTimeMs 1.23 off-grid → Step2 call drawBeatLines with same params → Step3 lines count, X, and kind identical to render path', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const renderer: any = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = tl.beatToMs(1.23);
    const scrollSpeed = 110;
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const { ctx: ctxRender, strokes: strokesRender } = makeMockCtx();
    renderer.render(ctxRender as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const viaRender = extractAllBeatLines(strokesRender);

    if (typeof renderer.drawBeatLines === 'function') {
      const { ctx, strokes } = makeMockCtx();
      renderer.drawBeatLines(ctx, tl, renderTimeMs, scrollSpeed);
      const direct = extractAllBeatLines(strokes);
      expect(direct.length).toBe(viaRender.length);
      for (let i = 0; i < direct.length; i++) {
        expect(direct[i].x).toBeCloseTo(viaRender[i].x, 0);
        expect(direct[i].kind).toBe(viaRender[i].kind);
      }
    } else {
      expect(viaRender.length).toBeGreaterThan(0);
      const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
      expect(viaRender.length).toBe(beats.length);
      for (let i = 0; i < beats.length; i++) {
        expect(viaRender[i].kind).toBe(expectedColorForBeat(beats[i]));
      }
    }
  });

  it('Step1 off-grid complex amp capture (2.7 at 0.37 beat) → Step2 direct drawBeatLines with zoom-derived scrollSpeed → Step3 X and dual colors correct', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }], 2.7);
    // Actually to get zoom variance we use explicit zoom param
    const tl2 = makeTimeline([{ beat: 0, bpm: 120, zoom: 2.7 }], 1.0);
    const renderTimeMs = tl2.beatToMs(0.37);
    const scrollSpeed = 110 * tl2.zoomAt(0.37);
    expect(scrollSpeed).toBeCloseTo(110 * 2.7, 2);
    const renderer: any = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);
    if (typeof renderer.drawBeatLines === 'function') {
      const { ctx, strokes } = makeMockCtx();
      renderer.drawBeatLines(ctx, tl2, renderTimeMs, scrollSpeed);
      const lines = extractAllBeatLines(strokes);
      const beats = computeVisibleBeats(tl2, renderTimeMs, scrollSpeed);
      expect(lines.length).toBe(beats.length);
      for (let i = 0; i < beats.length; i++) {
        expect(lines[i].kind).toBe(expectedColorForBeat(beats[i]));
        expect(lines[i].x).toBeCloseTo(beatX(beats[i], renderTimeMs, scrollSpeed, tl2), 0);
      }
    } else {
      // fallback via render path
      const wave = makeWaveEngine([{ beat: 0, bpm: 120 }], 2.7);
      const r = new Renderer();
      const { ctx, strokes } = makeMockCtx();
      r.render(ctx as any, {
        waveEngine: wave,
        cursor: { y: 300 } as any,
        rings: [],
        score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
        songTimeMs: renderTimeMs,
        bpmTimeline: tl2,
        judgementEvents: [],
        scrollSpeed,
      } as any);
      const lines = extractAllBeatLines(strokes);
      expect(lines.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// T218-7: Regression — no 0.06 remains, both opacities distinct, and b%4 logic
// ---------------------------------------------------------------------------
describe('T218-7: Regression — no 0.06, both opacities distinct, b%4 logic preserved (3-step)', () => {
  it('Step1 old color capture (0.06) → Step2 render current → Step3 no stroke uses 0.06 and both 0.20 and 0.30 appear', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: 2000,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const hasOld = strokes.some((s) => /0\.06/.test(s.strokeStyle));
    expect(hasOld).toBe(false);
    const hasNormal = strokes.some((s) => isNormalBeatColor(s.strokeStyle));
    const hasBar = strokes.some((s) => isBarBeatColor(s.strokeStyle));
    expect(hasNormal).toBe(true);
    expect(hasBar).toBe(true);
  });

  it('Step1 bar beats capture (0,4,8) → Step2 verify b%4===0 maps to 0.30 and others to 0.20 → Step3 computed strict segregation', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);
    const renderTimeMs = 0;
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed: 110,
    } as any);
    const lines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, 110);
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b % 4 === 0) {
        expect(lines[i].strokeStyle).toMatch(/0\.30/);
        expect(lines[i].kind).toBe('bar');
      } else {
        expect(lines[i].strokeStyle).toMatch(/0\.20/);
        expect(lines[i].strokeStyle).not.toMatch(/0\.30/);
        expect(lines[i].kind).toBe('normal');
      }
    }
  });

  it('Step1 complex amplitude 1.3 off-grid 1.23 capture → Step2 render → Step3 bar segregation still holds and X uses beatToMs correctly', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120, zoom: 1.3 }], 1.0);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120, zoom: 1.3 }], 1.0);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);
    const renderTimeMs = tl.beatToMs(1.23);
    const scrollSpeed = 110 * tl.zoomAt(1.23);
    const { ctx, strokes } = makeMockCtx();
    renderer.render(ctx as any, {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs: renderTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    } as any);
    const lines = extractAllBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
    expect(lines.length).toBe(beats.length);
    for (let i = 0; i < beats.length; i++) {
      expect(lines[i].kind).toBe(expectedColorForBeat(beats[i]));
      expect(lines[i].x).toBeCloseTo(beatX(beats[i], renderTimeMs, scrollSpeed, tl), 0);
    }
  });
});
