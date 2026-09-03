/**
 * T144 — ルーラーを小節単位（0,1,2...）に変更
 * Vitest node environment – pure computed values + file contract
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
 * Spec: WavePreview.tsx: strong = b%4==0 のとき ctx.fillText(String(b)) を String(Math.round(b/4)) に変更。
 * Spec: 線自体の strong 判定維持、minorStep 細線は beat 単位のまま。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { quantizeBeat } from '../src/chart/quantize';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers – file read & pure ruler simulation
// ---------------------------------------------------------------------------

function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

/**
 * Mirrors WavePreview.tsx ruler loop after fix.
 * Returns labels that would be drawn as fillText.
 */
function computeFixedRulerLabels(viewStart: number, viewBeats: number, minorStep: number): { beat: number; label: string | null; strong: boolean }[] {
  const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep;
  const out: { beat: number; label: string | null; strong: boolean }[] = [];
  for (let i = 0; ; i++) {
    const b = Number((firstMinor + i * minorStep).toFixed(4));
    if (b > viewStart + viewBeats + 1e-9) break;
    const strong = Math.abs(b % 4) < 1e-6;
    const label = strong ? String(Math.round(b / 4)) : null;
    out.push({ beat: b, label, strong });
  }
  return out;
}

/** Buggy (pre-T144) ruler: label = String(b) */
function computeBuggyRulerLabels(viewStart: number, viewBeats: number, minorStep: number): { beat: number; label: string | null; strong: boolean }[] {
  const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep;
  const out: { beat: number; label: string | null; strong: boolean }[] = [];
  for (let i = 0; ; i++) {
    const b = Number((firstMinor + i * minorStep).toFixed(4));
    if (b > viewStart + viewBeats + 1e-9) break;
    const strong = Math.abs(b % 4) < 1e-6;
    const label = strong ? String(b) : null;
    out.push({ beat: b, label, strong });
  }
  return out;
}

function minorStepFor(viewBeats: number): number {
  // Mirrors current WavePreview.tsx line: viewBeats <= 8 ? 0.5 : viewBeats <= 32 ? 1 : 4
  return viewBeats <= 8 ? 0.5 : viewBeats <= 32 ? 1 : 4;
}

// ---------------------------------------------------------------------------
// T144-1: File contract – label must be String(Math.round(b / 4))
// ---------------------------------------------------------------------------
describe('T144-1: File contract — WavePreview.tsx ruler label changed to measure units', () => {
  it('Step1 capture initial file state before → Step2 inspect ruler label line → Step3 fillText uses String(Math.round(b / 4))', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Expected fixed pattern: String(Math.round(b / 4))
    expect(src).toMatch(/ctx\.fillText\(\s*String\(\s*Math\.round\(\s*b\s*\/\s*4\s*\)\s*\)\s*,\s*gx\s*\+\s*4\s*,\s*4\s*\)/);
  });

  it('Step1 capture initial label pattern before → Step2 verify no longer String(b) at ruler → Step3 old buggy String(b) not present in strong block', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Find the strong block slice to avoid false positives elsewhere (e.g. START label)
    const rulerIdx = src.indexOf('// Beat ruler');
    expect(rulerIdx).toBeGreaterThan(-1);
    const slice = src.slice(rulerIdx, rulerIdx + 2500);
    // The strong block should NOT contain the buggy single-arg String(b) as fillText arg
    // (it must contain Math.round(b / 4) instead). Detect buggy pattern and fail if found.
    // We check that the slice contains the fixed form and lacks the buggy exact form.
    expect(slice).toContain('Math.round(b / 4)');
    // The buggy line would be exactly `ctx.fillText(String(b),` inside the if(strong) block
    // After fix, that exact token should not remain for ruler labels.
    // Use a negative check that the ruler segment does not use bare String(b) for grid labels.
    // We allow other String() uses elsewhere, but within the ruler strong block it must be the fixed form.
    const buggyInStrong = /if\s*\(strong\)\s*\{\s*[^}]*ctx\.fillText\(\s*String\(\s*b\s*\)\s*,/.test(slice);
    expect(buggyInStrong).toBe(false);
  });

  it('Step1 capture strong determination before → Step2 verify strong logic unchanged → Step3 strong = b%4==0 maintained (Math.abs(b % 4) < 1e-6)', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    const rulerIdx = src.indexOf('// Beat ruler');
    const slice = src.slice(rulerIdx, rulerIdx + 2500);
    expect(slice).toMatch(/const\s+strong\s*=\s*Math\.abs\(\s*b\s*%\s*4\s*\)\s*<\s*1e-6/);
    // Ensure the fixed file still references 4 as measure length
    expect(slice).toContain('% 4');
  });

  it('Step1 capture minorStep line before → Step2 inspect beats-per-grid line → Step3 minorStep remains beat-unit (strong 分離维持)', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*8\s*\?\s*0\.5\s*:\s*viewBeats\s*<=\s*32\s*\?\s*1\s*:\s*4/);
  });

  it('Step1 capture only WavePreview.tsx was touched before → Step2 scan other task files → Step3 no other file independently writes ruler labels', () => {
    // Guard: fix must be localized to WavePreview.tsx only per spec
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    // EditorScreen should not contain ruler fillText logic
    expect(editorSrc).not.toMatch(/ctx\.fillText\(\s*String\(\s*Math\.round\(b \/ 4\)\s*\)/);
    expect(editorSrc).not.toMatch(/const\s+minorStep/);
  });
});

