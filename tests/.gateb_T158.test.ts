/**
 * @vitest-environment node
 * T158 コンボ／ボーナス分離＋新得点（トレース・リング・コンボ切れの再定義） - Vitest node acceptance test
 * RED phase: expects ScoreManager with PERFECT 100, GOOD 30, TRACE_BASE 2, comboBonus/traceBeats/offBeats, recordTrace(dt,isOnWave,beatMs)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.useFakeTimers();

import { ScoreManager } from '../src/game/score';

const BEAT_MS_120 = 500; // 120 BPM = 500ms per beat
const BEAT_MS_180 = 333.333333;
const TRACE_INTERVAL = 0.15;
const EPS = 1e-6;

function scoreFrom(manager: ScoreManager): number { return manager.getStats().score; }
function comboFrom(manager: ScoreManager): number { return manager.getStats().combo; }
function getBonus(manager: ScoreManager): number {
  const anyM = manager as unknown as Record<string, unknown>;
  if ('comboBonus' in anyM) return anyM['comboBonus'] as number;
  if ('bonus' in anyM) return anyM['bonus'] as number;
  if ('comboAdd' in anyM) return anyM['comboAdd'] as number;
  // fallback: infer from score delta if not exposed – return NaN to force structural failure
  return NaN;
}
function getTraceBeats(manager: ScoreManager): number | undefined {
  const anyM = manager as unknown as Record<string, unknown>;
  if ('traceBeats' in anyM) return anyM['traceBeats'] as number;
  return undefined;
}
function getOffBeats(manager: ScoreManager): number | undefined {
  const anyM = manager as unknown as Record<string, unknown>;
  if ('offBeats' in anyM) return anyM['offBeats'] as number;
  if ('offWaveBeats' in anyM) return anyM['offWaveBeats'] as number;
  return undefined;
}

// ================================================================
// 1. Source structure: constants and new fields
// ================================================================
describe('T158 source structure: score.ts constants and new fields', () => {
  const srcPath = path.join(process.cwd(), 'src/game/score.ts');
  const src = fs.readFileSync(srcPath, 'utf-8');

  it('PERFECT_SCORE must be 100 (300→100)', () => {
    // [Step1] capture initial file content
    expect(src.length).toBeGreaterThan(200);
    // [Step2] check constant definition
    const has100 = /PERFECT_SCORE\s*=\s*100\b/.test(src) || /PERFECT[^0-9]*100/.test(src);
    expect(has100, 'PERFECT_SCORE should be 100, not 300. Found: ' + src.slice(src.indexOf('PERFECT'), src.indexOf('PERFECT')+80)).toBe(true);
    // [Step3] ensure old value 300 is not used as PERFECT_SCORE
    const oldPerfect = /PERFECT_SCORE\s*=\s*300/.test(src);
    expect(oldPerfect, 'old PERFECT_SCORE=300 must be replaced with 100').toBe(false);
  });

  it('GOOD_SCORE must be 30 (100→30)', () => {
    const has30 = /GOOD_SCORE\s*=\s*30\b/.test(src);
    expect(has30, 'GOOD_SCORE should be 30').toBe(true);
    const oldGood = /GOOD_SCORE\s*=\s*100\b/.test(src);
    expect(oldGood, 'old GOOD_SCORE=100 must be replaced').toBe(false);
  });

  it('TRACE_BASE_SCORE must be 2 (8→2)', () => {
    const has2 = /TRACE_BASE_SCORE\s*=\s*2\b/.test(src) || /TRACE_BASE[^=]*=\s*2\b/.test(src);
    expect(has2, 'TRACE_BASE_SCORE should be 2').toBe(true);
    const oldTrace8 = /TRACE_BASE_SCORE\s*=\s*8\b/.test(src);
    expect(oldTrace8, 'old TRACE_BASE_SCORE=8 must be replaced').toBe(false);
  });

  it('must introduce new fields comboBonus / traceBeats / offBeats', () => {
    expect(src, 'must declare comboBonus').toMatch(/comboBonus/);
    expect(src, 'must declare traceBeats').toMatch(/traceBeats/);
    expect(src, 'must declare offBeats').toMatch(/offBeats/);
  });

  it('recordTrace signature must have third argument beatMs', () => {
    expect(src, 'recordTrace must accept 3 args (dt, isOnWave, beatMs)').toMatch(/recordTrace\s*\(\s*dt[^,]*,\s*isOnWave[^,]*,\s*beatMs/);
    // beat conversion must use dt*1000/beatMs
    expect(src, 'must convert dt to beats via dt*1000/beatMs or dt/beatMs*1000').toMatch(/1000\s*\/\s*beatMs|beatMs.*1000|dt\s*\*\s*1000/);
  });

  it('GameScreen.tsx and CalibrationModal must pass beatMs as third arg', () => {
    const gsPath = path.join(process.cwd(), 'src/screens/GameScreen.tsx');
    const gsSrc = fs.readFileSync(gsPath, 'utf-8');
    expect(gsSrc, 'GameScreen must call recordTrace with 3 args').toMatch(/recordTrace\s*\(.*currentBeatMs|recordTrace\s*\(.*beatMs/);
    const calPathCandidates = [
      path.join(process.cwd(), 'src/screens/editor/CalibrationModal.tsx'),
      path.join(process.cwd(), 'src/screens/CalibrationScreen.tsx'),
      path.join(process.cwd(), 'src/screens/editor/CalibrationOverlay.tsx'),
    ];
    const existingCal = calPathCandidates.find(p => fs.existsSync(p));
    expect(existingCal, 'Calibration modal/overlay file must exist').toBeDefined();
    const calSrc = fs.readFileSync(existingCal!, 'utf-8');
    expect(calSrc, 'Calibration must call recordTrace with 3 args').toMatch(/recordTrace\s*\(.*currentBeatMs|recordTrace\s*\(.*beatMs/);
  });
});

// ================================================================
// 2. Hit scoring: PERFECT +100/+1 bonus unchanged, GOOD +30/+1, MISS resets both
// ================================================================
describe('T158 hit scoring: PERFECT/GOOD/MISS with combo and bonus separation', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.clearAllTimers(); });

  it('PERFECT: score+100, combo+1, bonus unchanged (3-step)', () => {
    // [Step1] capture initial state: fresh manager with no bonus
    const m = new ScoreManager();
    // accrue bonus artificially via 16 beats trace so we can test invariance
    const beatMs = BEAT_MS_120;
    // generate bonus 2 by tracing 16 beats
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // 54*0.3=16.2 beats -> bonus 2
    const bonusBefore = getBonus(m);
    expect(bonusBefore, 'bonus should be 2 after 16 beats').toBe(2);
    const scoreBefore = scoreFrom(m);
    const comboBefore = comboFrom(m);
    expect(comboBefore).toBe(0); // trace must not affect combo
    // [Step2] perform PERFECT hit
    m.recordHit('perfect');
    // [Step3] assert transition
    const afterScore = scoreFrom(m);
    const afterCombo = comboFrom(m);
    const afterBonus = getBonus(m);
    expect(afterScore - scoreBefore).toBe(100);
    expect(afterCombo).toBe(comboBefore + 1);
    expect(afterBonus).toBe(bonusBefore);
    //perfect count
    expect(m.getStats().perfect).toBe(1);
  });

  it('GOOD: score+30, combo+1, bonus unchanged (3-step)', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    const bonusBefore = getBonus(m);
    expect(bonusBefore).toBe(2);
    const scoreBefore = scoreFrom(m);
    const comboBefore = comboFrom(m);
    // [Step2] GOOD hit
    m.recordHit('good');
    // [Step3]
    expect(scoreFrom(m) - scoreBefore).toBe(30);
    expect(comboFrom(m)).toBe(comboBefore + 1);
    expect(getBonus(m)).toBe(bonusBefore);
    expect(m.getStats().good).toBe(1);
  });

  it('MISS: score+0, combo→0 and bonus→0 (3-step)', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(2);
    m.recordHit('perfect'); // combo 1
    m.recordHit('good'); // combo 2
    const scoreBeforeMiss = scoreFrom(m);
    const comboBeforeMiss = comboFrom(m);
    expect(comboBeforeMiss).toBe(2);
    // [Step2] miss
    m.recordHit('miss');
    // [Step3]
    expect(scoreFrom(m)).toBe(scoreBeforeMiss); // no score
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
    expect(m.getStats().miss).toBe(1);
  });

  it('fresh manager PERFECT adds exactly 100 (old 300 must fail)', () => {
    const m = new ScoreManager();
    const before = scoreFrom(m);
    m.recordHit('perfect');
    expect(scoreFrom(m) - before).toBe(100);
  });

  it('fresh manager GOOD adds exactly 30 (old 100 must fail)', () => {
    const m = new ScoreManager();
    const before = scoreFrom(m);
    m.recordHit('good');
    expect(scoreFrom(m) - before).toBe(30);
  });

  it('multiple PERFECT/GOOD accumulate correctly without affecting bonus', () => {
    const m = new ScoreManager();
    // [Step1] initial
    expect(scoreFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
    // [Step2] sequence perfect, good, perfect
    m.recordHit('perfect'); // +100
    m.recordHit('good'); // +30
    m.recordHit('perfect'); // +100
    // [Step3] total 230, combo 3, bonus still 0
    expect(scoreFrom(m)).toBe(230);
    expect(comboFrom(m)).toBe(3);
    expect(getBonus(m)).toBe(0);
    expect(m.getStats().maxCombo).toBe(3);
  });
});

// ================================================================
// 3. Trace tick: score 2+bonus, combo unchanged
// ================================================================
describe('T158 trace tick: score 2+bonus, combo unchanged', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.clearAllTimers(); });

  it('single tick adds 2 when bonus 0 and does not change combo', () => {
    // [Step1] fresh, bonus 0
    const m = new ScoreManager();
    expect(getBonus(m)).toBe(0);
    const scoreBefore = scoreFrom(m);
    const comboBefore = comboFrom(m);
    // [Step2] one tick
    m.recordTrace(TRACE_INTERVAL, true, BEAT_MS_120);
    // [Step3] score +2, combo unchanged
    expect(scoreFrom(m) - scoreBefore).toBe(2);
    expect(comboFrom(m)).toBe(comboBefore);
  });

  it('tick with bonus 2 adds 4, combo still unchanged', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // [Step1] accumulate bonus to 2 via 16 beats
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(2);
    const beforeScore = scoreFrom(m);
    const beforeCombo = comboFrom(m);
    // [Step2] next tick
    m.recordTrace(TRACE_INTERVAL, true, beatMs);
    // [Step3] should be 2+2=4
    expect(scoreFrom(m) - beforeScore).toBe(4);
    expect(comboFrom(m)).toBe(beforeCombo);
  });

  it('accumulating dt smaller than TRACE_INTERVAL does not score until threshold', () => {
    const m = new ScoreManager();
    // [Step1] dt=0.07 twice
    m.recordTrace(0.07, true, BEAT_MS_120);
    expect(scoreFrom(m)).toBe(0);
    expect(comboFrom(m)).toBe(0);
    // [Step2] second 0.07 -> total 0.14 still <0.15
    m.recordTrace(0.07, true, BEAT_MS_120);
    expect(scoreFrom(m)).toBe(0);
    // [Step3] third 0.07 -> total 0.21 crosses 0.15 once
    m.recordTrace(0.07, true, BEAT_MS_120);
    expect(scoreFrom(m)).toBe(2);
    expect(comboFrom(m)).toBe(0); // combo must remain 0
  });

  it('old implementation increments combo on trace -> must fail (combo unchanged)', () => {
    const m = new ScoreManager();
    const beforeCombo = comboFrom(m);
    m.recordTrace(TRACE_INTERVAL, true, BEAT_MS_120);
    // old code would have combo 1 here
    expect(comboFrom(m), 'trace must NOT increment combo').toBe(beforeCombo);
  });

  it('trace tick score before bonus vs after bonus differs', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // first 53 ticks still bonus 0? Let's compute: 53*0.3=15.9 beats (<16) so bonus still 0
    for (let i = 0; i < 53; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(0);
    const sBefore = scoreFrom(m);
    m.recordTrace(TRACE_INTERVAL, true, beatMs); // 54th tick crosses 16 beats -> bonus becomes 2, but this tick's score was with old bonus 0 or new?
    // Need to determine order: traceTick score uses current bonus before increment? Spec says tick adds 2+bonus, and bonus increments separately after 16 beats.
    // Implementation likely increments bonus after adding score for the tick that crosses threshold, or before next tick.
    // We test that bonus becomes 2 and next tick uses 4.
    expect(getBonus(m)).toBe(2);
    // The crossing tick's score: could be 2 or 4 depending on order; we assert next tick is 4
    const sAfterCross = scoreFrom(m);
    const deltaCross = sAfterCross - sBefore;
    expect([2,4].includes(deltaCross), 'crossing tick delta 2 or 4').toBe(true);
    const nBefore = scoreFrom(m);
    m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(scoreFrom(m) - nBefore).toBe(4);
  });
});

// ================================================================
// 4. Continuous trace 16 beats -> bonus +2 with remainder carry
// ================================================================
describe('T158 continuous trace 16 beats: bonus +2 with remainder carry, combo unchanged', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.clearAllTimers(); });

  it('16 beats of on-wave tracing increments bonus by 2, combo unchanged', () => {
    // [Step1] fresh
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    expect(getBonus(m)).toBe(0);
    expect(comboFrom(m)).toBe(0);
    // [Step2] simulate 16 beats via repeated TRACE_INTERVAL ticks (each 0.3 beats at 120 BPM)
    // Need ceil to exceed 16: 54 ticks =16.2 beats
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    // [Step3] bonus +2, combo still 0
    expect(getBonus(m)).toBe(2);
    expect(comboFrom(m)).toBe(0);
    // traceBeats remainder 0.2 should remain
    const tb = getTraceBeats(m);
    if (tb !== undefined) {
      expect(tb).toBeCloseTo(0.2, 1);
    }
  });

  it('32 beats (two thresholds) bonus +4 with remainder', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    for (let i = 0; i < 107; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // 107*0.3=32.1 beats
    // [Step1] after 32.1 beats, two bonuses
    expect(getBonus(m)).toBe(4);
    expect(comboFrom(m)).toBe(0);
    const tb = getTraceBeats(m);
    if (tb !== undefined) expect(tb).toBeCloseTo(0.1, 1); // 32.1-32=0.1
  });

  it('fractional off-grid dt still correctly counts beats (off-grid principle)', () => {
    // Use dt that is not multiple of TRACE_INTERVAL or snapshot
    // e.g., dt=0.07 (0.14 beats at 120 BPM) and 0.11, etc.
    const m = new ScoreManager();
    const beatMs = 400; // 150 BPM -> 0.15s =0.375 beats
    // [Step1] initial bonus 0
    expect(getBonus(m)).toBe(0);
    // [Step2] accumulate 16 beats via irregular dts
    let totalBeats = 0;
    while (totalBeats < 16.2) {
      const dt = 0.07 + (totalBeats % 0.05); // varying off-grid
      m.recordTrace(dt, true, beatMs);
      totalBeats += dt * 1000 / beatMs;
    }
    // [Step3] at least one bonus
    expect(getBonus(m)).toBeGreaterThanOrEqual(2);
    expect(comboFrom(m)).toBe(0);
  });

  it('off-wave resets traceBeats progress (short off <3 beats discards progress)', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // [Step1] accumulate 15 beats short of threshold (50 ticks =15 beats)
    for (let i = 0; i < 50; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); //15 beats
    expect(getBonus(m)).toBe(0);
    // verify traceBeats ~15
    const beforeOffBeats = getTraceBeats(m);
    if (beforeOffBeats !== undefined) expect(beforeOffBeats).toBeCloseTo(15, 0);
    // [Step2] go off-wave for 2 beats ( <3 ) -> should reset traceBeats but not bonus/combo
    for (let i = 0; i < 7; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs); // 7*0.3=2.1 beats off
    expect(getBonus(m)).toBe(0); // still 0, not reset (bonus was 0) but check combo
    expect(comboFrom(m)).toBe(0);
    const afterOffTrace = getTraceBeats(m);
    if (afterOffTrace !== undefined) expect(afterOffTrace).toBe(0);
    // [Step3] need fresh 16 beats to get bonus (not 1 beat)
    for (let i = 0; i < 4; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // only 1.2 beats
    expect(getBonus(m)).toBe(0); // should still be 0 because progress reset
    // now fill full 16 beats
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(2);
  });

  it('beatMs scaling: same dt at different BPM gives different beat thresholds', () => {
    // [Step1] two managers, same dt sequence but different beatMs
    const mSlow = new ScoreManager(); // beatMs 500 -> 0.3 beats per tick
    const mFast = new ScoreManager(); // beatMs 250 -> 0.6 beats per tick
    const beatSlow = 500;
    const beatFast = 250;
    // 30 ticks: slow 9 beats, fast 18 beats
    for (let i = 0; i < 30; i++) {
      mSlow.recordTrace(TRACE_INTERVAL, true, beatSlow);
      mFast.recordTrace(TRACE_INTERVAL, true, beatFast);
    }
    // [Step3] fast should have crossed 16 beats (bonus 2), slow not yet
    expect(getBonus(mSlow)).toBe(0);
    expect(getBonus(mFast)).toBe(2);
    // both combos unchanged
    expect(comboFrom(mSlow)).toBe(0);
    expect(comboFrom(mFast)).toBe(0);
  });
});

// ================================================================
// 5. Off-wave 3 beats continuous resets combo+bonus; <3 beats no reset
// ================================================================
describe('T158 off-wave 3 beats continuous resets combo and bonus', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.clearAllTimers(); });

  it('off-wave <3 beats does NOT reset combo/bonus', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // [Step1] build combo via hits and bonus via trace
    m.recordHit('perfect'); // combo 1
    m.recordHit('perfect'); // combo 2
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // bonus 2
    expect(comboFrom(m)).toBe(2);
    expect(getBonus(m)).toBe(2);
    // [Step2] off for 2.4 beats (8 ticks *0.3=2.4)
    for (let i = 0; i < 8; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs);
    // [Step3] still unchanged (threshold 3 not reached)
    expect(comboFrom(m)).toBe(2);
    expect(getBonus(m)).toBe(2);
  });

  it('off-wave 3 beats exactly resets combo and bonus to 0', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    m.recordHit('perfect'); // combo 1
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // bonus 2, combo still 1
    expect(comboFrom(m)).toBe(1);
    expect(getBonus(m)).toBe(2);
    // [Step1] capture before
    const scoreBefore = scoreFrom(m);
    // [Step2] off for 3 beats = 10 ticks (10*0.3=3.0)
    for (let i = 0; i < 10; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs);
    // [Step3] both reset
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
    expect(scoreFrom(m)).toBe(scoreBefore); // off-wave no score increase
  });

  it('off-wave >3 beats also resets and stays 0', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    m.recordHit('perfect');
    m.recordHit('good');
    expect(comboFrom(m)).toBe(2);
    expect(getBonus(m)).toBe(2);
    for (let i = 0; i < 20; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs); // 6 beats
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
  });

  it('off-wave interrupted (<3) then back on-wave resets offBeats counter', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    m.recordHit('perfect'); // combo 1
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // bonus 2
    // [Step1] off 2 beats
    for (let i = 0; i < 7; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs); // 2.1 beats
    expect(comboFrom(m)).toBe(1);
    // [Step2] back on-wave for one tick -> offBeats should reset to 0
    m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(comboFrom(m)).toBe(1);
    expect(getBonus(m)).toBe(2);
    // [Step3] off again 2.1 beats should still not reset (since counter restarted)
    for (let i = 0; i < 7; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs);
    expect(comboFrom(m)).toBe(1);
    expect(getBonus(m)).toBe(2);
    // now off 3 beats continuous -> reset
    for (let i = 0; i < 10; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs);
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
  });

  it('off-wave via irregular dt (off-grid 0.37/1.23 style) still thresholds at 3 beats', () => {
    const m = new ScoreManager();
    const beatMs = 400; // 150 BPM
    m.recordHit('perfect');
    for (let i = 0; i < 50; i++) m.recordTrace(0.15, true, beatMs);
    expect(comboFrom(m)).toBe(1);
    const bonusMid = getBonus(m);
    // off with dt 0.07 and 0.11 alternating -> 0.07*1000/400=0.175 beats, 0.11=0.275 etc
    let offBeats = 0;
    let ticks = 0;
    while (offBeats < 2.8) {
      const dt = ticks % 2 === 0 ? 0.07 : 0.11;
      const beforeCombo = comboFrom(m);
      m.recordTrace(dt, false, beatMs);
      offBeats += dt * 1000 / beatMs;
      expect(comboFrom(m)).toBe(beforeCombo); // not yet reset
      ticks++;
    }
    // push over threshold
    let extra = 0;
    while (extra < 0.5) {
      const dt = 0.15;
      m.recordTrace(dt, false, beatMs);
      extra += dt * 1000 / beatMs;
    }
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
    void bonusMid;
  });
});

// ================================================================
// 6. Integration: trace and hit interleaving, bonus carry, miss resets
// ================================================================
describe('T158 integration: trace/hit interleaving and bonus persistence', () => {
  beforeEach(() => { vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { vi.clearAllTimers(); });

  it('combo increases only on hits, not on trace; bonus only on trace, not on hits', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // [Step1] initial
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
    // [Step2] 10 trace ticks -> combo 0, bonus 0 (9 beats not enough)
    for (let i = 0; i < 30; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // 9 beats
    expect(comboFrom(m)).toBe(0);
    expect(getBonus(m)).toBe(0);
    const scoreAfterTrace = scoreFrom(m);
    expect(scoreAfterTrace).toBe(30 * 2); // 60
    // hit perfect -> combo 1, bonus still 0, score +100
    m.recordHit('perfect');
    expect(comboFrom(m)).toBe(1);
    expect(getBonus(m)).toBe(0);
    expect(scoreFrom(m)).toBe(scoreAfterTrace + 100);
    // more trace to reach 16 beats total -> need 7 more beats -> 24 ticks (7.2 beats) total 16.2
    for (let i = 0; i < 24; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(2);
    expect(comboFrom(m)).toBe(1); // still 1
    // good hit -> combo 2, bonus unchanged 2
    const beforeGoodScore = scoreFrom(m);
    m.recordHit('good');
    expect(comboFrom(m)).toBe(2);
    expect(getBonus(m)).toBe(2);
    expect(scoreFrom(m) - beforeGoodScore).toBe(30);
  });

  it('miss resets both combo and bonus regardless of prior trace progress', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // bonus 2
    m.recordHit('perfect'); // combo1
    m.recordHit('perfect'); // combo2
    expect(getBonus(m)).toBe(2);
    expect(comboFrom(m)).toBe(2);
    // [Step2] miss
    m.recordHit('miss');
    // [Step3] both 0
    expect(getBonus(m)).toBe(0);
    expect(comboFrom(m)).toBe(0);
    // traceBeats should also be reset? at least bonus reset, and off not needed
    // further trace needs full 16 beats again
    for (let i = 0; i < 30; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // 9 beats
    expect(getBonus(m)).toBe(0);
  });

  it('after reset, bonus accumulation restarts from 0 with remainder carry again', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // first bonus
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(2);
    // reset via off-wave 3 beats
    for (let i = 0; i < 10; i++) m.recordTrace(TRACE_INTERVAL, false, beatMs);
    expect(getBonus(m)).toBe(0);
    // second accrual: again 54 ticks -> bonus 2 again
    for (let i = 0; i < 54; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(getBonus(m)).toBe(2);
    expect(comboFrom(m)).toBe(0);
  });

  it('multiple bonuses: score per tick reflects current bonus level', () => {
    const m = new ScoreManager();
    const beatMs = BEAT_MS_120;
    // [Step1] accrue to bonus 4 (32 beats)
    for (let i = 0; i < 107; i++) m.recordTrace(TRACE_INTERVAL, true, beatMs); // 32.1 beats -> bonus 4
    expect(getBonus(m)).toBe(4);
    const before = scoreFrom(m);
    // [Step2] one more tick should give 2+4=6
    m.recordTrace(TRACE_INTERVAL, true, beatMs);
    expect(scoreFrom(m) - before).toBe(6);
    // [Step3] combo still 0
    expect(comboFrom(m)).toBe(0);
  });

  it('complex amplitude/beat scenario: traceBeats accounts BPM changes via beatMs param', () => {
    const m = new ScoreManager();
    // simulate BPM changes: first 8 beats at 120 (500ms), next 8 beats at 180 (333ms)
    // Use 27 ticks at 120: 27*0.3=8.1 beats
    for (let i = 0; i < 27; i++) m.recordTrace(TRACE_INTERVAL, true, BEAT_MS_120);
    expect(getBonus(m)).toBe(0);
    // remaining 8 beats at 180: each tick 0.45 beats -> need 18 ticks for 8.1 beats
    for (let i = 0; i < 18; i++) m.recordTrace(TRACE_INTERVAL, true, BEAT_MS_180);
    // total 16.2 beats -> bonus 2
    expect(getBonus(m)).toBe(2);
    expect(comboFrom(m)).toBe(0);
  });
});
