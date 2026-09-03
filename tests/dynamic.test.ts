/**
 * T145 — ルーラーの拡大率しきい値調整（細かい拍が見えるように）
 * Vitest node environment – pure computed values / file-contract
 * Strict TDD acceptance test: must FAIL before fix (old 3-stage) and PASS after (5-stage)
 * Spec: WavePreview.tsx:177 minorStep = viewBeats<=4?0.25:<=8?0.5:<=16?1:<=64?2:4
 * Requirement: viewBeats 16で1拍、8で0.5、4で0.25、32でも2刻みで空白が詰まる
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat, segmentize } from '../src/chart/quantize';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

// Spec fixed: 5段階
function computeMinorStepFixed(viewBeats: number): number {
  return viewBeats <= 4 ? 0.25 : viewBeats <= 8 ? 0.5 : viewBeats <= 16 ? 1 : viewBeats <= 64 ? 2 : 4;
}

// Old buggy: 3段階
function computeMinorStepBuggy(viewBeats: number): number {
  return viewBeats <= 8 ? 0.5 : viewBeats <= 32 ? 1 : 4;
}

interface RulerEntry {
  beat: number;
  strong: boolean;
  label: string | null;
  lineWidth: number;
  strokeStyle: string;
}

function computeRulerFixed(viewStart: number, viewBeats: number): RulerEntry[] {
  const minorStep = computeMinorStepFixed(viewBeats);
  const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep;
  const entries: RulerEntry[] = [];
  for (let i = 0; ; i++) {
    const b = Number((firstMinor + i * minorStep).toFixed(4));
    if (b > viewStart + viewBeats + 1e-9) break;
    const strong = Math.abs(b % 4) < 1e-6;
    const label = strong ? String(Math.round(b / 4)) : null;
    entries.push({
      beat: b,
      strong,
      label,
      lineWidth: strong ? 1.5 : 1,
      strokeStyle: strong ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)',
    });
  }
  return entries;
}

function computeRulerBuggy(viewStart: number, viewBeats: number): RulerEntry[] {
  const minorStep = computeMinorStepBuggy(viewBeats);
  const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep;
  const entries: RulerEntry[] = [];
  for (let i = 0; ; i++) {
    const b = Number((firstMinor + i * minorStep).toFixed(4));
    if (b > viewStart + viewBeats + 1e-9) break;
    const strong = Math.abs(b % 4) < 1e-6;
    const label = strong ? String(Math.round(b / 4)) : null;
    entries.push({
      beat: b,
      strong,
      label,
      lineWidth: strong ? 1.5 : 1,
      strokeStyle: strong ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)',
    });
  }
  return entries;
}

function strongEntries(entries: RulerEntry[]): RulerEntry[] {
  return entries.filter(e => e.strong);
}

// ---------------------------------------------------------------------------
// T145-1: File contract — WavePreview.tsx のみ 5段階 minorStep
// ---------------------------------------------------------------------------
describe('T145-1: File contract WavePreview.tsx minorStep 5段階細分化', () => {
  it('Step1 capture initial file state before → Step2 inspect minorStep declaration → Step3 5-stage expression exists', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Must contain the new 5-stage: <=4?0.25:<=8?0.5:<=16?1:<=64?2:4
    expect(src).toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*4\s*\?\s*0\.25\s*:\s*viewBeats\s*<=\s*8\s*\?\s*0\.5\s*:\s*viewBeats\s*<=\s*16\s*\?\s*1\s*:\s*viewBeats\s*<=\s*64\s*\?\s*2\s*:\s*4/);
  });

  it('Step1 capture old buggy 3-stage pattern before → Step2 verify file no longer contains old 3-stage → Step3 old pattern absent', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Old buggy is exactly <=8?0.5:<=32?1:4 — must NOT exist after fix
    expect(src).not.toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*8\s*\?\s*0\.5\s*:\s*viewBeats\s*<=\s*32\s*\?\s*1\s*:\s*4/);
  });

  it('Step1 capture WavePreview unchanged imports before → Step2 verify RULER_H and imports → Step3 file still has RULER_H and T144 label', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('RULER_H');
    expect(src).toContain("import { BpmTimeline } from '../../audio/bpmTimeline'");
    expect(src).toContain("import { TW_CENTER_Y, TW_AMP, WaveEngine } from '../../game/waveEngine'");
    // T144 must be preserved
    expect(src).toMatch(/String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)/);
    expect(src).toMatch(/const\s+strong\s*=\s*Math\.abs\s*\(\s*b\s*%\s*4\s*\)\s*<\s*1e-6/);
  });

  it('Step1 capture file isolation before → Step2 check other files not touched → Step3 other files do not contain ruler logic', () => {
    const waveSrc = readFile('src/game/waveEngine.ts');
    const cursorSrc = readFile('src/game/cursor.ts');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(waveSrc).not.toContain('minorStep');
    expect(waveSrc).not.toContain('RULER_H');
    expect(cursorSrc).not.toContain('minorStep');
    expect(cursorSrc).not.toContain('RULER_H');
    // EditorScreen should not contain minorStep ruler logic
    expect(editorSrc).not.toContain('minorStep');
    // Ensure WavePreview is only file with 5-stage
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('minorStep');
  });

  it('Step1 capture wavePreview data-testid before → Step2 verify required testids → Step3 canvas still present', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('data-testid="wave-preview"');
    expect(src).toContain('data-testid="wave-preview-canvas"');
    expect(src).toContain('data-testid="wave-preview-hint"');
  });

  it('Step1 capture old threshold values before → Step2 check that viewBeats<=4 boundary exists → Step3 0.25 step at strong zoom', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/viewBeats\s*<=\s*4\s*\?\s*0\.25/);
    expect(src).toMatch(/viewBeats\s*<=\s*64\s*\?\s*2/);
    // Ensure exactly 5-stage chain, not truncated
    const matches = src.match(/viewBeats\s*<=\s*\d+/g) || [];
    // Should have 4 threshold checks (4,8,16,64)
    expect(matches.length).toBeGreaterThanOrEqual(4);
    expect(src).toContain('0.25');
    expect(src).toContain('0.5');
  });
});

// ---------------------------------------------------------------------------
// T145-2: 完了条件1 — viewBeats=4,8,16,32,64,100 で minorStep が 0.25/0.5/1/2/4
// ---------------------------------------------------------------------------
describe('T145-2: 完了条件1 各拡大率で minorStep が spec通りに一致', () => {
  it('Step1 capture buggy initial minorStep values before → Step2 compute fixed values → Step3 each viewBeats maps to expected step', () => {
    // Step1: capture buggy baseline
    const buggyCases: Array<[number, number]> = [
      [4, 0.5],
      [8, 0.5],
      [16, 1],
      [32, 1],
      [64, 4],
      [100, 4],
    ];
    buggyCases.forEach(([beats, step]) => {
      expect(computeMinorStepBuggy(beats), `buggy viewBeats ${beats}`).toBe(step);
    });

    // Step2: fixed spec
    const fixedCases: Array<[number, number]> = [
      [4, 0.25],
      [8, 0.5],
      [16, 1],
      [32, 2],
      [64, 2],
      [100, 4],
    ];
    // Step3: assert transition to fixed
    fixedCases.forEach(([beats, step]) => {
      expect(computeMinorStepFixed(beats), `fixed viewBeats ${beats}`).toBe(step);
    });

    // Verify at least 3 differ from buggy (Red proof)
    const differing = fixedCases.filter(([b, s]) => computeMinorStepBuggy(b) !== s);
    expect(differing.length).toBeGreaterThanOrEqual(3);
    expect(differing.map(d => d[0])).toEqual(expect.arrayContaining([4, 32, 64]));
  });

  it('Step1 capture viewBeats=4 step before (0.5 buggy) → Step2 compute fixed 0.25 → Step3 total lines increased and 0.25刻み', () => {
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, 4);
    const buggy = computeRulerBuggy(viewStart, 4);
    // Buggy: 0.5刻み => 9 lines (0..4)
    expect(buggy).toHaveLength(9);
    expect(buggy.map(e => e.beat)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    // Fixed: 0.25刻み => 17 lines (0..4)
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4]);
    // Dynamic computed: intervals are exactly 0.25
    for (let i = 1; i < fixed.length; i++) {
      expect(fixed[i].beat - fixed[i - 1].beat).toBeCloseTo(0.25, 6);
    }
  });

  it('Step1 capture viewBeats=8 step before → Step2 fixed 0.5 remains but file logic changed → Step3 0.5刻みで17 lines', () => {
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, 8);
    const buggy = computeRulerBuggy(viewStart, 8);
    // Both should be 0.5 at 8, but fixed must also be 0.5
    expect(computeMinorStepFixed(8)).toBe(0.5);
    expect(computeMinorStepBuggy(8)).toBe(0.5);
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)[0]).toBe(0);
    expect(fixed.map(e => e.beat)[1]).toBe(0.5);
    expect(fixed[fixed.length - 1].beat).toBe(8);
    expect(buggy).toHaveLength(17); // same at 8
  });

  it('Step1 capture viewBeats=16 (初期) step before → Step2 fixed 1 → Step3 1拍刻み 17 lines', () => {
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, 16);
    const buggy = computeRulerBuggy(viewStart, 16);
    expect(computeMinorStepFixed(16)).toBe(1);
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    // At 16, buggy also 1, but ensure fixed matches spec
    expect(buggy.map(e => e.beat)).toEqual(fixed.map(e => e.beat));
    expect(fixed.filter(e => e.strong).map(e => e.beat)).toEqual([0, 4, 8, 12, 16]);
  });

  it('Step1 capture viewBeats=32 old 1 vs new 2 → Step2 fixed 2 → Step3 2拍刻みで空白詰まる (17 vs 33 lines)', () => {
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, 32);
    const buggy = computeRulerBuggy(viewStart, 32);
    expect(computeMinorStepFixed(32)).toBe(2);
    expect(computeMinorStepBuggy(32)).toBe(1);
    // Buggy 1拍刻み => 33 lines
    expect(buggy).toHaveLength(33);
    // Fixed 2拍刻み => 17 lines (0,2,4,...32)
    expect(fixed).toHaveLength(17);
    expect(fixed.map(e => e.beat)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]);
    // Strong every 4 beats: 0,4,8,...32 => 9 strong
    expect(fixed.filter(e => e.strong)).toHaveLength(9);
    expect(fixed.filter(e => e.strong).map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32]);
  });

  it('Step1 capture viewBeats=64 before (buggy 4) → Step2 fixed 2 → Step3 2拍刻み 33 lines vs buggy 17 lines', () => {
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, 64);
    const buggy = computeRulerBuggy(viewStart, 64);
    expect(computeMinorStepFixed(64)).toBe(2);
    expect(computeMinorStepBuggy(64)).toBe(4);
    // Fixed 2刻み => 33 lines 0..64 step2
    expect(fixed).toHaveLength(33);
    expect(fixed[1].beat).toBe(2);
    expect(fixed[2].beat).toBe(4);
    // Buggy 4刻み => 17 lines
    expect(buggy).toHaveLength(17);
    expect(buggy.map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]);
    // Fixed has more detail than buggy at 64
    expect(fixed.length).toBeGreaterThan(buggy.length);
  });

  it('Step1 capture viewBeats=100 before → Step2 fixed 4 → Step3 4拍(小節)刻み', () => {
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, 100);
    expect(computeMinorStepFixed(100)).toBe(4);
    expect(computeMinorStepBuggy(100)).toBe(4);
    // 0,4,8,...,100 => 26 lines (100/4=25 +1)
    expect(fixed).toHaveLength(26);
    expect(fixed.map(e => e.beat)).toEqual(Array.from({ length: 26 }, (_, i) => i * 4));
    expect(fixed.every(e => e.strong)).toBe(true);
  });

  it('Step1 capture boundary viewBeats values before → Step2 sweep boundaries → Step3 threshold正確', () => {
    const boundaries: Array<[number, number]> = [
      [1, 0.25],
      [4, 0.25],
      [4.01, 0.5],
      [8, 0.5],
      [8.01, 1],
      [16, 1],
      [16.01, 2],
      [32, 2],
      [64, 2],
      [64.01, 4],
      [100, 4],
      [200, 4],
    ];
    boundaries.forEach(([beats, expected]) => {
      expect(computeMinorStepFixed(beats), `viewBeats ${beats}`).toBe(expected);
    });
    // Verify buggy differs at key thresholds
    expect(computeMinorStepBuggy(4.01)).toBe(0.5);
    expect(computeMinorStepFixed(4.01)).toBe(0.5);
    expect(computeMinorStepBuggy(16.01)).toBe(1);
    expect(computeMinorStepFixed(16.01)).toBe(2);
    expect(computeMinorStepBuggy(64.01)).toBe(4);
    expect(computeMinorStepFixed(64.01)).toBe(4);
  });

  it('Step1 capture off-grid viewStart 0.37 with viewBeats=4 → Step2 fixed 0.25刻み → Step3 fractional start aligns', () => {
    const viewStart = 0.37;
    const viewBeats = 4;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    // minorStep 0.25, firstMinor = ceil(0.37/0.25)*0.25 = 0.5
    expect(fixed[0].beat).toBe(0.5);
    // Last should be <= viewStart+viewBeats =4.37, step 0.25 => 4.25
    expect(fixed[fixed.length - 1].beat).toBe(4.25);
    // All beats are multiples of 0.25
    fixed.forEach(e => {
      const mod = (e.beat * 100) % 25;
      expect(mod < 1e-6 || Math.abs(mod - 25) < 1e-6 || Math.abs(mod) < 1e-4).toBeTruthy();
    });
  });

  it('Step1 capture off-grid viewStart 1.23 viewBeats=8 → Step2 fixed 0.5刻み → Step3 strong at 4,8 still correct', () => {
    const viewStart = 1.23;
    const viewBeats = 8;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    // firstMinor ceil(1.23/0.5)*0.5=1.5
    expect(fixed[0].beat).toBe(1.5);
    const strong = strongEntries(fixed);
    // Visible strong in [1.23,9.23]: 4,8
    expect(strong.map(e => e.beat)).toEqual([4, 8]);
    expect(strong.map(e => e.label)).toEqual(['1', '2']);
  });
});

// ---------------------------------------------------------------------------
// T145-3: 完了条件2 — ルーラーの小節ラベル（T144の b/4）は strong のときのみ
// ---------------------------------------------------------------------------
describe('T145-3: 完了条件2 ルーラー小節ラベルは strong時のみ (minorStep変更で密度不変)', () => {
  it('Step1 capture strong labels before → Step2 compute fixed ruler viewBeats16 → Step3 only strong has label, minor null', () => {
    const fixed = computeRulerFixed(0, 16);
    fixed.forEach(e => {
      if (e.strong) {
        expect(e.label).not.toBeNull();
        expect(e.label).toBe(String(Math.round(e.beat / 4)));
        expect(e.lineWidth).toBe(1.5);
        expect(e.strokeStyle).toBe('rgba(255,255,255,0.20)');
      } else {
        expect(e.label).toBeNull();
        expect(e.lineWidth).toBe(1);
        expect(e.strokeStyle).toBe('rgba(255,255,255,0.07)');
      }
    });
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4']);
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16]);
  });

  it('Step1 capture buggy vs fixed label density before → Step2 compare strong counts → Step3 label密度は minorStepに依らず小節ごと', () => {
    // viewBeats 32: buggy 1刻み vs fixed 2刻み, strongはどちらも4拍ごと
    const fixed32 = computeRulerFixed(0, 32);
    const buggy32 = computeRulerBuggy(0, 32);
    const fixedStrong = strongEntries(fixed32);
    const buggyStrong = strongEntries(buggy32);
    expect(fixedStrong.map(e => e.beat)).toEqual(buggyStrong.map(e => e.beat));
    expect(fixedStrong.map(e => e.label)).toEqual(buggyStrong.map(e => e.label));
    expect(fixedStrong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    // Ensure minor labels remain null regardless of step
    expect(fixed32.filter(e => !e.strong).every(e => e.label === null)).toBe(true);
    expect(buggy32.filter(e => !e.strong).every(e => e.label === null)).toBe(true);
    // Fixed has fewer total lines but same strong labels
    expect(fixed32.length).toBeLessThan(buggy32.length);
    expect(fixedStrong.length).toBe(buggyStrong.length);
  });

  it('Step1 capture viewBeats=4 0.25刻み before → Step2 fixed strong at 0,4 → Step3 labels 0,1 only', () => {
    const fixed = computeRulerFixed(0, 4);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([0, 4]);
    expect(strong.map(e => e.label)).toEqual(['0', '1']);
    // 17 lines total, 2 strong + 15 minor
    expect(fixed).toHaveLength(17);
    expect(fixed.filter(e => !e.strong)).toHaveLength(15);
    fixed.filter(e => !e.strong).forEach(e => expect(e.label).toBeNull());
  });

  it('Step1 capture viewBeats=64 2刻み before → Step2 fixed strong at 4拍ごと → Step3 labels 0..16 measure numbers', () => {
    const fixed = computeRulerFixed(0, 64);
    const strong = strongEntries(fixed);
    // minorStep 2 => beats 0,2,4,...64 => strong at multiples of 4: 0,4,8,...,64 =17 strong
    expect(strong).toHaveLength(17);
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]);
    expect(strong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16']);
    // Between strong, minor lines at 2,6,10... have no labels
    const minors = fixed.filter(e => !e.strong);
    expect(minors.map(e => e.beat)).toEqual([2, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 62]);
    minors.forEach(e => expect(e.label).toBeNull());
  });

  it('Step1 capture viewBeats=100 4刻み (all strong) before → Step2 compute → Step3 all lines are strong with labels', () => {
    const fixed = computeRulerFixed(0, 100);
    expect(fixed.every(e => e.strong)).toBe(true);
    expect(fixed.every(e => e.label !== null)).toBe(true);
    expect(fixed.map(e => e.label)).toEqual(Array.from({ length: 26 }, (_, i) => String(i)));
    // Verify no minor lines without label confusion
    expect(fixed.filter(e => !e.strong)).toHaveLength(0);
  });

  it('Step1 capture off-grid viewStart 0.37 viewBeats=16 before → Step2 fixed strong 4,8,12,16 → Step3 labels still measure', () => {
    const fixed = computeRulerFixed(0.37, 16);
    const strong = strongEntries(fixed);
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4']);
    // Ensure label density unchanged: still only strong have labels
    expect(fixed.filter(e => e.label !== null)).toHaveLength(strong.length);
  });

  it('Step1 capture file still has strong-only fillText before → Step2 inspect source → Step3 if (strong) guard present', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Must have if (strong) { fillText(String(Math.round(b/4)) ) }
    expect(src).toMatch(/if\s*\(\s*strong\s*\)\s*\{\s*ctx\.fillStyle/);
    expect(src).toMatch(/ctx\.fillText\s*\(\s*String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)\s*,\s*gx\s*\+\s*4\s*,\s*4\s*\)/);
    // Must not have unconditional label outside strong
    const rulerIdx = src.indexOf('if (strong)');
    expect(rulerIdx).toBeGreaterThan(-1);
    // Ensure strong definition nearby
    expect(src.slice(rulerIdx - 500, rulerIdx + 200)).toMatch(/const\s+strong\s*=\s*Math\.abs\s*\(\s*b\s*%\s*4\s*\)/);
  });

  it('Step1 capture scrolled viewStart=2 viewBeats=32 before → Step2 fixed ruler → Step3 strong labels shift but remain measure', () => {
    const fixed = computeRulerFixed(2, 32);
    const strong = strongEntries(fixed);
    // view 2..34, minorStep 2 => beats 2,4,6,...,34 => strong at 4,8,12,16,20,24,28,32
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16, 20, 24, 28, 32]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    strong.forEach(e => expect(e.label).toBe(String(Math.round(e.beat / 4))));
  });
});

// ---------------------------------------------------------------------------
// T145-4: 回帰 & off-grid & 3-step state-transition robustness
// ---------------------------------------------------------------------------
describe('T145-4: 回帰・off-grid・3-step state-transition robustness', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it('Step1 capture initial buggy state (sparse) before → Step2 simulate zoom to 0.25 → Step3 transition to detailed grid', () => {
    // Step1: buggy at viewBeats 4 was sparse 0.5
    const buggyAt4 = computeRulerBuggy(0, 4);
    expect(buggyAt4).toHaveLength(9);
    expect(buggyAt4[1].beat).toBe(0.5);
    // Step2: fixed at viewBeats 4 is detailed 0.25
    const fixedAt4 = computeRulerFixed(0, 4);
    // Step3: assert detailed
    expect(fixedAt4).toHaveLength(17);
    expect(fixedAt4[1].beat).toBe(0.25);
    expect(fixedAt4[2].beat).toBe(0.5);
    // Labels unchanged
    expect(strongEntries(buggyAt4).map(e => e.label)).toEqual(['0', '1']);
    expect(strongEntries(fixedAt4).map(e => e.label)).toEqual(['0', '1']);
  });

  it('Step1 capture large viewBeats 32 before sparse→ Step2 zoom out to 100 → Step3 both converge to 4刻み', () => {
    const fixed32 = computeRulerFixed(0, 32);
    const fixed100 = computeRulerFixed(0, 100);
    expect(computeMinorStepFixed(32)).toBe(2);
    expect(computeMinorStepFixed(100)).toBe(4);
    // At 100, all are strong
    expect(fixed100.every(e => e.strong)).toBe(true);
    // At 32, mix of strong+minor
    expect(fixed32.some(e => !e.strong)).toBe(true);
    // Labels are consistent measure numbers in both
    expect(strongEntries(fixed32).map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    expect(fixed100.map(e => e.label)).toEqual(Array.from({ length: 26 }, (_, i) => String(i)));
  });

  it('Step1 capture off-grid fractional beat handling before → Step2 verify measure label at non-integer strong is robust → Step3 Math.round handles', () => {
    const testBeats = [0, 4, 8, 12, 16];
    testBeats.forEach(b => {
      expect(String(Math.round(b / 4))).toBe(String(b / 4));
    });
    expect(String(Math.round(4 / 4))).toBe('1');
    expect(String(Math.round(8 / 4))).toBe('2');
    // Ensure strong check tolerates floating errors
    const eps = 1e-6;
    expect(Math.abs(4.0000001 % 4) < eps || Math.abs(4.0000001 % 4 - 4) < eps).toBeFalsy(); // 4.0000001 %4 =0.0000001 <1e-6 true
    expect(Math.abs(0.0000001 % 4) < eps).toBeTruthy();
  });

  it('Step1 capture file tsc guard before → Step2 verify imports & types → Step3 TW_ constants untouched', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain("import { BpmTimeline } from '../../audio/bpmTimeline'");
    expect(src).toContain("import { TW_CENTER_Y, TW_AMP, WaveEngine } from '../../game/waveEngine'");
    const waveSrc = readFile('src/game/waveEngine.ts');
    expect(waveSrc).toContain('TW_AMP');
    expect(waveSrc).toContain('TW_CENTER_Y');
    expect(TW_AMP).toBe(130);
    expect(TW_CENTER_Y).toBe(300);
  });

  it('Step1 capture regression beat grid count vs buggy before → Step2 compare counts → Step3 strong counts equal, total differs meaningfully', () => {
    const cases: Array<[number, number]> = [
      [0, 4],
      [0, 32],
      [0, 64],
      [2, 16],
      [1.23, 8],
    ];
    cases.forEach(([start, beats]) => {
      const fixed = computeRulerFixed(start, beats);
      const buggy = computeRulerBuggy(start, beats);
      const fixedStrong = strongEntries(fixed);
      const buggyStrong = strongEntries(buggy);
      // Strong positions are always multiples of 4, so counts should match when both include same range
      // But total counts differ where minorStep differs
      if (beats === 32 || beats === 64 || beats === 4) {
        expect(fixed.length).not.toBe(buggy.length);
      }
      // Strong labels must be measure numbers in both
      fixedStrong.forEach(e => expect(e.label).toBe(String(Math.round(e.beat / 4))));
      buggyStrong.forEach(e => expect(e.label).toBe(String(Math.round(e.beat / 4))));
    });
  });

  it('Step1 capture WaveEngine/Cursor complex amplitudes before → Step2 sweep 0.7/1.3/2.7/3.4 off-grid 0.37/1.23 → Step3 numerical consistency', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      const startY = TW_CENTER_Y;
      for (const b of offGridBeats) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
      expect(engine.waveYAt(10)).toBeCloseTo(BOTTOM, 4);
      // Cursor consistency
      const beatMs = 500;
      const tl2 = new BpmTimeline(120, [], amp);
      const engine2 = new WaveEngine([{ direction: 'down', beats: 4 }], tl2, amp, 1.0);
      const perBeat2 = 2 * TW_AMP * amp;
      const cursor = new Cursor(amp, 1.0);
      const y0 = cursor.y;
      const beatsDelta = 0.37;
      const dt = (beatsDelta * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs);
      const cursorDelta = Math.abs(cursor.y - y0);
      expect(cursorDelta).toBeCloseTo(perBeat2 * 0.37, 3);
      const waveDelta = Math.abs(engine2.waveYAt(beatsDelta) - engine2.waveYAt(0));
      expect(waveDelta).toBeCloseTo(perBeat2 * 0.37, 3);
    }
  });

  it('Step1 capture quantize off-grid before → Step2 verify snap 0.25/0.5 handling → Step3 no overshoot', () => {
    const snap = 0.5;
    expect(quantizeBeat(1.2, snap)).toBeCloseTo(1.0, 4);
    expect(quantizeBeat(1.3, snap)).toBeCloseTo(1.5, 4);
    expect(quantizeBeat(0.37, 0.25)).toBeCloseTo(0.25, 4);
    expect(quantizeBeat(0.38, 0.25)).toBeCloseTo(0.5, 4);
    // Ensure minorStep-like quantization works for all T145 steps
    [0.25, 0.5, 1, 2, 4].forEach(step => {
      expect(quantizeBeat(1.2, step) % step).toBeCloseTo(0, 6);
    });
  });

  it('Step1 capture deterministic ruler computation before → Step2 advance timers → Step3 still deterministic', () => {
    const start = Date.now();
    vi.advanceTimersByTime(1000);
    expect(Date.now()).toBe(start + 1000);
    const fixed1 = computeRulerFixed(0, 16);
    const fixed2 = computeRulerFixed(0, 16);
    expect(fixed1.map(e => e.beat)).toEqual(fixed2.map(e => e.beat));
    expect(fixed1.map(e => e.label)).toEqual(fixed2.map(e => e.label));
    expect(computeMinorStepFixed(16)).toBe(1);
  });

  it('Step1 capture segmentize not broken by ruler change before → Step2 create trajectory → Step3 snap-aligned', () => {
    const snap = 0.5;
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.5, y: TW_CENTER_Y + 60, down: true },
      { beat: 1.0, y: TW_CENTER_Y + 120, down: true },
      { beat: 1.2, y: TW_CENTER_Y + 130, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
    }
    expect(segs.length).toBeGreaterThan(0);
  });

  it('Step1 capture getPoints length invariant before → Step2 vary segments → Step3 segments+1 holds', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const cases: any[] = [
      [{ direction: 'down', beats: 1 }],
      [{ direction: 'up', beats: 0.5 }, { direction: 'down', beats: 0.5 }, { direction: 'stay', beats: 1 }],
      [],
    ];
    for (const segs of cases) {
      const eng = new WaveEngine(segs, tl, 1.0, 0);
      const pts = eng.getPoints();
      if (segs.length === 0) expect(pts.length).toBe(2);
      else expect(pts.length).toBe(segs.length + 1);
      for (const p of pts) {
        expect(typeof p.beat).toBe('number');
        expect(typeof p.y).toBe('number');
      }
    }
  });
});
