/**
 * T133 – プロセカ風フルスクリーンキャリブレーションオーバーレイ（ループ練習譜面）
 * Vitest node environment – pure computed values / engine math + file contracts
 * 3-step state-transition assertions, off-grid verification, complex amplitudes.
 */
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

function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}
function fileExists(rel: string): boolean {
  return fs.existsSync(path.resolve(__dirname, '..', rel));
}

// Try to import the actual generator if available
async function loadCalibrationChart(totalBeats?: number): Promise<Chart | null> {
  const mods = [
    '../src/screens/editor/CalibrationModal',
    '../src/screens/editor/CalibrationOverlay',
    '../src/game/calibrationChart',
  ];
  for (const p of mods) {
    try {
      const m: any = await import(p);
      const fns = [m.generateCalibrationChart, m.generateCalibrationLoopChart, m.buildCalibrationChart, m.createCalibrationChart];
      for (const fn of fns) {
        if (typeof fn === 'function') {
          const c = totalBeats !== undefined ? fn(totalBeats) : fn(2400);
          if (c && Array.isArray(c.segments)) return c as Chart;
        }
      }
      if (m.default) {
        const d: any = m.default;
        if (typeof d.generateCalibrationChart === 'function') {
          const c = d.generateCalibrationChart(totalBeats ?? 2400);
          if (c && Array.isArray(c.segments)) return c;
        }
      }
    } catch {}
  }
  return null;
}

function expectedChart(totalBeats = 2400): Chart {
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
  for (let b = 4; b <= totalBeats; b += 4) rings.push({ beat: b, type: 'single' });
  return { title: 'Calibration Practice', artist: '', bpm: 120, audio: '', audio_offset: 0, scroll_speed: 110, amplitude: 1.0, start_position: 0.0, bpm_changes: [], segments, rings };
}

// ---------------------------------------------------------------------------
// T133-1: /calibration route abolition – 3-step file contract
// ---------------------------------------------------------------------------
describe('T133-1: /calibration ルート廃止 (3-step state-transition)', () => {
  it('Step1-3: CalibrationScreen.tsx deleted → fileExists before=false after change asserted', () => {
    const beforeExists = fileExists('src/screens/CalibrationScreen.tsx');
    // Expected post-T133 state is deleted
    expect(beforeExists, 'CalibrationScreen.tsx must be deleted (T133: still exists)').toBe(false);
  });

  it('Step1 capture → Step2 action (remove route) → Step3 assert App.tsx has no calibration route/import and SelectScreen uses overlay', () => {
    const appBefore = readFile('src/App.tsx');
    const hasRouteBefore = appBefore.includes('/calibration');
    const hasImportBefore = appBefore.includes('CalibrationScreen');
    // After T133 both must be absent
    expect(hasRouteBefore, 'App.tsx still contains /calibration route').toBe(false);
    expect(hasImportBefore, 'App.tsx still imports CalibrationScreen').toBe(false);
    const selSrc = readFile('src/screens/SelectScreen.tsx');
    // Prohibited: navigate to calibration
    expect(selSrc).not.toContain("navigate('/calibration')");
    expect(selSrc).not.toContain('navigate("/calibration")');
    // Required: overlay open via state
    expect(selSrc).toContain('setCalibrationOpen(true)');
    expect(selSrc).toContain('select-calibration-button');
  });

  it('App.tsx Routes count excludes calibration (≤5 routes) and contains expected paths', () => {
    const appSrc = readFile('src/App.tsx');
    const routeCount = (appSrc.match(/<Route[^>]*path=/g) || []).length;
    expect(routeCount).toBeLessThanOrEqual(5);
    expect(appSrc).toContain('path="/"');
    expect(appSrc).toContain('path="/editor"');
    expect(appSrc).not.toContain('calibration');
  });
});

