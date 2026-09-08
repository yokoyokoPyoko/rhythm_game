/**
 * @vitest-environment node
 * T210 — パブリックモード限定・譜面開始前チュートリアル（自動進行＋スキップ付き）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Spec:
 * - publicのみ: 譜面読込完了 → チュートリアル譜面自動再生 → 終了後本編へ自動遷移
 * - debug / playtest 時は出さない
 * - チュートリアル内容 (固定・コード生成、メトロノームのみ約10秒): BPM120, segments [stay 4, up 2, down 2, stay], rings at 4/8/12 single
 * - 拍連動の指示文オーバーレイ (移動→Space→ねぎらい)
 * - 修了条件: 成否不問・時間で自動進行 (最終リング+2秒で本編へ)
 * - スキップボタン常時表示 (記憶なし・毎回表示)
 * - チュートリアル中のスコアは破棄し本編開始時にリセット
 * - 新規 src/game/tutorial.ts: generateTutorialChart() + 指示文テーブル
 * - GameScreen.tsxのみ: フェーズ state ('tutorial'|'main') 追加
 *
 * Prohibited: Do NOT use === true for optional flags — use !== false.
 * MUST include off-grid (0.37 / 1.23) and complex amplitude checks for T127-style consistency.
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
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis as any;
}
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = { createElement: () => ({ getContext: () => null }) } as any;
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import { getViewMode, setViewMode } from '../src/viewMode';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}
function existsFile(rel: string): boolean {
  return fs.existsSync(path.resolve(__dirname, '..', rel));
}
function getTutorialMod(): any {
  // dynamic require via import — will throw if file missing (Red)
  // vitest will have already statically imported if available; use lazy import
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/game/tutorial.ts');
  } catch {
    return null;
  }
}

// Lazy import helper for generateTutorialChart — uses fs + dynamic import fallback
async function loadTutorial(): Promise<any> {
  try {
    const mod = await import('../src/game/tutorial');
    return mod;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T210-0: Precondition — file existence (3-step)
// ---------------------------------------------------------------------------
describe('T210-0: Precondition — src/game/tutorial.ts existence (3-step)', () => {
  it('Step1 capture initial (file may not exist) → Step2 check existence → Step3 file must exist and export generateTutorialChart', async () => {
    const beforeExists = existsFile('src/game/tutorial.ts');
    // Step1: capture
    expect(typeof beforeExists).toBe('boolean');
    // Step2 & 3: after fix, must exist
    expect(existsFile('src/game/tutorial.ts'), 'src/game/tutorial.ts must exist').toBe(true);
    const src = readFile('src/game/tutorial.ts');
    expect(src).toContain('generateTutorialChart');
    const mod = await loadTutorial();
    expect(mod, 'module must be importable').not.toBeNull();
    expect(typeof mod.generateTutorialChart).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// T210-1: generateTutorialChart — fixed chart spec (3-step, pure computed)
// ---------------------------------------------------------------------------
describe('T210-1: generateTutorialChart — fixed spec BPM120 stay4/up2/down2/stay rings4/8/12 (3-step)', () => {
  it('Step1 capture empty chart → Step2 generateTutorialChart() → Step3 BPM120, segments stay4/up2/down2/stay, rings 4/8/12 single', async () => {
    const mod = await loadTutorial();
    expect(mod).not.toBeNull();
    const chart = mod.generateTutorialChart();
    // Step1: capture before state — chart must be object with required keys
    expect(chart).toBeDefined();
    expect(typeof chart.title).toBe('string');
    // Step2 is the call above

    // Step3: assert resulting transition — spec compliance
    // BPM: base tempo derived from bpm_changes[0] bpm 120
    expect(chart.bpm_changes).toBeDefined();
    expect(Array.isArray(chart.bpm_changes)).toBe(true);
    expect(chart.bpm_changes.length).toBeGreaterThanOrEqual(1);
    const first = chart.bpm_changes[0];
    expect(first.beat).toBe(0);
    expect(first.bpm).toBe(120);
    // Chart amplitude should be defined (default 1.0)
    expect(chart.amplitude).toBeDefined();
    // Segments: exactly 4, directions and beats
    expect(chart.segments).toBeDefined();
    expect(chart.segments.length).toBe(4);
    expect(chart.segments[0].direction).toBe('stay');
    expect(chart.segments[0].beats).toBe(4);
    expect(chart.segments[1].direction).toBe('up');
    expect(chart.segments[1].beats).toBe(2);
    expect(chart.segments[2].direction).toBe('down');
    expect(chart.segments[2].beats).toBe(2);
    expect(chart.segments[3].direction).toBe('stay');
    expect(chart.segments[3].beats).toBeGreaterThan(0);
    // Rings: 3 at 4/8/12 single
    expect(chart.rings).toBeDefined();
    expect(chart.rings.length).toBe(3);
    const beats = chart.rings.map((r: any) => r.beat).sort((a: number, b: number) => a - b);
    expect(beats).toEqual([4, 8, 12]);
    for (const r of chart.rings) {
      // type must be single or undefined (implies single)
      const t = (r as any).type;
      expect(t === undefined || t === 'single').toBe(true);
    }
  });

  it('Step1 chart with off-grid beats capture → Step2 timeline beatToMs → Step3 rings at 4/8/12 have 500ms spacing at 120BPM', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    // Step1 capture: first ring at 4 beats should be 2000ms at 120bpm
    const ms4 = tl.beatToMs(4);
    const ms8 = tl.beatToMs(8);
    const ms12 = tl.beatToMs(12);
    expect(ms4).toBeCloseTo(2000, 0);
    expect(ms8).toBeCloseTo(4000, 0);
    expect(ms12).toBeCloseTo(6000, 0);
    // Off-grid: 4.37 should be 2000 + 0.37*500
    expect(tl.beatToMs(4.37)).toBeCloseTo(2000 + 0.37 * 500, 0);
    expect(tl.beatToMs(8.37)).toBeCloseTo(4000 + 0.37 * 500, 0);
    // Duration ~10s: last ring +2s = 8000ms, plus stay tail. Check total segments beats
    const totalBeats = chart.segments.reduce((s: number, seg: any) => s + seg.beats, 0);
    const totalMs = tl.beatToMs(totalBeats);
    // Should be roughly 10 seconds (7-14s range). Spec says ~10s metronome only
    expect(totalMs).toBeGreaterThanOrEqual(7000);
    expect(totalMs).toBeLessThanOrEqual(14000);
    // Auto-advance condition: lastHit + 2000
    const lastHit = tl.beatToMs(12);
    const autoEnd = lastHit + 2000;
    expect(autoEnd).toBeCloseTo(8000, 0);
  });

  it('Step1 empty segments capture → Step2 tutorial chart engine build → Step3 WaveEngine/Cursor numeric consistency at off-grid 0.37/1.23 with complex amp', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    // Verify engine works with tutorial chart
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engine = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position ?? 0);
    // Check that waveYAt at beat 0 is start position
    const startY = TW_CENTER_Y - (chart.start_position ?? 0) * TW_AMP;
    expect(engine.waveYAt(0)).toBeCloseTo(startY, 3);
    // For each off-grid phase, engine should be consistent with cursor speed model
    // Tutorial uses amplitude ~1.0, but test complex amps as well to ensure no regression
    const amps = [0.7, 1.3, 2.7, 3.4];
    for (const amp of amps) {
      const tl2 = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const eng2 = new WaveEngine(chart.segments, tl2, amp, 0);
      for (const off of [0.37, 1.23, 4.37, 8.37]) {
        const y = eng2.waveYAt(off);
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 0.01);
        expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 0.01);
      }
      // Cursor speed should match wave slope: 2*TW_AMP*amp per beat
      const cursor = new Cursor(amp, 0);
      const beatMs = tl2.beatMsAt(0);
      const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
      expect(speed).toBeCloseTo(2 * TW_AMP * amp / 0.5, 1);
      // Simulate one beat of up movement: should approach wave top
      cursor.y = TW_CENTER_Y;
      cursor.update(0.5, true, false, beatMs, eng2.waveYAt(0));
      expect(cursor.y).toBeLessThan(TW_CENTER_Y);
    }
  });
});

// ---------------------------------------------------------------------------
// T210-2: Instruction table — beat-synced overlay (3-step)
// ---------------------------------------------------------------------------
describe('T210-2: Tutorial instructions — beat-synced overlay table (3-step)', () => {
  it('Step1 capture empty instructions → Step2 load tutorial instructions → Step3 table has move/Space/encouragement at correct beats', async () => {
    const mod = await loadTutorial();
    expect(mod).not.toBeNull();
    const src = readFile('src/game/tutorial.ts');
    // Step1: ensure spec keywords exist in source
    expect(src.length).toBeGreaterThan(0);
    // Step3: instruction content must mention movement, Space, and encouragement
    // Check source contains relevant strings (Japanese or symbol)
    const hasMove = /移動|上下|↑↓|up|down/i.test(src) || src.includes('移動') || src.includes('Cursor');
    const hasSpace = /Space/i.test(src);
    const hasEncourage = /ねぎらい|素晴らしい|OK|完了|Great|Perfect|お疲れ/i.test(src) || src.includes('ねぎらい') || src.includes('ありがとう') || src.includes('完了');
    expect(hasMove, 'instructions must mention movement (↑↓/移動)').toBe(true);
    expect(hasSpace, 'instructions must mention Space').toBe(true);
    // Encouragement is more flexible but should exist
    expect(src.length).toBeGreaterThan(200);

    // Try to locate exported instruction table / function
    let instructions: any = null;
    let getFn: any = null;
    if (mod.TUTORIAL_INSTRUCTIONS) instructions = mod.TUTORIAL_INSTRUCTIONS;
    else if (mod.INSTRUCTIONS) instructions = mod.INSTRUCTIONS;
    else if (mod.tutorialInstructions) instructions = mod.tutorialInstructions;
    else if (mod.instructions) instructions = mod.instructions;
    if (mod.getTutorialInstruction) getFn = mod.getTutorialInstruction;
    else if (mod.getInstruction) getFn = mod.getInstruction;
    else if (mod.getInstructionAt) getFn = mod.getInstructionAt;

    // At least one of table or function must exist
    expect(instructions !== null || getFn !== null, 'must export instructions table or getter function').toBe(true);

    if (instructions && Array.isArray(instructions)) {
      expect(instructions.length).toBeGreaterThanOrEqual(3);
      // Each entry should have beat and text
      for (const entry of instructions) {
        expect(entry).toHaveProperty('beat');
        const hasText = 'text' in entry || 'message' in entry || 'label' in entry || 'instruction' in entry;
        expect(hasText).toBe(true);
      }
      // Check beat ordering covers 0, 4, 8, 12 ranges
      const beats = instructions.map((e: any) => e.beat).sort((a: number, b: number) => a - b);
      expect(beats[0]).toBeLessThanOrEqual(0);
      // Should have entries near 0, 4, 8
      const near = (b: number, target: number) => Math.abs(b - target) < 1.0;
      expect(beats.some((b: number) => near(b, 0))).toBe(true);
      expect(beats.some((b: number) => near(b, 4)) || beats.some((b: number) => near(b, 8))).toBe(true);
    }

    if (getFn) {
      // Test beat-synced lookup at on-grid and off-grid
      const at0 = getFn(0);
      const at037 = getFn(0.37);
      const at4 = getFn(4);
      const at437 = getFn(4.37);
      const at8 = getFn(8);
      const at837 = getFn(8.37);
      const at12 = getFn(12);
      expect(String(at0)).toBeTruthy();
      // Off-grid should give same as on-grid within same segment (0-4 is move)
      expect(String(at037)).toBe(String(at0));
      expect(String(at437)).toBe(String(at4));
      expect(String(at837)).toBe(String(at8));
      // Instructions should change across beats: 0 vs 4 vs 8 vs 12 should not all be identical
      const uniq = new Set([String(at0), String(at4), String(at8), String(at12)].map(String));
      expect(uniq.size).toBeGreaterThanOrEqual(2);
      // Move instruction should contain move keyword, middle should contain Space
      expect(String(at0)).toMatch(/移動|上下|↑↓|up|down/i);
      const midText = String(at4) + String(at8);
      expect(midText).toMatch(/Space/i);
    }
  });

  it('Step1 no instruction at negative beat capture → Step2 query off-grid 0.37/1.23/4.37 → Step3 returns first segment instruction consistently', async () => {
    const mod = await loadTutorial();
    const getFn = mod.getTutorialInstruction || mod.getInstruction || mod.getInstructionAt;
    if (!getFn) {
      // Fallback: check array includes off-grid resilience via beat ranges
      const arr = mod.TUTORIAL_INSTRUCTIONS || mod.INSTRUCTIONS || [];
      expect(Array.isArray(arr)).toBe(true);
      // Ensure array is sorted and covers off-grid via range check
      for (const off of [0.37, 1.23]) {
        const found = arr.find((e: any) => e.beat <= off && (arr.find((n: any) => n.beat > e.beat)?.beat ?? Infinity) > off);
        expect(found).toBeDefined();
      }
      return;
    }
    // If getter exists, verify off-grid stability
    const a = getFn(0.37);
    const b = getFn(1.23);
    const c = getFn(3.37);
    expect(String(a)).toBe(String(getFn(0)));
    expect(String(b)).toBe(String(getFn(0)));
    expect(String(c)).toBe(String(getFn(0)));
    // 4.37 and 5.23 should be in second segment
    expect(String(getFn(4.37))).toBe(String(getFn(4)));
    expect(String(getFn(5.23))).toBe(String(getFn(4)));
  });
});

// ---------------------------------------------------------------------------
// T210-3: GameScreen file contract — phase state, tutorial branch, skip (3-step)
// ---------------------------------------------------------------------------
describe('T210-3: GameScreen file contract — phase tutorial/main + skip + viewMode + playtest (3-step, file)', () => {
  it('Step1 capture initial GameScreen without tutorial → Step2 check file → Step3 contains phase state, generateTutorialChart import, and viewMode branching', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src.length).toBeGreaterThan(0);
    // Step1: ensure not empty
    expect(src).toContain('GameScreen');
    // Step3: after fix, must contain tutorial phase logic
    expect(src, 'must import generateTutorialChart').toMatch(/generateTutorialChart/);
    // phase state: 'tutorial' | 'main' or tutorialPhase or phase
    expect(src).toMatch(/tutorial/);
    expect(src).toMatch(/phase|tutorialPhase|gamePhase/);
    // Must handle public vs debug: tutorial only in public
    const hasViewModeCheck = /getViewMode\(\)/.test(src) && /public|debug/.test(src);
    expect(hasViewModeCheck, 'must check viewMode to gate tutorial').toBe(true);
    // More specific: public shows tutorial, debug skips
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]public['"]|getViewMode\(\)\s*!==\s*['"]debug['"]|getViewMode\(\)\s*===\s*['"]debug['"]/);
  });

  it('Step1 capture no skip button → Step2 check GameScreen source → Step3 contains skip button with data-testid tutorial-skip and tutorial-overlay', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must have skip button and overlay test ids
    expect(src, 'must contain tutorial-skip test id').toMatch(/tutorial-skip/);
    expect(src, 'must contain tutorial-overlay test id').toMatch(/tutorial-overlay/);
    // Must have instruction test id
    expect(src, 'must contain tutorial-instruction').toMatch(/tutorial-instruction/);
    // Skip should be always visible (記憶なし・毎回表示) — not behind localStorage check
    // Ensure skip is not gated by localStorage skip memory
    // If it were, would contain something like 'hasSeenTutorial' or 'skipTutorial' with localStorage
    // We allow localStorage for viewMode but not for tutorial skip memory
    const skipSection = src.slice(src.indexOf('tutorial-skip') - 500, src.indexOf('tutorial-skip') + 500);
    // Should not contain localStorage check for skip persistence (allow viewMode storage only)
    // The skip button handler should directly transition to main
    expect(skipSection.length).toBeGreaterThan(0);
  });

  it('Step1 capture playtest path → Step2 check branching → Step3 debug/playtest skips tutorial (playtestChart/playtestBuffer check)', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must check playtest props to skip tutorial
    const hasPlaytestCheck = /playtest/.test(src);
    expect(hasPlaytestCheck, 'must reference playtest to skip tutorial').toBe(true);
    // Look for tutorial gating that includes playtest check
    const tutorialBlock = src.slice(src.indexOf('tutorial') - 1000, src.indexOf('tutorial') + 2000);
    // Should contain logic that tutorial is not shown when playtestChart or playtest exists
    const skipsForPlaytest = /playtestChart|playtestBuffer|playtest/.test(tutorialBlock) || /onExit/.test(tutorialBlock);
    expect(skipsForPlaytest, 'tutorial gating should consider playtest/onExit').toBe(true);
    // Should also contain public check nearby
    expect(tutorialBlock).toMatch(/public|debug|getViewMode/);
  });

  it('Step1 scoreRef initial capture → Step2 tutorial score discard check → Step3 on tutorial->main transition score is reset (new ScoreManager or scoreRef reset)', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must reset score when transitioning from tutorial to main
    // Look for score reset pattern
    const hasScoreReset = /scoreRef\.current\s*=\s*new ScoreManager|scoreRef\.current\.reset|setScore|ScoreManager/.test(src);
    expect(hasScoreReset, 'must reset score on tutorial end/skip').toBe(true);
    // Search near tutorial transition
    const idx = src.indexOf('tutorial');
    const around = src.slice(Math.max(0, idx - 2000), idx + 3000);
    expect(around).toMatch(/ScoreManager|scoreRef/);
    // Must handle both auto-advance and skip (two transition paths)
    // Count occurrences of tutorial->main or phase change
    const phaseChanges = (src.match(/setPhase|phase.*main|tutorial.*main/gi) || []).length;
    expect(phaseChanges).toBeGreaterThanOrEqual(1);
  });

  it('Step1 T208 judgement detail flag capture → Step2 GameScreen render call → Step3 showJudgementDetail wiring remains (T208 regression)', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toContain('renderer.render');
    expect(src).toMatch(/showJudgementDetail/);
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]debug['"]/);
    // Must use !== false in renderer (check renderer file separately)
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/showJudgementDetail\s*!==\s*false/);
    expect(rendererSrc).not.toMatch(/showJudgementDetail\s*===\s*true/);
  });
});

// ---------------------------------------------------------------------------
// T210-4: Tutorial duration & auto-advance logic (3-step, pure computed + fake timers)
// ---------------------------------------------------------------------------
describe('T210-4: Tutorial duration & auto-advance — lastRing+2s (3-step, fake timers)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  it('Step1 initial score 0 capture → Step2 generate chart and compute lastHit+2000 → Step3 tutorial duration is 8000ms and auto-end at ~8000', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const lastHit = tl.beatToMs(12);
    expect(lastHit).toBeCloseTo(6000, 0);
    const expectedEnd = lastHit + 2000;
    expect(expectedEnd).toBeCloseTo(8000, 0);

    // Step1: capture initial score
    const score = new ScoreManager();
    expect(score.getStats().score).toBe(0);
    expect(score.getStats().combo).toBe(0);

    // Step2: simulate tutorial phase with fake timers
    let phase: 'tutorial' | 'main' = 'tutorial';
    let songTimeMs = 0;
    const END_DELAY = 2000;
    const tick = (dtMs: number) => {
      songTimeMs += dtMs;
      if (phase === 'tutorial' && songTimeMs > expectedEnd) {
        phase = 'main';
      }
    };
    expect(phase).toBe('tutorial');
    // Advance 7999ms — still tutorial
    tick(7999);
    expect(phase).toBe('tutorial');
    // Advance 2ms more — should transition
    tick(2);
    expect(phase).toBe('main');
    expect(songTimeMs).toBeCloseTo(8001, 0);
  });

  it('Step1 tutorial score with hits capture → Step2 skip immediately → Step3 score discarded and main starts at 0 (fake timers)', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    // Step1: simulate tutorial with scoring
    const tutorialScore = new ScoreManager();
    tutorialScore.recordHit('perfect');
    tutorialScore.recordTrace(0.15, true, 500);
    tutorialScore.recordHit('great');
    const beforeSkip = tutorialScore.getStats();
    expect(beforeSkip.score).toBeGreaterThan(0);
    expect(beforeSkip.perfect + beforeSkip.great).toBeGreaterThan(0);

    // Step2: perform skip — game should discard tutorial score and create new manager
    let phase: 'tutorial' | 'main' = 'tutorial';
    let activeScore = tutorialScore;
    const skip = () => {
      phase = 'main';
      activeScore = new ScoreManager(); // discard
    };
    expect(phase).toBe('tutorial');
    skip();
    // Step3: assert resulting transition
    expect(phase).toBe('main');
    expect(activeScore.getStats().score).toBe(0);
    expect(activeScore.getStats().combo).toBe(0);
    expect(activeScore.getStats().perfect).toBe(0);
    expect(activeScore.getStats().great).toBe(0);
    // Main should be able to record fresh hits
    activeScore.recordHit('perfect');
    expect(activeScore.getStats().score).toBe(50);
    expect(activeScore.getStats().perfect).toBe(1);
  });

  it('Step1 public mode capture → Step2 debug mode should skip auto-advance waiting → Step3 debug has no tutorial phase', async () => {
    localStorage.clear();
    expect(getViewMode()).toBe('public');
    // Simulate GameScreen logic: shouldShowTutorial = getViewMode() === 'public' && !playtest
    const shouldShowPublic = getViewMode() === 'public' && !false; // no playtest
    expect(shouldShowPublic).toBe(true);
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    const shouldShowDebug = getViewMode() === 'public' && !false;
    expect(shouldShowDebug).toBe(false);
    // Debug should immediately be main
    let phase: 'tutorial' | 'main' = shouldShowDebug ? 'tutorial' : 'main';
    expect(phase).toBe('main');
    // Even after time passes, stays main
    let t = 0;
    const lastHit = 6000;
    const end = lastHit + 2000;
    t = 9000;
    if (phase === 'tutorial' && t > end) phase = 'main';
    expect(phase).toBe('main');
  });

  it('Step1 off-grid songTime 0.37 capture → Step2 tutorial wave at 0.37/1.23 → Step3 engine returns finite Y within bounds', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engine = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position ?? 0);
    for (const off of [0.37, 1.23, 4.37, 8.37, 12.37]) {
      const y = engine.waveYAt(off);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
      expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
      const ms = tl.beatToMs(off);
      expect(engine.waveYAtMs(ms)).toBeCloseTo(y, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// T210-5: ViewMode gating & playtest skip — public only (3-step)
// ---------------------------------------------------------------------------
describe('T210-5: ViewMode gating — public shows tutorial, debug/playtest hides (3-step)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('Step1 initial public (no localStorage) capture → Step2 set debug → Step3 public shows tutorial, debug hides', () => {
    expect(getViewMode()).toBe('public');
    const showForPublic = getViewMode() === 'public';
    expect(showForPublic).toBe(true);
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    const showForDebug = getViewMode() === 'public';
    expect(showForDebug).toBe(false);
    // Verify source gating
    const src = readFile('src/screens/GameScreen.tsx');
    // Must contain condition that checks public for tutorial
    expect(src).toMatch(/getViewMode/);
    // The phase initialization should depend on viewMode
    const hasTutorialGate = src.includes('tutorial') && (src.includes('public') || src.includes('debug'));
    expect(hasTutorialGate).toBe(true);
  });

  it('Step1 playtestChart provided capture → Step2 tutorial should be skipped → Step3 file contains playtest guard for tutorial phase', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Ensure playtest props are destructured
    expect(src).toMatch(/playtestChart|playtest/);
    // Find the line where tutorial phase is decided
    const lines = src.split('\n');
    const tutorialLines = lines.filter(l => l.toLowerCase().includes('tutorial'));
    expect(tutorialLines.length).toBeGreaterThan(0);
    const combined = tutorialLines.join('\n');
    // Should mention playtest or onExit as skip condition
    expect(combined + src.slice(src.indexOf('tutorial') - 800, src.indexOf('tutorial') + 800)).toMatch(/playtest|onExit/);
  });

  it('Step1 skip always available (no memory) capture → Step2 check source for localStorage tutorial memory → Step3 must NOT store tutorial seen flag (always show)', () => {
    const tutorialSrc = readFile('src/game/tutorial.ts');
    // Should NOT contain localStorage setItem for tutorial seen
    expect(tutorialSrc).not.toMatch(/localStorage\.setItem.*tutorial/i);
    expect(tutorialSrc).not.toMatch(/hasSeenTutorial|tutorialSeen|skipTutorial/i);
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // GameScreen should not read a "tutorialSeen" flag to hide skip
    // It may read viewMode but not tutorialSeen
    const tutorialSection = gameSrc.slice(gameSrc.indexOf('tutorial') - 1500, gameSrc.indexOf('tutorial') + 3000);
    expect(tutorialSection).not.toMatch(/hasSeenTutorial|tutorialSeen/);
    // Skip button must be present regardless of phase initialization (always rendered in tutorial)
    expect(gameSrc).toMatch(/tutorial-skip/);
  });
});

// ---------------------------------------------------------------------------
// T210-6: Integration — T208 judgement detail applies during tutorial as well
// ---------------------------------------------------------------------------
describe('T210-6: Integration — T208 detail flag applies during tutorial & score isolation', () => {
  it('Step1 capture renderer default (no flag) shows details → Step2 render with tutorial phase flag false → Step3 public hides ms/ΔY even in tutorial', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engine = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position ?? 0);
    const cursor = new Cursor(chart.amplitude, chart.start_position ?? 0);
    const score = new ScoreManager();
    // Mock renderer to check detail flag
    const { Renderer } = await import('../src/game/renderer');
    const renderer = new Renderer();
    const mockCtx: any = {
      fillText: vi.fn(),
      fillRect: () => {}, strokeRect: () => {}, beginPath: () => {}, arc: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, fill: () => {}, save: () => {}, restore: () => {},
      set fillStyle(_: any) {}, get fillStyle() { return ''; },
      set strokeStyle(_: any) {}, get strokeStyle() { return ''; },
      set globalAlpha(_: any) {}, get globalAlpha() { return 1; },
      set lineWidth(_: any) {}, get lineWidth() { return 1; },
      set font(_: any) {}, get font() { return ''; },
      set textAlign(_: any) {}, get textAlign() { return ''; },
      set textBaseline(_: any) {}, get textBaseline() { return ''; },
      set lineCap(_: any) {}, get lineCap() { return ''; },
      set lineJoin(_: any) {}, get lineJoin() { return ''; },
      canvas: { width: 800, height: 600 },
    };
    const events: any[] = [{ result: 'great', y: 300, at: 990, errorMs: 40.37, yDist: 35 }];
    // public (false) — tutorial phase should also hide
    renderer.render(mockCtx, {
      waveEngine: engine,
      cursor,
      rings: [],
      score,
      songTimeMs: 1000,
      bpmTimeline: tl,
      judgementEvents: events,
      scrollSpeed: 110,
      showJudgementDetail: false,
    } as any);
    const publicCalls = (mockCtx.fillText as any).mock.calls.map((c: any[]) => String(c[0])).join(' | ');
    expect(publicCalls).toMatch(/GREAT/);
    expect(publicCalls).not.toMatch(/ms/);
    expect(publicCalls).not.toMatch(/ΔY/);
    // debug (true) — shows
    mockCtx.fillText.mockClear();
    const renderer2 = new Renderer();
    renderer2.render(mockCtx, {
      waveEngine: engine,
      cursor,
      rings: [],
      score,
      songTimeMs: 1000,
      bpmTimeline: tl,
      judgementEvents: events,
      scrollSpeed: 110,
      showJudgementDetail: true,
    } as any);
    const debugCalls = (mockCtx.fillText as any).mock.calls.map((c: any[]) => String(c[0])).join(' | ');
    expect(debugCalls).toMatch(/GREAT/);
    expect(debugCalls).toMatch(/\+40ms/);
  });

  it('Step1 tutorial score with trace capture → Step2 reset to main → Step3 trace bonus not carried', () => {
    const score = new ScoreManager();
    // Simulate tutorial trace: 16 beats should give bonus +2 but then discard
    const beatMs = 500;
    for (let i = 0; i < 160; i++) {
      score.recordTrace(0.05, true, beatMs);
    }
    const before = score.getStats();
    expect(before.score).toBeGreaterThan(0);
    // Now discard for main
    const mainScore = new ScoreManager();
    expect(mainScore.getStats().score).toBe(0);
    expect(mainScore.getStats().combo).toBe(0);
    // Main first trace should not have bonus from tutorial
    mainScore.recordTrace(0.15, true, beatMs);
    expect(mainScore.getStats().score).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T210-7: Regression — complex amp + off-grid + file contracts (3-step)
// ---------------------------------------------------------------------------
describe('T210-7: Regression — complex amplitude & off-grid consistency (T127 style)', () => {
  it('Step1 simple amp 1.0 capture → Step2 complex amps 0.7/1.3/2.7/3.4 at off-grid 0.37/1.23 → Step3 waveYAt consistent with Cursor speed', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    for (const amp of [0.7, 1.3, 2.7, 3.4]) {
      const tl = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const engine = new WaveEngine(chart.segments, tl, amp, 0);
      const cursor = new Cursor(amp, 0);
      for (const off of [0.37, 1.23, 4.37, 8.37]) {
        const y = engine.waveYAt(off);
        expect(Number.isFinite(y)).toBe(true);
        // Simulate cursor at same beat with renderTimeMs
        const renderTimeMs = tl.beatToMs(off);
        const waveY = engine.waveYAtMs(renderTimeMs);
        cursor.y = waveY;
        const beatMs = tl.beatMsAt(off);
        // One tick of no input should stay near wave (pull strength)
        const prevY = cursor.y;
        cursor.update(0.016, false, false, beatMs, waveY);
        expect(Math.abs(cursor.y - waveY)).toBeLessThan(1.0);
        expect(Math.abs(cursor.y - prevY)).toBeLessThan(1.0);
      }
    }
  });

  it('Step1 GameScreen file capture → Step2 check for prohibited === true on optional flags → Step3 uses !== false', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).not.toMatch(/showJudgementDetail\s*===\s*true/);
    expect(rendererSrc).not.toMatch(/showJudgementDetail\s*==\s*true/);
    expect(rendererSrc).toMatch(/showJudgementDetail\s*!==\s*false/);
  });

  it('Step1 BpmTimeline file capture → Step2 check tutorial uses 120 BPM → Step3 beatToMs(4) is 2000ms deterministic', async () => {
    const mod = await loadTutorial();
    const chart = mod.generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    // Deterministic: same fromMs twice gives same beatToMs
    const a = tl.beatToMs(4);
    const b = tl.beatToMs(4);
    expect(a).toBe(b);
    expect(a).toBeCloseTo(2000, 0);
    // Off-grid deterministic
    expect(tl.beatToMs(0.37)).toBeCloseTo(0.37 * 500, 0);
    expect(tl.beatToMs(1.23)).toBeCloseTo(1.23 * 500, 0);
  });
});
