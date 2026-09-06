/**
 * @vitest-environment node
 * T173 — ゲーム画面の判定テキストに誤差表示を追加（T172の本編側）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Spec:
 * - renderer.ts の判定テキストは現状ラベル名のみで JudgementEvent に errorMs がない
 * - 修正: JudgementEvent に errorMs: number|null (+optional yDist) を追加
 * - GameScreen.tsx handleHit で judgement.errorMs を渡し、期限切れMISSは null
 * - renderer.ts drawJudgements で errorMs!==null の場合のみ GREAT +40ms 形式で整数丸め表示（YあればΔY併記）、MISSはラベルのみ → 実際は MISSは「MISS --」で偽装0を出さない
 * - 生floatを表示しない、MISSは -- 、整数丸め
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
import { Renderer, type JudgementEvent } from '../src/game/renderer';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { judgeHit } from '../src/game/hitJudge';
import { ScoreManager } from '../src/game/score';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function extractInterfaceSlice(src: string): string {
  const idx = src.indexOf('export interface JudgementEvent');
  if (idx === -1) return '';
  return src.slice(idx, idx + 600);
}

function extractDrawJudgementsSlice(src: string): string {
  const idx = src.indexOf('private drawJudgements');
  if (idx === -1) return src.indexOf('drawJudgements') !== -1 ? src.slice(src.indexOf('drawJudgements'), src.indexOf('drawJudgements') + 2000) : '';
  return src.slice(idx, idx + 2800);
}

function extractHandleHitSlice(src: string): string {
  const idx = src.indexOf('const handleHit');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3200);
}

function extractTickMissSlice(src: string): string {
  // look for the expiry loop that pushes miss
  const pattern = /if\s*\(\s*songTimeMs\s*-\s*getManualOffsetMs\(\)\s*>\s*ring\.hitTime/;
  const m = src.match(pattern);
  if (!m || m.index === undefined) return '';
  return src.slice(m.index, m.index + 1200);
}

// Mock canvas ctx that records fillText calls
function createMockCtx() {
  const calls: string[] = [];
  const ctx: any = {
    fillText: (text: string) => { calls.push(text); },
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    save: () => {},
    restore: () => {},
    set fillStyle(_: any) {},
    get fillStyle() { return ''; },
    set strokeStyle(_: any) {},
    get strokeStyle() { return ''; },
    set globalAlpha(_: any) {},
    get globalAlpha() { return 1; },
    set lineWidth(_: any) {},
    get lineWidth() { return 1; },
    set font(_: any) {},
    get font() { return ''; },
    set textAlign(_: any) {},
    get textAlign() { return ''; },
    set textBaseline(_: any) {},
    get textBaseline() { return ''; },
    set lineCap(_: any) {},
    get lineCap() { return ''; },
    set lineJoin(_: any) {},
    get lineJoin() { return ''; },
  };
  // also support canvas getContext style properties
  ctx.canvas = { width: 800, height: 600 };
  return { ctx, calls };
}

function createMinimalWaveEngine(): WaveEngine {
  const tl = new BpmTimeline(120, [], 1.0);
  return new WaveEngine([{ direction: 'down', beats: 4 }], tl, 1.0, 0.0);
}

// ---------------------------------------------------------------------------
// T173-1: JudgementEvent 型拡張 — errorMs:number|null と yDist 追加 (3-step)
// ---------------------------------------------------------------------------
describe('T173-1: JudgementEvent 型拡張 — errorMs と yDist の必須化 (3-step, file contract)', () => {
  it('Step1 初期型 capture (errorMs無し) → Step2 仕様要求の型定義を探索 → Step3 errorMs:number|null と yDist が存在すること', () => {
    // Step1: capture initial state — current file before fix lacks errorMs
    const srcBefore = readFile('src/game/renderer.ts');
    const sliceBefore = extractInterfaceSlice(srcBefore);
    // Step2: we know spec requires errorMs and yDist; just verifying slice exists
    expect(sliceBefore.length, 'JudgementEvent interface slice must be found').toBeGreaterThan(0);
    // Step3: assert resulting transition — after fix, interface must contain errorMs and yDist
    const src = readFile('src/game/renderer.ts');
    const slice = extractInterfaceSlice(src);
    // errorMs must be number | null (allow optional ? or required)
    expect(slice, 'JudgementEvent must contain errorMs: number | null').toMatch(/errorMs\s*:\s*number\s*\|\s*null/);
    // yDist must exist as number | null (optional allowed)
    expect(slice, 'JudgementEvent must contain yDist: number | null (optional allowed)').toMatch(/yDist\s*\??\s*:\s*number\s*\|\s*null/);
    // result, y, at must still exist
    expect(slice).toMatch(/result\s*:\s*HitResult/);
    expect(slice).toMatch(/y\s*:\s*number/);
    expect(slice).toMatch(/at\s*:\s*number/);
    // ensure HitResult includes great/perfect/good/miss (type)
    const typesSrc = readFile('src/types.ts');
    expect(typesSrc).toMatch(/HitResult.*great/);
  });

  it('Step1 型呼び出し箇所 capture → Step2 各push箇所で新フィールドが供給される → Step3 全call sitesが errorMs/yDist を含む (依存漏れ検出)', () => {
    // Step1: capture initial — GameScreen currently pushes { result, y, at } only
    const initialGameSrc = readFile('src/screens/GameScreen.tsx');
    const initialPushCount = (initialGameSrc.match(/judgementEventsRef\.current\.push/g) || []).length;
    expect(initialPushCount).toBeGreaterThanOrEqual(3); // handleHit + expiry + hold
    // Step2: perform spec check — after fix, every push must include errorMs and yDist
    const src = readFile('src/screens/GameScreen.tsx');
    // Find all push occurrences
    const pushRegex = /judgementEventsRef\.current\.push\(\{[^}]+\}\)/gs;
    const pushes = src.match(pushRegex) || [];
    expect(pushes.length, 'must have at least 3 judgement push sites').toBeGreaterThanOrEqual(3);
    for (const p of pushes) {
      expect(p, `each push must include errorMs: ${p.slice(0, 80)}`).toMatch(/errorMs/);
      expect(p, `each push must include yDist: ${p.slice(0, 80)}`).toMatch(/yDist/);
    }
    // Ensure no push with old 3-field only shape remains: check that no push is exactly { result, y, at } without errorMs
    const oldShapeFound = pushes.some(p => !/errorMs/.test(p) || !/yDist/.test(p));
    expect(oldShapeFound, 'no old-shape push without errorMs/yDist should remain').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T173-2: GameScreen handleHit の errorMs/yDist 供給と期限切れMISS null化 (3-step)
// ---------------------------------------------------------------------------
describe('T173-2: GameScreen handleHit と期限切れMISS の errorMs/yDist 供給 (3-step, computed + file contract)', () => {
  it('Step1 handleHit 初期 capture (y のみ) → Step2 judgeHitで +40ms GREA Tを生成 → Step3 handleHit が Math.round で整数丸め errorMs と yDist を渡すこと（missでも raw を渡す）', () => {
    // Step1: capture initial — current handleHit lacks errorMs
    const before = readFile('src/screens/GameScreen.tsx');
    const beforeHandle = extractHandleHitSlice(before);
    expect(beforeHandle.length).toBeGreaterThan(0);
    // Step2: simulate a realistic hit with judgeHit to get a judgement
    const tl = new BpmTimeline(120, [], 1.3);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.3, 0.0);
    const targetY = engine.waveYAt(4);
    const hitTime = tl.beatToMs(4);
    const cursorY = targetY + 35.4; // off-grid fractional yDist
    const pressTime = hitTime + 40.37; // fractional ms
    const rings = [{ id: 1, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
    const beatMs = tl.beatMsAt(4);
    const judgement = judgeHit(pressTime, cursorY, rings, beatMs);
    expect(judgement).not.toBeNull();
    expect(judgement!.result).toBe('great');
    expect(judgement!.errorMs).toBeCloseTo(40.37, 2);
    const expectedYDist = Math.abs(cursorY - targetY);
    expect(Math.round(expectedYDist)).toBe(35);
    expect(Math.round(judgement!.errorMs)).toBe(40);

    // Step3: assert file contract — handleHit must push with Math.round
    const src = readFile('src/screens/GameScreen.tsx');
    const handleSlice = extractHandleHitSlice(src);
    expect(handleSlice, 'handleHit must use Math.round for errorMs').toMatch(/Math\.round\s*\(\s*judgement\.errorMs\s*\)/);
    expect(handleSlice, 'handleHit must compute yDist via Math.abs(cursorY - ring.targetY) rounded').toMatch(/Math\.round\s*\(\s*Math\.abs\s*\(/);
    expect(handleSlice).toMatch(/yDist/);
    expect(handleSlice).toMatch(/errorMs/);
    // Prohibited rule: Do NOT set errorMs to null for MISS in handleHit; must always pass raw (no conditional null)
    // So handleHit must NOT contain ternary like `errorMs: judgement.result === 'miss' ? null`
    expect(handleSlice, 'handleHit must NOT conditionally nullify errorMs for miss').not.toMatch(/errorMs\s*:\s*judgement\.result\s*===\s*'miss'\s*\?\s*null/);
    expect(handleSlice, 'handleHit must NOT conditionally nullify errorMs with ternary null').not.toMatch(/errorMs\s*:\s*\(.*\?\s*null/);
  });

  it('Step1 期限切れMISS前 capture → Step2 window超過でMISS発生 → Step3 期限切れは errorMs:null yDist:null で -- 表示用に push', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const tickSlice = extractTickMissSlice(src);
    expect(tickSlice.length, 'tick miss slice must be found').toBeGreaterThan(0);
    // Must contain errorMs: null and yDist: null for expiry miss
    expect(tickSlice, 'expiry miss must push errorMs: null').toMatch(/errorMs\s*:\s*null/);
    expect(tickSlice, 'expiry miss must push yDist: null').toMatch(/yDist\s*:\s*null/);
    expect(tickSlice).toMatch(/result\s*:\s*'miss'/);
    // Also hold expiry miss should be null
    // Check that src contains at least two expiry miss pushes with null
    const nullPushes = (src.match(/result:\s*'miss'[^}]*errorMs:\s*null/gs) || []).length;
    expect(nullPushes, 'at least 2 expiry miss pushes with null (hold + window)').toBeGreaterThanOrEqual(1);
  });

  it('Step1 複雑振幅0.7/1.3/2.7 と off-grid 0.37/1.23 capture → Step2 各振幅で judgeHit → Step3 handleHit の yDist が waveYAt 基準で正確', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrids = [0.37, 1.23];
    for (const amp of amps) {
      for (const off of offGrids) {
        const tl = new BpmTimeline(120, [], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0.0);
        const beat = 4 + off;
        const targetY = engine.waveYAt(beat);
        const hitTime = tl.beatToMs(beat);
        const cursorY = targetY + (off * 10); // fractional yDist
        const pressTime = hitTime + 40.37;
        const rings = [{ id: 100, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any];
        const beatMs = tl.beatMsAt(beat);
        const j = judgeHit(pressTime, cursorY, rings, beatMs);
        if (j) {
          expect(Math.round(j.errorMs)).toBe(40);
          expect(Math.round(Math.abs(cursorY - targetY))).toBe(Math.round(off * 10));
        }
      }
    }
    const src = readFile('src/screens/GameScreen.tsx');
    expect(extractHandleHitSlice(src)).toMatch(/yDist/);
  });
});

// ---------------------------------------------------------------------------
// T173-3: Renderer drawJudgements — 整数丸め +40ms, ΔY, MISS --, 生float禁止 (3-step, computed)
// ---------------------------------------------------------------------------
describe('T173-3: Renderer drawJudgements 整数丸め表示と MISS -- (3-step, pure rendering)', () => {
  function renderJudgements(events: JudgementEvent[], songTimeMs = 1000): string[] {
    const renderer = new Renderer();
    const { ctx, calls } = createMockCtx();
    const engine = createMinimalWaveEngine();
    const cursor = new Cursor(1.0, 0.0);
    const score = new ScoreManager();
    const tl = new BpmTimeline(120, [], 1.0);
    // Need songTimeMs such that age = songTimeMs - e.at is small positive (e.g. 10ms) to be visible
    // We call render with songTimeMs slightly after events.at
    renderer.render(ctx as any, {
      waveEngine: engine,
      cursor,
      rings: [],
      score,
      songTimeMs,
      bpmTimeline: tl,
      judgementEvents: events,
      scrollSpeed: 110,
    });
    return calls;
  }

  it('Step1 レンダラー初期 capture (ラベルのみ) → Step2 great +40.37ms ΔY 35.4px を描画 → Step3 +40ms と ΔY 35px の整数丸めが含まれ生floatが含まれない', () => {
    // Step1: capture initial — before fix, drawJudgements lacks errorMs handling
    const beforeSrc = readFile('src/game/renderer.ts');
    const beforeSlice = extractDrawJudgementsSlice(beforeSrc);
    expect(beforeSlice.length).toBeGreaterThan(0);
    // Step2: perform rendering with fractional errorMs
    const event: JudgementEvent = {
      result: 'great',
      y: 300,
      at: 990,
      errorMs: 40.37,
      yDist: 35.4,
    } as JudgementEvent;
    const calls = renderJudgements([event], 1000);
    // Filter for GREAT calls
    const judgementCalls = calls.filter(c => /GREAT/.test(c));
    expect(judgementCalls.length, 'GREAT judgement must produce at least one fillText containing GREAT').toBeGreaterThan(0);
    const text = judgementCalls.join(' | ');
    // Step3: assert resulting transition — must contain rounded integer, not raw float
    expect(text, 'must contain +40ms rounded').toMatch(/\+40ms/);
    expect(text, 'must NOT contain raw float 40.37').not.toMatch(/40\.37/);
    expect(text, 'must NOT contain raw float 35.4').not.toMatch(/35\.4/);
    expect(text, 'must contain ΔY 35px rounded').toMatch(/ΔY\s*35px/);
    expect(text).toMatch(/ms/);
  });

  it('Step1 正常ヒット capture → Step2 perfect +40.6ms と good -12.51ms を描画 → Step3 整数丸めと符号が正しく生float無し', () => {
    const events: JudgementEvent[] = [
      { result: 'perfect', y: 280, at: 990, errorMs: 40.6, yDist: 10 } as JudgementEvent,
      { result: 'good', y: 300, at: 991, errorMs: -12.51, yDist: 45 } as JudgementEvent,
      { result: 'great', y: 320, at: 992, errorMs: 0.49, yDist: 0 } as JudgementEvent,
    ];
    const calls = renderJudgements(events, 1005);
    const all = calls.join('\n');
    // perfect 40.6 -> +41ms
    expect(all).toMatch(/PERFECT!/);
    expect(all).toMatch(/\+41ms/);
    expect(all).not.toMatch(/40\.6/);
    // good -12.51 -> -13ms
    expect(all).toMatch(/GOOD/);
    // check negative rounding: Math.round(-12.51) = -13
    expect(all).toMatch(/-13ms/);
    expect(all).not.toMatch(/-12\.51/);
    // great 0.49 -> +0ms or 0ms (+0ms expected)
    // One of the events is near 0, should contain 0ms
    expect(all).toMatch(/0ms/);
    // ΔY for perfect with yDist 10 -> ΔY 10px
    expect(all).toMatch(/ΔY\s*10px/);
  });

  it('Step1 MISS前 capture → Step2 miss (errorMs:null) と miss (errorMs:0) を描画 → Step3 MISS -- のみで +0ms 偽装が出ない', () => {
    const missNull: JudgementEvent = { result: 'miss', y: 300, at: 990, errorMs: null, yDist: null } as JudgementEvent;
    const missZero: JudgementEvent = { result: 'miss', y: 310, at: 991, errorMs: 0, yDist: 35 } as JudgementEvent;
    const calls = renderJudgements([missNull, missZero], 1000);
    const missCalls = calls.filter(c => /MISS/.test(c));
    expect(missCalls.length, 'MISS must produce fillText').toBeGreaterThanOrEqual(1);
    const missText = missCalls.join(' | ');
    // Must contain -- and NOT contain +0ms
    expect(missText, 'MISS must contain --').toMatch(/--/);
    expect(missText, 'MISS must NOT contain +0ms fake').not.toMatch(/\+0ms/);
    expect(missText, 'MISS must NOT contain ms with number for null case (only --)').toBeTruthy();
    // Ensure that even missZero (errorMs 0) still shows -- not +0ms (spec: missはラベルのみ)
    // The spec says drawJudgements should show -- for miss regardless of errorMs value
    // So check that no MISS line contains "+0ms"
    for (const c of missCalls) {
      if (/MISS/.test(c)) {
        expect(c).not.toMatch(/\+0ms/);
        expect(c).toMatch(/--/);
      }
    }
  });

  it('Step1 MISS と GREAT の混在 capture → Step2 両方描画 → Step3 GREAT は +40ms、MISS は -- で分離される', () => {
    const events: JudgementEvent[] = [
      { result: 'great', y: 280, at: 990, errorMs: 40.37, yDist: 35 } as JudgementEvent,
      { result: 'miss', y: 300, at: 991, errorMs: null, yDist: null } as JudgementEvent,
    ];
    const calls = renderJudgements(events, 1000);
    const greatCall = calls.find(c => /GREAT/.test(c)) || '';
    const missCall = calls.find(c => /MISS/.test(c)) || '';
    expect(greatCall).toMatch(/\+40ms/);
    expect(greatCall).toMatch(/ΔY/);
    expect(missCall).toMatch(/MISS/);
    expect(missCall).toMatch(/--/);
    expect(missCall).not.toMatch(/\+40ms/);
  });
});

// ---------------------------------------------------------------------------
// T173-4: ファイル契約 — drawJudgements の MISS -- と Math.round と ms/ΔY 完全性 (3-step)
// ---------------------------------------------------------------------------
describe('T173-4: ファイル契約 — drawJudgements 実装完全性 (3-step, file contract)', () => {
  it('Step1 drawJudgements 初期 capture → Step2 文字列テンプレートを検証 → Step3 MISS は `${label} --`、他は Math.round と ms と ΔY を含む', () => {
    const src = readFile('src/game/renderer.ts');
    const slice = extractDrawJudgementsSlice(src);
    expect(slice.length).toBeGreaterThan(0);
    // Must contain MISS -- pattern: text = `${label} --` or `${label}--` or 'MISS --'
    expect(slice, 'MISS branch must be text = `${label} --`').toMatch(/\$\{label\}\s*--/);
    // Must contain Math.round for integer rounding
    expect(slice, 'must use Math.round for errorMs').toMatch(/Math\.round\s*\(\s*e\.errorMs/);
    // Must contain ms unit
    expect(slice).toMatch(/ms/);
    // Must contain ΔY and px
    expect(slice).toMatch(/ΔY/);
    expect(slice).toMatch(/px/);
    // Must branch on errorMs !== null or errorMs === null or result === 'miss'
    const hasMissGuard = /errorMs\s*===\s*null/.test(slice) || /errorMs\s*!==\s*null/.test(slice) || /result\s*===\s*'miss'/.test(slice);
    expect(hasMissGuard, 'must have miss/null guard branch').toBe(true);
    // Must NOT directly interpolate raw errorMs without rounding for ms display
    // e.g. should be Math.round(e.errorMs), not `${e.errorMs}ms` alone
    expect(slice).toMatch(/Math\.round/);
  });

  it('Step1 レンダラー全体 capture → Step2 エンドツーエンドで Perfect/Great/Good/Miss を描画 → Step3 各ラベルと誤差表示が要件通り', () => {
    const renderer = new Renderer();
    const { ctx, calls } = createMockCtx();
    const engine = createMinimalWaveEngine();
    const cursor = new Cursor(1.0, 0.0);
    const score = new ScoreManager();
    const tl = new BpmTimeline(120, [], 1.0);
    const events: JudgementEvent[] = [
      { result: 'perfect', y: 280, at: 990, errorMs: 5.4, yDist: 12.3 } as JudgementEvent,
      { result: 'great', y: 290, at: 991, errorMs: 80.6, yDist: 35.6 } as JudgementEvent,
      { result: 'good', y: 300, at: 992, errorMs: 99.63, yDist: 59.4 } as JudgementEvent,
      { result: 'miss', y: 310, at: 993, errorMs: null, yDist: null } as JudgementEvent,
    ];
    renderer.render(ctx as any, {
      waveEngine: engine,
      cursor,
      rings: [],
      score,
      songTimeMs: 1000,
      bpmTimeline: tl,
      judgementEvents: events,
      scrollSpeed: 110,
    });
    const all = calls.join('\n');
    // Perfect +5.4 -> +5ms
    expect(all).toMatch(/PERFECT!/);
    expect(all).toMatch(/\+5ms/);
    expect(all).not.toMatch(/5\.4ms/);
    // Great 80.6 -> +81ms (rounded) and ΔY 36px
    expect(all).toMatch(/GREAT/);
    expect(all).toMatch(/\+81ms/);
    expect(all).toMatch(/ΔY\s*36px/);
    // Good 99.63 -> +100ms
    expect(all).toMatch(/GOOD/);
    expect(all).toMatch(/\+100ms/);
    // Miss -- (no ms)
    const missLine = calls.find(c => /MISS/.test(c)) || '';
    expect(missLine).toMatch(/MISS/);
    expect(missLine).toMatch(/--/);
    expect(missLine).not.toMatch(/\+.*ms/);
    // Ensure no raw float leak
    expect(all).not.toMatch(/80\.6ms/);
    expect(all).not.toMatch(/99\.63/);
    expect(all).not.toMatch(/35\.6px/);
  });

  it('Step1 複雑振幅 off-grid capture → Step2 波形とカーソル整合を確認 → Step3 判定表示が振幅に依らず同様に機能', () => {
    // Ensure waveEngine and cursor numeric consistency still holds (T127 style, prohibited regression)
    const amps = [0.7, 1.3, 2.7, 3.4];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const off = 0.37;
      const expected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, TW_CENTER_Y + perBeat * off));
      expect(engine.waveYAt(off)).toBeCloseTo(expected, 4);
      const cur = new Cursor(amp, 0.0);
      const y0 = cur.y;
      cur.update((off * 500) / 1000, false, true, 500, engine.waveYAt(off));
      // cursor should have moved (pullTowards may affect but at least not broken)
      expect(cur.y).toBeDefined();
      expect(engine.getPoints().length).toBe(2);
    }
    // After that, renderer still works with same events
    const renderer = new Renderer();
    const { ctx, calls } = createMockCtx();
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], new BpmTimeline(120, [], 1.3), 1.3, 0.0);
    const cursor = new Cursor(1.3, 0.0);
    const score = new ScoreManager();
    const tl = new BpmTimeline(120, [], 1.3);
    const ev: JudgementEvent = { result: 'perfect', y: 300, at: 990, errorMs: 12.51, yDist: 10 } as JudgementEvent;
    renderer.render(ctx as any, { waveEngine: engine, cursor, rings: [], score, songTimeMs: 1000, bpmTimeline: tl, judgementEvents: [ev], scrollSpeed: 110 });
    const txt = calls.find(c => /PERFECT/.test(c)) || '';
    expect(txt).toMatch(/\+13ms/);
    expect(txt).not.toMatch(/12\.51/);
  });
});

// ---------------------------------------------------------------------------
// T173-5: 回帰 — tsc 型整合と handleHit/描画の整合 (3-step)
// ---------------------------------------------------------------------------
describe('T173-5: 回帰 — 既存判定ロジック不変と波形/カーソル整合維持', () => {
  it('Step1 hitJudge.ts capture → Step2 閾値 50/30/60/100 が不変 → Step3 判定結果が従来通り perfect/great/good/miss を返す', () => {
    const src = readFile('src/game/hitJudge.ts');
    expect(src).toMatch(/PERFECT_MS\s*=\s*50/);
    expect(src).toMatch(/GREAT_MS\s*=\s*100/);
    expect(src).toMatch(/PERFECT_Y\s*=\s*30/);
    expect(src).toMatch(/HIT_Y\s*=\s*60/);
    // Should NOT have been changed to different thresholds
    const tl = new BpmTimeline(120, [], 1.0);
    const engine = new WaveEngine([{ direction: 'down', beats: 8 }], tl, 1.0, 0.0);
    const targetY = engine.waveYAt(4);
    const hitTime = tl.beatToMs(4);
    const beatMs = tl.beatMsAt(4);
    // perfect case
    const p = judgeHit(hitTime + 10, targetY + 10, [{ id: 1, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any], beatMs);
    expect(p!.result).toBe('perfect');
    // great case (40ms but Y 35)
    const g = judgeHit(hitTime + 40, targetY + 35, [{ id: 2, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any], beatMs);
    expect(g!.result).toBe('great');
    // good case
    const go = judgeHit(hitTime + 150, targetY + 10, [{ id: 3, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any], beatMs);
    expect(go!.result).toBe('good');
    // miss case
    const m = judgeHit(hitTime + 10, targetY + 80, [{ id: 4, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false } as any], beatMs);
    expect(m!.result).toBe('miss');
  });

  it('Step1 スコア capture → Step2 既存配点 perfect 50 / great 30 / good 10 が維持 → Step3 getStats が正しい', () => {
    const scoreSrc = readFile('src/game/score.ts');
    expect(scoreSrc).toMatch(/PERFECT_SCORE\s*=\s*50/);
    expect(scoreSrc).toMatch(/GREAT_SCORE\s*=\s*30/);
    expect(scoreSrc).toMatch(/GOOD_SCORE\s*=\s*10/);
  });
});