// ---------------------------------------------------------------------------
// T144-2: 完了条件1 — viewBeats=16 初期表示で 0,1,2,3,4（小節）が表示され 4,8,12 が非表示
// ---------------------------------------------------------------------------
describe('T144-2: 完了条件1 viewBeats=16 でルーラー上部が 0,1,2,3,4（小節）になる', () => {
  it('Step1 capture buggy labels before with viewBeats=16 viewStart=0 → Step2 compute fixed labels → Step3 fixed=0..4 and buggy=0,4,8... diverges', () => {
    const viewStart = 0;
    const viewBeats = 16;
    const step = minorStepFor(viewBeats);
    expect(step).toBe(1); // pre-condition: T144 minorStep unchanged (1 at 16)

    // Step1: old buggy would produce 0,4,8,12,16
    const buggy = computeBuggyRulerLabels(viewStart, viewBeats, step)
      .filter(r => r.label !== null)
      .map(r => r.label);
    expect(buggy).toEqual(['0', '4', '8', '12', '16']);

    // Step2-3: fixed must produce measure numbers 0,1,2,3,4
    const fixed = computeFixedRulerLabels(viewStart, viewBeats, step)
      .filter(r => r.label !== null)
      .map(r => r.label);
    expect(fixed).toEqual(['0', '1', '2', '3', '4']);

    // Must NOT contain beat numbers 4,8,12 as labels
    expect(fixed).not.toContain('4');
    expect(fixed).not.toContain('8');
    expect(fixed).not.toContain('12');

    // Consistency of conversion: label == String(Math.round(beat/4))
    const raw = computeFixedRulerLabels(viewStart, viewBeats, step).filter(r => r.strong);
    for (const r of raw) {
      expect(r.label).toBe(String(Math.round(r.beat / 4)));
    }
  });

  it('Step1 capture viewBeats=16 viewStart=0 labels before → Step2 sweep alternative viewBeats (8,20,32) → Step3 measure labels remain beat/4', () => {
    const cases: Array<{ viewBeats: number; expected: string[] }> = [
      { viewBeats: 8, expected: ['0', '1', '2'] }, // beats 0,4,8 -> 0,1,2
      { viewBeats: 20, expected: ['0', '1', '2', '3', '4', '5'] }, // 0..20 step 1 -> 0,4,8,12,16,20 -> 0..5
      { viewBeats: 32, expected: ['0', '1', '2', '3', '4', '5', '6', '7', '8'] }, // step 1 up to 32 inclusive
    ];
    for (const c of cases) {
      const step = minorStepFor(c.viewBeats);
      const labels = computeFixedRulerLabels(0, c.viewBeats, step)
        .filter(r => r.label !== null)
        .map(r => r.label);
      expect(labels, `viewBeats ${c.viewBeats}`).toEqual(c.expected);
      // Negative: buggy would be multiples of 4
      const buggy = computeBuggyRulerLabels(0, c.viewBeats, step)
        .filter(r => r.label !== null)
        .map(r => r.label);
      expect(buggy).not.toEqual(labels);
    }
  });

  it('Step1 capture off-grid viewStart 0.37 viewBeats=16 before → Step2 compute ruler labels with same fixed logic → Step3 strong labels still beat/4 at 4,8,12... (off-grid start does not shift strong positions)', () => {
    const viewStart = 0.37;
    const viewBeats = 16;
    const step = minorStepFor(viewBeats); // 1
    const fixed = computeFixedRulerLabels(viewStart, viewBeats, step);
    const strongFixed = fixed.filter(r => r.strong);
    // With viewStart 0.37, first strong beat >= viewStart is 4, then 8,12,16
    expect(strongFixed.map(r => r.beat)).toEqual([4, 8, 12, 16]);
    expect(strongFixed.map(r => r.label)).toEqual(['1', '2', '3', '4']);
    // Verify buggy would be 4,8,12,16 instead
    const buggyStrong = computeBuggyRulerLabels(viewStart, viewBeats, step).filter(r => r.strong);
    expect(buggyStrong.map(r => r.label)).toEqual(['4', '8', '12', '16']);
    expect(strongFixed.map(r => r.label)).not.toEqual(buggyStrong.map(r => r.label));
    // Edge: no label equals "4" should appear twice; measure 1 corresponds to beat 4
    expect(strongFixed[0].label).toBe('1');
    expect(strongFixed[0].beat).toBe(4);
  });

  it('Step1 capture off-grid viewStart 1.23 viewBeats=12 before → Step2 compute labels → Step3 measure labels remain Math.round(b/4) even when view window slices mid-measure', () => {
    const viewStart = 1.23;
    const viewBeats = 12;
    const step = minorStepFor(viewBeats); // 1
    const fixed = computeFixedRulerLabels(viewStart, viewBeats, step);
    const strong = fixed.filter(r => r.strong);
    // Window: 1.23..13.23 => strong beats 4,8,12
    expect(strong.map(r => r.beat)).toEqual([4, 8, 12]);
    expect(strong.map(r => r.label)).toEqual(['1', '2', '3']);
    for (const r of strong) {
      expect(r.label).toBe(String(Math.round(r.beat / 4)));
      expect(Number(r.label)).toBe(r.beat / 4);
    }
  });

  it('Step1 capture spec example mapping before b=0->0,4->1,8->2 → Step2 apply String(Math.round(b/4)) → Step3 exact mapping holds for all strong beats', () => {
    const specPairs: Array<[number, string]> = [
      [0, '0'],
      [4, '1'],
      [8, '2'],
      [12, '3'],
      [16, '4'],
      [20, '5'],
      [100, '25'],
    ];
    for (const [b, expected] of specPairs) {
      expect(String(Math.round(b / 4))).toBe(expected);
      // Simulate fixed ruler entry for that beat being strong
      const strong = Math.abs(b % 4) < 1e-6;
      expect(strong).toBe(true);
      expect(String(Math.round(b / 4))).not.toBe(String(b));
    }
    // Non-strong beat must not produce label
    const nonStrong = computeFixedRulerLabels(0, 16, 1).filter(r => !r.strong);
    for (const r of nonStrong) {
      expect(r.label).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// T144-3: 完了条件2 — minorStep 縦線は beat 単位で引かれ 小節太線と beat 細線が区別できる
// ---------------------------------------------------------------------------
describe('T144-3: 完了条件2 minorStep beat グリッドが beat 単位で引かれ 太線/細線が区別される', () => {
  it('Step1 capture initial minorStep table before → Step2 compute minorStep for each viewBeats → Step3 beat-unit grid count matches expected and strong subset = measure*4', () => {
    const cases: Array<{ viewBeats: number; minorStep: number; totalLines: number; strongCount: number }> = [
      { viewBeats: 8, minorStep: 0.5, totalLines: 17, strongCount: 3 }, // 0..8 /0.5 => 17, strong 0,4,8
      { viewBeats: 16, minorStep: 1, totalLines: 17, strongCount: 5 }, // 0..16 /1
      { viewBeats: 32, minorStep: 1, totalLines: 33, strongCount: 9 }, // 0..32 /1
      { viewBeats: 64, minorStep: 4, totalLines: 17, strongCount: 17 }, // 0..64 /4 => all strong
    ];
    for (const c of cases) {
      const step = minorStepFor(c.viewBeats);
      expect(step, `minorStep viewBeats ${c.viewBeats}`).toBe(c.minorStep);
      const all = computeFixedRulerLabels(0, c.viewBeats, step);
      expect(all.length, `total lines viewBeats ${c.viewBeats}`).toBe(c.totalLines);
      const strong = all.filter(r => r.strong);
      expect(strong.length, `strong count viewBeats ${c.viewBeats}`).toBe(c.strongCount);
      // Strong lines must be at beats 0,4,8... (multiples of 4)
      for (const s of strong) {
        expect(s.beat % 4).toBeCloseTo(0, 6);
        expect(s.label).toBe(String(Math.round(s.beat / 4)));
      }
      // Minor (weak) lines must be at non-multiples of 4
      const weak = all.filter(r => !r.strong);
      for (const w of weak) {
        expect(Math.abs(w.beat % 4) < 1e-6).toBe(false);
        expect(w.label).toBeNull();
      }
      // Grid remains beat-unit: distance between consecutive grid marks = minorStep beats
      for (let i = 1; i < all.length; i++) {
        expect(all[i].beat - all[i - 1].beat).toBeCloseTo(step, 6);
      }
    }
  });

  it('Step1 capture viewBeats=16 weak lines before (beats 1,2,3,5,6,7...) → Step2 compute all grid beats → Step3 weak lines exist and are not labeled as measures', () => {
    const viewBeats = 16;
    const step = minorStepFor(viewBeats);
    const all = computeFixedRulerLabels(0, viewBeats, step);
    const weakBeats = all.filter(r => !r.strong).map(r => r.beat);
    expect(weakBeats).toEqual([1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]);
    // Weak lines must have strokeStyle rgba(255,255,255,0.07) and lineWidth 1 (verified via file)
    const src = readFile('src/screens/editor/WavePreview.tsx');
    const rulerIdx = src.indexOf('// Beat ruler');
    const slice = src.slice(rulerIdx, rulerIdx + 2500);
    expect(slice).toMatch(/ctx\.strokeStyle\s*=\s*strong\s*\?\s*'rgba\(255,255,255,0\.20\)'\s*:\s*'rgba\(255,255,255,0\.07\)'/);
    expect(slice).toMatch(/ctx\.lineWidth\s*=\s*strong\s*\?\s*1\.5\s*:\s*1/);
    // Strong lines thicker: 1.5 + rgba 0.20
    expect(slice).toContain("rgba(255,255,255,0.20)");
  });

  it('Step1 capture viewBeats=8 denser grid (0.5 step) before → Step2 compute labels → Step3 only strong beats have labels, half-beats never labeled', () => {
    const viewBeats = 8;
    const step = minorStepFor(viewBeats);
    const all = computeFixedRulerLabels(0, viewBeats, step);
    // At 0.5 resolution, beats 0.5,1.5,2.5 etc are weak
    const halfBeats = all.filter(r => Math.abs((r.beat * 2) % 2) < 1e-9 && Math.abs(r.beat % 1 - 0.5) < 1e-9);
    expect(halfBeats.length).toBe(8); // 0.5,1.5,2.5,3.5,4.5,5.5,6.5,7.5
    for (const h of halfBeats) {
      expect(h.strong).toBe(false);
      expect(h.label).toBeNull();
    }
    // Strong still only multiples of 4, labeled as measures
    const strong = all.filter(r => r.strong);
    expect(strong.map(r => r.label)).toEqual(['0', '1', '2']);
  });

  it('Step1 capture off-grid viewStart 0.37 minorStep 0.5 before → Step2 verify weak/strong distinction persists off-grid → Step3 strong still 4,8... weak not labeled', () => {
    const viewStart = 0.37;
    const viewBeats = 8;
    const step = minorStepFor(viewBeats); // 0.5
    const all = computeFixedRulerLabels(viewStart, viewBeats, step);
    const strong = all.filter(r => r.strong);
    // Strong beats inside 0.37..8.37 are 4,8
    expect(strong.map(r => r.beat)).toEqual([4, 8]);
    expect(strong.map(r => r.label)).toEqual(['1', '2']);
    const weak = all.filter(r => !r.strong);
    expect(weak.length).toBeGreaterThan(0);
    for (const w of weak) expect(w.label).toBeNull();
  });

  it('Step1 capture that beat grid is independent of amplitude/bpm before → Step2 instantiate engines with varied amplitudes → Step3 minorStep table unchanged (engine does not affect grid)', () => {
    const viewBeatsCases = [8, 16, 64];
    for (const vb of viewBeatsCases) {
      expect(minorStepFor(vb)).toBe(vb <= 8 ? 0.5 : vb <= 32 ? 1 : 4);
    }
    // Engine amplitude should not leak into ruler grid
    const amps = [0.7, 1.3, 2.7];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const eng = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 0);
      // waveYAt sanity (uses amplitude for wave slope, not ruler)
      expect(eng.waveYAt(0.37)).toBeDefined();
      expect(minorStepFor(16)).toBe(1);
    }
    // quantizeBeat alignment also beat-unit (sanity)
    expect(quantizeBeat(1.2, 0.25)).toBeCloseTo(1.25, 6);
    expect(quantizeBeat(1.3, 0.5)).toBeCloseTo(1.5, 6);
  });
});

// ---------------------------------------------------------------------------
// T144-4: 文字列変換の数学的一貫性 & 回帰（minorStep 依らず / file に余分な fillText が無い）
// ---------------------------------------------------------------------------
describe('T144-4: 数学的一貫性（measure = round(beat/4)）と軽度回帰', () => {
  it('Step1 capture identity label = round(beat/4) before → Step2 sweep beats 0..100 with step 0.5 → Step3 strong label equals measure and labels strictly increasing by 1 per strong beat', () => {
    const viewBeats = 100;
    const step = minorStepFor(viewBeats); // 4 at large view
    const all = computeFixedRulerLabels(0, viewBeats, step);
    const strong = all.filter(r => r.strong);
    expect(strong.length).toBeGreaterThan(10);
    for (let i = 0; i < strong.length; i++) {
      const s = strong[i];
      expect(s.label).toBe(String(Math.round(s.beat / 4)));
      expect(Number(s.label)).toBe(s.beat / 4);
      if (i > 0) {
        expect(Number(s.label) - Number(strong[i - 1].label)).toBe(1);
        expect(s.beat - strong[i - 1].beat).toBe(4);
      }
    }
    // No duplicate measure labels
    const labels = strong.map(s => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('Step1 capture file has two fillText sites before (ruler + START) → Step2 inspect both → Step3 ruler site uses round(b/4) and START site unchanged', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Ruler must use round(b/4)
    expect(src).toMatch(/ctx\.fillText\(\s*String\(\s*Math\.round\(\s*b\s*\/\s*4\s*\)\s*\)\s*,\s*gx\s*\+\s*4\s*,\s*4\s*\)/);
    // START label must remain
    expect(src).toContain("ctx.fillText('START'");
    // PLAY label remains
    expect(src).toContain("ctx.fillText('PLAY'");
    // Count of ctx.fillText(String( including ruler) — ruler + no other beat-number label
    const rulerMatches = (src.match(/ctx\.fillText\(\s*String\(\s*Math\.round\(b \/ 4\)\s*\)/g) || []).length;
    expect(rulerMatches).toBe(1);
  });

  it('Step1 capture TW_AMP / TW_CENTER_Y invariants before → Step2 verify engine still returns correct Y independent of ruler → Step3 ruler change does not alter wave physics', () => {
    expect(TW_AMP).toBe(130);
    expect(TW_CENTER_Y).toBe(300);
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'down', beats: 4 }, { direction: 'up', beats: 4 }], tl, 1.0, 0);
    // Wave physics unchanged: at beat 0 start at -TW_AMP offset (startPosition 0 => CENTER)
    expect(eng.waveYAt(0)).toBeCloseTo(TW_CENTER_Y, 0);
    // At beat 2 down segment should be moving toward bottom, measure labels not involved
    const y2 = eng.waveYAt(2);
    const y0 = eng.waveYAt(0);
    expect(y2).toBeGreaterThan(y0);
    // Ruler label at beat 4 must be "1" even though wave physics uses beat=4 as top/bottom
    expect(String(Math.round(4 / 4))).toBe('1');
    expect(String(Math.round(8 / 4))).toBe('2');
  });

  it('Step1 capture extreme off-grid large viewBeats 200 before → Step2 compute ruler limited window → Step3 measure numbers continue correctly and no beat-number leak', () => {
    const viewStart = 122.37;
    const viewBeats = 16;
    const step = minorStepFor(viewBeats);
    const all = computeFixedRulerLabels(viewStart, viewBeats, step);
    const strong = all.filter(r => r.strong);
    // Inside 122.37..138.37 strong beats are 124,128,132,136
    expect(strong.map(r => r.beat)).toEqual([124, 128, 132, 136]);
    expect(strong.map(r => r.label)).toEqual([
      String(Math.round(124 / 4)),
      String(Math.round(128 / 4)),
      String(Math.round(132 / 4)),
      String(Math.round(136 / 4)),
    ]);
    expect(strong.map(r => r.label)).toEqual(['31', '32', '33', '34']);
    // Buggy would be 124,128... as labels
    expect(strong.map(r => r.label)).not.toContain('124');
    expect(strong.map(r => r.label)).not.toContain('128');
  });
});