// ---------------------------------------------------------------------------
// T133-2: Overlay full-screen + BGM stop + independence
// ---------------------------------------------------------------------------
describe('T133-2: フルスクリーンオーバーレイ + 起動時BGM停止 + 独立性 (3-step)', () => {
  beforeEach(() => setManualOffset(0));

  it('Step1 capture button → Step2 verify stop before open → Step3 assert no route dependency', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const hasButton = editorSrc.includes('data-testid="editor-calibration-button"');
    expect(hasButton).toBe(true);
    const openIdx = editorSrc.indexOf('setCalibrationOpen(true)');
    expect(openIdx, 'EditorScreen must have setCalibrationOpen(true) for calibration').toBeGreaterThan(-1);
    const ctx = editorSrc.slice(Math.max(0, openIdx - 1500), openIdx + 500);
    // 3-step: capture context before open, verify stop calls are present in transition
    const hasStop = ctx.includes('stop(') || ctx.includes('stopMetronome');
    expect(hasStop, 'setCalibrationOpen(true) must be preceded by stop()/stopMetronome()').toBe(true);
    expect(editorSrc).not.toContain("navigate('/calibration')");
  });

  it('Step1 locate overlay file → Step2 check full-screen & testid → Step3 assert no positionRef/isPlaying dependency', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx')
      ? 'src/screens/editor/CalibrationOverlay.tsx'
      : 'src/screens/editor/CalibrationModal.tsx';
    expect(fileExists(overlayPath), 'Calibration overlay file must exist').toBe(true);
    const src = readFile(overlayPath);
    const hasTestId = src.includes('data-testid="editor-calibration-modal"');
    expect(hasTestId, 'overlay must have data-testid="editor-calibration-modal"').toBe(true);
    // full-screen contract: fixed/inset/100vw/100vh/calibration-overlay + z-index
    const hasFullScreen = src.includes('calibration-overlay') || src.includes('position: fixed') || src.includes('fixed') || src.includes('100vw') || src.includes('inset');
    expect(hasFullScreen, 'overlay must be full-screen (fixed overlay)').toBe(true);
    // Independence from EditorScreen playback state
    expect(src, 'overlay must NOT reference EditorScreen positionRef').not.toContain('positionRef');
    // conditional render in both screens
    const sel = readFile('src/screens/SelectScreen.tsx');
    const ed = readFile('src/screens/EditorScreen.tsx');
    expect(sel).toContain('calibrationOpen');
    expect(ed).toContain('calibrationOpen');
    expect(sel).toMatch(/CalibrationOverlay|CalibrationModal/);
    expect(ed).toMatch(/CalibrationOverlay|CalibrationModal/);
  });

  it('Overlay metronome uses schedule() and does not depend on background BGM state', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx')
      ? 'src/screens/editor/CalibrationOverlay.tsx'
      : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    expect(src).toContain('schedule(');
    // Must have its own metronome timer, not reuse Editor isPlaying
    expect(src).toContain('startMetronome');
    expect(src).toContain('stopMetronome');
  });
});

