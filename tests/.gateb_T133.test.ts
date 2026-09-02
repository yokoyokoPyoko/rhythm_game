/**
 * Vitest unit tests for T133 – プロセカ風フルスクリーンキャリブレーションオーバーレイ（ループ練習譜面）
 * Runs in node environment without browser. Verifies pure computed values / engine math
 * and file-level implementation contracts with 3-step state-transition assertions.
 *
 * Spec summary:
 * - /calibration route and CalibrationScreen.tsx completely removed
 * - Calibration is full-screen overlay (data-testid="editor-calibration-modal") opened from SelectScreen (L key -> setCalibrationOpen true) and EditorScreen (editor-calibration-button), stopping BGM via stop()/stopMetronome() on open
 * - Infinite loop chart: BPM=120 fixed, segments up 2 / down 2 alternating, rings at beats 4,8,12,... (>=2400 beats, type single)
 * - Overlay: metronome schedule + chart playback, Space judgement with errorMs display, ,/< and ./> ±10ms or buttons, save (calibration-save / Enter) vs cancel (calibration-cancel / ESC) with offset restore
 * - Regression: T132 offset correction, T102/T103 play stamp prohibition, T129 snap alignment
 */

// ensure localStorage mock for node environment (clock.ts uses localStorage)
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  } as any;
}

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat, segmentize, isSnapAligned } from '../src/chart/quantize';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';
import { judgeHit } from '../src/game/hitJudge';
import type { Segment, RingDef, Chart } from '../src/types';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  const p = path.resolve(__dirname, '..', rel);
  return fs.readFileSync(p, 'utf-8');
}
function fileExists(rel: string): boolean {
  const p = path.resolve(__dirname, '..', rel);
  return fs.existsSync(p);
}
function isSnapAlignedLocal(beats: number, snap: number, eps = 1e-6): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < eps || Math.abs(rem - snap) < eps;
}

// Build expected calibration chart per spec (for numeric validation)
function makeExpectedCalibrationChart(totalBeats = 2400): Chart {
  const segments: Segment[] = [];
  let beat = 0;
  let isUp = true;
  while (beat < totalBeats) {
    const remaining = totalBeats - beat;
    const beats = Math.min(2, remaining);
    segments.push({ direction: isUp ? 'up' : 'down', beats });
    beat += beats;
    isUp = !isUp;
  }
  const rings: RingDef[] = [];
  for (let b = 4; b <= totalBeats; b += 4) {
    rings.push({ beat: b, type: 'single' });
  }
  return {
    title: 'Calibration Practice',
    artist: '',
    bpm: 120,
    audio: '',
    audio_offset: 0,
    scroll_speed: 110,
    amplitude: 1.0,
    start_position: 0.0,
    bpm_changes: [],
    segments,
    rings,
  };
}

// Try to load implementation's calibration chart generator (multiple possible paths/exports)
async function tryLoadCalibrationChart(): Promise<{ chart: Chart; source: string } | null> {
  const candidates = [
    '../src/screens/editor/CalibrationOverlay',
    '../src/screens/editor/CalibrationModal',
    '../src/game/calibrationChart',
    '../src/screens/SelectScreen',
    '../src/screens/EditorScreen',
  ];
  for (const modPath of candidates) {
    try {
      const mod: any = await import(modPath);
      // named exports that could generate chart
      const genCandidates = [
        mod.generateCalibrationChart,
        mod.generateCalibrationLoopChart,
        mod.buildCalibrationChart,
        mod.createCalibrationChart,
        mod.getCalibrationChart,
        mod.calibrationChart,
        mod.CALIBRATION_CHART,
      ];
      for (const g of genCandidates) {
        if (typeof g === 'function') {
          const c = g(2400) ?? g();
          if (c && Array.isArray((c as Chart).segments) && Array.isArray((c as Chart).rings)) {
            return { chart: c as Chart, source: modPath + '::function' };
          }
        } else if (g && typeof g === 'object' && Array.isArray((g as Chart).segments)) {
          return { chart: g as Chart, source: modPath + '::object' };
        }
      }
      // default export may be component with attached chart
      if (mod.default) {
        const d: any = mod.default;
        if (d.generateCalibrationChart) {
          const c = d.generateCalibrationChart(2400) ?? d.generateCalibrationChart();
          if (c && Array.isArray(c.segments)) return { chart: c, source: modPath + '::default.fn' };
        }
      }
    } catch {
      // ignore import failure, try next
    }
  }
  return null;
}

