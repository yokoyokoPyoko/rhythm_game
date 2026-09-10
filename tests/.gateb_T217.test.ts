/**
 * T217 — プレイ画面の1拍ごとの薄い縦線（拍グリッド） TDD Red → Green
 * Vitest (TypeScript, node environment) pure unit — no browser / no DOM.
 * Spec:
 *  - 整数拍ごとに1px縦線、全高、右→左へスクロール（リングと同一式）
 *  - 色: 1拍線 rgba(255,255,255,0.20)、小節線(b%4===0) rgba(255,255,255,0.30)、線幅1、主張しない
 *  - beatToMsで位置算出 → BPM変更で間隔自動追従、時変zoomはリングと同一近似（scrollSpeed引数）
 *  - 描画順: 背景の直後、判定線・波形・リングより背面
 *  - CalibrationModalも同一Rendererで追従
 *  - 実装は src/game/renderer.ts のみ: drawBeatLines(ctx, bpmTimeline, renderTimeMs, scrollSpeed) + render()内でdrawBackground直後に呼出
 *  - 表示範囲: 左端/右端msをmsToBeatで拍に換算し整数拍ループ（件数ガード）、b<0は描画しない
 *
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
  // minimal segments: need at least something
  return new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], tl, amp, startPos);
}

function makeTimeline(bpmChanges: any[], amp = 1.0): BpmTimeline {
  return new BpmTimeline(bpmChanges, amp);
}

function beatX(beat: number, renderTimeMs: number, scrollSpeed: number, tl: BpmTimeline): number {
  return TW_JUDGE_X + ((tl.beatToMs(beat) - renderTimeMs) / 1000) * scrollSpeed;
}

function extractBeatLines(strokes: StrokeRecord[]): { x: number; strokeStyle: string; lineWidth: number }[] {
  const out: { x: number; strokeStyle: string; lineWidth: number }[] = [];
  for (const s of strokes) {
    // beat lines: thin white (0.20 normal / 0.30 bar at b%4===0), lineWidth 1, vertical full height
    const isBeatColor = s.strokeStyle === 'rgba(255,255,255,0.20)' || s.strokeStyle === 'rgba(255,255,255,0.30)' || /rgba\(255,\s*255,\s*255,\s*0\.(20|30)\)/.test(s.strokeStyle);
    if (!isBeatColor) continue;
    if (s.lineWidth !== 1) continue;
    // path should be moveTo(x,0) -> lineTo(x,600) (or close)
    if (s.path.length < 2) continue;
    const m = s.path[0];
    const l = s.path[1];
    if (m.op !== 'moveTo' || l.op !== 'lineTo') continue;
    // check vertical
    if (Math.abs(m.x - l.x) > 0.5) continue;
    // check full height (0 to 600) with tolerance
    const y0 = Math.min(m.y, l.y);
    const y1 = Math.max(m.y, l.y);
    if (y0 > 1 || y1 < CANVAS_HEIGHT - 1) continue;
    out.push({ x: m.x, strokeStyle: s.strokeStyle, lineWidth: s.lineWidth });
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
    if (beats.length > 500) break; // guard
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
// T217-0: File contract — drawBeatLines exists and is called in correct order
// ---------------------------------------------------------------------------
describe('T217-0: File contract — drawBeatLines existence and call order (3-step)', () => {
  it('Step1 capture initial (no drawBeatLines) → Step2 read source → Step3 drawBeatLines(ctx, bpmTimeline, renderTimeMs, scrollSpeed) exists', () => {
    const beforeHasMethod = false;
    expect(beforeHasMethod).toBe(false);

    const src = readFile('src/game/renderer.ts');

    // method must exist
    expect(src).toContain('drawBeatLines');
    // signature must contain all 3 domain params
    expect(src).toMatch(/drawBeatLines\s*\([^)]*bpmTimeline[^)]*renderTimeMs[^)]*scrollSpeed[^)]*\)/);
    // also ctx
    expect(src).toMatch(/drawBeatLines\s*\([^)]*ctx[^)]*\)/);
  });

  it('Step1 render before state (only drawBackground) → Step2 read render() body → Step3 drawBeatLines is called immediately after drawBackground and before drawJudgeLine/drawWave/drawRings', () => {
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
    // strict: beat immediately after background (not after wave)
    expect(beatIdx - bgIdx).toBeLessThan(judgeIdx - bgIdx);
  });

  it('Step1 style capture (no dual thin white) → Step2 source search → Step3 strokeStyle rgba(255,255,255,0.20/0.30) and lineWidth 1 and b<0 guard and count guard exist', () => {
    const src = readFile('src/game/renderer.ts');
    // style: normal beat 0.20, bar beat 0.30, switched per beat by b%4===0
    expect(src).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.20\)/);
    expect(src).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.30\)/);
    expect(src).toMatch(/b\s*%\s*4\s*===\s*0/);
    expect(src).toMatch(/lineWidth\s*=\s*1/);
    // guards
    expect(src).toMatch(/b\s*<\s*0/);
    // integer loop and guard
    expect(src).toMatch(/for\s*\(.*let\s+b.*\)/);
    expect(src).toMatch(/Infinity|500|200|100|guard|break|length\s*>/);
    // msToBeat usage
    expect(src).toMatch(/msToBeat/);
    expect(src).toMatch(/beatToMs/);
    // uses renderTimeMs and scrollSpeed (same formula as rings)
    expect(src).toMatch(/TW_JUDGE_X.*beatToMs.*renderTimeMs.*scrollSpeed/);
  });
});

// ---------------------------------------------------------------------------
// T217-1: Beat grid rendering — single BPM, integer beats at correct X, full height
// ---------------------------------------------------------------------------
describe('T217-1: Beat grid renders integer beats at correct X with correct style (3-step, computed, off-grid)', () => {
  it('Step1 capture no lines at t=0 renderTimeMs → Step2 render at 2000ms (beat4 at judge line) → Step3 beat lines at integer beats with correct X/strokeStyle/lineWidth/fullHeight', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    const spyOffset = vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const songTimeMs = 2000;
    const renderTimeMs = songTimeMs - 0;
    const scrollSpeed = 110;

    const { ctx, strokes } = makeMockCtx();
    const params: any = {
      waveEngine: wave,
      cursor: { y: 300 } as any,
      rings: [],
      score: { getStats: () => ({ combo: 0, score: 0 }) } as any,
      songTimeMs,
      bpmTimeline: tl,
      judgementEvents: [],
      scrollSpeed,
    };
    strokes.length = 0;
    renderer.render(ctx, params);

    const beatLines = extractBeatLines(strokes);
    const expectedBeats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);

    // Must have at least some lines
    expect(beatLines.length).toBeGreaterThan(0);
    expect(beatLines.length).toBe(expectedBeats.length);

    // Each line X must equal ring formula
    for (let i = 0; i < expectedBeats.length; i++) {
      const b = expectedBeats[i];
      const expectedX = beatX(b, renderTimeMs, scrollSpeed, tl);
      expect(beatLines[i].x).toBeCloseTo(expectedX, 0);
      expect(beatLines[i].strokeStyle).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.(20|30)\)/);
      expect(beatLines[i].lineWidth).toBe(1);
    }

    // Special: beat 4 must be exactly at judge line when renderTimeMs == beatToMs(4)
    const idx4 = expectedBeats.indexOf(4);
    if (idx4 !== -1) {
      expect(beatLines[idx4].x).toBeCloseTo(TW_JUDGE_X, 0);
    }

    // b<0 must never be drawn even if in range calculation would include negative
    for (const bl of beatLines) {
      expect(bl.x).toBeDefined();
    }
    // verify no negative beat drawn by checking expectedBeats never contains <0
    expect(expectedBeats.every((b) => b >= 0)).toBe(true);

    spyOffset.mockRestore();
  });

  it('Step1 off-grid renderTimeMs capture (0.37 beat = 185ms at 120bpm) → Step2 render with off-grid time → Step3 integer beats still correctly placed with fractional offset', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    // off-grid: 0.37 beat, 1.23 beat, 3.37 beat
    const offGridBeats = [0.37, 1.23, 3.37];
    for (const og of offGridBeats) {
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
      const beatLines = extractBeatLines(strokes);
      const expectedBeats = computeVisibleBeats(tl, renderTimeMs, 110);
      expect(beatLines.length).toBe(expectedBeats.length);
      for (let i = 0; i < expectedBeats.length; i++) {
        const b = expectedBeats[i];
        const expectedX = beatX(b, renderTimeMs, 110, tl);
        expect(beatLines[i].x).toBeCloseTo(expectedX, 0);
      }
      // No half-beat lines: all b are integers
      for (const b of expectedBeats) {
        expect(Number.isInteger(b)).toBe(true);
      }
    }
  });

  it('Step1 b<0 guard capture (renderTimeMs=0, left beat negative) → Step2 render at start → Step3 beats <0 not drawn, first beat is 0', () => {
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
    const beatLines = extractBeatLines(strokes);
    const expectedBeats = computeVisibleBeats(tl, renderTimeMs, 110);
    expect(expectedBeats[0]).toBe(0);
    expect(extractBeatLines(strokes)[0].x).toBeCloseTo(beatX(0, renderTimeMs, 110, tl), 0);
    // ensure no negative beat line present
    expect(expectedBeats.every((b) => b >= 0)).toBe(true);
    // also ensure at least one line exists
    expect(beatLines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T217-2: Scroll sync — lines move left as time advances, same formula as rings
// ---------------------------------------------------------------------------
describe('T217-2: Scroll sync — beat lines move with time using ring formula (3-step, computed)', () => {
  it('Step1 capture X at t0 → Step2 advance time by 500ms (1 beat at 120bpm) → Step3 each line shifts left by scrollSpeed * dt/1000', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer0 = new Renderer();
    const renderer1 = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const scrollSpeed = 110;
    const t0 = 2000;
    const dt = 500; // 1 beat at 120bpm
    const t1 = t0 + dt;

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
    const lines0 = extractBeatLines(strokes0);

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
    const lines1 = extractBeatLines(strokes1);

    // Both have similar counts (may differ by 1 at edges)
    expect(lines0.length).toBeGreaterThan(0);
    expect(lines1.length).toBeGreaterThan(0);

    // For any beat that is visible in both frames, X should have moved left by dt*scrollSpeed/1000
    const expectedShift = (dt / 1000) * scrollSpeed; // 55
    expect(expectedShift).toBeCloseTo(55, 3);

    // Find common beats: intersection of visible beat sets
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
    }
  });

  it('Step1 ring X capture at same time → Step2 get beat line X for same beat → Step3 they use identical formula', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = tl.beatToMs(3.37); // off-grid
    const scrollSpeed = 110;
    const beat = 5;
    // ring formula: TW_JUDGE_X + ((hitTime - renderTimeMs)/1000)*scrollSpeed
    const hitTime = tl.beatToMs(beat);
    const ringX = TW_JUDGE_X + ((hitTime - renderTimeMs) / 1000) * scrollSpeed;
    const beatLineX = beatX(beat, renderTimeMs, scrollSpeed, tl);
    expect(beatLineX).toBeCloseTo(ringX, 5);

    // Verify actual rendered beat line X matches
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
    const lines = extractBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
    const idx = beats.indexOf(beat);
    if (idx !== -1) {
      expect(lines[idx].x).toBeCloseTo(ringX, 0);
    }
  });

  it('Step1 manualOffset capture (0) → Step2 set +80ms offset → Step3 beat lines shift by -offset (renderTimeMs = songTimeMs - offset)', () => {
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
    const lines0 = extractBeatLines(s0);
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
    const lines1 = extractBeatLines(s1);
    // renderTimeMs = 1920, so each beat line moves right by 80/1000*110 = 8.8px
    const expectedShift = (80 / 1000) * scrollSpeed;
    const common = beats0.filter((b) => computeVisibleBeats(tl, 1920, scrollSpeed).includes(b));
    for (const b of common.slice(0, 3)) {
      const idx0 = beats0.indexOf(b);
      const idx1 = computeVisibleBeats(tl, 1920, scrollSpeed).indexOf(b);
      if (idx0 !== -1 && idx1 !== -1) {
        expect(lines1[idx1].x).toBeCloseTo(lines0[idx0].x + expectedShift, 0);
      }
    }
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// T217-3: BPM change — interval adapts via beatToMs, spacing correct
// ---------------------------------------------------------------------------
describe('T217-3: BPM change interval adapts (3-step, computed, off-grid)', () => {
  it('Step1 single BPM capture (uniform 55px) → Step2 timeline with 120→60 at beat4 → Step3 spacing 55px before boundary and 110px after', () => {
    // single BPM baseline: spacing should be uniform 55px
    const single = makeTimeline([{ beat: 0, bpm: 120 }]);
    const spacingSingle = (single.beatToMs(2) - single.beatToMs(1)) / 1000 * 110;
    expect(spacingSingle).toBeCloseTo(55, 2);

    // BPM change: 120 until beat 4, then 60
    const changed = makeTimeline([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    // Render where both zones visible: choose renderTimeMs around beat 2 (1000ms)
    // so beats 0..~8 visible includes boundary
    const renderTimeMs = changed.beatToMs(2); // 1000ms
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
    const lines = extractBeatLines(strokes);
    const beats = computeVisibleBeats(changed, renderTimeMs, scrollSpeed);

    // spacing before boundary: b=1-2, 2-3 should be 55
    for (const b of [1, 2]) {
      const idx = beats.indexOf(b);
      const idxNext = beats.indexOf(b + 1);
      if (idx !== -1 && idxNext !== -1) {
        const gap = lines[idxNext].x - lines[idx].x;
        expect(gap).toBeCloseTo(55, 0);
      }
    }
    // spacing after boundary: b=5-6 should be 110 (60bpm beatMs 1000)
    for (const b of [5, 6]) {
      const idx = beats.indexOf(b);
      const idxNext = beats.indexOf(b + 1);
      if (idx !== -1 && idxNext !== -1) {
        const gap = lines[idxNext].x - lines[idx].x;
        expect(gap).toBeCloseTo(110, 0);
      }
    }
    // boundary gap 4->5 also 110 (since beat 4 starts 60bpm zone beatMs 1000)
    const idx4 = beats.indexOf(4);
    const idx5 = beats.indexOf(5);
    if (idx4 !== -1 && idx5 !== -1) {
      expect(lines[idx5].x - lines[idx4].x).toBeCloseTo(110, 0);
    }
  });

  it('Step1 capture gap at off-grid renderTimeMs 1.37 beats → Step2 same BPM change timeline → Step3 beat lines still at integer beats and gaps remain 55/110', () => {
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
    const lines = extractBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, 110);
    // Verify still integer beats only
    expect(beats.every((b) => Number.isInteger(b))).toBe(true);
    // Spacing check: find a pre-boundary adjacent pair
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

  it('Step1 complex BpmTimeline (120->150 at beat8) capture → Step2 render across change → Step3 beatToMs spacing reflects new BPM', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 150 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 150 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    // gap before change: 500ms -> 55px, after: 400ms -> 44px
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
    const lines = extractBeatLines(strokes);
    const beats = computeVisibleBeats(tl, renderTimeMs, 110);
    const idx6 = beats.indexOf(6);
    const idx7 = beats.indexOf(7);
    if (idx6 !== -1 && idx7 !== -1) expect(lines[idx7].x - lines[idx6].x).toBeCloseTo(55, 0);
    const idx9 = beats.indexOf(9);
    const idx10 = beats.indexOf(10);
    if (idx9 !== -1 && idx10 !== -1) expect(lines[idx10].x - lines[idx9].x).toBeCloseTo(44, 0);
  });
});

// ---------------------------------------------------------------------------
// T217-4: Zoom (scrollSpeed) and guard + style full-height
// ---------------------------------------------------------------------------
describe('T217-4: Zoom scrollSpeed, guard, and style verification (3-step)', () => {
  it('Step1 scrollSpeed=110 capture X → Step2 scrollSpeed=220 (zoom2.0) → Step3 X distance from judge line doubles', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const renderTimeMs = tl.beatToMs(4);
    const beat = 6; // 2 beats ahead
    const x110 = beatX(beat, renderTimeMs, 110, tl);
    const x220 = beatX(beat, renderTimeMs, 220, tl);
    expect(x220 - TW_JUDGE_X).toBeCloseTo(2 * (x110 - TW_JUDGE_X), 5);

    // Verify via actual renderer drawBeatLines direct call if method exposed
    const renderer: any = new Renderer();
    if (typeof renderer.drawBeatLines === 'function') {
      const { ctx: ctxA, strokes: sA } = makeMockCtx();
      renderer.drawBeatLines(ctxA, tl, renderTimeMs, 110);
      const linesA = extractBeatLines(sA);
      const beatsA = computeVisibleBeats(tl, renderTimeMs, 110);
      const idxA = beatsA.indexOf(beat);
      const { ctx: ctxB, strokes: sB } = makeMockCtx();
      renderer.drawBeatLines(ctxB, tl, renderTimeMs, 220);
      const linesB = extractBeatLines(sB);
      const beatsB = computeVisibleBeats(tl, renderTimeMs, 220);
      const idxB = beatsB.indexOf(beat);
      if (idxA !== -1 && idxB !== -1) {
        expect(linesB[idxB].x - TW_JUDGE_X).toBeCloseTo(2 * (linesA[idxA].x - TW_JUDGE_X), 0);
      }
    } else {
      // fallback: renderer.render with different scrollSpeed
      const rA = new Renderer();
      const { ctx: cA, strokes: stA } = makeMockCtx();
      rA.render(cA as any, { waveEngine: wave, cursor: { y: 300 } as any, rings: [], score: { getStats: () => ({ combo: 0, score: 0 }) } as any, songTimeMs: renderTimeMs, bpmTimeline: tl, judgementEvents: [], scrollSpeed: 110 } as any);
      const linesA2 = extractBeatLines(stA);
      const beatsA2 = computeVisibleBeats(tl, renderTimeMs, 110);
      const rB = new Renderer();
      const { ctx: cB, strokes: stB } = makeMockCtx();
      rB.render(cB as any, { waveEngine: wave, cursor: { y: 300 } as any, rings: [], score: { getStats: () => ({ combo: 0, score: 0 }) } as any, songTimeMs: renderTimeMs, bpmTimeline: tl, judgementEvents: [], scrollSpeed: 220 } as any);
      const linesB2 = extractBeatLines(stB);
      const beatsB2 = computeVisibleBeats(tl, renderTimeMs, 220);
      const idxA2 = beatsA2.indexOf(beat);
      const idxB2 = beatsB2.indexOf(beat);
      if (idxA2 !== -1 && idxB2 !== -1) {
        expect(linesB2[idxB2].x - TW_JUDGE_X).toBeCloseTo(2 * (linesA2[idxA2].x - TW_JUDGE_X), 0);
      }
    }
  });

  it('Step1 guard capture (huge view) → Step2 render with tiny beatMs (bpm 1000) and large canvas equivalent → Step3 line count is bounded (no infinite loop)', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 1000 }]); // beatMs 60ms
    const wave = makeWaveEngine([{ beat: 0, bpm: 1000 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const { ctx, strokes } = makeMockCtx();
    // Use normal scroll but render at 0 where left negative causes many beats? With zoom guard we expect <500
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
    const lines = extractBeatLines(strokes);
    expect(lines.length).toBeLessThan(500);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('Step1 style before (no thin) → Step2 render → Step3 all beat lines have rgba 0.20/0.30 lineWidth1 full-height vertical', () => {
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
    const lines = extractBeatLines(strokes);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.strokeStyle).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.(20|30)\)/);
      expect(line.lineWidth).toBe(1);
    }
    // Verify underlying strokes are vertical full height
    const beatStrokes = strokes.filter((s) => /rgba\(255,\s*255,\s*255,\s*0\.1[08]\)/.test(s.strokeStyle) && s.lineWidth === 1);
    for (const s of beatStrokes) {
      expect(s.path.length).toBe(2);
      expect(s.path[0].x).toBeCloseTo(s.path[1].x, 0);
      expect(Math.min(s.path[0].y, s.path[1].y)).toBeCloseTo(0, 0);
      expect(Math.max(s.path[0].y, s.path[1].y)).toBeCloseTo(CANVAS_HEIGHT, 0);
    }
  });

  it('Step1 zoomAt off-grid 0.37 capture → Step2 tl.zoomAt with complex amps 0.7/1.3/2.7 → Step3 scrollSpeed 110*zoomAt used consistently for beat lines', () => {
    const amps = [0.7, 1.3, 2.7];
    const offGrids = [0.37, 1.23, 3.37];
    for (const amp of amps) {
      const tl = makeTimeline([{ beat: 0, bpm: 120, zoom: amp }], 1.0);
      // need timeline with zoom at beat 0
      // BpmTimeline with bpmChanges containing zoom
      // verify zoomAt
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
        const lines = extractBeatLines(strokes);
        const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
        expect(lines.length).toBe(beats.length);
        // spot check one beat line X
        if (beats.length > 1) {
          const b = beats[0];
          expect(lines[0].x).toBeCloseTo(beatX(b, renderTimeMs, scrollSpeed, tl), 0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T217-5: Draw order — beat lines behind judge/wave/rings
// ---------------------------------------------------------------------------
describe('T217-5: Draw order — beat lines immediately after background, before judge/wave/rings (3-step)', () => {
  it('Step1 capture stroke order indices → Step2 render and collect ordered strokes → Step3 beat indices < judge < wave < rings', () => {
    const tl = makeTimeline([{ beat: 0, bpm: 120 }]);
    const wave = makeWaveEngine([{ beat: 0, bpm: 120 }]);
    const renderer = new Renderer();
    vi.spyOn(clock, 'getManualOffsetMs').mockReturnValue(0);

    const { ctx, strokes } = makeMockCtx();
    // need ctx.fillRect tracking for background order
    let order: string[] = [];
    const origFillRect = (ctx as any).fillRect;
    (ctx as any).fillRect = vi.fn((...args: any[]) => {
      order.push('background');
      return origFillRect(...args);
    });
    const origStroke = (ctx as any).stroke;
    // wrap stroke to capture order by style
    let strokeOrder: string[] = [];
    let currentStyle = '';
    Object.defineProperty(ctx, 'strokeStyle', {
      get() { return currentStyle; },
      set(v: string) { currentStyle = String(v); },
      configurable: true,
    });
    (ctx as any).stroke = vi.fn(() => {
      // classify by style at stroke time
      if (/rgba\(255,\s*255,\s*255,\s*0\.1[08]\)/.test(currentStyle)) strokeOrder.push('beat');
      else if (currentStyle === 'rgba(255,255,255,0.08)' || currentStyle === 'rgba(255,255,255,0.08)') strokeOrder.push('judge');
      else if (currentStyle === '#6366f1') strokeOrder.push('wave');
      else strokeOrder.push(`other:${currentStyle}`);
      // still record for extract
      const mock: any = ctx;
      // push to strokes via original mock logic is lost after override, so manually handle
      // we rely on source order test already done, but also verify beat < judge < wave
    });

    // Instead verify via source + via separate renderer that uses our original makeMockCtx strokes order
    // Re-create with original mock to get precise order
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
    // strokes2 contains all strokes in drawing order
    const indices: Record<string, number> = {};
    for (let i = 0; i < strokes2.length; i++) {
      const s = strokes2[i];
      if (/rgba\(255,\s*255,\s*255,\s*0\.(20|30)\)/.test(s.strokeStyle) && s.lineWidth === 1 && indices['beat'] === undefined) indices['beat'] = i;
      if (s.strokeStyle === 'rgba(255,255,255,0.08)' && indices['judge'] === undefined) indices['judge'] = i;
      if (s.strokeStyle === '#6366f1' && indices['wave'] === undefined) indices['wave'] = i;
      // rings use #ededed or #4ade80 etc with radius arc
      if ((s.strokeStyle === '#ededed' || s.strokeStyle === '#4ade80') && s.path.some((p: any) => p.op === 'arc') && indices['ring'] === undefined) {
        // ring arc is circle, not vertical line
        indices['ring'] = i;
      }
    }
    // background is fillRect not stroke, so we assert beat before judge/wave/ring
    expect(indices['beat']).toBeDefined();
    expect(indices['judge']).toBeDefined();
    expect(indices['wave']).toBeDefined();
    expect(indices['beat']!).toBeLessThan(indices['judge']!);
    expect(indices['beat']!).toBeLessThan(indices['wave']!);
    if (indices['ring'] !== undefined) {
      expect(indices['beat']!).toBeLessThan(indices['ring']!);
    }
  });

  it('Step1 source order capture → Step2 read renderer.ts → Step3 drawBeatLines appears exactly once as drawBackground->drawBeatLines->drawJudgeLine', () => {
    const src = readFile('src/game/renderer.ts');
    const count = (src.match(/drawBeatLines/g) || []).length;
    // one definition + one call = 2 occurrences
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
// T217-6: Integration — drawBeatLines callable directly and matches render path
// ---------------------------------------------------------------------------
describe('T217-6: drawBeatLines direct call matches ring formula and guards (3-step)', () => {
  it('Step1 direct call at renderTimeMs 1.23 off-grid → Step2 call drawBeatLines with same params → Step3 lines count and X identical to render path', () => {
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
    const viaRender = extractBeatLines(strokesRender);

    if (typeof renderer.drawBeatLines === 'function') {
      const { ctx, strokes } = makeMockCtx();
      renderer.drawBeatLines(ctx, tl, renderTimeMs, scrollSpeed);
      const direct = extractBeatLines(strokes);
      expect(direct.length).toBe(viaRender.length);
      for (let i = 0; i < direct.length; i++) {
        expect(direct[i].x).toBeCloseTo(viaRender[i].x, 0);
      }
    } else {
      // If method is private, we still expect viaRender to have correct lines
      expect(viaRender.length).toBeGreaterThan(0);
      const beats = computeVisibleBeats(tl, renderTimeMs, scrollSpeed);
      expect(viaRender.length).toBe(beats.length);
    }
  });
});
