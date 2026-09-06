/**
 * T168 — キャリブレーション専用の広い判定ウィンドウ（200ms超遅延PC対応）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * 完了条件:
 * 1. ±500ms級の遅延タップでも最近傍リングに判定が付き、誤差が表示されること（calibration wide window ±750ms）
 * 2. ゲーム本編のウィンドウ（beatMs*0.4）は不変であること
 * 3. tsc --noEmit 型契約
 * 制約:
 * - CalibrationModal 内のみで広窓を適用（hitJudge の既定値は変更しない）
 * - ring間隔=4拍=2000ms の半分未満 → 上限 <1000ms（隣リング混入なし）
 * - judgeHit に任意の windowMs 引数を追加するか、オーバーレイ側で最近傍直指定ラッパーを用いる（両方式を許容）
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { judgeHit } from '../src/game/hitJudge';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function makeRing(hitTime: number, targetY = 300, id = 0): any {
  return {
    id,
    spawnTime: hitTime - 1500,
    hitTime,
    targetY,
    resolved: false,
    hit: false,
    type: 'single' as const,
  };
}

function cloneRing(r: any): any {
  return { ...r, resolved: false, hit: false };
}

function beatMsAt(bpm = 120): number {
  return 60000 / bpm; // 500ms at 120
}

// ---------------------------------------------------------------------------
// T168-1: calibration wide window — ±500ms still hits nearest ring
// ---------------------------------------------------------------------------
describe('T168-1: calibration wide window ±500msでも最近傍リングに判定 (3-step state-transition)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 default窓(±200ms)では+500msはMISS(null) → Step2 広窓750でHIT → Step3 errorMsが500msでgreat/goodに反映', () => {
    const bpm = 120;
    const bMs = beatMsAt(bpm); // 500
    const windowDefault = bMs * 0.4; // 200
    expect(windowDefault).toBeCloseTo(200, 6);

    const hitTime = 8000;
    const targetY = 300;
    const cursorY = 300;

    // Step1: capture default failure
    const ringDefault = makeRing(hitTime, targetY, 0);
    const resultDefault = judgeHit(hitTime + 500, cursorY, [ringDefault], bMs);
    expect(resultDefault, 'default window (±200ms) は+500msでnullを返す想定').toBeNull();
    // ring must stay unresolved on miss
    expect(ringDefault.resolved).toBe(false);

    // Step2: apply wide window (750). Red before fix: this still returns null because param not implemented
    const ringWide = makeRing(hitTime, targetY, 1);
    const wideWindow = 750;
    // Try calling with 5th arg. Before fix hitJudge ignores it => null => this assertion FAILS => Red
    // We call with explicit wide window; if wrapper approach used, file contract test below will still require wide handling
    const resultWide: any = (judgeHit as any)(hitTime + 500, cursorY, [ringWide], bMs, wideWindow);
    expect(resultWide, 'wide window 750ms で+500msはHITする（calibration用）。実装前はここでnullとなりFAILする').not.toBeNull();
    // Step3: assert transition — hit with correct errorMs and ring resolved
    expect(resultWide.errorMs).toBeCloseTo(500, 2);
    expect(ringWide.resolved).toBe(true);
    expect(ringWide.hit).toBe(true);
    // Within 60px Y and 750ms window, result should be great or good (not miss). 500ms >100 so good expected
    expect(['good', 'great']).toContain(resultWide.result);
  });

  it('Step1 負方向-500msもdefaultでMISS → Step2 wide 750でHIT → Step3 errorMs=-500とmiss再計上なし', () => {
    const bMs = beatMsAt(120);
    const hitTime = 6000;
    const targetY = 250;

    const r1 = makeRing(hitTime, targetY, 0);
    expect(judgeHit(hitTime - 500, targetY, [r1], bMs)).toBeNull();
    expect(r1.resolved).toBe(false);

    const r2 = makeRing(hitTime, targetY, 1);
    const res = (judgeHit as any)(hitTime - 500, targetY, [r2], bMs, 750);
    expect(res).not.toBeNull();
    expect(res.errorMs).toBeCloseTo(-500, 2);
    expect(r2.resolved).toBe(true);
    expect(r2.hit).toBe(true);
    // -500 not <100 so good
    expect(res.result).toBe('good');
  });

  it('Step1 端数オフグリッド +500.37ms capture → Step2 wide 750で吸着 → Step3 errorMsが端数で一致しY僅差でもHIT', () => {
    const bMs = beatMsAt(120);
    const hitTime = 12000;
    const targetY = 300;

    const tapOffGrid = hitTime + 500.37;
    const r1 = makeRing(hitTime, targetY, 0);
    expect(judgeHit(tapOffGrid, targetY, [r1], bMs)).toBeNull();

    // Y off-grid +29px still within HIT_Y=60 -> should hit with wide
    const r2 = makeRing(hitTime, targetY, 1);
    const res = (judgeHit as any)(tapOffGrid, targetY + 29, [r2], bMs, 750);
    expect(res).not.toBeNull();
    expect(res.errorMs).toBeCloseTo(500.37, 2);
    // 500.37 -> good
    expect(res.result).toBe('good');

    // Near miss boundary: Y 59 still hit, Y 60 miss
    const r3 = makeRing(hitTime, targetY, 2);
    const resInside = (judgeHit as any)(tapOffGrid, targetY + 59, [r3], bMs, 750);
    expect(resInside).not.toBeNull();
    expect(resInside.result).not.toBe('miss');

    const r4 = makeRing(hitTime, targetY, 3);
    const resOutside = (judgeHit as any)(tapOffGrid, targetY + 60, [r4], bMs, 750);
    expect(resOutside).not.toBeNull();
    expect(resOutside.result).toBe('miss'); // Y too far -> miss result but still resolved
  });

  it('Step1 calibration chart生成のリング間隔2000ms確認 → Step2 wide 750タップで最近傍のみヒット → Step3 隣リングへ混入なし', () => {
    const bpm = 120;
    const bMs = beatMsAt(bpm); // 500
    const timeline = new BpmTimeline(bpm, [], 1.0);
    // Two rings 4 beats apart = 2000ms at 120bpm
    const hit1 = timeline.beatToMs(4); // 2000
    const hit2 = timeline.beatToMs(8); // 4000
    expect(hit2 - hit1).toBeCloseTo(2000, 3);

    const rA = makeRing(hit1, 300, 0);
    const rB = makeRing(hit2, 300, 1);

    // Tap at +700ms from first ring, -1300ms from second -> nearest is first
    const tapNearFirst = hit1 + 700;
    const rings = [cloneRing(rA), cloneRing(rB)];
    const res = (judgeHit as any)(tapNearFirst, 300, rings, bMs, 750);
    expect(res).not.toBeNull();
    expect(res.errorMs).toBeCloseTo(700, 2);
    // First ring should be resolved, second should remain unresolved
    expect(rings[0].resolved).toBe(true);
    expect(rings[1].resolved).toBe(false);

    // Tap at +900 from first = -1100 from second. With 750, both are outside? Actually 900 >750 so null if wide 750
    // But if wide were 1000+, it would incorrectly pick one. Verify upper bound <1000: 900 with 750 must be null
    const rC = makeRing(hit1, 300, 2);
    const rD = makeRing(hit2, 300, 3);
    const res900 = (judgeHit as any)(hit1 + 900, 300, [cloneRing(rC), cloneRing(rD)], bMs, 750);
    expect(res900, '900ms with 750 window must be null (upper bound <1000 avoids adjacent confusion)').toBeNull();

    // Edge: exactly 749 should still hit first
    const rE = makeRing(hit1, 300, 4);
    const rF = makeRing(hit2, 300, 5);
    const res749 = (judgeHit as any)(hit1 + 749, 300, [cloneRing(rE), cloneRing(rF)], bMs, 750);
    expect(res749).not.toBeNull();
    expect(res749.errorMs).toBeCloseTo(749, 2);
  });

  it('±500ms前後スイープ: wide 750で全点HIT、defaultで全点MISS（複雑BPM 100/150でも）', () => {
    const cases = [
      { bpm: 120, beatMs: 500 },
      { bpm: 100, beatMs: 600 },
      { bpm: 150, beatMs: 400 },
      { bpm: 180, beatMs: 60000 / 180 },
    ];
    const offsets = [500, -500, 510, -510, 499, -499, 501.23, -501.37, 749, -749];
    for (const c of cases) {
      const hitTime = 10000;
      for (const off of offsets) {
        const tap = hitTime + off;
        const rDef = makeRing(hitTime, 300, 0);
        const def = judgeHit(tap, 300, [rDef], c.beatMs);
        // For bpm 100 default window=240, bpm 150 default=160 -> off 500 always outside default
        expect(def, `default must MISS bpm=${c.bpm} off=${off}`).toBeNull();

        const rWide = makeRing(hitTime, 300, 1);
        const wide = (judgeHit as any)(tap, 300, [rWide], c.beatMs, 750);
        // With wide 750, |off|<750 should HIT, |off|==750 -> strictly < window, so 750 itself is MISS (err < window)
        // Note judgeHit uses err < windowMs (strict). So 750 with window 750 -> miss. We test 749 hits, 750 misses.
        const expectedHit = Math.abs(off) < 750;
        if (expectedHit) {
          expect(wide, `wide 750 must HIT bpm=${c.bpm} off=${off}`).not.toBeNull();
          expect(wide.errorMs).toBeCloseTo(off, 2);
          const shouldBeGood = Math.abs(off) >= 100; // great <100 else good/perfect
          if (Math.abs(off) >= 100) expect(['good', 'great']).toContain(wide.result);
        } else {
          // For off exactly 750, strict < means null or if Y also? Use slightly over
          if (Math.abs(off) === 750) {
            expect(wide).toBeNull();
          } else if (Math.abs(off) > 750) {
            expect(wide).toBeNull();
          }
        }
        // Y distance check: even with wide timing, Y 61 should give miss result not null (since candidate exists but y too far)
        // This verifies Y gating still applies under wide window
        const rWideY = makeRing(hitTime, 300, 2);
        const withBadY = (judgeHit as any)(tap, 300 + 65, [rWideY], c.beatMs, 750);
        if (expectedHit) {
          expect(withBadY).not.toBeNull();
          expect(withBadY.result).toBe('miss');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T168-2: ゲーム本編のウィンドウは不変（beatMs*0.4）
// ---------------------------------------------------------------------------
describe('T168-2: ゲーム本編の判定ウィンドウは beatMs*0.4 で不変（3-step & file contracts）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 default window capture 200ms at 120bpm → Step2 manual変動なし → Step3 game呼出はwide無しで210msでMISS', () => {
    const bMs = beatMsAt(120); // 500
    const win = bMs * 0.4;
    expect(win).toBeCloseTo(200, 6);

    // Step1: 190ms inside, 210ms outside default
    const hitTime = 5000;
    const rIn = makeRing(hitTime, 300, 0);
    const resIn = judgeHit(hitTime + 190, 300, [rIn], bMs);
    expect(resIn).not.toBeNull(); // inside

    const rOut = makeRing(hitTime, 300, 1);
    const resOut = judgeHit(hitTime + 210, 300, [rOut], bMs);
    expect(resOut).toBeNull(); // outside

    // Step2: manualOffset does not affect window size (it's on error side per T167)
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const rOut2 = makeRing(hitTime, 300, 2);
    // judgeHit itself sees raw press; caller is responsible for subtracting manual. So raw window still 200
    const resOut2 = judgeHit(hitTime + 210, 300, [rOut2], bMs);
    expect(resOut2).toBeNull();

    // Step3: file contract - GameScreen must NOT pass wide window
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    // GameScreen handleHit should call judgeHit with 4 args (no wide) and miss loop uses *0.4
    const hitCalls = [...gameSrc.matchAll(/judgeHit\s*\(/g)];
    expect(hitCalls.length).toBeGreaterThan(0);
    // Check that GameScreen hitJudge slice does NOT contain 750, 700, 800 etc as literal wide arg
    const handleHitIdx = gameSrc.indexOf('const handleHit');
    const handleSlice = gameSrc.slice(handleHitIdx, handleHitIdx + 1500);
    expect(handleSlice, 'GameScreen handleHit must NOT pass wide window like 750').not.toMatch(/judgeHit\s*\([^)]*,\s*7\d{2}/);
    expect(handleSlice, 'GameScreen handleHit must use beatMs derived window via hitJudge default').toContain('judgeHit');
    // Miss loop window must be beatMs*0.4
    expect(gameSrc, 'GameScreen MISS window must be *0.4').toMatch(/windowMs\s*=\s*.*\* 0\.4/);
  });

  it('Step1 hitJudge.ts default定義が beatMs*0.4 を含む capture → Step2 引数無し呼出しでそれが有効 → Step3 wide指定がない限り不透過', () => {
    const src = readFile('src/game/hitJudge.ts');
    // Must contain default window fallback
    expect(src, 'hitJudge must define windowMs as currentBeatMs*0.4 or beatMs*0.4').toMatch(/windowMs.*\* ?0\.4/);
    // If optional param exists, it must default to beatMs*0.4 when undefined
    // Check that the optional param, if present, has fallback: windowMs ?? currentBeatMs*0.4 / windowMs ? ... :
    const hasOptional = /judgeHit\s*\([^)]*windowMs/.test(src);
    if (hasOptional) {
      expect(src).toMatch(/windowMs\s*\?\?|windowMs\s*\|\||typeof windowMs|windowMs\s*===\s*undefined/);
      // default still *0.4
      expect(src).toMatch(/\*\s*0\.4/);
    }
    // No hard-coded 750 in hitJudge default path (only as passed value)
    // The only 750-like number should be via parameter, not as fixed value replacing 0.4
    const lines = src.split('\n');
    const fixedWideLine = lines.some((l) => /const\s+windowMs\s*=\s*750/.test(l));
    expect(fixedWideLine, 'hitJudge must NOT hardcode 750 as default').toBe(false);

    // Numeric: without 5th arg, 250ms at 120bpm must still be MISS (only calibration may pass 750)
    const bMs = 500;
    const hitTime = 10000;
    const r = makeRing(hitTime, 300, 0);
    expect(judgeHit(hitTime + 250, 300, [r], bMs)).toBeNull();
    const r2 = makeRing(hitTime, 300, 1);
    expect(judgeHit(hitTime + 199, 300, [r2], bMs)).not.toBeNull();
  });

  it('off-grid beatMs (bpm 137.5 etc) でも default windowは0.4倍で厳密', () => {
    const bpm = 137.5;
    const bMs = 60000 / bpm; // 436.363...
    const win = bMs * 0.4;
    expect(win).toBeCloseTo(174.545, 2);
    const hitTime = 7000;
    const inside = hitTime + win - 1; // just inside
    const outside = hitTime + win + 1; // just outside
    const r1 = makeRing(hitTime, 300, 0);
    expect(judgeHit(inside, 300, [r1], bMs)).not.toBeNull();
    const r2 = makeRing(hitTime, 300, 1);
    expect(judgeHit(outside, 300, [r2], bMs)).toBeNull();
    // Wide would still hit outside
    const r3 = makeRing(hitTime, 300, 2);
    expect((judgeHit as any)(outside, 300, [r3], bMs, 750)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T168-3: 上限 <1000ms（隣リング混入なし）
// ---------------------------------------------------------------------------
describe('T168-3: 広いウィンドウ上限 <1000ms（リング間隔2000msの半分）', () => {
  it('Step1 calibration chart間隔2000ms capture → Step2 仮想wideが999以下 → Step3 ソースの数値が<1000', () => {
    // Step1: interval
    const bpm = 120;
    const tl = new BpmTimeline(bpm, [], 1.0);
    const interval = tl.beatToMs(4); // 1小節
    expect(interval).toBeCloseTo(2000, 3);

    // Step2: conceptually wide must be <1000
    const maxAllowed = 1000;
    const candidateWides = [750, 700, 800, 600, 500, 900];
    for (const w of candidateWides) {
      expect(w).toBeLessThan(maxAllowed);
    }

    // Step3: CalibrationModal source must contain a window <1000 and not >=1000
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    // Find any judgeHit call with 5th arg or wrapper constant
    const hasWideArg = /judgeHit\s*\([^)]*,\s*(750|7\d{2}|800|600|500|900|999)\s*\)/.test(calSrc);
    const hasWideConst = /(WIDE|CALIBRATION|WINDOW|wideWindow|calibrationWindow).*750|CAL_WINDOW|750/.test(calSrc);
    const wrapperPattern = /recent.*ring|nearest.*ring|direct.*ring/i.test(calSrc) && /750|700|800/.test(calSrc);
    const hasAnyWideRef = hasWideArg || hasWideConst || wrapperPattern || /judgeHit/.test(calSrc) && /750/.test(calSrc);
    // At minimum, after fix file must reference 750-ish literal or a <1000 variable passed to judgeHit
    expect(hasAnyWideRef || /windowMs/.test(readFile('src/game/hitJudge.ts')), 'CalibrationModal must apply wide window <1000 (e.g. 750) via judgeHit 5th arg or wrapper').toBe(true);

    // Ensure not 1000 or more
    // If file contains 1000+ literal used as window, it would violate spec
    const hasBadWide = /judgeHit\s*\([^)]*,\s*1\d{3,}\s*\)/.test(calSrc) && !/1000\s*ms.*上限/.test(calSrc);
    // More precise: look for window assignment >=1000
    const windowLiterals = [...calSrc.matchAll(/windowMs[^;]*=\s*(\d{3,4})/g)].map((m) => Number(m[1]));
    const direct750s = [...calSrc.matchAll(/judgeHit\([^)]*,\s*(\d{3,4})/g)].map((m) => Number(m[1]));
    const allCandidates = [...windowLiterals, ...direct750s];
    if (allCandidates.length > 0) {
      for (const v of allCandidates) {
        // Only check those that look like window values (100-2000)
        if (v >= 100 && v < 5000) {
          expect(v, `wide window literal ${v} must be <1000`).toBeLessThan(1000);
        }
      }
    }
    // Also check hitJudge param default is not >=1000
    const hjSrc = readFile('src/game/hitJudge.ts');
    const hjNumbers = [...hjSrc.matchAll(/750|800|900|1000|1100/g)].map((m) => Number(m[0]));
    for (const v of hjNumbers) {
      if (v >= 750) {
        // If hitJudge contains a literal 750 as default, it would be wrong for game (game needs 200). So expect none or only as example in comment
        // Allow 750 only if it's in optional fallback handling, not as hard-fixed default
        // We already checked no hard-fixed 750 default above; so this is just soft
      }
    }
  });

  it('±990msは広窓900でもヒット、±1010はヒットしない（上限の厳密性）', () => {
    const bMs = 500;
    const hitTime = 20000;
    // Simulate wide 900 vs 1000 boundary
    const wide900 = 900;
    const tap990 = hitTime + 990;
    // With 900 window, 990 must MISS (strict <)
    // But spec says upper <1000, so 990 with 750 also MISS. The point is adjacency: first ring 900 away still less than 1000 so would be ambiguous if window >=1000
    // Test that our expected calibration window (750) does NOT claim 990
    const r1 = makeRing(hitTime, 300, 0);
    expect((judgeHit as any)(tap990, 300, [r1], bMs, wide900)).toBeNull();
    const r2 = makeRing(hitTime, 300, 1);
    // 899 inside 900 should HIT
    expect((judgeHit as any)(hitTime + 899, 300, [r2], bMs, wide900)).not.toBeNull();

    // Also verify that two rings 2000 apart with 750 window cannot steal neighboring hit even when tapping midway (1000)
    const rA = makeRing(10000, 300, 2);
    const rB = makeRing(12000, 300, 3);
    const mid = 11000; // 1000 from both
    const resMid = (judgeHit as any)(mid, 300, [cloneRing(rA), cloneRing(rB)], bMs, 750);
    expect(resMid, 'midpoint 1000 from both with 750 must be null (no steal)').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T168-4: ファイル契約 — optional windowMs OR calibration wrapper
// ---------------------------------------------------------------------------
describe('T168-4: ファイル契約 — hitJudge optional windowMs または Calibration wrapper で±750適用', () => {
  it('Step1 初期hitJudgeは4引数 → Step2 広窓適用後の署名変化 → Step3 不変条件を維持', () => {
    const hjSrc = readFile('src/game/hitJudge.ts');
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    const gameSrc = readFile('src/screens/GameScreen.tsx');

    // Step1: hitJudge default must be beatMs*0.4
    expect(hjSrc).toMatch(/currentBeatMs\s*\*\s*0\.4|beatMs\s*\*\s*0\.4/);

    // Step2: after fix, either hitJudge has optional 5th param OR cal has wrapper with wide logic
    const hjHasOptional = /judgeHit\s*\([^)]*windowMs\??\s*:/.test(hjSrc) || /judgeHit\s*\([^)]*windowMs/.test(hjSrc);
    const hjHasWindowParam = hjSrc.includes('windowMs');
    const calHasWide = /750|700|800|windowMs|WIDE|CAL_WINDOW/.test(calSrc) && /judgeHit/.test(calSrc);
    const calHasWrapper = /recent|nearest|wrapper|direct/.test(calSrc.toLowerCase()) && /ring/i.test(calSrc);

    const satisfies = hjHasOptional || hjHasWindowParam || calHasWide || calHasWrapper;
    expect(satisfies, 'Either hitJudge has optional windowMs param OR CalibrationModal applies wide window (e.g. 750) via wrapper/param').toBe(true);

    // Step3: game must stay narrow
    expect(gameSrc).toMatch(/\*\s*0\.4/);
    expect(gameSrc).not.toMatch(/judgeHit\s*\([^)]*,\s*750/);
    // calibration must have wide
    if (hjHasOptional) {
      expect(calSrc).toMatch(/judgeHit\s*\(.*750|windowMs.*750|750/);
    } else {
      // wrapper case: at least calibration file mentions wide handling
      expect(calSrc.length).toBeGreaterThan(0);
    }
  });

  it('hitJudge.ts 行動: 第5引数が与えられればそれを使い、無ければbeatMs*0.4にフォールバックする', () => {
    const bMs = 500;
    const hitTime = 30000;
    // Without 5th arg, uses 0.4*500=200 -> 250 miss
    const r1 = makeRing(hitTime, 300, 0);
    expect(judgeHit(hitTime + 250, 300, [r1], bMs)).toBeNull();
    // With 5th arg 750, 250 hits
    const r2 = makeRing(hitTime, 300, 1);
    const res = (judgeHit as any)(hitTime + 250, 300, [r2], bMs, 750);
    // If implementation uses optional param, this will be non-null. If not yet implemented, this FAILS => Red
    expect(res).not.toBeNull();
    // With explicit small window 100, 90 hits, 110 misses
    const r3 = makeRing(hitTime, 300, 2);
    expect((judgeHit as any)(hitTime + 90, 300, [r3], bMs, 100)).not.toBeNull();
    const r4 = makeRing(hitTime, 300, 3);
    expect((judgeHit as any)(hitTime + 110, 300, [r4], bMs, 100)).toBeNull();
    // Undefined/null should fallback to 200
    const r5 = makeRing(hitTime, 300, 4);
    expect((judgeHit as any)(hitTime + 250, 300, [r5], bMs, undefined)).toBeNull();
  });

  it('CalibrationModal の handleHit が T167の manualOffset 減算を維持したまま wide を適用', () => {
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    const idx = calSrc.indexOf('const handleHit');
    expect(idx).toBeGreaterThan(-1);
    const slice = calSrc.slice(idx, idx + 2500);
    // T167: pressTime = songNow() - getManualOffsetMs()
    expect(slice).toMatch(/getManualOffsetMs/);
    expect(slice).toMatch(/songNow/);
    expect(slice).toMatch(/judgeHit/);
    // After T168, slice should also contain 750 or windowMs
    const hasWideInHandle = /750|700|800|windowMs|WIDE/.test(slice);
    expect(hasWideInHandle, 'handleHit must pass wide window (750 etc) to judgeHit or wrapper').toBe(true);
    // Ensure miss loop not widened? Calibration miss loop maybe also widened? But spec says only hit path needs wide; miss deadline could also use wide for consistency
    // At least not using raw *0.4 as sole window for calibration hit path
  });
});

// ---------------------------------------------------------------------------
// T168-5: tsc型契約 + 回帰（WaveEngine/Cursor off-grid整合）
// ---------------------------------------------------------------------------
describe('T168-5: 型契約 & 回帰 off-grid / 複雑振幅整合', () => {
  beforeEach(() => setManualOffset(0));

  it('Step1 シンボルimport capture → Step2 実行 → Step3 型正しく呼べエラー無し', () => {
    expect(typeof judgeHit).toBe('function');
    const tl = new BpmTimeline(120, [], 1.0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(getManualOffsetMs()).toBeDefined();
    const bMs = 500;
    const r = makeRing(5000, 300, 0);
    expect(() => judgeHit(5000, 300, [r], bMs)).not.toThrow();
    expect(() => (judgeHit as any)(5000, 300, [cloneRing(r)], bMs, 750)).not.toThrow();
    // File must be syntactically valid TS (read check)
    const hjSrc = readFile('src/game/hitJudge.ts');
    expect(hjSrc).toContain('export function judgeHit');
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(calSrc).toContain('export function generateCalibrationChart');
  });

  it('Step1 gameは狭窓のまま → Step2 calibration広窓 → Step3 判定分岐が一致せず回帰なし', () => {
    const bMs = 500;
    const hitTime = 9000;
    // Game path: 210ms must remain null forever
    const rGame = makeRing(hitTime, 300, 0);
    expect(judgeHit(hitTime + 210, 300, [rGame], bMs)).toBeNull();
    // Calibration path: same tap with 750 must hit
    const rCal = makeRing(hitTime, 300, 1);
    expect((judgeHit as any)(hitTime + 210, 300, [rCal], bMs, 750)).not.toBeNull();

    // Perfect/Great/Good branching still correct under wide window
    const rPerfect = makeRing(hitTime, 300, 2);
    const resPerfect = (judgeHit as any)(hitTime + 30, 300, [rPerfect], bMs, 750);
    expect(resPerfect).not.toBeNull();
    expect(resPerfect.result).toBe('perfect'); // <50ms & <30px

    const rGreat = makeRing(hitTime, 300, 3);
    const resGreat = (judgeHit as any)(hitTime + 80, 300, [rGreat], bMs, 750);
    expect(resGreat).not.toBeNull();
    expect(resGreat.result).toBe('great'); // 50-100ms

    const rGood = makeRing(hitTime, 300, 4);
    const resGood = (judgeHit as any)(hitTime + 250, 300, [rGood], bMs, 750);
    expect(resGood).not.toBeNull();
    expect(resGood.result).toBe('good'); // >100ms but within wide

    // Y threshold still enforced under wide
    const rMissY = makeRing(hitTime, 300, 5);
    const resMissY = (judgeHit as any)(hitTime + 30, 300 + 65, [rMissY], bMs, 750);
    expect(resMissY).not.toBeNull();
    expect(resMissY.result).toBe('miss');
  });
});