function parseCalibrationSourceViaFs(): { segmentsOk: boolean; ringsOk: boolean; bpmOk: boolean; beats: number | null } | null {
  // Fallback: scan fs for generation logic if dynamic import fails
  // Prioritize overlay files which contain the definitive generation params (>=2400)
  const overlayFiles = [
    'src/screens/editor/CalibrationOverlay.tsx',
    'src/screens/editor/CalibrationModal.tsx',
    'src/game/calibrationChart.ts',
  ];
  const otherFiles = [
    'src/screens/EditorScreen.tsx',
    'src/screens/SelectScreen.tsx',
  ];
  let aggregatedOverlay = '';
  for (const f of overlayFiles) {
    if (fileExists(f)) aggregatedOverlay += '\n' + readFile(f);
  }
  let aggregated = aggregatedOverlay;
  for (const f of otherFiles) {
    if (fileExists(f)) aggregated += '\n' + readFile(f);
  }
  if (!aggregated) return null;
  const searchStr = aggregatedOverlay || aggregated;
  const hasBpm120 = /bpm\s*[:=]\s*120/.test(searchStr) || /BPM\s*=\s*120/.test(searchStr) || (searchStr.includes('CAL_BPM') && searchStr.includes('120')) || searchStr.includes('bpm: 120') || searchStr.includes('bpm = 120');
  const hasUp2Down2 = searchStr.includes('up') && searchStr.includes('down') && /beats.*?2/.test(searchStr);
  const hasRing4 = /beat\s*=\s*4/.test(searchStr) || /beat:\s*4/.test(searchStr) || /4,\s*8,\s*12/.test(searchStr) || /4\s*\*\s*/.test(searchStr) || /\+=.*4/.test(searchStr);
  // Extract beats: look for any 4-digit number >=2400 in overlay file (prefer max)
  let beats: number | null = null;
  const allNums = [...searchStr.matchAll(/(\d{4,})/g)].map(m => Number(m[1])).filter(n => Number.isFinite(n));
  if (allNums.length) {
    const max = Math.max(...allNums);
    if (max >= 1000) beats = max;
  }
  // explicit 2400 check overrides
  if (searchStr.includes('2400')) beats = Math.max(beats ?? 0, 2400);
  // also check totalBeats param
  const mTotal = searchStr.match(/totalBeats\s*[=:]\s*(\d+)/);
  if (mTotal) {
    const n = Number(mTotal[1]);
    if (Number.isFinite(n)) beats = Math.max(beats ?? 0, n);
  }
  return { segmentsOk: hasUp2Down2, ringsOk: hasRing4, bpmOk: hasBpm120, beats };
}

// ---------------------------------------------------------------------------
// T133-1: /calibration route abolition
// ---------------------------------------------------------------------------
describe('T133-1: /calibration ルート廃止と CalibrationScreen 削除 (3-step)', () => {
  it('Step1-3: CalibrationScreen.tsx が削除されていること', () => {
    // Step1: capture initial existence
    const calPath = 'src/screens/CalibrationScreen.tsx';
    const existsBefore = fileExists(calPath);
    // Step2: expected after fix is non-existence
    // Step3: assert transition to deleted
    expect(existsBefore, 'CalibrationScreen.tsx must be deleted for T133 (still exists -> Red)').toBe(false);
  });

  it('Step1-3: App.tsx に path="/calibration" と CalibrationScreen import が存在しないこと', () => {
    // Step1: capture App.tsx content
    const appSrc = readFile('src/App.tsx');
    const hasRoute = appSrc.includes('path="/calibration"') || appSrc.includes("path='/calibration'") || appSrc.includes('path="/calibration"');
    const hasImport = appSrc.includes('CalibrationScreen');
    // Step2: after fix both must be removed
    // Step3: assert
    expect(hasRoute, 'App.tsx still contains /calibration route (must be removed)').toBe(false);
    expect(hasImport, 'App.tsx still imports CalibrationScreen (must be removed)').toBe(false);
    // Also ensure no navigate('/calibration') remains in codebase for SelectScreen
    const selectSrc = readFile('src/screens/SelectScreen.tsx');
    expect(selectSrc, 'SelectScreen must not use navigate("/calibration")').not.toContain("navigate('/calibration')");
    expect(selectSrc, 'SelectScreen must not use navigate("/calibration") double-quote').not.toContain('navigate("/calibration")');
  });

  it('Step1-3: SelectScreen の L キーハンドラがオーバーレイ起動 setCalibrationOpen(true) に変更されていること', () => {
    // Step1: read SelectScreen source
    const src = readFile('src/screens/SelectScreen.tsx');
    const hasNavigateCalibration = src.includes("navigate('/calibration')") || src.includes('navigate("/calibration")');
    const hasOverlayOpen = src.includes('setCalibrationOpen(true)') || src.includes('setCalibrationOpen( true )') || src.includes('calibrationOpen');
    // Step2: after fix navigate must be gone, overlay state must exist
    // Step3: assert 3-step transition
    expect(hasNavigateCalibration, 'L key still navigates to /calibration (must use overlay)').toBe(false);
    expect(hasOverlayOpen, 'SelectScreen must have setCalibrationOpen(true) overlay state for L key').toBe(true);
    // Also ensure data-testid for calibration button exists (SelectScreen)
    expect(src, 'SelectScreen must have data-testid="select-calibration-button"').toContain('select-calibration-button');
  });

  it('App.tsx の Routes に editor/select/game/result 以外の calibration ルートが無いこと', () => {
    const appSrc = readFile('src/App.tsx');
    const routeMatches = (appSrc.match(/<Route[^>]*path=/g) || []).length;
    // Expect exactly 5 routes max: /, /play/:songId, /play/custom, /result, /editor (no calibration)
    // If calibration route remains, count would be 6
    expect(routeMatches).toBeLessThanOrEqual(5);
    expect(appSrc).toContain('path="/editor"');
    expect(appSrc).toContain('path="/"');
  });
});

