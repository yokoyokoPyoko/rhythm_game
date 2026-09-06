/**
 * @vitest-environment node
 * T172 — キャリブレーション判定表示のY距離・丸め修正（GREAT(+40)問題）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Spec:
 * - Perfect: 誤差<50ms かつ Y<30px 。+40msでもY 30〜60pxならGREATが正当だが現行はmsのみ表示で誤解を招く
 * - 誤差は生float、MISSは journal('miss',0) の偽装+0ms
 * - 修正は CalibrationModal.tsx のみ。lastLabelを GREAT (+40ms, ΔY 35px) 形式にし誤差は整数丸め。MISS時は -- 表示
 * - 判定ロジック(hitJudge.ts)は不変。yDistを返すかhandleHit側で算出するかは自由。型追加のみ許容
 *
 * 禁止事項(過去失敗より):
 * - indexOf('const save') のような曖昧検索禁止 → 'const save =' を使う
 * - ブロックスコープ変数を使用前に参照してはならない
 * - TW_AMP を直ハードコードした wave位置期待値禁止 — WaveEngine.waveYAt で算出
 * - computeCoarseOffset の省略禁止 — 粗調整で呼ばれ続けなければならない
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
  (globalThis as any).document = { createElement: () => ({}) } as any;
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { judgeHit } from '../src/game/hitJudge';
import { getManualOffsetMs, setManualOffset } from '../src/audio/clock';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers — readFile + export discovery, specific indexOf patterns only
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function findLabelFormatterName(src: string): string | null {
  const patterns = [
    /export\s+function\s+(\w*format\w*[Ll]abel\w*)\s*\(/,
    /export\s+function\s+(\w*[Ll]abel\w*)\s*\(/,
    /export\s+function\s+(buildLastLabel)\s*\(/,
    /export\s+function\s+(getLastLabel)\s*\(/,
    /export\s+const\s+(\w*label\w*)\s*=/,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractLastLabelSlice(src: string): string {
  const idx = src.indexOf('const lastLabel =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 1400);
}
function extractJournalSlice(src: string): string {
  const idx = src.indexOf('const journal =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 1100);
}
function extractHandleHitSlice(src: string): string {
  const idx = src.indexOf('const handleHit =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3200);
}
function extractTickMissSlice(src: string): string {
  const idx = src.indexOf("journal('miss'");
  if (idx === -1) return '';
  return src.slice(Math.max(0, idx - 300), idx + 600);
}

// ---------------------------------------------------------------------------
// T172-1: GREAT(+40) Y要因が目視で判別可能 — 判定はYでGREAT、表示にΔYが含まれる
// ---------------------------------------------------------------------------
describe('T172-1: GREAT(+40) Y要因の目視判別 (3-step, computed + file contract)', () => {
  it('Step1 初期候補無し capture → Step2 +40ms & ΔY 35px で judgeHit → Step3 GREAT かつ表示にΔY 35px が含まれる', async () => {
    // Step1: capture initial — no ring yet, file must currently lack ΔY (Red), after fix it contains ΔY
    const srcBefore = readFile('src/screens/editor/CalibrationModal.tsx');
    // Step2: perform judgement with off-grid friendly numbers: timing +40ms (perfect range) but Y 35px (great range)
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0.0);
    const targetY = engine.waveYAt(4);
    const cursorY = targetY + 35;
    const hitTime = tl.beatToMs(4);
    const pressTime = hitTime + 40;
    const rings = [{ id: 1, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const beatMs = tl.beatMsAt(4);
    // judgeHit should return great (not perfect) because yDist 35 >=30 even though err 40 <50
    const judgement = judgeHit(pressTime, cursorY, rings, beatMs);
    expect(judgement, 'judgeHit must return judgement for within-window hit').not.toBeNull();
    expect(judgement!.result).toBe('great');
    expect(Math.round(judgement!.errorMs)).toBe(40);
    // also verify Y distance via waveEngine vs direct
    const yDistComputed = Math.abs(cursorY - targetY);
    expect(Math.round(yDistComputed)).toBe(35);
    // Verify waveYAt is used, not hardcoded TW_AMP
    const expectedTopViaEngine = engine.waveYAt(0);
    expect(expectedTopViaEngine).toBeCloseTo(TW_CENTER_Y, 1);

    // Step3: assert file contract — lastLabel must contain ΔY and rounded error
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src, 'lastLabel must contain ΔY for Y-factor visibility').toMatch(/ΔY/);
    // Must round errorMs via Math.round
    const lastLabelSlice = extractLastLabelSlice(src);
    expect(lastLabelSlice, 'lastLabel must use Math.round for integer ms').toMatch(/Math\.round/);
    // Must include yDist/ΔY in lastLabel template (e.g. ΔY ${...}px)
    expect(lastLabelSlice).toMatch(/ΔY/);
    // The great case must be formatted with both ms and ΔY
    // Try formatter export if available, otherwise validate source pattern
    const formatterName = findLabelFormatterName(src);
    if (formatterName) {
      const mod: any = await import('../src/screens/editor/CalibrationModal');
      const fn = mod[formatterName];
      expect(typeof fn, `exported ${formatterName} must be function`).toBe('function');
      // Call with great, +40, yDist 35 — expect string contains both
      const label = fn('great', 40, 35) ?? fn({ result: 'great', errorMs: 40, yDist: 35 }) ?? '';
      const labelStr = String(label);
      expect(labelStr).toMatch(/GREAT/);
      expect(labelStr).toMatch(/\+40ms/);
      expect(labelStr).toMatch(/ΔY/);
      expect(labelStr).toMatch(/35px/);
    } else {
      // No exported formatter — source must still produce GREAT (+40ms, ΔY 35px) pattern
      expect(lastLabelSlice).toMatch(/GREAT/);
      expect(lastLabelSlice).toMatch(/\+/);
      expect(lastLabelSlice).toMatch(/ms/);
      expect(lastLabelSlice).toMatch(/ΔY/);
    }
  });

  it('Step1 Perfect境界 capture(誤差29ms Y29px) → Step2 PERFECT、端数でGREATへ遷移 → Step3 表示がYで切り替わる', async () => {
    const tl = new BpmTimeline(120, [], 1.3);
    const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, 1.3, 0.0);
    const targetY = engine.waveYAt(4);
    // Perfect case: err 29, y 29 -> perfect
    const hitTime = tl.beatToMs(4);
    const perfectY = targetY + 29;
    const perfectPress = hitTime + 29;
    const beatMs = tl.beatMsAt(4);
    const ringsA = [{ id: 2, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const jPerfect = judgeHit(perfectPress, perfectY, ringsA, beatMs);
    expect(jPerfect!.result).toBe('perfect');
    // Great case: same timing 40 but Y 35 -> great (off-grid 0.37 style fractional)
    const greatY = targetY + 35;
    const greatPress = hitTime + 40.37;
    const ringsB = [{ id: 3, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const jGreat = judgeHit(greatPress, greatY, ringsB, beatMs);
    expect(jGreat!.result).toBe('great');
    // Raw error 40.37 must be rounded to 40 in display, yDist 34.63 -> 35 etc.
    expect(Math.round(jGreat!.errorMs)).toBe(40);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const lastSlice = extractLastLabelSlice(src);
    expect(lastSlice).toMatch(/Math\.round/);
    expect(lastSlice).toMatch(/ΔY/);
    // Verify formatter rounding if exported
    const formatterName = findLabelFormatterName(src);
    if (formatterName) {
      const mod: any = await import('../src/screens/editor/CalibrationModal');
      const fn = mod[formatterName];
      const labelFrac = fn('great', 40.37, 35.4) ?? fn({ result: 'great', errorMs: 40.37, yDist: 35.4 }) ?? '';
      expect(String(labelFrac)).toMatch(/\+40ms/);
      expect(String(labelFrac)).not.toMatch(/40\.37/);
      expect(String(labelFrac)).toMatch(/35px/);
    }
  });

  it('Step1 複雑振幅0.7/2.7 & off-grid 0.37拍 capture → Step2 各振幅でGREAT判定 → Step3 ΔY表示が振幅に依らず一致', async () => {
    const amps = [0.7, 1.3, 2.7];
    const offBeat = 0.37;
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, amp, 0.0);
      const beat = 4 + offBeat;
      const targetY = engine.waveYAt(beat);
      const hitTime = tl.beatToMs(beat);
      const cursorY = targetY + 34.63;
      const pressTime = hitTime + 40.37;
      const rings = [{ id: 10, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
      const beatMs = tl.beatMsAt(beat);
      const j = judgeHit(pressTime, cursorY, rings, beatMs);
      expect(j, `amp ${amp} off-grid ${offBeat} must be great`).not.toBeNull();
      expect(j!.result).toBe('great');
      expect(Math.round(j!.errorMs)).toBe(40);
      expect(Math.round(Math.abs(cursorY - targetY))).toBe(35);
    }
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toMatch(/ΔY/);
    expect(extractLastLabelSlice(src)).toMatch(/Math\.round/);
  });
});

// ---------------------------------------------------------------------------
// T172-2: 誤差の整数丸め — 生floatを表示しない
// ---------------------------------------------------------------------------
describe('T172-2: 誤差整数丸め (3-step, computed)', () => {
  it('Step1 生float 40.6 capture → Step2 丸め → Step3 +41ms(整数)かつfloatが含まれない', async () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const formatterName = findLabelFormatterName(src);
    const testCases: Array<{ in: number; out: string }> = [
      { in: 40.6, out: '+41ms' },
      { in: 40.37, out: '+40ms' },
      { in: -12.51, out: '-13ms' },
      { in: -0.49, out: '+0ms' },
      { in: 0.51, out: '+1ms' },
      { in: 99.63, out: '+100ms' },
    ];
    if (formatterName) {
      const mod: any = await import('../src/screens/editor/CalibrationModal');
      const fn = mod[formatterName];
      expect(typeof fn).toBe('function');
      for (const { in: v, out } of testCases) {
        const label = fn('perfect', v, 10) ?? fn({ result: 'perfect', errorMs: v, yDist: 10 }) ?? '';
        const s = String(label);
        expect(s, `error ${v} -> ${out}`).toContain(out);
        expect(s).not.toContain(String(v));
      }
    } else {
      // No exported formatter: verify source uses Math.round on errorMs
      const slice = extractLastLabelSlice(src);
      expect(slice).toMatch(/Math\.round/);
      // Simulate expected rounding logic ourselves to prove spec
      for (const { in: v, out } of testCases) {
        const rounded = Math.round(v);
        const sign = rounded >= 0 ? '+' : '';
        const formatted = `${sign}${rounded}ms`;
        expect(formatted).toBe(out);
      }
      // Ensure slice does NOT directly interpolate raw errorMs without round
      // e.g. it should not be `${errorMs}ms` without Math.round
      expect(slice).not.toMatch(/\$\{[^}]*errorMs\}ms/);
      // Must be Math.round(errorMs)
      expect(slice).toMatch(/Math\.round\([^)]*errorMs/);
    }
  });

  it('Step1 Y距離端数 35.6px capture → Step2 丸め → Step3 36px 表示', async () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const formatterName = findLabelFormatterName(src);
    const yCases: Array<{ y: number; expected: string }> = [
      { y: 35.6, expected: '36px' },
      { y: 35.4, expected: '35px' },
      { y: 29.5, expected: '30px' },
      { y: 0.49, expected: '0px' },
    ];
    if (formatterName) {
      const mod: any = await import('../src/screens/editor/CalibrationModal');
      const fn = mod[formatterName];
      for (const { y, expected } of yCases) {
        const label = fn('great', 40, y) ?? fn({ result: 'great', errorMs: 40, yDist: y }) ?? '';
        expect(String(label), `yDist ${y} -> ${expected}`).toContain(expected);
      }
    } else {
      const slice = extractLastLabelSlice(src);
      // Y rounding must use Math.round as well
      expect(slice).toMatch(/Math\.round/);
      expect(slice).toMatch(/ΔY/);
      for (const { y, expected } of yCases) {
        const roundedY = Math.round(y);
        expect(`${roundedY}px`).toBe(expected);
      }
    }
  });

  it('Step1 端数タイミング1.23拍由来の誤差 capture → Step2 judgeHit → Step3 errorMsがfloatでも表示は整数', async () => {
    const tl = new BpmTimeline(120, [], 1.3);
    const engine = new WaveEngine([{ direction: 'up', beats: 8 }], tl, 1.3, 0.0);
    const beat = 8 + 0.23;
    const targetY = engine.waveYAt(beat);
    const hitTime = tl.beatToMs(beat);
    // Press with fractional 1.23*500 = 615ms offset's fractional part 0.37 -> float error
    const floatErr = 40.37;
    const pressTime = hitTime + floatErr;
    const rings = [{ id: 20, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const beatMs = tl.beatMsAt(beat);
    const j = judgeHit(pressTime, targetY, rings, beatMs);
    expect(j!.result).toBe('perfect');
    expect(j!.errorMs).toBeCloseTo(40.37, 4);
    expect(Math.round(j!.errorMs)).toBe(40);
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(extractLastLabelSlice(src)).toMatch(/Math\.round/);
  });
});

// ---------------------------------------------------------------------------
// T172-3: MISS時は偽装(+0ms)を出さず -- 表示
// ---------------------------------------------------------------------------
describe('T172-3: MISS時 -- 表示 (3-step, computed + file contract)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 MISS前 label capture(—) → Step2 MISS判定 or 期限切れ → Step3 labelが MISS (--) で +0msを含まない', async () => {
    // Step1: capture initial — state
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    expect(src).toContain('const lastLabel =');
    // Step2: simulate MISS via judgeHit miss (yDist out of range)
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0.0);
    const targetY = engine.waveYAt(4);
    const hitTime = tl.beatToMs(4);
    const farY = targetY + 80;
    const pressTime = hitTime + 10;
    const rings = [{ id: 30, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const beatMs = tl.beatMsAt(4);
    const missJ = judgeHit(pressTime, farY, rings, beatMs);
    expect(missJ!.result).toBe('miss');
    // Also expiry MISS case: songTime exceeds hitTime + window, should be miss with null error
    // Step3: verify file contract — lastLabel must branch to -- for miss / null
    const lastSlice = extractLastLabelSlice(src);
    // Must contain -- for miss
    expect(lastSlice, 'MISS branch must contain --').toMatch(/--/);
    // Must NOT be (+0ms) fake — check that miss path does not use +0ms
    // Specifically, miss label should not contain Math.round(0) as +0ms; it should show --
    expect(lastSlice).toMatch(/MISS/);
    // Ensure journal miss is not hardcoded to 0
    const journalSlice = extractJournalSlice(src);
    const tickMissSlice = extractTickMissSlice(src);
    // After fix, tick's miss should pass null, not 0
    // Check that file does NOT contain journal('miss', 0) literal
    const hasFakeZero = src.includes("journal('miss', 0)") || src.includes('journal("miss", 0)') || src.includes("journal('miss',0)");
    expect(hasFakeZero, 'tick MISS must not use journal(miss,0) fake zero').toBe(false);
    // Must contain null handling: errorMs: number | null or miss ? '--'
    const hasNullHandling = /errorMs\s*:\s*number\s*\|\s*null/.test(src) || /--/.test(lastSlice) || /errorMs\s*===\s*null/.test(src) || /result\s*===\s*'miss'/.test(lastSlice);
    expect(hasNullHandling, 'must handle miss with null or -- branch').toBe(true);

    // If formatter exported, verify miss -> --
    const formatterName = findLabelFormatterName(src);
    if (formatterName) {
      const mod: any = await import('../src/screens/editor/CalibrationModal');
      const fn = mod[formatterName];
      const missLabelNull = fn('miss', null, null) ?? fn({ result: 'miss', errorMs: null, yDist: null }) ?? fn('miss', 0, 0) ?? '';
      const s = String(missLabelNull);
      expect(s).toMatch(/MISS/);
      expect(s).toMatch(/--/);
      expect(s).not.toMatch(/\+0ms/);
      // Even if called with 0, miss should still show -- (not +0ms)
      const missLabelZero = fn('miss', 0, 35) ?? '';
      if (String(missLabelZero).includes('MISS')) {
        expect(String(missLabelZero)).not.toMatch(/\+0ms/);
        expect(String(missLabelZero)).toMatch(/--/);
      }
    }
  });

  it('Step1 正常ヒット +40ms capture → Step2 MISS期限切れへ遷移 → Step3 +0msが表示されない', async () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0.0);
    const targetY = engine.waveYAt(4);
    const hitTime = tl.beatToMs(4);
    const beatMs = tl.beatMsAt(4);
    // Step1: great hit +40ms
    const rings1 = [{ id: 40, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const j1 = judgeHit(hitTime + 40, targetY + 35, rings1, beatMs);
    expect(j1!.result).toBe('great');
    // Step2: miss via far Y
    const rings2 = [{ id: 41, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const j2 = judgeHit(hitTime + 10, targetY + 80, rings2, beatMs);
    expect(j2!.result).toBe('miss');
    // Step3: miss errorMs must not be displayed as +0ms
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const lastSlice = extractLastLabelSlice(src);
    expect(lastSlice).toMatch(/--/);
    expect(lastSlice).toMatch(/MISS/);
    // Ensure positive hit still shows +40ms branch
    expect(lastSlice).toMatch(/ms/);
    // Verify that miss case in lastLabel does not go through ms branch
    // e.g. ternary: result==='miss' ? 'MISS (--)' : `${...}ms`
    const hasMissBranch = /result\s*===\s*'miss'[\s\S]*?--/.test(lastSlice) || /miss[\s\S]*--/.test(lastSlice) || /errorMs\s*===\s*null[\s\S]*--/.test(lastSlice);
    expect(hasMissBranch, 'lastLabel must have explicit miss/-- branch').toBe(true);
  });

  it('Step1 期限切れMISS直前のsongTime capture → Step2 tickがmissを記録 → Step3 journalに0偽装が渡らない', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    // Check that journal type allows null
    const hasNullable = /errorMs\s*:\s*number\s*\|\s*null/.test(src) || /LastJudgement[\s\S]*?errorMs\s*:\s*number\s*\|\s*null/.test(src) || /journal.*number\s*\|\s*null/.test(src);
    // If not strictly typed as nullable, must at least branch on miss to show --
    const lastSlice = extractLastLabelSlice(src);
    const journalSlice = extractJournalSlice(src);
    expect(lastSlice).toMatch(/--/);
    // tick miss slice should call journal with null or with no +0ms path
    const tickSlice = extractTickMissSlice(src);
    if (tickSlice.length > 0) {
      expect(tickSlice).not.toMatch(/journal\('miss',\s*0\s*\)/);
      const hasNullInTick = /journal\('miss',\s*null/.test(tickSlice) || /journal\("miss",\s*null/.test(tickSlice);
      // Accept either null or -- branch as evidence of fix
      if (!hasNullInTick) {
        expect(lastSlice).toMatch(/--/);
      } else {
        expect(hasNullInTick).toBe(true);
      }
    }
    // verify handleHit does not produce +0ms for miss: errorMs must be from judgement or null
    const handleSlice = extractHandleHitSlice(src);
    // handleHit should not synthesize 0 for miss; it should pass judgement.errorMs or null
    expect(handleSlice).not.toMatch(/journal\('miss',\s*0\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// T172-4: ファイル契約 — CalibrationModalのみ変更、判定ロジック不変、丸め・ΔY・--が揃う
// ---------------------------------------------------------------------------
describe('T172-4: ファイル契約 — 判定ロジック不変 & 表示修正の整合 (3-step)', () => {
  it('Step1 hitJudge.ts capture → Step2 PERFECT/GREAT閾値が不変 → Step3 50/100/30/60 が維持される', () => {
    const hitSrc = readFile('src/game/hitJudge.ts');
    // Step1 capture
    expect(hitSrc).toContain('PERFECT_MS');
    // Step2 thresholds must remain 50, 30, 60, 100
    expect(hitSrc).toMatch(/PERFECT_MS\s*=\s*50/);
    expect(hitSrc).toMatch(/PERFECT_Y\s*=\s*30/);
    expect(hitSrc).toMatch(/HIT_Y\s*=\s*60/);
    expect(hitSrc).toMatch(/GREAT_MS\s*=\s*100/);
    // Step3 judgement logic unchanged: err < PERFECT_MS && yDist < PERFECT_Y -> perfect
    expect(hitSrc).toMatch(/selected\.err\s*<\s*PERFECT_MS\s*&&\s*selected\.yDist\s*<\s*PERFECT_Y/);
    expect(hitSrc).toMatch(/selected\.err\s*<\s*GREAT_MS/);
    // Must still return errorMs as pressTime - ring.hitTime (not rounded there)
    expect(hitSrc).toMatch(/errorMs:\s*pressTimeMs\s*-\s*selected\.ring\.hitTime/);
  });

  it('Step1 CalibrationModal lastLabel capture → Step2 Math.round と ΔY と -- が同時に存在 → Step3 全完了条件を満たす', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const lastSlice = extractLastLabelSlice(src);
    // Must contain Math.round (integer rounding)
    expect(lastSlice, 'Math.round for errorMs').toMatch(/Math\.round/);
    // Must contain ΔY
    expect(lastSlice, 'ΔY visibility').toMatch(/ΔY/);
    // Must contain -- for miss
    expect(lastSlice, 'MISS --').toMatch(/--/);
    // Must contain ms unit
    expect(lastSlice).toMatch(/ms/);
    // Must contain px unit for ΔY
    expect(lastSlice).toMatch(/px/);
    // Must differentiate miss vs hit: miss should NOT show +...ms
    const hasMissGuard = /miss/.test(lastSlice.toLowerCase()) && /--/.test(lastSlice);
    expect(hasMissGuard).toBe(true);
    // save/cancel must still use specific pattern (prohibited rule)
    expect(src.indexOf('const save ='), 'must use specific const save =').toBeGreaterThan(-1);
    expect(src.indexOf('const cancel ='), 'must use specific const cancel =').toBeGreaterThan(-1);
  });

  it('Step1 journal型 capture → Step2 errorMsが number|null を許容 → Step3 tick と handleHit が整合', () => {
    const src = readFile('src/screens/editor/CalibrationModal.tsx');
    const hasNullable = /errorMs\s*:\s*number\s*\|\s*null/.test(src);
    const lastSlice = extractLastLabelSlice(src);
    const journalSlice = extractJournalSlice(src);
    // At least one of: nullable type or explicit miss -> -- branch counts as fix
    if (!hasNullable) {
      // Alternative: journal takes number but lastLabel branches on result==='miss' to show --
      expect(lastSlice).toMatch(/--/);
      expect(lastSlice).toMatch(/miss/i);
    } else {
      expect(hasNullable).toBe(true);
    }
    // journal must be called with errorMs from judgement or null, not hardcoded 0 for miss tick
    expect(src).not.toMatch(/journal\('miss',\s*0\s*\)/);
    // handleHit should compute yDist or use judgement yDist for ΔY
    const handleSlice = extractHandleHitSlice(src);
    const hasYDistCalc = /yDist/.test(handleSlice) || /Math\.abs\(.*cursor.*targetY/.test(handleSlice) || /Math\.abs\(cursorY.*targetY/.test(handleSlice) || /Math\.abs\(.*y.*-.*targetY/.test(handleSlice);
    // If judgeHit now returns yDist, hitJudge.ts would contain yDist in HitJudgement
    const hitJudgeSrc = readFile('src/game/hitJudge.ts');
    const hitJudgeHasYDist = /yDist/.test(hitJudgeSrc) && /HitJudgement/.test(hitJudgeSrc);
    // Either handleHit computes yDist or judgeHit returns it — one must be true
    expect(hasYDistCalc || hitJudgeHasYDist, 'yDist must be computed in handleHit or returned by judgeHit').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T172-5: computeCoarseOffset維持 & 複雑振幅 off-grid 数値整合 (T127 style, prohibited守備)
// ---------------------------------------------------------------------------
describe('T172-5: 回帰 — computeCoarseOffset維持 & 波形/カーソル複雑振幅整合', () => {
  it('Step1 import capture → Step2 computeCoarseOffset/unwrapTimingError/generateChart 存在 → Step3 型と計算が正しい', async () => {
    const mod: any = await import('../src/screens/editor/CalibrationModal');
    expect(typeof mod.computeCoarseOffset, 'computeCoarseOffset must exist (prohibited omission)').toBe('function');
    expect(typeof mod.unwrapTimingError, 'unwrapTimingError must exist').toBe('function');
    expect(typeof mod.generateCalibrationChart).toBe('function');
    const raw = [999, 999, 100, 102, 98, 101, 99, 100];
    expect(mod.computeCoarseOffset(raw, 0)).toBe(100);
    expect(mod.computeCoarseOffset(raw, 10)).toBe(110);
    const offRaw = [0, 0, 100.37, 99.63, 100.37, 99.63, 100.37, 99.63];
    expect(mod.computeCoarseOffset(offRaw, 0)).toBe(100);
    expect(mod.unwrapTimingError(1200)).toBeCloseTo(-800, 6);
  });

  it('Step1 複雑振幅0.7/1.3/2.7/3.4 capture → Step2 off-grid 0.37/1.23でwaveYAt → Step3 傾斜が2*TW_AMP*ampで一致', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.62, 2.37];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
      const perBeat = 2 * TW_AMP * amp;
      const top = TW_CENTER_Y - TW_AMP;
      const bottom = TW_CENTER_Y + TW_AMP;
      for (const b of offGridBeats) {
        const rawExpected = TW_CENTER_Y + perBeat * b;
        const clampedExpected = Math.max(top, Math.min(bottom, rawExpected));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(clampedExpected, 4);
        expect(engine.getPoints().length).toBe(2);
      }
    }
  });

  it('Step1 cursor初期 capture → Step2 0.37拍移動 → Step3 cursorとwave傾斜が一致しmanualOffsetが波高に影響しない', () => {
    setManualOffset(0);
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    expect(y0).toBeCloseTo(engine.waveYAt(0), 6);
    cursor.update((0.37 * beatMs) / 1000, false, true, beatMs);
    const delta = Math.abs(cursor.y - y0);
    expect(delta).toBeCloseTo(perBeat * 0.37, 4);
    expect(Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0))).toBeCloseTo(perBeat * 0.37, 4);
    setManualOffset(80);
    expect(engine.waveYAt(0.37)).toBeCloseTo(engine.waveYAt(0) + perBeat * 0.37, 4);
    setManualOffset(0);
  });
});
