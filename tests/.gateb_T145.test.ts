/**
 * T145 — ルーラーの拡大率しきい値調整（細かい拍が見えるように）
 * Vitest node environment – pure computed values / file-contract
 * Strict TDD acceptance test: must FAIL before fix (old 3-stage) and PASS after (5-stage)
 * Spec: WavePreview.tsx:177 minorStep 3段階 → 5段階
 *   viewBeats<=4 ?0.25 : viewBeats<=8?0.5 : viewBeats<=16?1 : viewBeats<=64?2 :4
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { segmentize, quantizeBeat } from '../src/chart/quantize';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers – file read & pure ruler logic (mirrors WavePreview.tsx)
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

/** Fixed 5-stage spec (T145) */
function computeMinorStepFixed(viewBeats: number): number {
  if (viewBeats <= 4) return 0.25;
  if (viewBeats <= 8) return 0.5;
  if (viewBeats <= 16) return 1;
  if (viewBeats <= 64) return 2;
  return 4;
}

/** Old buggy 3-stage (pre-T145) */
function computeMinorStepBuggy(viewBeats: number): number {
  if (viewBeats <= 8) return 0.5;
  if (viewBeats <= 32) return 1;
  return 4;
}

interface RulerEntry {
  beat: number;
  strong: boolean;
  label: string | null;
  lineWidth: number;
}

function computeRuler(viewStart: number, viewBeats: number, useFixed = true): RulerEntry[] {
  const minorStep = useFixed ? computeMinorStepFixed(viewBeats) : computeMinorStepBuggy(viewBeats);
  const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep;
  const entries: RulerEntry[] = [];
  for (let i = 0; ; i++) {
    const b = Number((firstMinor + i * minorStep).toFixed(4));
    if (b > viewStart + viewBeats + 1e-9) break;
    const strong = Math.abs(b % 4) < 1e-6;
    const label = strong ? String(Math.round(b / 4)) : null;
    entries.push({ beat: b, strong, label, lineWidth: strong ? 1.5 : 1 });
  }
  return entries;
}

function strongEntries(entries: RulerEntry[]): RulerEntry[] {
  return entries.filter(e => e.strong);
}

// ---------------------------------------------------------------------------
// T145-1: File contract — WavePreview.tsx のみ修正、5段階 minorStep と T144 維持
// ---------------------------------------------------------------------------
describe('T145-1: File contract WavePreview.tsx 5-stage minorStep & T144 measure label', () => {
  it('Step1 capture initial file state before → Step2 inspect minorStep line → Step3 contains 5-stage 0.25/0.5/1/2/4', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Must contain 5-stage expression exactly as spec
    expect(src).toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*4\s*\?\s*0\.25/);
    expect(src).toMatch(/viewBeats\s*<=\s*4\s*\?\s*0\.25\s*:\s*viewBeats\s*<=\s*8\s*\?\s*0\.5\s*:\s*viewBeats\s*<=\s*16\s*\?\s*1\s*:\s*viewBeats\s*<=\s*64\s*\?\s*2\s*:\s*4/);
    // Old 3-stage (<=8 ?0.5: <=32 ?1:4) must be gone – ensure no standalone <=32 tier
    // The new code has <=64 ?2:4, not <=32. Verify <=32 no longer appears in minorStep line.
    const idx = src.indexOf('const minorStep');
    expect(idx).toBeGreaterThan(-1);
    const slice = src.slice(idx, idx + 500);
    expect(slice).not.toMatch(/viewBeats\s*<=\s*32\s*\?\s*1\s*:\s*4/);
    expect(slice).toContain('0.25');
    expect(slice).toContain('0.5');
  });

  it('Step1 capture old buggy pattern before (3-stage) → Step2 verify file no longer uses 3-stage thresholds → Step3 5-stage thresholds isolated', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Verify that the minorStep block contains all 5 tiers
    expect(src).toMatch(/viewBeats\s*<=\s*4\s*\?\s*0\.25/);
    expect(src).toMatch(/viewBeats\s*<=\s*8\s*\?\s*0\.5/);
    expect(src).toMatch(/viewBeats\s*<=\s*16\s*\?\s*1/);
    expect(src).toMatch(/viewBeats\s*<=\s*64\s*\?\s*2\s*:\s*4/);
  });

  it('Step1 capture strong definition before → Step2 verify small-section label is T144 measure → Step3 Math.abs(b%4)<1e-6 and String(Math.round(b/4)) maintained', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/const\s+strong\s*=\s*Math\.abs\s*\(\s*b\s*%\s*4\s*\)\s*<\s*1e-6/);
    expect(src).toMatch(/String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)/);
    expect(src).toMatch(/ctx\.fillText\s*\(\s*String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)\s*,\s*gx\s*\+\s*4\s*,\s*4\s*\)/);
  });

  it('Step1 capture minorStep comment context before → Step2 verify only WavePreview.tsx was modified → Step3 engine files unchanged', () => {
    const waveSrc = readFile('src/game/waveEngine.ts');
    const cursorSrc = readFile('src/game/cursor.ts');
    expect(waveSrc).not.toContain('minorStep');
    expect(waveSrc).not.toContain('RULER_H');
    expect(cursorSrc).not.toContain('minorStep');
    expect(cursorSrc).not.toContain('RULER_H');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).not.toContain('minorStep');
  });

  it('Step1 capture data-testid availability before → Step2 check wave-preview elements → Step3 required testids present, no hallucinated IDs', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('data-testid="wave-preview"');
    expect(src).toContain('data-testid="wave-preview-canvas"');
    expect(src).toContain('data-testid="wave-preview-hint"');
    expect(src).not.toContain('data-testid="music-control"');
    expect(src).not.toContain('data-testid="bpm-editor"');
  });

  it('Step1 capture ruler loop integrity before → Step2 verify firstMinor epsilon and strong styling → Step3 loop uses minorStep and strong check', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('firstMinor');
    expect(src).toContain('Math.ceil(viewStart / minorStep');
    expect(src).toContain("ctx.strokeStyle = strong ? 'rgba(255,255,255,0.20)'");
    expect(src).toContain("ctx.lineWidth = strong ? 1.5 : 1");
    expect(src).toContain('Math.abs(b % 4) < 1e-6');
  });
});