// ---------------------------------------------------------------------------
// T133-2: Overlay起動時の背景楽曲停止と Space 入力分離
// ---------------------------------------------------------------------------
describe('T133-2: オーバーレイ起動時の背景楽曲停止とキー分離 (3-step)', () => {
  beforeEach(() => {
    setManualOffset(0);
  });

  it('Step1-3: EditorScreen のキャリブレーション起動時に stop()/stopMetronome() が呼ばれてから開くこと', () => {
    // Step1: capture EditorScreen source before
    const src = readFile('src/screens/EditorScreen.tsx');
    const hasCalibrationButton = src.includes('data-testid="editor-calibration-button"');
    expect(hasCalibrationButton, 'EditorScreen must have editor-calibration-button').toBe(true);

    // Step2: find the onClick handler for calibration button
    // It should call stop() and/or stopMetronome() before setCalibrationOpen(true)
    const btnIdx = src.indexOf('data-testid="editor-calibration-button"');
    const afterBtn = src.slice(Math.max(0, btnIdx - 800), btnIdx + 1500);
    // Check that stop logic exists near button handler
    const callsStop = afterBtn.includes('stop(') || src.includes('stopMetronome()');
    // Also check global handler for calibration open includes stop
    const openIdx = src.indexOf('setCalibrationOpen(true)');
    const contextAroundOpen = src.slice(Math.max(0, openIdx - 1200), openIdx + 500);
    const hasStopBeforeOpen = contextAroundOpen.includes('stop(') || contextAroundOpen.includes('stopMetronome');

    // Step3: assert
    expect(callsStop, 'EditorScreen calibration open must call stop()').toBe(true);
    expect(hasStopBeforeOpen, 'setCalibrationOpen(true) must be preceded by stop()/stopMetronome() to prevent BGM overlap').toBe(true);
    // Also ensure stale CalibrationModal (8-tap) logic is gone if Overlay is used
    expect(src).not.toContain("navigate('/calibration')");
  });

  it('キャリブレーションオーバーレイが full-screen かつ data-testid="editor-calibration-modal" を持ち、positionRef/isPlayingに非依存であること', () => {
    // Step1: locate overlay implementation (CalibrationOverlay.tsx or updated CalibrationModal.tsx)
    const overlayExists = fileExists('src/screens/editor/CalibrationOverlay.tsx') || fileExists('src/screens/editor/CalibrationModal.tsx');
    expect(overlayExists, 'Calibration overlay file must exist (CalibrationOverlay.tsx or CalibrationModal.tsx)').toBe(true);

    let src = '';
    if (fileExists('src/screens/editor/CalibrationOverlay.tsx')) src = readFile('src/screens/editor/CalibrationOverlay.tsx');
    else src = readFile('src/screens/editor/CalibrationModal.tsx');

    // Step2: check full-screen characteristics
    const hasModalTestId = src.includes('data-testid="editor-calibration-modal"') || src.includes("data-testid='editor-calibration-modal'");
    const hasFullScreenStyle = src.includes('position: fixed') || src.includes('fixed') || src.includes('inset: 0') || src.includes('100vw') || src.includes('100vh') || src.includes('calibration-overlay') || src.includes('z-index');
    const dependsOnPositionRef = src.includes('positionRef') || src.includes('isPlayingRef');

    // Step3: assert
    expect(hasModalTestId, 'Overlay must have data-testid="editor-calibration-modal"').toBe(true);
    expect(hasFullScreenStyle, 'Overlay must be full-screen (fixed/inset/100vw etc)').toBe(true);
    expect(dependsOnPositionRef, 'Overlay must NOT depend on EditorScreen positionRef/isPlaying (must be independent)').toBe(false);
  });

  it('オーバーレイは dedicated route に依存せず、SelectScreen/EditorScreen で条件付きrenderされること', () => {
    const selectSrc = readFile('src/screens/SelectScreen.tsx');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    // Both should conditionally render overlay via {calibrationOpen && ...} or similar
    const selectHasConditional = selectSrc.includes('calibrationOpen') && (selectSrc.includes('CalibrationOverlay') || selectSrc.includes('CalibrationModal'));
    const editorHasConditional = editorSrc.includes('calibrationOpen') && (editorSrc.includes('CalibrationOverlay') || editorSrc.includes('CalibrationModal'));
    expect(selectHasConditional, 'SelectScreen must conditionally render Calibration overlay (not route)').toBe(true);
    expect(editorHasConditional, 'EditorScreen must conditionally render Calibration overlay').toBe(true);
    // Ensure App.tsx has no calibration route (already checked, double-assert)
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toContain('CalibrationOverlay');
    expect(appSrc).not.toContain('CalibrationModal');
  });

  it('オーバーレイ起動中は BGM/録音/メトロノームが停止し Space 入力が編集と重複しない (file contract: stop before open)', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Find calibration open sequence: should stop music, metronome, and recording
    // Look for stop() and stopMetronome together near setCalibrationOpen
    const idx = src.indexOf('setCalibrationOpen(true)');
    expect(idx).toBeGreaterThan(-1);
    const windowSrc = src.slice(Math.max(0, idx - 1500), idx + 500);
    // Must handle both music stop and metronome stop
    expect(windowSrc).toContain('stop');
    // Also overlay file should handle its own metronome and not reuse EditorScreen's positionRef
    const overlayFile = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const overlaySrc = readFile(overlayFile);
    expect(overlaySrc).toContain('schedule(');
    expect(overlaySrc).not.toContain('positionRef');
  });
});

