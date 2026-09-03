/**
 * T138 — 判定ライン＝緑バーの同一化（記録位置とプレイ判定の整合）・案A
 * 旧 T136 ゲート（緑バー＝可聴位置から leadMs 減算）を T138 新規約へ更新。
 * T138 案A: 緑バー④ = raw（Play 判定① songNow と同一）。tick/stop の leadMs 減算を撤廃し、
 * positionRef は raw 追跡。録音 beat は raw（Play と完全同相）。getLeadMs は音楽開始のみに適用。
 * Vitest node environment – 純粋計算 + ファイル契約。Red→Green 判定。
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat, segmentize } from '../src/chart/quantize';
import { getManualOffsetMs, setManualOffset, offsetSeconds, getLeadMs } from '../src/audio/clock';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

// T138 raw green bar (判定基準 = Play songNow と同一)
function computeGreenPosRaw(startMs: number, ctxNow: number, startCtxTime: number): number {
  return Math.max(0, startMs + (ctxNow - startCtxTime) * 1000);
}
// T136 旧挙動（廃止対象）: raw - leadMs
function computeGreenPosBuggy(startMs: number, ctxNow: number, startCtxTime: number, audioOffset: number, manual: number): number {
  return Math.max(0, startMs + (ctxNow - startCtxTime) * 1000 - (audioOffset + manual));
}

// Recording beat: positionRef (raw) をそのまま quantize
function computeRecordBeat(tl: BpmTimeline, positionRef: number, snap: number): number {
  return quantizeBeat(tl.msToBeat(positionRef), snap);
}

function getTickBody(src: string): string {
  const idx = src.indexOf('const tick = ()');
  const end = src.indexOf('return () => cancelAnimationFrame(raf)');
  if (idx === -1) return src.slice(src.indexOf('startMsRef.current'), src.indexOf('startMsRef.current') + 5000);
  return src.slice(idx, end === -1 ? idx + 5000 : end);
}
function getStopSlice(src: string): string {
  const idx = src.indexOf('const stop =');
  if (idx === -1) return '';
  return src.slice(idx, idx + 3000);
}

// ---------------------------------------------------------------------------
// T138-1: 緑バー追跡 pos = startMs + (ctx.currentTime - startCtxTime)*1000 (raw)
// ---------------------------------------------------------------------------
describe('T138-1: 緑バー追跡 raw（leadMs 減算撤廃）manual 不変', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 raw at 0 → Step2 set +80 → Step3 raw unchanged (buggy would shift -80)', () => {
    expect(getManualOffsetMs()).toBe(0);
    const startMs = 0;
    const startCtx = 10.0;
    const ctxNow = 10.5; // 500ms elapsed
    setManualOffset(80);
    const raw = computeGreenPosRaw(startMs, ctxNow, startCtx);
    expect(raw).toBeCloseTo(500, 6);
    const buggy = computeGreenPosBuggy(startMs, ctxNow, startCtx, 0, 80);
    expect(buggy).toBeCloseTo(420, 6);
    expect(raw).not.toBeCloseTo(buggy, 1);
  });

  it('Step1 negative offset -80 → Step2 compute → Step3 raw 200 (buggy 280)', () => {
    setManualOffset(-80);
    const startMs = 0;
    const startCtx = 5.0;
    const ctxNow = 5.2;
    const raw = computeGreenPosRaw(startMs, ctxNow, startCtx);
    expect(raw).toBeCloseTo(200, 6);
    const buggy = computeGreenPosBuggy(startMs, ctxNow, startCtx, 0, -80);
    expect(buggy).toBeCloseTo(280, 6);
    expect(raw).not.toBeCloseTo(buggy, 1);
  });

  it('Step1 file contract tick raw → Step2 inspect source → Step3 no leadMs subtraction / no positionRef - manual', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const tick = getTickBody(src);
    expect(tick).toMatch(/const\s+rawPos\s*=\s*startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    expect(tick).toMatch(/const\s+pos\s*=\s*Math\.max\(0,\s*rawPos\)/);
    expect(tick).not.toMatch(/rawPos\s*-\s*leadMs/);
    expect(src.match(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/g) || []).toHaveLength(0);
  });

  it('Step1 file contract stop raw → Step2 inspect → Step3 no leadMs subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const stop = getStopSlice(src);
    expect(stop).toMatch(/const\s+rawPos\s*=\s*startMsRef\.current\s*\+\s*\(ctx\.currentTime\s*-\s*startCtxTimeRef\.current\)\s*\*\s*1000/);
    expect(stop).toMatch(/const\s+pos\s*=\s*Math\.max\(0,\s*rawPos\)/);
    expect(stop).not.toMatch(/-\s*leadMs/);
  });
});

// ---------------------------------------------------------------------------
// T138-2: 録音 beat = msToBeat(raw) が Play songNow と一致（leadMs ズレなし）
// ---------------------------------------------------------------------------
describe('T138-2: 録音 beat は positionRef(raw) をそのまま使用、Play 判定と同相', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 off-grid 1237ms snap0.25 manual 0 → Step2 set manual +80 → Step3 B identical, != buggy(pos-80)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const snap = 0.25;
    const pos = 1237; // off-grid 2.474 beats
    setManualOffset(0);
    const b0 = computeRecordBeat(tl, pos, snap);
    expect(b0).toBeCloseTo(2.5, 4);
    setManualOffset(80);
    const b80 = computeRecordBeat(tl, pos, snap);
    expect(b80).toBeCloseTo(b0, 6);
    const buggy = computeRecordBeat(tl, pos - 80, snap);
    expect(buggy).toBeCloseTo(2.25, 4);
    expect(buggy).not.toBeCloseTo(b80, 4);
    // Play hitTime
    expect(tl.beatToMs(b80)).toBeCloseTo(1250, 4);
  });

  it('Step1 file contract ring/arrow/hold use const pos = positionRef.current → Step2 inspect → Step3 no manual subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringIdx = src.indexOf('spacePressBeatRef.current =');
    const ringSlice = src.slice(Math.max(0, ringIdx - 700), ringIdx + 700);
    expect(ringSlice).toMatch(/const pos\s*=\s*positionRef\.current/);
    expect(ringSlice).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
    const releaseIdx = src.indexOf('const releaseBeat');
    const arrowSlice = src.slice(Math.max(0, releaseIdx - 900), releaseIdx + 600);
    expect(arrowSlice).toMatch(/const pos\s*=\s*positionRef\.current/);
    expect(arrowSlice).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs/);
  });
});

// ---------------------------------------------------------------------------
// T138-3: getLeadMs 一元化（音楽開始のみに適用、緑バーには適用しない）
// ---------------------------------------------------------------------------
describe('T138-3: getLeadMs 一元化（music only）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 clock defines getLeadMs(audioOffset)=audioOffset+manual → Step2 vary → Step3 one definition', () => {
    const clockSrc = readFile('src/audio/clock.ts');
    expect(clockSrc).toMatch(/export function getLeadMs\(/);
    expect(clockSrc).toContain('return audioOffset');
    expect(clockSrc).toContain('manualOffsetMs');
    setManualOffset(80);
    expect(getLeadMs(200)).toBe(280);
    expect(getLeadMs(0)).toBe(80);
    setManualOffset(0);
  });

  it('Step1 EditorScreen playFrom uses getLeadMs(audioOffset) → Step2 inspect → Step3 music start delayed by lead, green raw', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/import.*getLeadMs.*from.*clock/);
    expect(src).toMatch(/getLeadMs\(audioOffset\)/);
    const tick = getTickBody(src);
    expect(tick).not.toContain('getLeadMs');
    expect(tick).not.toContain('(audioOffset + getManualOffsetMs())');
  });

  it('Step1 GameScreen unchanged (plan A 案A: 変更不要) → Step2 inspect → Step3 keeps inline (audioOffsetMs + getManualOffsetMs())/1000', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    expect(gameSrc).toContain('source.start');
    expect(gameSrc).not.toContain('startMsRef');
  });
});

// ---------------------------------------------------------------------------
// T138-4: T137 決定性 & 回帰（T102/T103/T129/T133, WaveEngine/Cursor 数値整合）
// ---------------------------------------------------------------------------
describe('T138-4: 決定性 & 回帰', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 startMetronome deterministic signature → Step2 inspect → Step3 startCtxTime/leadMs(=audioOffset) anchored, not stale positionRef', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/const\s+startMetronome\s*=\s*useCallback\s*\(\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs\s*:\s*number\s*\)/);
    expect(src).toMatch(/let\s+nextBeatTime\s*=\s*startCtxTime\s*\+\s*leadMs\s*\/\s*1000/);
    expect(src).toMatch(/while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs\(\)\s*\/\s*1000\s*<\s*ctx\.currentTime/);
    expect(src).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
    expect(src).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*positionRef\.current/);
  });

  it('Step1 T102/T103 guard → Step2 inspect → Step3 modeRef record guards remain, no manual subtraction', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const guards = (src.match(/modeRef\.current === 'record'/g) || []).length;
    expect(guards).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/positionRef\.current\s*-\s*getManualOffsetMs\(\)/);
  });

  it('Step1 T129 snap整合 0.30 snap0.25 → Step2 segmentize → Step3 0.25 not 1/amplitude', () => {
    const snap = 0.25;
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.30, y: TW_CENTER_Y + 40, down: false },
    ];
    const segs = segmentize(traj, snap, 1.0);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      const rem = ((s.beats % snap) + snap) % snap;
      expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
    }
    expect(segs[0].beats).toBeCloseTo(0.25, 4);
    expect(segs[0].beats).not.toBeCloseTo(1.0, 4);
  });

  it('Step1 T133 calibration overlay → Step2 App.tsx → Step3 /calibration route absent, modal present', () => {
    const appSrc = readFile('src/App.tsx');
    expect(appSrc).not.toMatch(/path="\/calibration"/);
    expect(appSrc).not.toContain('CalibrationScreen');
    expect(readFile('src/screens/EditorScreen.tsx')).toContain('CalibrationModal');
    expect(readFile('src/screens/editor/CalibrationModal.tsx')).toContain('data-testid="editor-calibration-modal"');
  });

  it('Step1 WaveEngine/Cursor 数値整合 複雑振幅 off-grid → Step2 compute → Step3 raw & raw slope一致', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      for (const b of [0.37, 1.23]) {
        const expected = Math.max(TOP, Math.min(BOTTOM, TW_CENTER_Y + perBeat * b));
        expect(engine.waveYAt(b)).toBeCloseTo(expected, 4);
      }
    }
    // getPoints 長さ不変
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 0.5 }, { direction: 'stay', beats: 1 }], tl, 1.0, 0);
    expect(eng.getPoints()).toHaveLength(3);
  });

  it('All symbols typed (tsc guard)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(getLeadMs(0)).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    expect(TW_AMP).toBe(130);
    expect(TW_CENTER_Y).toBe(300);
  });
});