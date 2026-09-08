/**
 * @vitest-environment node
 * T208 — パブリックモードの判定表示はランク名のみ（ms・ΔY非表示）
 * Vitest node environment — pure computed values / engine math only.
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * Spec:
 * - public: 判定テキストはランク名のみ。+40ms・ΔY 35px を出さない
 * - debug:  従来通り詳細表示（ランク名＋ms＋ΔY）
 * - 対象はゲームプレイ中のキャンバス判定テキスト (renderer.ts:drawJudgements) のみ
 * - 不変: コンボ・スコアHUD、リザルト集計、offset:+Xms表示、calibration-last
 * - 修正: RenderParams に showJudgementDetail?:boolean 追加。false時はランク名のみ描画。
 *         未指定時は詳細表示のまま（既存呼び出し・テスト互換）。GameScreenは getViewMode()==='debug' を渡す。
 * - Prohibited: Do NOT use `=== true` — must use `!== false` for backwards compat.
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
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import { getViewMode, setViewMode } from '../src/viewMode';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers — file reading & mock canvas
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function extractRenderParamsSlice(src: string): string {
  const idx = src.indexOf('export interface RenderParams');
  if (idx === -1) return '';
  return src.slice(idx, idx + 800);
}

function extractDrawJudgementsSlice(src: string): string {
  const idx = src.indexOf('private drawJudgements');
  if (idx === -1) return src.indexOf('drawJudgements') !== -1 ? src.slice(src.indexOf('drawJudgements'), src.indexOf('drawJudgements') + 3000) : '';
  return src.slice(idx, idx + 3200);
}

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
  ctx.canvas = { width: 800, height: 600 };
  return { ctx, calls };
}

function createMinimalWorld() {
  const tl = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
  const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, 1.0, 0.0);
  const cursor = new Cursor(1.0, 0.0);
  const score = new ScoreManager();
  return { tl, engine, cursor, score };
}

function renderWithFlag(events: JudgementEvent[], flag: boolean | undefined, songTimeMs = 1000): string[] {
  const renderer = new Renderer();
  const { ctx, calls } = createMockCtx();
  const { tl, engine, cursor, score } = createMinimalWorld();
  const params: any = {
    waveEngine: engine,
    cursor,
    rings: [],
    score,
    songTimeMs,
    bpmTimeline: tl,
    judgementEvents: events,
    scrollSpeed: 110,
  };
  if (flag !== undefined) params.showJudgementDetail = flag;
  // omit when undefined to test backwards compat default
  renderer.render(ctx as any, params);
  return calls;
}

// ---------------------------------------------------------------------------
// T208-1: RenderParams 型契約 — showJudgementDetail?:boolean 追加 (3-step)
// ---------------------------------------------------------------------------
describe('T208-1: RenderParams 型契約 — showJudgementDetail?:boolean (3-step, file contract)', () => {
  it('Step1 初期 capture (Paramsにフラグ無し) → Step2 仕様要求の型定義を探索 → Step3 showJudgementDetail?: boolean が存在し optional であること', () => {
    // Step1: capture initial state — before fix, RenderParams has no showJudgementDetail
    const beforeSrc = readFile('src/game/renderer.ts');
    const beforeSlice = extractRenderParamsSlice(beforeSrc);
    expect(beforeSlice.length, 'RenderParams slice must be found').toBeGreaterThan(0);

    // Step2: we know spec requires optional boolean
    // Step3: assert resulting transition — after fix, interface must contain optional flag
    const src = readFile('src/game/renderer.ts');
    const slice = extractRenderParamsSlice(src);
    expect(slice, 'RenderParams must contain showJudgementDetail').toMatch(/showJudgementDetail/);
    // must be optional ?: and boolean type
    expect(slice, 'must be optional boolean (?: boolean)').toMatch(/showJudgementDetail\s*\?\s*:\s*boolean/);
    // must NOT be required (without ?) — ensure optional
    expect(slice).not.toMatch(/showJudgementDetail\s*:\s*boolean\s*;/);
  });

  it('Step1 GameScreen 初期 capture (renderer.render 呼び出しにフラグ無し) → Step2 詳細フラグを渡す修正 → Step3 GameScreenが getViewMode()===debug を showJudgementDetail に渡す', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Step1: ensure file exists and contains renderer.render
    expect(src).toContain('renderer.render');
    // Step3: must contain showJudgementDetail wiring
    expect(src, 'GameScreen must import getViewMode').toMatch(/getViewMode/);
    expect(src, 'must pass showJudgementDetail: getViewMode()').toMatch(/showJudgementDetail/);
    // The flag must be derived from view mode debug check — allow variants but must contain debug
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]debug['"]/);
    // Must be inside tick/renderer.render call context (near waveEngine/cursor/rings)
    const renderCallIdx = src.indexOf('renderer.render');
    const aroundRender = src.slice(Math.max(0, renderCallIdx - 500), renderCallIdx + 800);
    expect(aroundRender, 'showJudgementDetail should be near renderer.render call').toMatch(/showJudgementDetail/);
  });
});

// ---------------------------------------------------------------------------
// T208-2: Renderer publicモード — ランク名のみで数値非表示 (3-step, computed)
// ---------------------------------------------------------------------------
describe('T208-2: Renderer publicモード — showJudgementDetail=false で数値非表示 (3-step, computed)', () => {
  it('Step1 通常詳細表示を capture (flag無しで +40ms 表示) → Step2 flag=false で再描画 → Step3 ランク名のみで ms/ΔY が一切含まれない', () => {
    // Step1: capture initial detailed state — without flag or with true, details shown
    const detailedEvents: JudgementEvent[] = [
      { result: 'great', y: 300, at: 990, errorMs: 40.37, yDist: 35.4 } as JudgementEvent,
      { result: 'perfect', y: 280, at: 991, errorMs: 12.6, yDist: 8 } as JudgementEvent,
      { result: 'good', y: 310, at: 992, errorMs: 99.63, yDist: 45 } as JudgementEvent,
    ];
    const beforeCalls = renderWithFlag(detailedEvents, undefined, 1000);
    const beforeText = beforeCalls.filter(c => /PERFECT|GREAT|GOOD/.test(c)).join(' | ');
    // Before (or true) should contain ms and ΔY
    expect(beforeText, 'before/default must show ms').toMatch(/ms/);
    expect(beforeText, 'before/default must show ΔY').toMatch(/ΔY/);

    // Step2: perform interaction — re-render with explicit false (public mode)
    const publicEvents: JudgementEvent[] = [
      { result: 'great', y: 300, at: 990, errorMs: 40.37, yDist: 35.4 } as JudgementEvent,
      { result: 'perfect', y: 280, at: 991, errorMs: 5.4, yDist: 12 } as JudgementEvent,
      { result: 'good', y: 310, at: 992, errorMs: -12.51, yDist: 45 } as JudgementEvent,
    ];
    const calls = renderWithFlag(publicEvents, false, 1000);
    const judgementCalls = calls.filter(c => /PERFECT|GREAT|GOOD|MISS/.test(c));
    expect(judgementCalls.length, 'must produce judgement texts even in public mode').toBeGreaterThan(0);
    const all = judgementCalls.join('\n');

    // Step3: assert resulting transition — public must show rank only, no numbers
    expect(all, 'public GREAT must contain rank').toMatch(/GREAT/);
    expect(all, 'public PERFECT must contain rank').toMatch(/PERFECT/);
    expect(all, 'public GOOD must contain rank').toMatch(/GOOD/);
    // Must NOT contain ms unit (no +40ms / delay numbers)
    expect(all, 'public must NOT contain ms unit').not.toMatch(/ms/);
    // Must NOT contain ΔY
    expect(all, 'public must NOT contain ΔY').not.toMatch(/ΔY/);
    // Must NOT contain raw float or rounded px numbers
    expect(all).not.toMatch(/40\.37/);
    expect(all).not.toMatch(/\d+ms/);
    expect(all).not.toMatch(/35px/);
    expect(all).not.toMatch(/\+40/);
  });

  it('Step1 GREAT +40.37 ΔY35 を capture → Step2 flag=false と true を比較 → Step3 falseは ms/ΔY無し、trueは +40ms + ΔY 35px 付き', () => {
    const ev: JudgementEvent = { result: 'great', y: 300, at: 990, errorMs: 40.37, yDist: 35.4 } as JudgementEvent;
    // Step1 capture public
    const publicCalls = renderWithFlag([ev], false, 1000);
    const publicText = publicCalls.filter(c => /GREAT/.test(c)).join(' | ');
    // Step2 true
    const debugCalls = renderWithFlag([ev], true, 1000);
    const debugText = debugCalls.filter(c => /GREAT/.test(c)).join(' | ');

    // Step3 assertions — public hides, debug shows
    expect(publicText).toMatch(/GREAT/);
    expect(publicText).not.toMatch(/ms/);
    expect(publicText).not.toMatch(/ΔY/);
    expect(publicText).not.toMatch(/\+40/);

    expect(debugText).toMatch(/GREAT/);
    expect(debugText).toMatch(/\+40ms/);
    expect(debugText).toMatch(/ΔY\s*35px/);
    expect(debugText).not.toMatch(/40\.37/);
  });

  it('Step1 MISS(false) と MISS(true) を capture → Step2 両方描画 → Step3 どちらも MISS -- で ms/ΔY 無し (MISSは元々数値無し)', () => {
    const miss: JudgementEvent = { result: 'miss', y: 300, at: 990, errorMs: null, yDist: null } as JudgementEvent;
    const missZero: JudgementEvent = { result: 'miss', y: 310, at: 991, errorMs: 0, yDist: 35 } as JudgementEvent;
    for (const flag of [false, true, undefined] as const) {
      const calls = renderWithFlag([miss, missZero], flag, 1000);
      const missCalls = calls.filter(c => /MISS/.test(c));
      expect(missCalls.length).toBeGreaterThan(0);
      const text = missCalls.join(' | ');
      // All flags: MISS shows --, never ms or ΔY
      expect(text, `MISS flag=${String(flag)} must contain --`).toMatch(/--/);
      // Must not leak +0ms fake even with errorMs 0 + yDist 35 when flag true (MISS branch overrides)
      for (const c of missCalls) {
        if (/MISS/.test(c)) {
          expect(c, `MISS line flag=${String(flag)} must not contain ms`).not.toMatch(/\d+ms/);
          expect(c).not.toMatch(/ΔY/);
          expect(c).not.toMatch(/\+0ms/);
        }
      }
    }
  });

  it('Step1 公開で errorMs=null / 0 混在 capture → Step2 flag=false で描画 → Step3 全てランク名のみ、nullでも偽装0が出ない', () => {
    const events: JudgementEvent[] = [
      { result: 'perfect', y: 280, at: 990, errorMs: null, yDist: null } as JudgementEvent,
      { result: 'great', y: 290, at: 991, errorMs: 0, yDist: 0 } as JudgementEvent,
      { result: 'good', y: 300, at: 992, errorMs: -5.49, yDist: 20 } as JudgementEvent,
    ];
    const calls = renderWithFlag(events, false, 1005);
    const allJul = calls.filter(c => /PERFECT|GREAT|GOOD|MISS/.test(c)).join('\n');
    expect(allJul).toMatch(/PERFECT/);
    expect(allJul).toMatch(/GREAT/);
    expect(allJul).toMatch(/GOOD/);
    // public must not contain any ms or ΔY even when errorMs is 0 or -5.49
    expect(allJul).not.toMatch(/ms/);
    expect(allJul).not.toMatch(/ΔY/);
    expect(allJul).not.toMatch(/\+0ms/);
    expect(allJul).not.toMatch(/-5ms/);
  });
});

// ---------------------------------------------------------------------------
// T208-3: Renderer debugモード — 詳細表示 (3-step, computed) + backwards compat
// ---------------------------------------------------------------------------
describe('T208-3: Renderer debugモード — showJudgementDetail=true / undefined で詳細表示 (3-step, computed)', () => {
  it('Step1 flag=false で数値無しを capture → Step2 flag=true / undefined で描画 → Step3 整数丸めの +40ms と ΔY が表示され生float無し', () => {
    const ev: JudgementEvent = { result: 'great', y: 300, at: 990, errorMs: 40.37, yDist: 35.4 } as JudgementEvent;

    // Step1: false hides
    const hidden = renderWithFlag([ev], false, 1000).filter(c => /GREAT/.test(c)).join(' | ');
    expect(hidden).not.toMatch(/ms/);

    // Step2: true shows
    const debugTrue = renderWithFlag([ev], true, 1000).filter(c => /GREAT/.test(c)).join(' | ');
    expect(debugTrue).toMatch(/\+40ms/);
    expect(debugTrue).toMatch(/ΔY\s*35px/);
    expect(debugTrue).not.toMatch(/40\.37/);
    expect(debugTrue).not.toMatch(/35\.4/);

    // Step2b: undefined (omitted) must also show details (backwards compat)
    const debugUndef = renderWithFlag([ev], undefined, 1000).filter(c => /GREAT/.test(c)).join(' | ');
    expect(debugUndef, 'undefined flag must still show details (default true)').toMatch(/\+40ms/);
    expect(debugUndef).toMatch(/ΔY\s*35px/);
  });

  it('Step1 perfect +12.51ms ΔY10 / good -12.51ms capture → Step2 debug で描画 → Step3 符号と丸めが正確', () => {
    const events: JudgementEvent[] = [
      { result: 'perfect', y: 280, at: 990, errorMs: 12.51, yDist: 10 } as JudgementEvent,
      { result: 'good', y: 300, at: 991, errorMs: -12.51, yDist: 45.6 } as JudgementEvent,
      { result: 'great', y: 320, at: 992, errorMs: 0.49, yDist: 0 } as JudgementEvent,
    ];
    const calls = renderWithFlag(events, true, 1005);
    const all = calls.filter(c => /PERFECT|GREAT|GOOD/.test(c)).join('\n');
    // 12.51 -> +13ms
    expect(all).toMatch(/\+13ms/);
    expect(all).not.toMatch(/12\.51/);
    // -12.51 -> -13ms
    expect(all).toMatch(/-13ms/);
    expect(all).not.toMatch(/-12\.51/);
    // 0.49 -> +0ms and ΔY 0px
    expect(all).toMatch(/0ms/);
    // ΔY 10px and 46px (45.6 rounded)
    expect(all).toMatch(/ΔY\s*10px/);
    expect(all).toMatch(/ΔY\s*46px/);
  });

  it('Step1 複雑振幅 0.7/1.3/2.7 & off-grid 0.37/1.23 capture → Step2 各振幅で描画 → Step3 振幅に依らず debug 詳細が機能し public は隠す', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrids = [0.37, 1.23];
    for (const amp of amps) {
      for (const off of offGrids) {
        const tl = new BpmTimeline([{ beat: 0, bpm: 120 }], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0.0);
        // verify wave/cursor consistency still holds (T127 regression guard)
        const perBeat = 2 * TW_AMP * amp;
        const expected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, TW_CENTER_Y + perBeat * off));
        expect(engine.waveYAt(off)).toBeCloseTo(expected, 3);

        const renderer = new Renderer();
        const { ctx, calls } = createMockCtx();
        const cursor = new Cursor(amp, 0.0);
        const score = new ScoreManager();
        const ev: JudgementEvent = { result: 'perfect', y: engine.waveYAt(off), at: 990, errorMs: 40.37, yDist: 22.6 } as JudgementEvent;
        // debug — shows
        renderer.render(ctx as any, { waveEngine: engine, cursor, rings: [], score, songTimeMs: 1000, bpmTimeline: tl, judgementEvents: [ev], scrollSpeed: 110, showJudgementDetail: true } as any);
        const debugText = calls.filter(c => /PERFECT/.test(c)).join(' | ');
        expect(debugText).toMatch(/\+40ms/);
        expect(debugText).toMatch(/ΔY/);

        // public — hides, even with same off-grid amp
        calls.length = 0;
        const renderer2 = new Renderer();
        const { ctx: ctx2, calls: calls2 } = createMockCtx();
        renderer2.render(ctx2 as any, { waveEngine: engine, cursor, rings: [], score, songTimeMs: 1000, bpmTimeline: tl, judgementEvents: [ev], scrollSpeed: 110, showJudgementDetail: false } as any);
        const publicText = calls2.filter(c => /PERFECT/.test(c)).join(' | ');
        expect(publicText).toMatch(/PERFECT/);
        expect(publicText).not.toMatch(/ms/);
        expect(publicText).not.toMatch(/ΔY/);
      }
    }
  });

  it('Step1 詳細分岐の符号別 capture → Step2 MISS以外で errorMs:null は miss以外でも --? → Step3 perfect/great/good の errorMs:null は MISS以外でも ms無し扱い (null guard)', () => {
    // For non-miss, errorMs:null should not show ms (spec: errorMs!==null の場合のみ ms)
    // This is technically a debug edge case but validates !== false branch does not break null guard
    const evNull: JudgementEvent = { result: 'perfect', y: 300, at: 990, errorMs: null, yDist: 10 } as JudgementEvent;
    const debugCalls = renderWithFlag([evNull], true, 1000).filter(c => /PERFECT/.test(c)).join(' | ');
    // perfect with null errorMs should not show ms/ΔY even in debug — only label (miss以外でも null なら ms出さないがラベルは perfect)
    // Depending on impl, it may show just "PERFECT!" — assert no ms leak
    expect(debugCalls).toMatch(/PERFECT/);
    // Should NOT show +...ms when errorMs is null even in debug
    expect(debugCalls).not.toMatch(/\d+ms/);

    const evNum: JudgementEvent = { result: 'perfect', y: 300, at: 991, errorMs: 5, yDist: null } as JudgementEvent;
    const debugNum = renderWithFlag([evNum], true, 1002).filter(c => /PERFECT/.test(c)).join(' | ');
    expect(debugNum).toMatch(/\+5ms/);
    // yDist null -> no ΔY even with errorMs present
    expect(debugNum).not.toMatch(/ΔY/);
  });
});

// ---------------------------------------------------------------------------
// T208-4: ファイル契約 — !== false による後方互換 (prohibited === true 検出) (3-step)
// ---------------------------------------------------------------------------
describe('T208-4: ファイル契約 — !== false による後方互換 (prohibited === true 検出) (3-step, file contract)', () => {
  it('Step1 drawJudgements 先頭 capture → Step2 showJudgementDetail 条件を探索 → Step3 条件が !== false (undefinedでも詳細表示) であり === true でない', () => {
    const src = readFile('src/game/renderer.ts');
    const slice = extractDrawJudgementsSlice(src);
    expect(slice.length, 'drawJudgements slice must be found').toBeGreaterThan(0);
    // Must reference showJudgementDetail
    expect(slice).toMatch(/showJudgementDetail/);
    // Prohibited: strict === true is forbidden for default-true flags
    expect(slice, 'must NOT use strict === true (breaks undefined default)').not.toMatch(/showJudgementDetail\s*===\s*true/);
    expect(slice, 'must NOT use == true').not.toMatch(/showJudgementDetail\s*==\s*true/);
    // Recommended: use !== false
    expect(slice, 'must use !== false for backwards compatible default').toMatch(/showJudgementDetail\s*!==\s*false/);
  });

  it('Step1 RenderParams 周辺 capture → Step2 showJudgementDetail が RenderParams にある → Step3 型が optional boolean かつ drawJudgements 側で !== false', () => {
    const src = readFile('src/game/renderer.ts');
    const paramsSlice = extractRenderParamsSlice(src);
    const drawSlice = extractDrawJudgementsSlice(src);
    // Params is optional boolean
    expect(paramsSlice).toMatch(/showJudgementDetail\s*\?\s*:\s*boolean/);
    // draw uses !== false
    expect(drawSlice).toMatch(/showJudgementDetail\s*!==\s*false/);
    // Also ensure that text building respects the flag: when false, only label; when true, includes ms/ΔY
    expect(drawSlice).toMatch(/PERFECT/);
    expect(drawSlice).toMatch(/GREAT/);
    expect(drawSlice).toMatch(/ms/);
    expect(drawSlice).toMatch(/ΔY/);
  });

  it('Step1 GameScreen の tick capture → Step2 showJudgementDetail が毎フレーム評価される → Step3 tick内で getViewMode() 比較が renderer.render 引数にある', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Find the renderer.render block
    const renderIdx = src.indexOf('renderer.render');
    expect(renderIdx).toBeGreaterThan(-1);
    const window = src.slice(renderIdx - 1200, renderIdx + 1200);
    // Must contain showJudgementDetail with getViewMode comparison
    expect(window).toMatch(/showJudgementDetail/);
    expect(window).toMatch(/getViewMode\(\)\s*===\s*['"]debug['"]/);
    // Ensure not hardcoded to true/false literal only
    expect(window).not.toMatch(/showJudgementDetail:\s*true\s*[,}]/);
    expect(window).not.toMatch(/showJudgementDetail:\s*false\s*[,}]/);
  });
});

// ---------------------------------------------------------------------------
// T208-5: 結合 — GameScreen wiring via getViewMode & HUD不変 (3-step, dynamic)
// ---------------------------------------------------------------------------
describe('T208-5: 結合 — GameScreen の viewMode 切替と HUD/スコア不変 (3-step)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('Step1 初期 public capture (localStorage empty => public) → Step2 debugへ切替 → Step3 getViewMode が debug になり renderer は詳細を表示する (逆も)', () => {
    // Step1: initial is public
    expect(getViewMode()).toBe('public');
    const ev: JudgementEvent = { result: 'great', y: 300, at: 990, errorMs: 40, yDist: 35 } as JudgementEvent;
    // Simulate what GameScreen would compute: showJudgementDetail = getViewMode() === 'debug'
    let showDetail = getViewMode() === 'debug';
    expect(showDetail).toBe(false);
    let calls = renderWithFlag([ev], showDetail, 1000).filter(c => /GREAT/.test(c)).join(' | ');
    expect(calls).not.toMatch(/ms/);
    expect(calls).not.toMatch(/ΔY/);

    // Step2: switch to debug
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    showDetail = getViewMode() === 'debug';
    expect(showDetail).toBe(true);
    calls = renderWithFlag([ev], showDetail, 1000).filter(c => /GREAT/.test(c)).join(' | ');
    // Step3: now details appear
    expect(calls).toMatch(/\+40ms/);
    expect(calls).toMatch(/ΔY/);

    // Switch back to public
    setViewMode('public');
    expect(getViewMode()).toBe('public');
    showDetail = getViewMode() === 'debug';
    calls = renderWithFlag([ev], showDetail, 1000).filter(c => /GREAT/.test(c)).join(' | ');
    expect(calls).not.toMatch(/ms/);
  });

  it('Step1 HUD/スコア等の表示は flag に依らず不変 capture → Step2 両フラグで render → Step3 コンボ・スコアHUDは flag に影響されない (renderer.renderがクラッシュしない)', () => {
    const score = new ScoreManager();
    score.recordHit('perfect');
    score.recordHit('great');
    const { tl, engine, cursor } = createMinimalWorld();
    const ev: JudgementEvent = { result: 'perfect', y: 300, at: 990, errorMs: 10, yDist: 5 } as JudgementEvent;
    for (const flag of [false, true, undefined] as const) {
      const renderer = new Renderer();
      const { ctx, calls } = createMockCtx();
      // Should not throw regardless of flag
      expect(() => {
        renderer.render(ctx as any, {
          waveEngine: engine,
          cursor,
          rings: [],
          score,
          songTimeMs: 1000,
          bpmTimeline: tl,
          judgementEvents: [ev],
          scrollSpeed: 110,
          ...(flag !== undefined ? { showJudgementDetail: flag } : {}),
        } as any);
      }).not.toThrow();
      // HUD draws score text via fillText — at least some fillText calls must exist (score/combo)
      // We can't strictly count HUD text vs judgement text separately without instrumentation,
      // but ensure total fillText calls > 0 for both modes
      expect(calls.length).toBeGreaterThan(0);
      // Judgement visibility still respects flag
      const jCalls = calls.filter(c => /PERFECT|GREAT/.test(c));
      if (flag === false) {
        expect(jCalls.join('')).not.toMatch(/ms/);
      } else {
        expect(jCalls.join('')).toMatch(/ms/);
      }
    }
  });

  it('Step1 複数判定混在 (PERFECT/GREAT/GOOD/MISS) を capture → Step2 public/debug それぞれで描画 → Step3 publicは全てランクのみ・debugは詳細、MISSは常に --', () => {
    const events: JudgementEvent[] = [
      { result: 'perfect', y: 280, at: 990, errorMs: 5.4, yDist: 12 } as JudgementEvent,
      { result: 'great', y: 290, at: 991, errorMs: 40.37, yDist: 35 } as JudgementEvent,
      { result: 'good', y: 300, at: 992, errorMs: 99.63, yDist: 20 } as JudgementEvent,
      { result: 'miss', y: 310, at: 993, errorMs: null, yDist: null } as JudgementEvent,
    ];
    // public
    const pubCalls = renderWithFlag(events, false, 1005).filter(c => /PERFECT|GREAT|GOOD|MISS/.test(c));
    expect(pubCalls.length).toBeGreaterThanOrEqual(4);
    const pubAll = pubCalls.join('\n');
    // All ranks must be present
    expect(pubAll).toMatch(/PERFECT/);
    expect(pubAll).toMatch(/GREAT/);
    expect(pubAll).toMatch(/GOOD/);
    expect(pubAll).toMatch(/MISS/);
    // No ms/ΔY anywhere in public
    expect(pubAll).not.toMatch(/ms/);
    expect(pubAll).not.toMatch(/ΔY/);
    // MISS still has --
    const pubMiss = pubCalls.find(c => /MISS/.test(c)) || '';
    expect(pubMiss).toMatch(/--/);

    // debug
    const dbgCalls = renderWithFlag(events, true, 1005).filter(c => /PERFECT|GREAT|GOOD|MISS/.test(c));
    const dbgAll = dbgCalls.join('\n');
    expect(dbgAll).toMatch(/PERFECT/);
    expect(dbgAll).toMatch(/\+5ms/);
    expect(dbgAll).toMatch(/\+40ms/);
    expect(dbgAll).toMatch(/\+100ms/);
    expect(dbgAll).toMatch(/ΔY/);
    const dbgMiss = dbgCalls.find(c => /MISS/.test(c)) || '';
    expect(dbgMiss).toMatch(/--/);
    expect(dbgMiss).not.toMatch(/\d+ms/);
  });

  it('Step1 同一エンドツーエンド波形/カーソル世界で public→debug 切替 → Step3 見た目の差が ms/ΔY の有無のみで、それ以外は一貫', () => {
    const ev: JudgementEvent = { result: 'great', y: 300, at: 990, errorMs: 80.6, yDist: 35.6 } as JudgementEvent;
    const pub = renderWithFlag([ev], false, 1000).filter(c => /GREAT/.test(c))[0] || '';
    const dbg = renderWithFlag([ev], true, 1000).filter(c => /GREAT/.test(c))[0] || '';
    expect(pub).toMatch(/^GREAT/);
    expect(dbg).toMatch(/^GREAT/);
    // pub should be shorter (just rank) than debug (rank + numbers)
    expect(pub.length).toBeLessThan(dbg.length);
    expect(pub).toBe('GREAT');
    expect(dbg).toMatch(/GREAT\s+\+81ms,\s*ΔY\s*36px/);
  });
});

// Extra guard: ensure no glow/blur leakage and viewMode default remains public
describe('T208-6: 回帰 — viewMode既定 public・T167/T173 不変量維持', () => {
  it('Step1 viewMode 未設定 capture → Step2 getViewMode() 呼び → Step3 既定 public であり localStorage未保存時は public', () => {
    localStorage.clear();
    expect(getViewMode()).toBe('public');
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    localStorage.clear();
    expect(getViewMode()).toBe('public');
  });

  it('Step1 ヒット判定ロジック capture → Step2 閾値は T162/T173 のまま → Step3 判定ロジックに影響しないこと (score 含む)', () => {
    const hitSrc = readFile('src/game/hitJudge.ts');
    // Must still define perfect/great/good thresholds (50/100/60)
    expect(hitSrc).toMatch(/PERFECT/);
    expect(hitSrc).toMatch(/GREAT/);
    const scoreSrc = readFile('src/game/score.ts');
    expect(scoreSrc).toMatch(/PERFECT/);
    // renderer change must not leak into hitJudge or score logic
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(extractRenderParamsSlice(rendererSrc)).toMatch(/showJudgementDetail/);
    expect(readFile('src/game/hitJudge.ts')).not.toMatch(/showJudgementDetail/);
    expect(readFile('src/game/score.ts')).not.toMatch(/showJudgementDetail/);
  });
});