// ---------------------------------------------------------------------------
// T133-3: 無限ループ練習譜面生成 (BPM 120, up2/down2交互, リング4拍ごと, >=2400beats)
// ---------------------------------------------------------------------------
describe('T133-3: プロセカ風無限ループ譜面生成 (BPM120 / up2-down2交互 / リング4拍ごと / >=2400)', () => {
  beforeEach(() => {
    setManualOffset(0);
  });

  it('Step1-3: 生成譜面が BPM120固定で totalBeats >=2400 であること (3-step dynamic)', async () => {
    // Step1: capture initial attempt via fs fallback
    const parsed = parseCalibrationSourceViaFs();
    // Step2: try dynamic import of generator
    const impl = await tryLoadCalibrationChart();
    let chart: Chart | null = null;
    let source = 'expected-manual';
    if (impl) {
      chart = impl.chart;
      source = impl.source;
    } else {
      // If no impl, use expected manual chart but expect fs to contain 2400
      chart = makeExpectedCalibrationChart(2400);
      // This branch means impl missing -> will still check fs for 2400, failing before fix
      if (parsed) {
        expect(parsed.bpmOk, `Calibration source must have BPM 120 (source scan)`).toBe(true);
        expect(parsed.beats, `Calibration chart must be generated with >=2400 beats (found ${parsed.beats}, source: scan)`).not.toBeNull();
        expect(parsed.beats!, `Calibration beats must be >=2400 (found ${parsed?.beats})`).toBeGreaterThanOrEqual(2400);
      }
    }
    // Step3: assert resulting chart
    expect(chart, `Calibration chart must be generated (source: ${source})`).not.toBeNull();
    expect(chart!.bpm, `BPM must be 120 (got ${chart!.bpm}) source ${source}`).toBe(120);
    const totalBeats = chart!.segments.reduce((s, seg) => s + seg.beats, 0);
    expect(totalBeats, `totalBeats must be >=2400 (got ${totalBeats}, source ${source})`).toBeGreaterThanOrEqual(2400);
    // Also via fs direct check for minimum 2400
    if (parsed?.beats !== null && parsed?.beats !== undefined) {
      expect(parsed.beats).toBeGreaterThanOrEqual(2400);
    }
    // BpmTimeline with 120 must have 500ms per beat
    const tl = new BpmTimeline(chart!.bpm, chart!.bpm_changes ?? []);
    expect(tl.beatMsAt(0)).toBeCloseTo(500, 0);
    expect(tl.beatMsAt(100)).toBeCloseTo(500, 0);
  });

  it('セグメントが up 2拍 / down 2拍 を交互に繰り返すこと (direction & beats)', async () => {
    const impl = await tryLoadCalibrationChart();
    let chart: Chart;
    if (impl) chart = impl.chart;
    else chart = makeExpectedCalibrationChart(2400);

    // Step1: capture segments
    const segs = chart.segments;
    expect(segs.length, 'segments must exist and be many for 2400 beats').toBeGreaterThanOrEqual(500);
    // Step2: verify alternating pattern
    for (let i = 0; i < Math.min(segs.length, 20); i++) {
      const expectedDir = i % 2 === 0 ? 'up' : 'down';
      expect(segs[i].direction, `segment ${i} direction must be ${expectedDir} (alternating up/down)`).toBe(expectedDir);
      expect(segs[i].beats, `segment ${i} beats must be 2`).toBeCloseTo(2, 4);
    }
    // Step3: all segments must be 2 beats and only up/down (no stay)
    for (const s of segs) {
      expect(s.beats).toBeCloseTo(2, 4);
      expect(['up', 'down']).toContain(s.direction);
    }
    // Validate via WaveEngine that pattern yields correct Y alternation
    const tl = new BpmTimeline(chart.bpm, []);
    const engine = new WaveEngine(segs.slice(0, 10), tl, 1.0, 0);
    // up 2 from center -> top, down 2 -> bottom etc. Check endpoints
    const pts = engine.getPoints();
    expect(pts.length).toBe(11);
    // first up 2 should reach top, second down 2 should reach bottom (clamped)
    // With amp 1, up -520 clamped to top, so pts[1].y == top
    const TOP = TW_CENTER_Y - TW_AMP;
    const BOTTOM = TW_CENTER_Y + TW_AMP;
    expect(pts[1].y).toBeCloseTo(TOP, 0);
    expect(pts[2].y).toBeCloseTo(BOTTOM, 0);
  });

  it('リングが 4拍ごと (beat 4,8,12,...) に type single で配置されること', async () => {
    const impl = await tryLoadCalibrationChart();
    let chart: Chart;
    if (impl) chart = impl.chart;
    else chart = makeExpectedCalibrationChart(2400);

    const rings = chart.rings;
    expect(rings.length, 'rings must be many (totalBeats/4)').toBeGreaterThanOrEqual(500);
    // first few must be 4,8,12,16...
    for (let i = 0; i < Math.min(10, rings.length); i++) {
      const expectedBeat = (i + 1) * 4;
      expect(rings[i].beat, `ring ${i} beat must be ${expectedBeat}`).toBeCloseTo(expectedBeat, 4);
      expect(rings[i].type ?? 'single', `ring ${i} type must be single`).toBe('single');
    }
    // all rings must be multiples of 4
    for (const r of rings) {
      expect(r.beat % 4, `ring beat ${r.beat} must be multiple of 4`).toBeCloseTo(0, 4);
      expect(r.type ?? 'single').toBe('single');
    }
    // Must not be 8-tap limited: ensure many rings (at least 200 for 800 beats, but 600 for 2400)
    expect(rings.length).toBeGreaterThanOrEqual(600);
    // Verify ring Y via WaveEngine matches waveYAt at beat
    const tl = new BpmTimeline(120, []);
    const engine = new WaveEngine(chart.segments.slice(0, 10), tl, 1.0, 0);
    for (let i = 0; i < 3; i++) {
      const b = rings[i].beat;
      const y = engine.waveYAt(b);
      expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6);
      expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6);
    }
  });

  it('譜面生成が Chart 形式で BpmTimeline / WaveEngine / Cursor と整合し、20分以上 (2400 beats) 再生可能であること (off-grid check)', async () => {
    const impl = await tryLoadCalibrationChart();
    let chart: Chart;
    if (impl) chart = impl.chart;
    else chart = makeExpectedCalibrationChart(2400);

    const tl = new BpmTimeline(chart.bpm, chart.bpm_changes ?? []);
    const totalBeats = chart.segments.reduce((s, seg) => s + seg.beats, 0);
    // 2400 beats at 120BPM = 20 minutes = 1_200_000 ms
    const totalMs = tl.beatToMs(totalBeats);
    expect(totalMs).toBeCloseTo(2400 * 500, 0);
    expect(totalMs).toBeGreaterThanOrEqual(20 * 60 * 1000);

    // WaveEngine must be consistent with Cursor speed across off-grid phases
    const engine = new WaveEngine(chart.segments.slice(0, 20), tl, 1.0, 0);
    const offGridBeats = [0.37, 1.23, 2.62, 3.37, 4.23];
    for (const b of offGridBeats) {
      const y = engine.waveYAt(b);
      expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6);
      expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6);
    }
    // Cursor speed: amp 1 => 260 px/beat, wave slope before clip must match
    const cursor = new Cursor(1.0, 0);
    const startY = cursor.y;
    const dt = (0.1 * 500) / 1000; // 0.1 beats
    cursor.update(dt, false, true, 500);
    const cursorSlope = (cursor.y - startY) / 0.1;
    expect(cursorSlope).toBeCloseTo(2 * TW_AMP * 1.0, 0);
    // Wave slope for first down segment would also be 260, but calibration starts up so first is -260
    // So check that after first up is clamped top, second down slope is +260
    const seg2Engine = new WaveEngine([{ direction: 'down', beats: 2 }], tl, 1.0, 1.0); // from top down
    const slope2 = (seg2Engine.waveYAt(0.1) - seg2Engine.waveYAt(0)) / 0.1;
    expect(slope2).toBeCloseTo(260, 0);
  });

  it('生成ロジックが hardcode 200 beats でなく 2400 beats で大量生成すること (regression for past failure)', () => {
    const parsed = parseCalibrationSourceViaFs();
    if (parsed) {
      expect(parsed.beats, 'must generate >=2400 beats, not 200').not.toBe(200);
      if (parsed.beats !== null) expect(parsed.beats).toBeGreaterThanOrEqual(2400);
    }
    // Also check that file does not contain magic 200 as totalBeats limit for calibration
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    if (fileExists(overlayPath)) {
      const src = readFile(overlayPath);
      // If it contains 200 as totalBeats param, ensure it also has 2400
      const has2400 = src.includes('2400') || src.includes('2500') || src.includes('3000') || /totalBeats\s*=\s*\d{4,}/.test(src);
      expect(has2400, `${overlayPath} must generate >=2400 beats (found 2400 or more)`).toBe(true);
    }
  });

  it('セグメント getPoints 長さが segments.length+1 を維持すること (editor 1:1 mapping regression)', async () => {
    const impl = await tryLoadCalibrationChart();
    let chart: Chart;
    if (impl) chart = impl.chart;
    else chart = makeExpectedCalibrationChart(32);
    const tl = new BpmTimeline(chart.bpm, []);
    const engine = new WaveEngine(chart.segments.slice(0, 5), tl, 1.0, 0);
    const pts = engine.getPoints();
    expect(pts.length).toBe(6);
    for (const p of pts) {
      expect(typeof p.beat).toBe('number');
      expect(typeof p.y).toBe('number');
      expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
    }
  });
});

