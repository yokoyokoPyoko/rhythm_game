/**
 * T227 — MISS-inflation fixes regression locks (vitest, source-contract + numeric).
 *
 * Bug 1 (critical): the tutorial-hold → main auto-transition called enterMain()
 * synchronously inside tick while inMainWait/inTutorialWait flags were still at
 * their pre-transition values. The fresh spawner then respawned tutorial rings
 * at tutorial-clock time and the expiry loop recorded them all as MISS into the
 * fresh main score (plus a flash of MISS texts). Fix: defer via setTimeout like
 * the other stage transitions + phase guard in enterMain.
 *
 * Bug 2: Space keydown had no e.repeat guard, so holding Space (mandatory for
 * holds) spammed handleHit() and ate nearby rings as phantom MISSes.
 * Fix: `if (e.repeat) return` after keysRef.space tracking.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
}

describe('T227-0: hold→main transition is deferred (no stale-flag gameplay)', () => {
  it('Step1 capture direct enterMain() call → Step2 read tick → Step3 hold→main uses setTimeout like wave→ring/ring→hold', () => {
    const src = readSrc('src/screens/GameScreen.tsx');
    // All three tutorial transitions must go through setTimeout.
    expect(src).toMatch(/setTimeout\(\(\) => startRingStage\(\), 0\)/);
    expect(src).toMatch(/setTimeout\(\(\) => startHoldStage\(\), 0\)/);
    expect(src).toMatch(/setTimeout\(\(\) => enterMain\(\), 0\)/);
    // The hold→main tick block must reach enterMain only via setTimeout.
    const holdBlockIdx = src.indexOf("phaseRef.current === 'tutorial-hold'");
    expect(holdBlockIdx).toBeGreaterThan(-1);
    const holdBlock = src.slice(holdBlockIdx, holdBlockIdx + 800);
    expect(holdBlock).not.toMatch(/^\s*enterMain\(\)/m);
    // The only direct call allowed is skipTutorial's click handler (outside tick).
    const lines = src.split('\n');
    const directCalls = lines.filter(
      (l) => /^\s*enterMain\(\)/.test(l) && !l.includes('setTimeout'),
    );
    expect(directCalls.length).toBe(1);
    const skipIdx = src.indexOf('const skipTutorial');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(src.slice(skipIdx, skipIdx + 300)).toContain('enterMain()');
  });

  it('Step1 capture enterMain → Step2 read body → Step3 phase guard prevents double-run', () => {
    const src = readSrc('src/screens/GameScreen.tsx');
    expect(src).toMatch(/if \(phaseRef\.current === 'main'\) return/);
  });
});

describe('T227-1: Space auto-repeat never judges', () => {
  it('Step1 capture Space branch → Step2 read handler → Step3 e.repeat guard after space-level tracking', () => {
    const src = readSrc('src/screens/GameScreen.tsx');
    const idx = src.indexOf("if (e.code === 'Space')");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1200);
    expect(block).toContain('keysRef.current.space = true');
    expect(block).toMatch(/if \(e\.repeat\) return/);
    // The guard must come after level tracking so hold maintenance still works.
    expect(block.indexOf('keysRef.current.space = true')).toBeLessThan(
      block.indexOf('if (e.repeat) return'),
    );
  });

  it('Step1 capture CalibrationModal guard → Step2 parity check → Step3 both screens ignore repeats', () => {
    const cal = readSrc('src/screens/editor/CalibrationModal.tsx');
    expect(cal).toMatch(/if \(e\.repeat\) return/);
  });
});

describe('T227-2: tutorial MISS can never leak into main score', () => {
  it('Step1 capture enterMain → Step2 read body → Step3 score is replaced (not carried over)', () => {
    const src = readSrc('src/screens/GameScreen.tsx');
    const idx = src.indexOf('const enterMain = useCallback');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2500);
    expect(body).toContain('scoreRef.current = new ScoreManager()');
    expect(body).toContain('ringsRef.current = []');
    expect(body).toContain('judgementEventsRef.current = []');
  });
});