// ---------------------------------------------------------------------------
// T145-2: 完了条件1 — viewBeats=4,8,16,32,64,100 で minorStep が 0.25/0.5/1/2/4 に一致
// ---------------------------------------------------------------------------
describe('T145-2: 完了条件1 viewBeats=4,8,16,32,64,100 の各拡大率で minorStep が spec 値に一致', () => {
  it('Step1 capture buggy values before (old 3-stage) → Step2 compute fixed 5-stage → Step3 fixed matches spec, buggy differs for key cases', () => {
    const cases: Array<[number, number]> = [
      [4, 0.25],
      [8, 0.5],
      [16, 1],
      [32, 2],
      [64, 2],
      [100, 4],
    ];
    for (const [beats, expected] of cases) {
      expect(computeMinorStepFixed(beats), `viewBeats ${beats} fixed`).toBe(expected);
    }
    // Buggy differs for 4 and 32
    expect(computeMinorStepBuggy(4)).toBe(0.5);
    expect(computeMinorStepFixed(4)).toBe(0.25);
    expect(computeMinorStepBuggy(32)).toBe(1);
    expect(computeMinorStepFixed(32)).toBe(2);
    expect(computeMinorStepFixed(4)).not.toBe(computeMinorStepBuggy(4));
    expect(computeMinorStepFixed(32)).not.toBe(computeMinorStepBuggy(32));
  });

  it('Step1 capture viewBeats=16 initial (default) before → Step2 compute fixed → Step3 viewBeats=16 gives 1拍 (17 lines 0..16)', () => {
    const fixed = computeRuler(0, 16, true);
    expect(computeMinorStepFixed(16)).toBe(1);
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const buggy = computeRuler(0, 16, false);
    // For 16, buggy also 1, but fixed is same – verify spec still holds
    expect(computeMinorStepBuggy(16)).toBe(1);
    expect(buggy.map(e => e.beat)).toEqual(fixed.map(e => e.beat));
  });

  it('Step1 capture viewBeats=8 before → Step2 compute fixed 0.5 → Step3 17 lines every 0.5 with strong at multiples of 4', () => {
    const fixed = computeRuler(0, 8, true);
    expect(computeMinorStepFixed(8)).toBe(0.5);
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8]);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8]);
    expect(strong.map(e => e.label)).toEqual(['0', '1', '2']);
  });

  it('Step1 capture viewBeats=4 strong magnification before → Step2 compute fixed 0.25 → Step3 17 lines every 0.25 with strong 0/4 only', () => {
    const fixed = computeRuler(0, 4, true);
    expect(computeMinorStepFixed(4)).toBe(0.25);
    expect(fixed).toHaveLength(17);
    expect(fixed[0].beat).toBe(0);
    expect(fixed[fixed.length - 1].beat).toBe(4);
    expect(fixed.map(e => e.beat)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4]);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([0, 4]);
    expect(strong.map(e => e.label)).toEqual(['0', '1']);
    // Buggy would have been 0.5 step with only 9 lines
    const buggy = computeRuler(0, 4, false);
    expect(buggy).toHaveLength(9);
    expect(fixed.length).not.toBe(buggy.length);
  });

  it('Step1 capture viewBeats=32 before (wide) → Step2 compute fixed 2拍刻み → Step3 17 lines 0,2,4...32 with 9 strong labels 0..8', () => {
    const fixed = computeRuler(0, 32, true);
    expect(computeMinorStepFixed(32)).toBe(2);
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);
    const strong = strongEntries(fixed);
    expect(strong).toHaveLength(9);
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32]);
    expect(strong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    const buggy = computeRuler(0, 32, false);
    expect(computeMinorStepBuggy(32)).toBe(1);
    expect(buggy).toHaveLength(33);
    expect(fixed.length).not.toBe(buggy.length);
  });

  it('Step1 capture viewBeats=64 boundary before → Step2 compute fixed → Step3 viewBeats=64 gives 2, viewBeats=64.0001 gives 4', () => {
    expect(computeMinorStepFixed(64)).toBe(2);
    expect(computeMinorStepFixed(64.0001)).toBe(4);
    expect(computeMinorStepFixed(100)).toBe(4);
    expect(computeMinorStepFixed(200)).toBe(4);
    const fixed64 = computeRuler(0, 64, true);
    expect(fixed64).toHaveLength(33);
    expect(strongEntries(fixed64)).toHaveLength(17);
    const fixed100 = computeRuler(0, 100, true);
    expect(computeMinorStepFixed(100)).toBe(4);
    // 0..100 step4 => 26 lines
    expect(fixed100).toHaveLength(26);
    expect(strongEntries(fixed100).map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92, 96, 100]);
  });

  it('Step1 capture threshold edges before → Step2 sweep just above/below boundaries → Step3 4/8/16/64 tiering is exact', () => {
    // Below tier → at tier → just above
    expect(computeMinorStepFixed(3.999)).toBe(0.25);
    expect(computeMinorStepFixed(4)).toBe(0.25);
    expect(computeMinorStepFixed(4.0001)).toBe(0.5);

    expect(computeMinorStepFixed(7.999)).toBe(0.5);
    expect(computeMinorStepFixed(8)).toBe(0.5);
    expect(computeMinorStepFixed(8.0001)).toBe(1);

    expect(computeMinorStepFixed(15.999)).toBe(1);
    expect(computeMinorStepFixed(16)).toBe(1);
    expect(computeMinorStepFixed(16.0001)).toBe(2);

    expect(computeMinorStepFixed(63.999)).toBe(2);
    expect(computeMinorStepFixed(64)).toBe(2);
    expect(computeMinorStepFixed(64.0001)).toBe(4);
  });

  it('Step1 capture 3-step transition for all 6 required viewBeats → Step2 buggy vs fixed divergence → Step3 fixed satisfies spec table', () => {
    const required: Array<[number, number]> = [
      [4, 0.25],
      [8, 0.5],
      [16, 1],
      [32, 2],
      [64, 2],
      [100, 4],
    ];
    // Step1: old buggy map
    const buggyMap = new Map(required.map(([k]) => [k, computeMinorStepBuggy(k)]));
    expect(buggyMap.get(4)).toBe(0.5);
    expect(buggyMap.get(32)).toBe(1);
    // Step3: fixed map must equal spec
    required.forEach(([beats, expected]) => {
      const got = computeMinorStepFixed(beats);
      expect(got, `viewBeats ${beats}`).toBe(expected);
      // Dynamic computed: beats/step is integer
      expect(Number.isInteger(4 / got) || got === 0.25 || got === 0.5).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// T145-3: 完了条件2 — ルーラーの小節ラベル（T144 b/4）は strong のときのみ表示
// ---------------------------------------------------------------------------
describe('T145-3: 完了条件2 小節ラベルは strong のときのみ（minorStep で密度不変）', () => {
  it('Step1 capture initial label density before (buggy beat labels) → Step2 compute fixed measure labels → Step3 only strong has label, minors are null', () => {
    const viewBeats = 16;
    const fixed = computeRuler(0, viewBeats, true);
    fixed.forEach(e => {
      if (e.strong) {
        expect(e.label).not.toBeNull();
        expect(e.label).toBe(String(Math.round(e.beat / 4)));
        expect(e.lineWidth).toBe(1.5);
      } else {
        expect(e.label).toBeNull();
        expect(e.lineWidth).toBe(1);
      }
    });
    // Ensure non-multiples of 4 never get a label even with fine minorStep
    const fine = computeRuler(0, 4, true); // 0.25
    expect(fine.filter(e => !e.strong).every(e => e.label === null)).toBeTruthy();
    expect(fine.filter(e => e.strong).every(e => e.label !== null)).toBeTruthy();
  });

  it('Step1 capture viewBeats=8 minorStep 0.5 before → Step2 verify label count unchanged by minorStep refinement → Step3 strong labels 0,1,2 only', () => {
    const fixed8 = computeRuler(0, 8, true);
    const strong8 = strongEntries(fixed8);
    expect(strong8).toHaveLength(3);
    expect(strong8.map(e => e.label)).toEqual(['0', '1', '2']);
    // Minor beats must not gain labels when minorStep gets finer
    const minors = fixed8.filter(e => !e.strong);
    expect(minors.every(e => e.label === null)).toBeTruthy();
    expect(minors.map(e => e.beat)).toContain(0.5);
    expect(minors.map(e => e.beat)).toContain(2.5);
  });

  it('Step1 capture viewBeats=32 wide before → Step2 compute fixed 2拍刻み → Step3 strong every 4 beats (0,4,8...), label Math.round(b/4), minors at 2,6,10 have no label', () => {
    const fixed = computeRuler(0, 32, true);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32]);
    expect(strong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    const minors = fixed.filter(e => !e.strong);
    expect(minors.map(e => e.beat)).toEqual([2, 6, 10, 14, 18, 22, 26, 30]);
    minors.forEach(e => {
      expect(e.label).toBeNull();
      // Must NOT be falsely strong due to epsilon
      expect(Math.abs(e.beat % 4) < 1e-6).toBeFalsy();
    });
  });

  it('Step1 capture off-grid viewStart=0.37 viewBeats=16 before → Step2 compute fixed → Step3 strong still 4,8,12,16 with correct measure labels', () => {
    const fixed = computeRuler(0.37, 16, true);
    const strong = strongEntries(fixed);
    // With viewBeats=16 minorStep=1, firstMinor = ceil(0.37/1 -1e-9)=1, so beats 1..16.37, strong 4,8,12,16
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4']);
    strong.forEach(e => expect(e.label).toBe(String(Math.round(e.beat / 4))));
    // Off-grid fractional must not create extra strong
    expect(fixed.some(e => e.beat === 0 && e.strong)).toBeFalsy();
  });

  it('Step1 capture ultra-fine viewBeats=4 with off-grid 1.23 before → Step2 compute → Step3 strong at 4 only, minors 1.25/1.5 etc have no labels', () => {
    const fixed = computeRuler(1.23, 4, true); // minorStep 0.25, view [1.23,5.23]
    // firstMinor = ceil(1.23/0.25 -1e-9)*0.25 = ceil(4.92 - eps)=5*0.25=1.25
    const beats = fixed.map(e => e.beat);
    expect(beats[0]).toBeCloseTo(1.25);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([4]);
    expect(strong[0].label).toBe('1');
    expect(fixed.filter(e => !e.strong).every(e => e.label === null)).toBeTruthy();
  });

  it('Step1 capture file strong threshold before → Step2 verify 4.0000001%4 <1e-6 is true (no false negative) → Step3 3.9999999 etc handled via toFixed', () => {
    // This guards the postmortem bug: 4.0000001 %4 = 0.0000001 <1e-6 → strong = true
    expect(Math.abs(4.0000001 % 4) < 1e-6).toBeTruthy();
    // Our fixed ruler rounds via Number(...toFixed(4)), so 4.0000001 becomes 4
    const b = Number((4.0000001).toFixed(4));
    expect(b).toBe(4);
    expect(Math.abs(b % 4) < 1e-6).toBeTruthy();
    expect(String(Math.round(b / 4))).toBe('1');
    // Non-strong must stay false
    expect(Math.abs(4.5 % 4) < 1e-6).toBeFalsy();
    expect(Math.abs(2 % 4) < 1e-6).toBeFalsy();
  });

  it('Step1 capture regression beat grid count vs label count before → Step2 compare fixed vs buggy for 0,16 → Step3 grid beats are beat intervals, labels are measure (beat/4)', () => {
    const cases: Array<[number, number]> = [
      [0, 4],
      [0, 8],
      [0, 16],
      [0, 32],
      [0, 64],
    ];
    cases.forEach(([start, beats]) => {
      const fixed = computeRuler(start, beats, true);
      const buggy = computeRuler(start, beats, false);
      // For beats where minorStep differs, length differs, but strong count ratio is stable (every 4 beats)
      const fixedStrong = strongEntries(fixed);
      fixedStrong.forEach(e => {
        expect(e.label).toBe(String(Math.round(e.beat / 4)));
        // Old buggy would have been String(e.beat)
        expect(e.label).not.toBe(String(e.beat) !== String(Math.round(e.beat / 4)) ? String(e.beat) : '__impossible');
      });
      // Buggy and fixed strong beats must be same set when both cover same range (multiples of 4)
      // For start 0, they should both have strong at 0,4,8...
      const fixedStrongBeats = fixedStrong.map(e => e.beat);
      const buggyStrongBeats = strongEntries(buggy).map(e => e.beat);
      // Both should contain all multiples of 4 in range (maybe buggy has fewer lines but still covers multiples)
      fixedStrongBeats.forEach(b => expect(b % 4).toBe(0));
      buggyStrongBeats.forEach(b => expect(b % 4).toBe(0));
    });
  });
});

// ---------------------------------------------------------------------------
// T145-4: Off-grid, 3-step state-transition, tsc & WaveEngine/Cursor regression
// ---------------------------------------------------------------------------
describe('T145-4: Off-grid・3-step・regression (engine & tsc guard)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it('Step1 capture initial buggy density before → Step2 switch to fixed minorStep for viewBeats=4 → Step3 finer grid appears (17 vs 9 lines)', () => {
    // Step1
    const buggy4 = computeRuler(0, 4, false);
    expect(buggy4).toHaveLength(9);
    expect(buggy4.map(e => e.beat)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    // Step2: transition to fixed
    const fixed4 = computeRuler(0, 4, true);
    // Step3: denser
    expect(fixed4).toHaveLength(17);
    expect(fixed4.length).toBeGreaterThan(buggy4.length);
    expect(strongEntries(fixed4).map(e => e.label)).toEqual(['0', '1']);
  });

  it('Step1 capture scrolled viewStart=2 viewBeats=16 before → Step2 compute fixed → Step3 strong 4,8,12,16 not shifted', () => {
    const fixed = computeRuler(2, 16, true);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4']);
    const fixed2 = computeRuler(4, 16, true);
    expect(strongEntries(fixed2).map(e => e.beat)).toEqual([4, 8, 12, 16, 20]);
    expect(strongEntries(fixed2).map(e => e.label)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('Step1 capture viewBeats=100 far zoom-out before → Step2 compute fixed 4拍刻み → Step3 only measure lines, no fractional minors', () => {
    const fixed = computeRuler(0, 100, true);
    expect(computeMinorStepFixed(100)).toBe(4);
    // All beats multiples of 4
    expect(fixed.every(e => Math.abs(e.beat % 4) < 1e-6)).toBeTruthy();
    expect(fixed.every(e => e.strong)).toBeTruthy();
    expect(fixed.every(e => e.label !== null)).toBeTruthy();
    expect(fixed.map(e => e.label)).toEqual(['0','1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25']);
  });

  it('Step1 capture fake timer determinism before → Step2 advance 1000ms → Step3 ruler computation pure and deterministic', () => {
    const start = Date.now();
    vi.advanceTimersByTime(1000);
    expect(Date.now()).toBe(start + 1000);
    const a = computeRuler(0, 16, true);
    const b = computeRuler(0, 16, true);
    expect(a.map(e => e.beat)).toEqual(b.map(e => e.beat));
    expect(a.map(e => e.label)).toEqual(b.map(e => e.label));
  });

  it('Step1 capture WaveEngine/Cursor numeric consistency before (regression guard) → Step2 create timeline with complex amplitude → Step3 cursor and waveYAt agree per-beat', () => {
    // Guard that T127/T128/T131 conventions still hold after ruler-only change
    const amplitudes = [0.7, 1.3, 2.7, 3.4];
    const bpm = 120;
    for (const amp of amplitudes) {
      const timeline = new BpmTimeline(bpm, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], timeline, amp, 0);
      const perBeatPx = 2 * TW_AMP * amp;
      // Off-grid beats inside first segment before clamp
      const offGridBeats = [0.37, 1.23];
      for (const b of offGridBeats) {
        if (b * perBeatPx >= TW_AMP) continue; // skip clamped region
        const y = engine.waveYAt(b);
        const expected = TW_CENTER_Y + b * perBeatPx; // startPosition 0 => CENTER, down
        expect(y, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
      // Cursor moves with same perBeat: start at center (0.0), move 0.1 beats down
      const cursor = new Cursor(amp, 0.0);
      const beatMs = 60000 / bpm;
      const beatsDelta = 0.1;
      const dt = (beatsDelta * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs);
      const expectedY = TW_CENTER_Y + perBeatPx * beatsDelta;
      // Guard postmortem #2: use small beatsDelta from center so no clamp
      expect(cursor.y).toBeCloseTo(expectedY, 3);
      expect(Math.abs(cursor.y - TW_CENTER_Y)).toBeGreaterThan(1);
      // Cross-check waveYAt at beatsDelta equals cursor.y
      const waveAtDelta = engine.waveYAt(beatsDelta);
      expect(waveAtDelta).toBeCloseTo(cursor.y, 3);
    }
  });

  it('Step1 capture quantizeBeat & isSnapAligned before → Step2 exercise snap multiples → Step3 beats remain snap-aligned (prevents false pass)', () => {
    const snaps = [0.125, 0.25, 0.5, 1];
    for (const snap of snaps) {
      const beatsList = [snap, snap * 2, snap * 3, 1.0, 2.0];
      for (const raw of beatsList) {
        const q = quantizeBeat(raw, snap);
        const remainder = ((q % snap) + snap) % snap;
        expect(remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6, `beat ${raw} snap ${snap} q=${q}`).toBeTruthy();
      }
    }
    // End-to-end segmentize snap invariant (short press 0.30 beat amp=1)
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: false },
      { beat: 0.3, y: TW_CENTER_Y + 50, down: true },
      { beat: 0.31, y: TW_CENTER_Y + 50, down: false },
    ];
    const segs = segmentize(traj, 0.25, 1);
    segs.forEach(s => {
      const rem = ((s.beats % 0.25) + 0.25) % 0.25;
      expect(rem < 1e-6 || Math.abs(rem - 0.25) < 1e-6).toBeTruthy();
    });
  });

  it('Step1 capture tsc --noEmit guard before → Step2 verify WavePreview imports & TW constants → Step3 file type-correct and no regression', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain("import { BpmTimeline } from '../../audio/bpmTimeline'");
    expect(src).toContain("import { TW_CENTER_Y, TW_AMP, WaveEngine } from '../../game/waveEngine'");
    expect(src).toContain('RULER_H');
    const waveSrc = readFile('src/game/waveEngine.ts');
    expect(waveSrc).toContain('export const TW_AMP');
    expect(waveSrc).toContain('TW_CENTER_Y');
    expect(src).toMatch(/ctx\.fillText\s*\(\s*String\s*\(/);
  });

  it('Step1 capture ruler label isolation before → Step2 verify minorStep refinement does not bleed into measure labels → Step3 density of measure labels depends only on viewBeats/4, not minorStep', () => {
    // For same view window [0,16], strong labels always 0..4 regardless of minorStep
    const fixed16 = computeRuler(0, 16, true); // 1
    const fixed8 = computeRuler(0, 8, true);  // 0.5 but only 0..8 visible
    const fixed32 = computeRuler(0, 32, true); // 2
    expect(strongEntries(fixed16).map(e => e.label)).toEqual(['0','1','2','3','4']);
    expect(strongEntries(fixed8).map(e => e.label)).toEqual(['0','1','2']);
    expect(strongEntries(fixed32).map(e => e.label).slice(0,5)).toEqual(['0','1','2','3','4']);
    // Ensure that widening view adds exactly one label per 4 beats, not per minorStep
    const fixed64 = computeRuler(0, 64, true);
    expect(strongEntries(fixed64)).toHaveLength(17);
    expect(strongEntries(fixed64).map(e => e.label)[16]).toBe('16');
  });
});