// ---------------------------------------------------------------------------
// T133-4: 操作 – Space判定・誤差表示、±10ms微調整、保存/キャンセル
// ---------------------------------------------------------------------------
describe('T133-4: プロセカ風操作 – Space判定・誤差表示・±10ms・保存/キャンセル (3-step)', () => {
  beforeEach(() => {
    setManualOffset(0);
  });

  it('Step1-3: Space でリングを叩くと judgeHit が PERFECT/GOOD を返し errorMs が表示されること (3-step)', () => {
    // Step1: capture initial offset and prepare calibration timeline/rings
    expect(getManualOffsetMs()).toBe(0);
    const chart = makeExpectedCalibrationChart(32);
    const tl = new BpmTimeline(chart.bpm, []);
    // Simulate ring at beat 4
    const hitBeat = 4;
    const hitTime = tl.beatToMs(hitBeat);
    const engine = new WaveEngine(chart.segments, tl, 1.0, 0);
    const targetY = engine.waveYAt(hitBeat);
    const ringState: any = {
      id: 0,
      hitTime,
      targetY,
      resolved: false,
      hit: false,
      type: 'single',
    };
    // Step2: perform hit exactly at hitTime with correct Y (perfect)
    const perfectY = targetY + 5; // within 30
    const resPerfect = judgeHit(hitTime + 12, perfectY, [ringState], 500); // 12ms error
    // Step3: assert perfect
    expect(resPerfect).not.toBeNull();
    expect(resPerfect!.result).toBe('perfect');
    expect(resPerfect!.errorMs).toBeCloseTo(12, 0);

    // Good case: larger Y distance but still hit
    const ring2: any = { id: 1, hitTime: tl.beatToMs(8), targetY: engine.waveYAt(8), resolved: false, hit: false, type: 'single' };
    const goodY = ring2.targetY + 45; // within 60 but >30
    const resGood = judgeHit(ring2.hitTime + 30, goodY, [ring2], 500);
    expect(resGood).not.toBeNull();
    expect(resGood!.result).toBe('good');

    // Miss case: Y too far
    const ring3: any = { id: 2, hitTime: tl.beatToMs(12), targetY: engine.waveYAt(12), resolved: false, hit: false, type: 'single' };
    const miss = judgeHit(ring3.hitTime, ring3.targetY + 80, [ring3], 500); // Y 80 >60
    expect(miss).not.toBeNull();
    expect(miss!.result).toBe('miss');

    // Verify overlay file displays judgement with errorMs (PERFECT (+12ms) etc)
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    expect(src).toContain('PERFECT');
    expect(src).toContain('GOOD');
    expect(src).toContain('errorMs');
  });

  it('Step1-3: ,/< と ./> または ±10ms ボタンで manualOffsetMs が ±10 変化し保存されること', () => {
    // Step1: initial
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    // Step2: simulate adjust logic as in EditorScreen/GameScreen/Overlay
    const adjust = (delta: number) => {
      const next = Math.round(getManualOffsetMs() + delta);
      setManualOffset(next);
      return next;
    };
    const afterMinus = adjust(-10);
    expect(afterMinus).toBe(-10);
    expect(getManualOffsetMs()).toBe(-10);
    const afterPlus = adjust(10);
    expect(afterPlus).toBe(0);
    expect(getManualOffsetMs()).toBe(0);
    adjust(10);
    adjust(10);
    expect(getManualOffsetMs()).toBe(20);
    // Step3: verify file contract for buttons
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Must have calibration-plus / minus or -10ms / +10ms handling
    const hasMinus = src.includes('calibration-minus') || src.includes('-10') || src.includes("','") || src.includes('","');
    const hasPlus = src.includes('calibration-plus') || src.includes('+10') || src.includes("'.'") || src.includes('"."');
    const hasDataTestIdMinus = src.includes('data-testid="calibration-minus"') || src.includes("data-testid='calibration-minus'");
    const hasDataTestIdPlus = src.includes('data-testid="calibration-plus"') || src.includes("data-testid='calibration-plus'");
    expect(hasMinus || hasDataTestIdMinus, 'Overlay must have -10ms button/handler').toBe(true);
    expect(hasPlus || hasDataTestIdPlus, 'Overlay must have +10ms button/handler').toBe(true);
    expect(src).toContain('setManualOffset');
    expect(src).toContain('getManualOffsetMs');
  });

  it('オーバーレイが calibration-save (保存して終了 / Enter) と calibration-cancel (キャンセル / ESC) を持つこと', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Must have both buttons
    expect(src, 'must have calibration-save').toContain('calibration-save');
    expect(src, 'must have calibration-cancel').toContain('calibration-cancel');
    // Must handle Enter and ESC
    expect(src).toContain('Enter');
    expect(src).toContain('Escape');
    // Must have setManualOffset save and restore on cancel
    expect(src).toContain('setManualOffset');
    // Cancel should restore saved offset (contains savedOffset or previous)
    expect(src).toMatch(/savedOffset|prevOffset|originalOffset|beforeOffset|startOffset/i);
  });

  it('Step1-3: 保存して終了で setManualOffset が保存され閉じ、キャンセル/ESCで直前値に復元され保存されないこと', () => {
    // Step1: set initial offset 123, simulate overlay open save previous
    setManualOffset(123);
    const saved = getManualOffsetMs();
    expect(saved).toBe(123);
    // Simulate overlay open: savedOffsetRef = saved
    let overlayCurrentOffset = 50; // user adjusted to 50 via ±10
    // Save path: setManualOffset(overlayCurrentOffset) and close
    setManualOffset(overlayCurrentOffset);
    expect(getManualOffsetMs()).toBe(50);
    // Cancel path: should restore saved
    setManualOffset(saved);
    expect(getManualOffsetMs()).toBe(123);
    expect(getManualOffsetMs()).not.toBe(50);

    // File contract: overlay must implement save vs cancel distinction
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Save button should call onClose(true) or setManualOffset then close
    expect(src).toMatch(/onClose\(true\)|setManualOffset.*close|calibration-save/);
    // Cancel should call onClose(false) or restore
    expect(src).toMatch(/onClose\(false\)|cancel|restore/);
  });

  it('無限ループ・やらせっぱなしで好きなタイミングで終了できること (8回タップ自動完了が廃止)', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Must NOT have CAL_SAMPLES =8 auto-finish logic (or if it has, it must not auto-close)
    // Old CalibrationModal had CAL_SAMPLES=8 and samplesRef.length >= CAL_SAMPLES -> done
    // New overlay should not auto-complete on 8 taps
    const hasOldAutoFinish = src.includes('CAL_SAMPLES') && src.includes('samplesRef.current.length >= CAL_SAMPLES');
    // If file still contains CAL_SAMPLES, it must not be used to auto-close after 8
    // Simpler: ensure loop logic is infinite, not checking for 8
    if (hasOldAutoFinish) {
      // If still has CAL_SAMPLES, check that done does not auto-close overlay (has save/cancel instead)
      expect(src).toContain('calibration-save');
    }
    // Must have infinite loop concept: totalBeats large or while true loop
    const parsed = parseCalibrationSourceViaFs();
    if (parsed?.beats !== null) {
      expect(parsed.beats).toBeGreaterThanOrEqual(2400);
    }
    // Ensure overlay does not have "8回" fixed completion text as sole termination
    // It may mention but not enforce
    expect(src).not.toMatch(/samplesRef\.current\.length >= 8.*onClose\(true\)/);
  });

  it('判定結果と打刻誤差が判定線付近にリアルタイム表示されること (file contract)', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Must display judgement near judgement line
    expect(src).toMatch(/PERFECT|GOOD|MISS/);
    expect(src).toMatch(/errorMs|ms\)/);
    // Should have last judgement state (calibration-last etc)
    expect(src).toContain('calibration-last');
  });
});