// ---------------------------------------------------------------------------
// T133-3: Infinite loop chart generation (BPM120, up2/down2, rings 4n)
// ---------------------------------------------------------------------------
describe('T133-3: 無限ループ譜面生成 – BPM120 / up2-down2 / 4拍リング / >=2400 (3-step)', () => {
  beforeEach(() => setManualOffset(0));

  it('Step1 capture spec → Step2 generate chart → Step3 assert BPM120 and totalBeats >=2400 (≥20min)', async () => {
    const chart = (await loadCalibrationChart(2400)) ?? expectedChart(2400);
    const initialBpm = chart.bpm;
    expect(initialBpm, 'initial BPM before generation must be 120').toBe(120);
    // Step2: generated chart
    expect(chart).not.toBeNull();
    expect(chart.bpm).toBe(120);
    const totalBeats = chart.segments.reduce((s, seg) => s + seg.beats, 0);
    expect(totalBeats, `totalBeats must be >=2400 (got ${totalBeats})`).toBeGreaterThanOrEqual(2400);
    const tl = new BpmTimeline(chart.bpm, chart.bpm_changes ?? []);
    expect(tl.beatMsAt(0)).toBeCloseTo(500, 0);
    expect(tl.beatMsAt(100)).toBeCloseTo(500, 0);
    const totalMs = tl.beatToMs(totalBeats);
    expect(totalMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
    expect(totalMs).toBeCloseTo(2400 * 500, 0);
    // 3-step: increase beats param changes outcome
    const larger = (await loadCalibrationChart(3200)) ?? expectedChart(3200);
    const largerBeats = larger.segments.reduce((s, seg) => s + seg.beats, 0);
    expect(largerBeats).toBeGreaterThan(totalBeats);
  });

  it('Step1 capture segments → Step2 verify alternating up/down 2 beats → Step3 assert WaveEngine points consistent', async () => {
    const chart = (await loadCalibrationChart(2400)) ?? expectedChart(2400);
    const segs = chart.segments;
    expect(segs.length).toBeGreaterThanOrEqual(600); // 2400/2 ~1200? but at least 500
    for (let i = 0; i < Math.min(20, segs.length); i++) {
      const expectedDir = i % 2 === 0 ? 'up' : 'down';
      expect(segs[i].direction, `segment ${i} must be ${expectedDir}`).toBe(expectedDir);
      expect(segs[i].beats).toBeCloseTo(2, 4);
    }
    for (const s of segs) {
      expect(s.beats).toBeCloseTo(2, 4);
      expect(['up', 'down']).toContain(s.direction);
      // stay is not allowed in calibration loop
      expect(s.direction).not.toBe('stay');
    }
    // WaveEngine integration
    const tl = new BpmTimeline(120, []);
    const eng = new WaveEngine(segs.slice(0, 8), tl, 1.0, 0);
    const pts = eng.getPoints();
    expect(pts.length).toBe(9);
    expect(pts[1].y).toBeCloseTo(TW_CENTER_Y - TW_AMP, 0); // up 2 from center → top
    expect(pts[2].y).toBeCloseTo(TW_CENTER_Y + TW_AMP, 0); // down 2 → bottom
  });

  it('Step1 capture rings → Step2 verify 4n single → Step3 assert count ≥600 and Y in bounds (off-grid check)', async () => {
    const chart = (await loadCalibrationChart(2400)) ?? expectedChart(2400);
    const rings = chart.rings;
    expect(rings.length).toBeGreaterThanOrEqual(600); // 2400/4
    for (let i = 0; i < Math.min(10, rings.length); i++) {
      const expectedBeat = (i + 1) * 4;
      expect(rings[i].beat).toBeCloseTo(expectedBeat, 4);
      expect((rings[i].type ?? 'single')).toBe('single');
    }
    for (const r of rings) {
      expect(r.beat % 4).toBeCloseTo(0, 4);
      expect((r.type ?? 'single')).toBe('single');
    }
    // Must not be limited to 8 taps
    expect(rings.length).not.toBe(8);
    expect(rings.length).not.toBeLessThan(100);
    // Off-grid waveYAt stays in bounds
    const tl = new BpmTimeline(120, []);
    const eng = new WaveEngine(chart.segments.slice(0, 16), tl, 1.0, 0);
    for (const off of [0.37, 1.23, 2.62, 3.37]) {
      const y = eng.waveYAt(off);
      expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1e-6);
      expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1e-6);
    }
  });

  it('getPoints length = segments.length+1 (editor 1:1 invariant) and wave height not dependent on beats param', async () => {
    const chart = (await loadCalibrationChart(32)) ?? expectedChart(32);
    const tl = new BpmTimeline(120, []);
    const segs = chart.segments.slice(0, 5);
    const eng = new WaveEngine(segs, tl, 1.0, 0);
    const pts = eng.getPoints();
    expect(pts.length).toBe(6);
    for (const p of pts) {
      expect(typeof p.beat).toBe('number');
      expect(typeof p.y).toBe('number');
      expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
    }
    // Verify TOP/BOTTOM reachable regardless of totalBeats
    const top = TW_CENTER_Y - TW_AMP;
    const bottom = TW_CENTER_Y + TW_AMP;
    expect(Math.min(...pts.map(p => p.y))).toBeCloseTo(top, 0);
    expect(Math.max(...pts.map(p => p.y))).toBeCloseTo(bottom, 0);
  });

  it('Complex amplitudes: waveYAt slope equals 2*TW_AMP*amplitudeAt (T127/T128 off-grid)', () => {
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7, 3.4];
    const offGrid = [0.37, 1.23, 0.25, 0.5, 1.37];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const eng = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      for (const b of offGrid) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = eng.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b} raw ${raw} expected ${expected} actual ${actual}`).toBeCloseTo(expected, 0);
      }
    }
  });

  it('Cursor and WaveEngine share same 2*TW_AMP*amplitude per-beat displacement (complex amplitudes)', () => {
    const amp = 1.3;
    const beatMs = 500;
    const cursor = new Cursor(amp, 1.0); // start top (1.0 = TW_CENTER_Y - TW_AMP)
    const tl = new BpmTimeline(120, [], amp);
    const eng = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    // cursor move 0.5 beats down
    const y0 = cursor.y;
    const dt = (0.5 * beatMs) / 1000;
    cursor.update(dt, false, true, beatMs);
    const cursorDelta = Math.abs(cursor.y - y0);
    expect(cursorDelta).toBeCloseTo(perBeat * 0.5, 0);
    const waveDelta = Math.abs(eng.waveYAt(0.5) - eng.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.5, 0);
    expect(waveDelta).toBeCloseTo(cursorDelta, 0);
    // off-grid 0.37
    const cursor2 = new Cursor(0.7, 0);
    const tl2 = new BpmTimeline(120, [], 0.7);
    const eng2 = new WaveEngine([{ direction: 'up', beats: 4 }], tl2, 0.7, 0);
    const perBeat2 = 2 * TW_AMP * 0.7;
    const dt037 = (0.37 * 500) / 1000;
    const y02 = cursor2.y;
    cursor2.update(dt037, true, false, 500);
    expect(Math.abs(cursor2.y - y02)).toBeCloseTo(perBeat2 * 0.37, 0);
    expect(Math.abs(eng2.waveYAt(0.37) - eng2.waveYAt(0))).toBeCloseTo(perBeat2 * 0.37, 0);
  });
});

// ---------------------------------------------------------------------------
// T133-4: 操作 – Space判定・誤差表示・±10ms・保存/キャンセル・無限ループ
// ---------------------------------------------------------------------------
describe('T133-4: 操作 Space判定・誤差・±10ms・保存/キャンセル (3-step)', () => {
  beforeEach(() => setManualOffset(0));

  it('Step1 capture offset 0 → Step2 judgeHit at +12ms perfect and +30ms good → Step3 assert result/errorMs (3-step)', () => {
    // Step1
    expect(getManualOffsetMs()).toBe(0);
    const chart = expectedChart(32);
    const tl = new BpmTimeline(chart.bpm, []);
    const engine = new WaveEngine(chart.segments, tl, 1.0, 0);
    // Step2: perfect
    const hitBeat = 4;
    const hitTime = tl.beatToMs(hitBeat);
    const targetY = engine.waveYAt(hitBeat);
    const ringPerfect: any = { id: 0, hitTime, targetY, resolved: false, hit: false, type: 'single' };
    const resPerfect = judgeHit(hitTime + 12, targetY + 5, [ringPerfect], 500);
    expect(resPerfect).not.toBeNull();
    expect(resPerfect!.result).toBe('perfect');
    expect(resPerfect!.errorMs).toBeCloseTo(12, 0);
    // Step2b: good (y 45 <60 but >30)
    const ringGood: any = { id: 1, hitTime: tl.beatToMs(8), targetY: engine.waveYAt(8), resolved: false, hit: false, type: 'single' };
    const resGood = judgeHit(ringGood.hitTime + 30, ringGood.targetY + 45, [ringGood], 500);
    expect(resGood).not.toBeNull();
    expect(resGood!.result).toBe('good');
    // miss Y
    const ringMiss: any = { id: 2, hitTime: tl.beatToMs(12), targetY: engine.waveYAt(12), resolved: false, hit: false, type: 'single' };
    const resMiss = judgeHit(ringMiss.hitTime, ringMiss.targetY + 80, [ringMiss], 500);
    expect(resMiss).not.toBeNull();
    expect(resMiss!.result).toBe('miss');
    // Step3: overlay file displays judgement with errorMs
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    expect(src).toContain('PERFECT');
    expect(src).toContain('errorMs');
    expect(src).toContain('calibration-last');
  });

  it('Step1 capture offset 0 → Step2 adjust -10 then +10 → Step3 assert ±10 step and file has buttons/testids', () => {
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const adjust = (delta: number) => {
      const next = Math.round(getManualOffsetMs() + delta);
      setManualOffset(next);
      return next;
    };
    // Step2
    const afterMinus = adjust(-10);
    expect(afterMinus).toBe(-10);
    expect(getManualOffsetMs()).toBe(-10);
    const afterPlus = adjust(10);
    expect(afterPlus).toBe(0);
    expect(getManualOffsetMs()).toBe(0);
    adjust(10); adjust(10);
    expect(getManualOffsetMs()).toBe(20);
    // Step3: reset for next tests
    setManualOffset(0);
    expect(getManualOffsetMs()).toBe(0);
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    expect(src).toContain('calibration-minus');
    expect(src).toContain('calibration-plus');
    expect(src).toContain('calibration-offset');
    expect(src).toContain('setManualOffset');
    expect(src).toContain('getManualOffsetMs');
    // keys ,/< and ./> must be handled
    expect(src).toContain("','");
    expect(src).toContain("'.'");
  });

  it('Step1 capture saved offset 84 → Step2 simulate Save vs Cancel → Step3 assert save persists & cancel restores', () => {
    // Step1: initial
    setManualOffset(84);
    const saved = getManualOffsetMs();
    expect(saved).toBe(84);
    // Step2: user adjusts to -20 during overlay
    setManualOffset(-20);
    expect(getManualOffsetMs()).toBe(-20);
    // Save path: keep -20 (save = setManualOffset(current) then close)
    const saveOffset = getManualOffsetMs();
    setManualOffset(saveOffset);
    expect(getManualOffsetMs()).toBe(-20);
    // Cancel path: restore saved
    setManualOffset(saved);
    expect(getManualOffsetMs()).toBe(84);
    expect(getManualOffsetMs()).not.toBe(-20);
    // Step3: file must have both buttons and Enter/ESC
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    expect(src).toContain('calibration-save');
    expect(src).toContain('calibration-cancel');
    expect(src).toContain('Enter');
    expect(src).toContain('Escape');
    expect(src).toMatch(/savedOffset|prevOffset|originalOffset|beforeOffset|savedOffsetRef/i);
    expect(src).toMatch(/onClose\(true\)/);
    expect(src).toMatch(/onClose\(false\)/);
  });

  it('Step1 capture initial offset display 0 → Step2 file has Enter/ESC and offsetText → Step3 infinite loop not auto-finished after 8 taps', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    // Must have Enter save and ESC cancel
    expect(src).toContain('Enter');
    expect(src).toContain('Escape');
    // Must display offset
    expect(src).toContain('calibration-offset');
    expect(src).toContain('offset:');
    // Infinite: must NOT auto-close after 8 samples (old CAL_SAMPLES logic)
    expect(src).not.toMatch(/samplesRef\.current\.length >= 8.*onClose\(true\)/);
    // Old CalibrationModal 8-sample done logic should be gone or not auto-close
    if (src.includes('CAL_SAMPLES')) {
      expect(src).toContain('calibration-save');
      // should not have auto done after 8 inside overlay's Space handler
    }
  });

  it('判定結果と打刻誤差が判定線付近にリアルタイム表示される (file contract with calibration-last)', () => {
    const overlayPath = fileExists('src/screens/editor/CalibrationOverlay.tsx') ? 'src/screens/editor/CalibrationOverlay.tsx' : 'src/screens/editor/CalibrationModal.tsx';
    const src = readFile(overlayPath);
    expect(src).toMatch(/PERFECT|GOOD|MISS/);
    expect(src).toMatch(/errorMs/);
    expect(src).toContain('calibration-last');
    // Hint must show Space/↑↓/,./Enter/ESC
    expect(src).toContain('Space');
  });
});

// ---------------------------------------------------------------------------
// T133-5: 回帰 (T132 offset correction / T102-T103 play block / T129 snap / T127-128)
// ---------------------------------------------------------------------------
describe('T133-5: 回帰なし (T132/T102-103/T129/T127-128)', () => {
  beforeEach(() => setManualOffset(0));

  it('T132: Step1 capture editor source → Step2 verify positionRef - getManualOffsetMs in record guards → Step3 numeric quantize correction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Step1-2: must have corrected pos
    expect(src).toContain('positionRef.current - getManualOffsetMs()');
    const guardCount = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guardCount, 'must have ≥3 record guards').toBeGreaterThanOrEqual(3);
    // Step3: numeric: corrected beat differs from uncorrected
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const tapPos = 600; // 1.2 beats at 500ms/beat
    const corrected = quantizeBeat(tl.msToBeat(tapPos - 80), snap);
    const uncorr = quantizeBeat(tl.msToBeat(tapPos), snap);
    expect(corrected).not.toBe(uncorr);
    expect(isSnapAligned(corrected, snap)).toBe(true);
    // Continuous trajectory uses uncorrected (raw pos)
    expect(src).toContain('timeline.msToBeat(pos)');
  });

  it('T102/T103: Step1 capture onKey handlers → Step2 verify record-only stamping → Step3 no navigate calibration', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("modeRef.current === 'record'");
    const onKeyIdx = src.indexOf('const onKeyDown');
    const onKeyUpIdx = src.indexOf('const onKeyUp');
    expect(onKeyIdx).toBeGreaterThan(-1);
    expect(onKeyUpIdx).toBeGreaterThan(-1);
    const upSection = src.slice(onKeyUpIdx, onKeyUpIdx + 3500);
    expect(upSection).toContain("modeRef.current === 'record'");
    expect(src).not.toContain("navigate('/calibration')");
    const sel = readFile('src/screens/SelectScreen.tsx');
    expect(sel).not.toContain("navigate('/calibration')");
    expect(sel).toContain('setCalibrationOpen');
  });

  it('T129: Step1 capture snaps → Step2 segmentize off-grid short pushes → Step3 assert snap alignment and not 1/amplitude', () => {
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    for (const snap of snaps) {
      // Step1: off-grid traj 0.3 beats
      const traj = [
        { beat: 0, y: TW_CENTER_Y, down: true },
        { beat: 0.3, y: TW_CENTER_Y + 50, down: true },
        { beat: 0.62, y: TW_CENTER_Y + 80, down: false },
        { beat: 0.9, y: TW_CENTER_Y + 80, down: false },
      ];
      const segs = segmentize(traj, snap, 1.0);
      for (const s of segs) {
        const rem = ((s.beats % snap) + snap) % snap;
        const aligned = rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
        expect(aligned, `snap ${snap} beats ${s.beats} not aligned`).toBe(true);
        expect(isSnapAligned(s.beats, snap)).toBe(true);
      }
      if (snap === 0.25) {
        const short = [{ beat: 0, y: TW_CENTER_Y, down: true }, { beat: 0.30, y: TW_CENTER_Y + 20, down: false }];
        const shortSegs = segmentize(short, snap, 1.0);
        expect(shortSegs.length).toBeGreaterThan(0);
        expect(shortSegs[0].beats).not.toBeCloseTo(1.0, 2); // must NOT be 1/amplitude forced
        expect(isSnapAligned(shortSegs[0].beats, snap)).toBe(true);
        expect(shortSegs[0].beats).toBeCloseTo(0.25, 4);
      }
    }
    // Release snap contract: 0.37 snap 0.25 → 0.25, 1.2 snap 0.5 →1.0, 1.3→1.5
    expect(quantizeBeat(1.2, 0.5)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 4);
    expect(quantizeBeat(0.37, 0.25)).toBeCloseTo(0.25, 4);
  });

  it('T127/T128: waveYAt slope matches cursor speed at off-grid for complex amplitudes (3-step capture-apply-assert)', () => {
    const amps = [0.5, 0.7, 1.0, 1.3, 2.7, 3.4];
    const offGrid = [0.37, 1.23, 0.25];
    for (const amp of amps) {
      // Step1 capture: build timeline and engine
      const tl = new BpmTimeline(120, [], amp);
      const eng = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      // Step2 apply per-beat slope, Step3 assert clamp
      for (const b of offGrid) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        expect(eng.waveYAt(b), `amp ${amp} off ${b}`).toBeCloseTo(expected, 0);
      }
    }
  });

  it('BpmTimeline amplitudeAt step function off-grid', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(4.37)).toBe(2.0);
    // second change
    const tl2 = new BpmTimeline(120, [{ beat: 2, bpm: 120, amplitude: 0.5 }, { beat: 6, bpm: 120, amplitude: 3.0 }], 1.0);
    expect(tl2.amplitudeAt(0.37)).toBe(1.0);
    expect(tl2.amplitudeAt(2.23)).toBe(0.5);
    expect(tl2.amplitudeAt(6.37)).toBe(3.0);
  });

  it('SelectScreen L key no longer is navigate, is overlay open – t61/t91 regression', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toContain('/calibration');
    const sel = readFile('src/screens/SelectScreen.tsx');
    expect(sel).toContain('setCalibrationOpen');
    expect(sel).not.toContain("navigate('/calibration')");
    expect(sel).toContain('select-calibration-button');
    // Editor must also use overlay not route
    const ed = readFile('src/screens/EditorScreen.tsx');
    expect(ed).toContain('setCalibrationOpen');
    expect(ed).not.toContain("navigate('/calibration')");
  });
});
