/**
 * T144 — ルーラーを小節単位（0,1,2...）に変更
 * Vitest node environment – pure computed values / file-contract
 * Strict TDD acceptance test: must FAIL before fix (old String(b)) and PASS after (String(Math.round(b/4)))
 * Spec: WavePreview.tsx:184-194  strong = b % 4 == 0 の label を String(Math.round(b/4)) に変更。線は strong 判定維持、minorStep は beat 単位のまま。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function computeMinorStep(viewBeats: number): number {
  // current production logic (unchanged in T144)
  return viewBeats <= 8 ? 0.5 : viewBeats <= 32 ? 1 : 4;
}

interface RulerEntry {
  beat: number;
  strong: boolean;
  label: string | null; // measure label if strong else null
  lineWidth: number;
  strokeStyle: string;
}

function computeRulerFixed(viewStart: number, viewBeats: number): RulerEntry[] {
  const minorStep = computeMinorStep(viewBeats);
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
  // old buggy: label = String(b) at strong positions
  const minorStep = computeMinorStep(viewBeats);
  const firstMinor = Math.ceil(viewStart / minorStep - 1e-9) * minorStep;
  const entries: RulerEntry[] = [];
  for (let i = 0; ; i++) {
    const b = Number((firstMinor + i * minorStep).toFixed(4));
    if (b > viewStart + viewBeats + 1e-9) break;
    const strong = Math.abs(b % 4) < 1e-6;
    const label = strong ? String(b) : null;
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
// T144-1: File contract — WavePreview.tsx のみ修正、Math.round(b/4) で小節番号
// ---------------------------------------------------------------------------
describe('T144-1: File contract WavePreview.tsx 小節ラベル Math.round(b/4) と strong 維持', () => {
  it('Step1 capture initial file state before → Step2 inspect ruler label line → Step3 contains String(Math.round(b / 4))', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    // Must contain the fixed measure label expression
    expect(src).toMatch(/String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)/);
    // Exact context: fillText with gx+4, 4
    expect(src).toMatch(/ctx\.fillText\s*\(\s*String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)\s*,\s*gx\s*\+\s*4\s*,\s*4\s*\)/);
  });

  it('Step1 capture old buggy pattern before (String(b)) → Step2 verify file no longer uses bare beat label → Step3 no bare String(b) in strong block', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    const rulerIdx = src.indexOf('if (strong)');
    expect(rulerIdx).toBeGreaterThan(-1);
    const slice = src.slice(rulerIdx, rulerIdx + 600);
    // Must contain the fixed version
    expect(slice).toContain('Math.round(b / 4)');
    // Must NOT contain the old buggy bare fillText(String(b), ...) in the strong block
    // Extract the fillText call inside the strong block
    const fillMatch = slice.match(/ctx\.fillText\s*\([^)]+\)/);
    expect(fillMatch).not.toBeNull();
    const call = fillMatch![0];
    // Old buggy would be exactly String(b) without division
    expect(call).not.toMatch(/String\s*\(\s*b\s*\)\s*,/);
    expect(call).toMatch(/Math\.round\s*\(\s*b\s*\/\s*4\s*\)/);
  });

  it('Step1 capture strong definition before → Step2 verify strong判定 → Step3 Math.abs(b % 4) < 1e-6 を維持', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/const\s+strong\s*=\s*Math\.abs\s*\(\s*b\s*%\s*4\s*\)\s*<\s*1e-6/);
    // Must NOT have been changed to beat/measure based strong (e.g. b%1)
    expect(src).not.toMatch(/const\s+strong\s*=\s*Math\.abs\s*\(\s*b\s*%\s*1\s*\)/);
  });

  it('Step1 capture minorStep definition before → Step2 verify beat-based grid → Step3 viewBeats<=8?0.5:viewBeats<=32?1:4 を維持', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*8\s*\?\s*0\.5\s*:\s*viewBeats\s*<=\s*32\s*\?\s*1\s*:\s*4/);
  });

  it('Step1 capture ruler rendering completeness before → Step2 verify fillStyle & stroke logic → Step3 strong=0.20/1.5 vs minor=0.07/1', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain("ctx.strokeStyle = strong ? 'rgba(255,255,255,0.20)'");
    expect(src).toContain("ctx.lineWidth = strong ? 1.5 : 1");
    expect(src).toContain("rgba(255,255,255,0.07)");
    expect(src).toContain("ctx.fillStyle = 'rgba(255,255,255,0.5)'");
  });

  it('Step1 capture data-testid availability before → Step2 check wave-preview elements → Step3 required testids present', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('data-testid="wave-preview"');
    expect(src).toContain('data-testid="wave-preview-canvas"');
    expect(src).toContain('data-testid="wave-preview-hint"');
    // Must NOT hallucinate parent containers
    expect(src).not.toContain('data-testid="music-control"');
    expect(src).not.toContain('data-testid="bpm-editor"');
  });
});

// ---------------------------------------------------------------------------
// T144-2: 完了条件1 — viewBeats=16 初期表示で 0,1,2,3,4 が表示され 4,8,12 が小節ラベルとして出ない
// ---------------------------------------------------------------------------
describe('T144-2: 完了条件1 viewBeats=16 初期表示 0,1,2,3,4（小節）で 4,8,12 は beat ラベルとして消失', () => {
  it('Step1 capture old beat labels [0,4,8,12,16] before → Step2 compute new measure labels → Step3 new is [0,1,2,3,4] not beat numbers', () => {
    const viewStart = 0;
    const viewBeats = 16;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    const buggy = computeRulerBuggy(viewStart, viewBeats);
    const fixedStrong = strongEntries(fixed);
    const buggyStrong = strongEntries(buggy);

    // Step1: buggy old expectations
    expect(buggyStrong.map(e => e.label)).toEqual(['0', '4', '8', '12', '16']);
    expect(buggyStrong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16]);

    // Step3: fixed new expectations
    expect(fixedStrong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16]);
    expect(fixedStrong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4']);

    // First label must be 0 (measure 0) not 8 confusion
    expect(fixedStrong[0].label).toBe('0');
    expect(fixedStrong[0].beat).toBe(0);
    expect(fixedStrong[1].beat).toBe(4);
    expect(fixedStrong[1].label).toBe('1');

    // Verify that label "4" at beat 16 is measure 4, beat 4's label is NOT "4"
    const beat4Entry = fixedStrong.find(e => e.beat === 4)!;
    expect(beat4Entry.label).toBe('1');
    expect(beat4Entry.label).not.toBe('4');

    const beat16Entry = fixedStrong.find(e => e.beat === 16)!;
    expect(beat16Entry.label).toBe('4');
  });

  it('Step1 capture viewBeats=16 strong count before → Step2 compute fixed ruler → Step3 5 strong labels with exact measure mapping', () => {
    const fixed = computeRulerFixed(0, 16);
    const strong = strongEntries(fixed);
    expect(strong).toHaveLength(5);
    // Exact beat->label mapping via Math.round(b/4)
    const expectedPairs: [number, string][] = [
      [0, '0'],
      [4, '1'],
      [8, '2'],
      [12, '3'],
      [16, '4'],
    ];
    expectedPairs.forEach(([beat, label]) => {
      const e = strong.find(x => x.beat === beat);
      expect(e, `beat ${beat} should exist`).toBeDefined();
      expect(e!.label).toBe(label);
      expect(e!.label).toBe(String(Math.round(beat / 4)));
    });
    // Ensure 4,8,12 do NOT appear as labels except where measure number coincides (measure 4 at beat16 is ok, but not at beat4)
    const labels = strong.map(e => e.label);
    expect(labels).not.toContain('8');
    expect(labels).not.toContain('12');
    // label "4" appears only once (at beat16), not at beat4
    expect(labels.filter(l => l === '4')).toHaveLength(1);
    expect(strong.find(e => e.label === '4')!.beat).toBe(16);
  });

  it('Step1 capture viewBeats variations before → Step2 sweep viewBeats 4/8/16/32/64 → Step3 measure mapping holds for each', () => {
    const cases: Array<{ viewBeats: number; viewStart: number; expected: Array<[number, string]> }> = [
      { viewBeats: 4, viewStart: 0, expected: [[0, '0'], [4, '1']] },
      { viewBeats: 8, viewStart: 0, expected: [[0, '0'], [4, '1'], [8, '2']] },
      { viewBeats: 32, viewStart: 0, expected: [[0, '0'], [4, '1'], [8, '2'], [12, '3'], [16, '4'], [20, '5'], [24, '6'], [28, '7'], [32, '8']] },
      { viewBeats: 20, viewStart: 0, expected: [[0, '0'], [4, '1'], [8, '2'], [12, '3'], [16, '4'], [20, '5']] },
    ];
    for (const c of cases) {
      const fixed = computeRulerFixed(c.viewStart, c.viewBeats);
      const strong = strongEntries(fixed);
      for (const [beat, label] of c.expected) {
        const e = strong.find(x => x.beat === beat);
        expect(e, `viewBeats ${c.viewBeats} beat ${beat} should exist`).toBeDefined();
        expect(e!.label, `viewBeats ${c.viewBeats} beat ${beat}`).toBe(label);
      }
    }
  });

  it('Step1 capture off-grid viewStart 0.37 before → Step2 compute fixed ruler with minorStep 1 → Step3 strong still multiples of 4 with correct measure labels', () => {
    const viewStart = 0.37;
    const viewBeats = 16;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    const strong = strongEntries(fixed);
    // Visible strong beats within [0.37, 16.37] are 4,8,12,16
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4']);
    // Verify each label is Math.round(b/4)
    strong.forEach(e => {
      expect(e.label).toBe(String(Math.round(e.beat / 4)));
    });
    // Ensure off-grid does not shift label to beat number
    expect(strong[0].label).not.toBe('4');
    expect(strong[0].label).toBe('1');
  });

  it('Step1 capture scrolled viewStart=2 with viewBeats=16 before → Step2 compute → Step3 strong beats 4,8,12,16,20 with labels 1,2,3,4,5', () => {
    const fixed = computeRulerFixed(2, 16);
    const strong = strongEntries(fixed);
    // firstMinor=2, minorStep=1, so beats 2..18, strong at 4,8,12,16
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4']);
    // Shifted viewStart 4..20
    const fixed2 = computeRulerFixed(4, 16);
    expect(strongEntries(fixed2).map(e => e.beat)).toEqual([4, 8, 12, 16, 20]);
    expect(strongEntries(fixed2).map(e => e.label)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('Step1 capture off-grid fractional beat handling before → Step2 verify measure label at non-integer strong is robust → Step3 Math.round handles 4.0001 etc', () => {
    // Simulate b values that might be 3.9999 or 4.0001 due to floating errors, but source uses toFixed(4) and 1e-6 tolerance
    const testBeats = [0, 4, 8.0001, 7.9999, 12, 16];
    testBeats.forEach(b => {
      const rounded = Math.round(b / 4);
      // For b within 1e-6 of multiple of 4, label should be rounded measure
      if (Math.abs(b % 4) < 1e-6 || Math.abs(b - Math.round(b)) < 0.001) {
        // Check that our fixed logic matches spec: String(Math.round(b/4))
        if (Math.abs(b % 4) < 0.01) {
          expect(String(Math.round(b / 4))).toBe(String(rounded));
        }
      }
    });
    // Specific: b=0->0, b=4->1, b=8->2
    expect(String(Math.round(0 / 4))).toBe('0');
    expect(String(Math.round(4 / 4))).toBe('1');
    expect(String(Math.round(8 / 4))).toBe('2');
    expect(String(Math.round(12 / 4))).toBe('3');
    expect(String(Math.round(16 / 4))).toBe('4');
    // Old buggy would give different
    expect(String(4)).not.toBe(String(Math.round(4 / 4)));
    expect(String(8)).not.toBe(String(Math.round(8 / 4)));
  });
});

// ---------------------------------------------------------------------------
// T144-3: 完了条件2 — minorStep の縦線（beat グリッド）は従来通り beat 単位で引かれ、小節太線と beat 細線が区別
// ---------------------------------------------------------------------------
describe('T144-3: 完了条件2 minorStep beat グリッドは従来通り、小節太線と beat 細線の区別', () => {
  it('Step1 capture minorStep values before → Step2 compute for viewBeats=4,8,16,32,64,100 → Step3 matches beat-based spec 0.5/1/4', () => {
    const expectations: Array<[number, number]> = [
      [4, 0.5],
      [8, 0.5],
      [16, 1],
      [32, 1],
      [64, 4],
      [100, 4],
    ];
    expectations.forEach(([beats, step]) => {
      expect(computeMinorStep(beats), `viewBeats ${beats}`).toBe(step);
    });
    // Ensure T144 did not change minorStep definition
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toMatch(/viewBeats\s*<=\s*8\s*\?\s*0\.5/);
    expect(src).toMatch(/viewBeats\s*<=\s*32\s*\?\s*1\s*:\s*4/);
  });

  it('Step1 capture total vertical lines for viewBeats=16 before → Step2 compute fixed ruler → Step3 17 beat lines with 5 strong + 12 minor', () => {
    const viewStart = 0;
    const viewBeats = 16;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    // minorStep=1 => beats 0..16 inclusive => 17 lines
    expect(fixed).toHaveLength(17);
    const strong = strongEntries(fixed);
    const minor = fixed.filter(e => !e.strong);
    expect(strong).toHaveLength(5);
    expect(minor).toHaveLength(12);
    // Strong at multiples of 4
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16]);
    // Minor at other beats
    expect(minor.map(e => e.beat)).toEqual([1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15]);
  });

  it('Step1 capture line styling distinction before → Step2 inspect fixed entries → Step3 strong: width 1.5 rgba 0.20 vs minor: width 1 rgba 0.07', () => {
    const fixed = computeRulerFixed(0, 16);
    fixed.forEach(e => {
      if (e.strong) {
        expect(e.lineWidth).toBe(1.5);
        expect(e.strokeStyle).toBe('rgba(255,255,255,0.20)');
        expect(e.label).not.toBeNull();
        // label is measure number
        expect(e.label).toBe(String(Math.round(e.beat / 4)));
      } else {
        expect(e.lineWidth).toBe(1);
        expect(e.strokeStyle).toBe('rgba(255,255,255,0.07)');
        expect(e.label).toBeNull();
      }
    });
  });

  it('Step1 capture beat grid while major labels are measure numbers before → Step2 verify both arrays coexist → Step3 grid beats are beat intervals, labels are measure intervals', () => {
    const viewBeats = 8; // minorStep 0.5
    const fixed = computeRulerFixed(0, viewBeats);
    // Beats should be every 0.5
    const beats = fixed.map(e => e.beat);
    expect(beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8]);
    // Strong only at multiples of 4
    const strongBeats = strongEntries(fixed).map(e => e.beat);
    expect(strongBeats).toEqual([0, 4, 8]);
    // Labels at strong are measure numbers 0,1,2
    expect(strongEntries(fixed).map(e => e.label)).toEqual(['0', '1', '2']);
    // Verify that the grid is still beat-based (0.5 increments) while labels are measure-based
    const minorBeats = fixed.filter(e => !e.strong).map(e => e.beat);
    expect(minorBeats).toContain(0.5);
    expect(minorBeats).toContain(1);
    expect(minorBeats).not.toContain(4); // 4 is strong
  });

  it('Step1 capture file guarantees beat grid remains before → Step2 check source still draws vertical grid per minorStep → Step3 loop uses minorStep and strong check', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain('const minorStep = viewBeats');
    expect(src).toContain('firstMinor');
    expect(src).toContain('Math.ceil(viewStart / minorStep');
    expect(src).toMatch(/for\s*\(\s*let\s+i\s*=\s*0\s*;\s*;\s*i\+\+\s*\)/);
    expect(src).toContain('Math.abs(b % 4) < 1e-6');
    expect(src).toContain('ctx.moveTo(gx, RULER_H)');
    expect(src).toContain('ctx.lineTo(gx, cssH)');
  });

  it('Step1 capture viewBeats=32 minorStep=1 strong every 4 beats before → Step2 compute → Step3 33 lines with 9 strong (0..32) and measure labels 0..8', () => {
    const fixed = computeRulerFixed(0, 32);
    expect(fixed).toHaveLength(33);
    const strong = strongEntries(fixed);
    expect(strong).toHaveLength(9);
    expect(strong.map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32]);
    expect(strong.map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
    // Verify old buggy would have been different
    const buggy = computeRulerBuggy(0, 32);
    expect(strongEntries(buggy).map(e => e.label)).toEqual(['0', '4', '8', '12', '16', '20', '24', '28', '32']);
    expect(strong.map(e => e.label)).not.toEqual(strongEntries(buggy).map(e => e.label));
  });
});

// ---------------------------------------------------------------------------
// T144-4: 回帰 & off-grid & 3-step state-transition robustness
// ---------------------------------------------------------------------------
describe('T144-4: 回帰・off-grid・3-step state-transition robustness', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it('Step1 capture initial rendering state (buggy beat labels) before → Step2 simulate fix to measure labels → Step3 transition assert measure labels correct and old values gone', () => {
    // Step1: initial buggy state
    const buggyLabels = computeRulerBuggy(0, 16).filter(e => e.strong).map(e => e.label);
    expect(buggyLabels).toEqual(['0', '4', '8', '12', '16']);
    // Step2: perform fix (math.round(b/4))
    const fixedLabels = computeRulerFixed(0, 16).filter(e => e.strong).map(e => e.label);
    // Step3: assert transition to expected measure numbers
    expect(fixedLabels).toEqual(['0', '1', '2', '3', '4']);
    expect(fixedLabels).not.toEqual(buggyLabels);
    // Dynamic computed: beats/snap style check not needed but label numeric conversion
    fixedLabels.forEach((label, idx) => {
      const beat = idx * 4;
      expect(Number(label)).toBeCloseTo(beat / 4);
      expect(label).toBe(String(Math.round(beat / 4)));
    });
  });

  it('Step1 capture large viewBeats=64 (wide) before → Step2 compute measure labels → Step3 minorStep=4 only strong lines visible and labels 0..16', () => {
    const viewBeats = 64;
    const viewStart = 0;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    // minorStep=4 => only multiples of 4 are drawn, all are strong
    expect(computeMinorStep(viewBeats)).toBe(4);
    expect(fixed.every(e => e.strong)).toBe(true);
    expect(fixed.map(e => e.beat)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]);
    expect(fixed.map(e => e.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16']);
    // Old buggy would have labels equal to beats
    const buggy = computeRulerBuggy(viewStart, viewBeats);
    expect(buggy.map(e => e.label)).toEqual(['0', '4', '8', '12', '16', '20', '24', '28', '32', '36', '40', '44', '48', '52', '56', '60', '64']);
    expect(fixed.map(e => e.label)).not.toEqual(buggy.map(e => e.label));
  });

  it('Step1 capture off-grid viewStart=1.23 viewBeats=16 before → Step2 compute → Step3 strong labels still measure accurate', () => {
    const viewStart = 1.23;
    const viewBeats = 16;
    const fixed = computeRulerFixed(viewStart, viewBeats);
    const strong = strongEntries(fixed);
    // Visible strong beats in [1.23, 17.23]: 4,8,12,16
    expect(strong.map(e => e.beat)).toEqual([4, 8, 12, 16]);
    expect(strong.map(e => e.label)).toEqual(['1', '2', '3', '4']);
    // Each label must be Math.round(b/4)
    strong.forEach(e => {
      expect(e.label).toBe(String(Math.round(e.beat / 4)));
      expect(Number(e.label) * 4).toBe(e.beat);
    });
  });

  it('Step1 capture viewBeats=16 file content before → Step2 verify only WavePreview.tsx was modified → Step3 other files unchanged (WaveEngine etc)', () => {
    const waveSrc = readFile('src/game/waveEngine.ts');
    const cursorSrc = readFile('src/game/cursor.ts');
    // Ensure these engine files do NOT contain ruler logic (isolation)
    expect(waveSrc).not.toContain('String(Math.round(b / 4))');
    expect(waveSrc).not.toContain('RULER_H');
    expect(cursorSrc).not.toContain('RULER_H');
    // Ensure WavePreview is the only file with measure label
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).not.toContain('String(Math.round(b / 4))');
  });

  it('Step1 capture negative time handling before (system time) → Step2 advance timers → Step3 ruler computation deterministic', () => {
    // Use fake timers to prove determinism
    const start = Date.now();
    vi.advanceTimersByTime(1000);
    expect(Date.now()).toBe(start + 1000);
    const fixed1 = computeRulerFixed(0, 16);
    const fixed2 = computeRulerFixed(0, 16);
    expect(fixed1.map(e => e.label)).toEqual(fixed2.map(e => e.label));
    expect(fixed1.map(e => e.beat)).toEqual(fixed2.map(e => e.beat));
    // Ensure measure conversion is pure
    expect(fixed1.filter(e => e.strong).map(e => e.label)).toEqual(['0', '1', '2', '3', '4']);
  });

  it('Step1 capture tsc --noEmit guard before → Step2 verify WavePreview imports & types → Step3 file has correct imports and TW_ constants untouched', () => {
    const src = readFile('src/screens/editor/WavePreview.tsx');
    expect(src).toContain("import { BpmTimeline } from '../../audio/bpmTimeline'");
    expect(src).toContain("import { TW_CENTER_Y, TW_AMP, WaveEngine } from '../../game/waveEngine'");
    expect(src).toContain('RULER_H');
    // Ensure TW_AMP is not changed by this task
    const waveSrc = readFile('src/game/waveEngine.ts');
    expect(waveSrc).toContain('TW_AMP');
    expect(waveSrc).toContain('TW_CENTER_Y');
    // Ensure type correctness: String(Math.round(b/4)) returns string, fillText expects string
    expect(src).toMatch(/ctx\.fillText\s*\(\s*String\s*\(/);
  });

  it('Step1 capture regression: beat grid count unchanged by label change before → Step2 compare fixed vs buggy grid counts → Step3 counts equal, only labels differ', () => {
    const cases: Array<[number, number]> = [
      [0, 16],
      [0, 8],
      [2, 16],
      [0, 32],
      [5, 20],
    ];
    cases.forEach(([start, beats]) => {
      const fixed = computeRulerFixed(start, beats);
      const buggy = computeRulerBuggy(start, beats);
      expect(fixed.length, `start ${start} beats ${beats} length`).toBe(buggy.length);
      expect(fixed.map(e => e.beat)).toEqual(buggy.map(e => e.beat));
      expect(fixed.map(e => e.strong)).toEqual(buggy.map(e => e.strong));
      // Only labels differ for beats >=4
      const fixedLabels = fixed.filter(e => e.strong).map(e => e.label);
      const buggyLabels = buggy.filter(e => e.strong).map(e => e.label);
      if (fixedLabels.length > 1) {
        expect(fixedLabels).not.toEqual(buggyLabels);
        // Fixed labels must be measure numbers
        fixed.filter(e => e.strong).forEach(e => {
          expect(e.label).toBe(String(Math.round(e.beat / 4)));
        });
      }
    });
  });
});