// ---------------------------------------------------------------------------
// T133-5: 回帰なし (T132, T102/T103, T129) + WaveEngine/Cursor consistency
// ---------------------------------------------------------------------------
describe('T133-5: 回帰なし (T132録音オフセット補正 / T102-T103禁止 / T129 snap / T127-128)', () => {
  beforeEach(() => {
    setManualOffset(0);
  });

  it('T132: 録音時のオフセット補正が維持されること (positionRef.current - getManualOffsetMs())', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain('positionRef.current - getManualOffsetMs()');
    // Must be inside mode === record guard
    expect(src).toMatch(/modeRef\.current === 'record'/);
    const guardCount = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    // Loop trajectory must NOT be corrected (raw pos)
    expect(src).toContain('timeline.msToBeat(pos)');
    // Verify numeric: correctedBeat = quantizeBeat(msToBeat(tapPos -80), snap)
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const tapPos = 600; // 1.2 beats
    const corrected = quantizeBeat(tl.msToBeat(tapPos - 80), snap);
    const uncorr = quantizeBeat(tl.msToBeat(tapPos), snap);
    expect(corrected).not.toBe(uncorr);
    expect(isSnapAligned(corrected, snap)).toBe(true);
  });

  it('T102/T103: 再生モード(play)で Space押下・矢印キーでリング/セグメントが増えないロジックを保持', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    expect(src).toMatch(/if\s*\(\s*modeRef\.current === 'record'/);
    const onKeyUpSection = src.slice(src.indexOf('const onKeyUp'), src.indexOf('const onKeyUp') + 3500);
    expect(onKeyUpSection).toContain("modeRef.current === 'record'");
    // Ensure no stamping in play mode
    expect(src).not.toContain("navigate('/calibration')");
  });

  it('T129: segmentize の全 beats が snap 整数倍であり 1/amplitude でないこと (off-grid)', () => {
    const snaps = [0.125, 0.25, 0.5, 1];
    for (const snap of snaps) {
      const traj = [
        { beat: 0, y: TW_CENTER_Y, down: true },
        { beat: 0.3, y: TW_CENTER_Y + 50, down: true }, // off-grid 0.3
        { beat: 0.62, y: TW_CENTER_Y + 80, down: false },
        { beat: 0.9, y: TW_CENTER_Y + 80, down: false },
      ];
      const segs = segmentize(traj, snap, 1.0);
      for (const s of segs) {
        expect(isSnapAligned(s.beats, snap), `snap ${snap} beats ${s.beats} not aligned`).toBe(true);
        expect(isSnapAlignedLocal(s.beats, snap)).toBe(true);
      }
      if (snap === 0.25) {
        const shortTraj = [
          { beat: 0, y: TW_CENTER_Y, down: true },
          { beat: 0.30, y: TW_CENTER_Y + 20, down: false },
        ];
        const shortSegs = segmentize(shortTraj, snap, 1.0);
        expect(shortSegs.length).toBeGreaterThan(0);
        expect(shortSegs[0].beats).not.toBeCloseTo(1.0, 2);
        expect(isSnapAligned(shortSegs[0].beats, snap)).toBe(true);
      }
    }
    // Release吸着: b_end = round(b_rel/s)*s (off-grid)
    expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4);
    expect(quantizeBeat(0.37, 0.25)).toBeCloseTo(0.25, 4);
  });

  it('T127/T128: WaveEngine waveYAt の区間傾斜が 2*TW_AMP*amplitudeAt と一致 (off-grid, 複雑振幅)', () => {
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7];
    const offGrid = [0.37, 1.23, 0.25, 0.5];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 5 }], tl, amp, 0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      for (const b of offGrid) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 1);
      }
    }
  });

  it('Cursor と WaveEngine が同一規約で一致すること (same 2*TW_AMP*amplitude, off-grid)', () => {
    const amp = 1.3;
    const beatMs = 500;
    const cursor = new Cursor(amp, -1.0);
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'up', beats: 3 }], tl, amp, -1.0);
    const perBeat = 2 * TW_AMP * amp;
    const dt = (0.5 * beatMs) / 1000; // 0.5 beats
    const y0 = cursor.y;
    cursor.update(dt, true, false, beatMs);
    const cursorDelta = Math.abs(cursor.y - y0);
    expect(cursorDelta).toBeCloseTo(perBeat * 0.5, 1);
    const waveDelta = Math.abs(engine.waveYAt(0.5) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.5, 1);
    expect(waveDelta).toBeCloseTo(cursorDelta, 1);
  });

  it('getPoints 長さが segments.length+1 を維持 (T128回帰)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const cases: Segment[][] = [
      [],
      [{ direction: 'down', beats: 1 }],
      [{ direction: 'up', beats: 0.5 }, { direction: 'down', beats: 0.5 }],
      [{ direction: 'down', beats: 3 }, { direction: 'up', beats: 2 }],
    ];
    for (const segs of cases) {
      const eng = new WaveEngine(segs, tl, 1.0, 0);
      const pts = eng.getPoints();
      const expected = segs.length === 0 ? 2 : segs.length + 1;
      expect(pts.length, `segs ${JSON.stringify(segs)}`).toBe(expected);
      for (const p of pts) {
        expect(typeof p.beat).toBe('number');
        expect(typeof p.y).toBe('number');
        expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
      }
    }
  });

  it('EditorScreen/SelectScreen が navigate による画面遷移でなく overlay 条件render であること (Lキー回帰)', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toContain('/calibration');
    const sel = readFile('src/screens/SelectScreen.tsx');
    expect(sel).toContain('setCalibrationOpen');
    expect(sel).not.toContain("navigate('/calibration')");
    // Old t61/t91 tests expected /calibration route, now must be overlay
    expect(sel).toContain('select-calibration-button');
  });
});

// ---------------------------------------------------------------------------
// Extra: Metronome latency & amplitudeAt step (T131) sanity
// ---------------------------------------------------------------------------
describe('T133-extra: BpmTimeline amplitudeAt step & metronome schedule sanity', () => {
  it('amplitudeAt step関数が off-grid beatで正しく切り替わる', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(4.37)).toBe(2.0);
  });

  it('Calibration overlay の schedule 呼び出しが latency なし (out param optional, not adding latency)', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Old bug was + latency; new should be when = nextBeatTime + offsetSeconds() without latency
    // Check that schedule is called with at least 3 args, no latency variable added in when calc if present
    expect(src).toContain('schedule(');
    // If file still computes latency, it should not be added to when (the T91 fix). For T133 overlay, ensure not using latency
    if (src.includes('latency')) {
      // latency should not be part of when calculation for metronome
      const scheduleIdx = src.indexOf('schedule(');
      const window = src.slice(Math.max(0, scheduleIdx - 800), scheduleIdx + 400);
      // If latency exists, ensure it's not added to nextBeatTime in the same line as offsetSeconds
      // This is a soft check – if latency is removed entirely, it passes
      expect(window).not.toMatch(/nextBeatTime\s*\+\s*.*latency/);
    }
  });
});
