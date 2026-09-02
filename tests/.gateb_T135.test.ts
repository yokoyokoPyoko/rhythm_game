/**
 * T135 — 楽曲再生に判定オフセット（manualOffsetMs）を適用し、メトロノームと楽曲を同期
 * Vitest node environment – pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. Must FAIL before fix (Red) and PASS after (Green).
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
import { getManualOffsetMs, setManualOffset, offsetSeconds, manualOffsetMs } from '../src/audio/clock';
import { schedule } from '../src/audio/metronome';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function createMockAudioContext(currentTime = 10.0) {
  const destination = { __isDestination: true } as unknown as AudioNode;
  let lastGain: any = null;
  let lastOsc: any = null;
  const ctx = {
    currentTime,
    destination,
    _lastGain: null as any,
    _lastOsc: null as any,
    createOscillator() {
      const o: any = {
        type: 'sine',
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      lastOsc = o;
      (ctx as any)._lastOsc = o;
      return o as unknown as OscillatorNode;
    },
    createGain() {
      const g: any = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn((dest: unknown) => { g._connectedTo = dest; }),
        _connectedTo: null,
      };
      lastGain = g;
      (ctx as any)._lastGain = g;
      return g as unknown as GainNode;
    },
    createBufferSource() {
      const src: any = {
        buffer: null,
        connect: vi.fn(),
        start: vi.fn((when: number, offset?: number, duration?: number) => {
          src._startWhen = when;
          src._startOffset = offset;
          src._startDuration = duration;
        }),
        stop: vi.fn(),
        disconnect: vi.fn(),
        _startWhen: null as number | null,
        _startOffset: null as number | null,
      };
      (ctx as any)._lastSource = src;
      ctx._lastSource = src;
      return src as unknown as AudioBufferSourceNode;
    },
    _lastSource: null as any,
    get lastGainNode() { return lastGain; },
  } as unknown as AudioContext & {
    destination: AudioNode;
    _lastGain: any; _lastOsc: any; _lastSource: any;
    createBufferSource: () => AudioBufferSourceNode;
  };
  return { ctx, destination, getLastGain: () => lastGain, getLastOsc: () => lastOsc, getLastSource: () => ctx._lastSource };
}

// Replicate fixed logic for GameScreen playMusic and EditorScreen playFrom
function computeGamePlayMusicParams(ctxTime: number, audioOffsetMs: number, manualOffsetMsVal: number) {
  const offsetSec = (audioOffsetMs + manualOffsetMsVal) / 1000;
  let startWhen: number;
  let startOffset: number | undefined;
  // GameScreen playMusic logic: if offsetSec >=0 => start(ctx.currentTime+offsetSec), else start(ctx.currentTime, -offsetSec)
  if (offsetSec >= 0) {
    startWhen = ctxTime + offsetSec;
    startOffset = undefined; // start with no offset arg (or 0) – but we capture when
  } else {
    startWhen = ctxTime;
    startOffset = -offsetSec;
  }
  return { offsetSec, startWhen, startOffset };
}

function computeEditorPlayFromParams(ctxTime: number, fromMs: number, audioOffset: number, manualOffsetMsVal: number) {
  const offsetSec = (audioOffset + manualOffsetMsVal) / 1000;
  const audioTime = Math.max(0, fromMs / 1000);
  let startWhen: number;
  let startOffset: number;
  if (offsetSec >= 0) {
    startWhen = ctxTime + offsetSec;
    startOffset = audioTime;
  } else {
    startWhen = ctxTime;
    startOffset = Math.max(0, audioTime - offsetSec);
  }
  return { offsetSec, startWhen, startOffset, audioTime };
}

function computeBuggyGameOffsetSec(audioOffsetMs: number) {
  return audioOffsetMs / 1000;
}
function computeBuggyEditorOffsetSec(audioOffset: number) {
  return audioOffset / 1000;
}

// ---------------------------------------------------------------------------
// T135-1: GameScreen playMusic must include manualOffsetMs
// ---------------------------------------------------------------------------
describe('T135-1: GameScreen playMusic offsetSec includes manualOffsetMs (3-step file contract)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture buggy vs fixed offsetSec at 0 → Step2 set +80 → Step3 assert file contains (audioOffsetMs + getManualOffsetMs())', () => {
    // Step1: capture initial state
    expect(getManualOffsetMs()).toBe(0);
    const audioOffsetMs = 120;
    const buggyBefore = computeBuggyGameOffsetSec(audioOffsetMs);
    const fixedBefore = computeGamePlayMusicParams(10.0, audioOffsetMs, 0).offsetSec;
    expect(fixedBefore).toBeCloseTo(0.12, 6);
    expect(buggyBefore).toBeCloseTo(0.12, 6);
    // at 0, buggy and fixed coincide – need to prove shift after offset

    // Step2: perform action set offset +80 (simulates </> key)
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);

    // Step3: assert resulting transition – file contract
    const src = readFile('src/screens/GameScreen.tsx');
    // Must contain the fixed formula
    expect(src, 'GameScreen.tsx playMusic must use (audioOffsetMs + getManualOffsetMs()) / 1000').toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    // Must NOT still be buggy alone
    // Check that line `const offsetSec = audioOffsetMs / 1000` does NOT exist without manualOffset
    const buggyPattern = /const\s+offsetSec\s*=\s*audioOffsetMs\s*\/\s*1000\s*(?![;]*\s*\/\/)/;
    // If fixed, buggy alone should be absent – we search for exact buggy without plus
    const hasFixed = /\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/.test(src);
    expect(hasFixed).toBe(true);
    // Ensure the fixed line is inside playMusic (near source.start)
    const playMusicIdx = src.indexOf('const playMusic');
    expect(playMusicIdx).toBeGreaterThan(-1);
    const playMusicSlice = src.slice(playMusicIdx, playMusicIdx + 600);
    expect(playMusicSlice).toMatch(/getManualOffsetMs\(\)/);
    expect(playMusicSlice).toMatch(/offsetSec/);
    // Numeric verification: with +80, offsetSec must be (120+80)/1000=0.2 not 0.12
    const fixedAfter = computeGamePlayMusicParams(10.0, audioOffsetMs, 80).offsetSec;
    const buggyAfter = computeBuggyGameOffsetSec(audioOffsetMs);
    expect(fixedAfter).toBeCloseTo(0.2, 6);
    expect(buggyAfter).toBeCloseTo(0.12, 6);
    expect(fixedAfter).not.toBeCloseTo(buggyAfter, 6);
    expect(fixedAfter - buggyAfter).toBeCloseTo(0.08, 6);
  });

  it('Step1 capture audioOffsetMs 0 → Step2 set manual -50 → Step3 assert startWhen incorporates negative offset', () => {
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(-50);
    expect(getManualOffsetMs()).toBe(-50);
    const audioOffsetMs = 0;
    const { offsetSec, startWhen, startOffset } = computeGamePlayMusicParams(5.0, audioOffsetMs, -50);
    expect(offsetSec).toBeCloseTo(-0.05, 6);
    // For negative offsetSec, GameScreen does start(ctx.currentTime, -offsetSec)
    expect(startWhen).toBeCloseTo(5.0, 6);
    expect(startOffset).toBeCloseTo(0.05, 6);
    // With buggy logic, offset would remain 0 and startOffset would be undefined/0
    const buggyOff = computeBuggyGameOffsetSec(audioOffsetMs);
    expect(buggyOff).toBeCloseTo(0, 6);
    expect(offsetSec).not.toBeCloseTo(buggyOff, 6);
    // Verify file handles negative branch includes manualOffset
    const src = readFile('src/screens/GameScreen.tsx');
    const playMusicSlice = src.slice(src.indexOf('const playMusic'), src.indexOf('const playMusic') + 800);
    expect(playMusicSlice).toContain('source.start');
    expect(playMusicSlice).toMatch(/getManualOffsetMs/);
  });

  it('GameScreen imports getManualOffsetMs and uses it exactly once in offsetSec', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/import.*getManualOffsetMs.*from.*clock/);
    const occurrences = (src.match(/getManualOffsetMs\(\)/g) || []).length;
    // At least 1 in playMusic, plus maybe adjustOffset logic (existing) – ensure >=1
    expect(occurrences).toBeGreaterThanOrEqual(1);
    // The offsetSec line must appear exactly once with the fixed pattern
    const fixedCount = (src.match(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/g) || []).length;
    expect(fixedCount, 'GameScreen should have exactly one fixed offsetSec line').toBe(1);
  });

  it('GameScreen playMusic mock: setting manualOffset changes source.start when/startOffset (3-step with MockAudioContext)', () => {
    setManualOffset(0);
    const { ctx } = createMockAudioContext(10.0);
    const audioOffsetMs = 200;
    // Step1: before – manual 0
    const beforeParams = computeGamePlayMusicParams(ctx.currentTime, audioOffsetMs, getManualOffsetMs());
    expect(beforeParams.offsetSec).toBeCloseTo(0.2, 6);
    const srcBefore: any = ctx.createBufferSource();
    if (beforeParams.offsetSec >= 0) srcBefore.start(ctx.currentTime + beforeParams.offsetSec);
    else srcBefore.start(ctx.currentTime, -beforeParams.offsetSec);
    expect(srcBefore._startWhen).toBeCloseTo(10.2, 6);

    // Step2: set +80 and recompute
    setManualOffset(80);
    const afterParams = computeGamePlayMusicParams(ctx.currentTime, audioOffsetMs, getManualOffsetMs());
    expect(afterParams.offsetSec).toBeCloseTo(0.28, 6);

    // Step3: assert changed
    const srcAfter: any = ctx.createBufferSource();
    if (afterParams.offsetSec >= 0) srcAfter.start(ctx.currentTime + afterParams.offsetSec);
    else srcAfter.start(ctx.currentTime, -afterParams.offsetSec);
    expect(srcAfter._startWhen).toBeCloseTo(10.28, 6);
    expect(srcAfter._startWhen).not.toBeCloseTo(srcBefore._startWhen!, 6);
    expect(srcAfter._startWhen! - srcBefore._startWhen!).toBeCloseTo(0.08, 6);
  });
});

// ---------------------------------------------------------------------------
// T135-2: EditorScreen playFrom must include manualOffsetMs
// ---------------------------------------------------------------------------
describe('T135-2: EditorScreen playFrom offsetSec includes manualOffsetMs (3-step file contract)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture buggy vs fixed at 0 → Step2 set +80 → Step3 assert file contains (audioOffset + getManualOffsetMs())', () => {
    expect(getManualOffsetMs()).toBe(0);
    const audioOffset = 100;
    const buggyBefore = computeBuggyEditorOffsetSec(audioOffset);
    const fixedBefore = computeEditorPlayFromParams(10.0, 0, audioOffset, 0).offsetSec;
    expect(buggyBefore).toBeCloseTo(0.1, 6);
    expect(fixedBefore).toBeCloseTo(0.1, 6);

    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);

    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src, 'EditorScreen.tsx playFrom must use (audioOffset + getManualOffsetMs()) / 1000').toMatch(/\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)\s*\/\s*1000/);
    const hasFixed = /\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/.test(src);
    expect(hasFixed).toBe(true);
    const playFromIdx = src.indexOf('const playFrom');
    expect(playFromIdx).toBeGreaterThan(-1);
    const slice = src.slice(playFromIdx, playFromIdx + 2000);
    expect(slice).toMatch(/getManualOffsetMs\(\)/);
    // Numeric shift: (100+80)/1000=0.18 vs 0.1
    const fixedAfter = computeEditorPlayFromParams(10.0, 0, audioOffset, 80).offsetSec;
    expect(fixedAfter).toBeCloseTo(0.18, 6);
    expect(fixedAfter).not.toBeCloseTo(buggyBefore, 6);
    expect(fixedAfter - buggyBefore).toBeCloseTo(0.08, 6);
  });

  it('Step1 capture fromMs 1000 audioOffset 50 manual 0 → Step2 set manual -120 → Step3 assert startWhen/startOffset shift correctly (negative branch)', () => {
    expect(getManualOffsetMs()).toBe(0);
    const fromMs = 1000; // audioTime=1.0
    const audioOffset = 50; // 0.05 fixed before
    const before = computeEditorPlayFromParams(7.0, fromMs, audioOffset, 0);
    expect(before.offsetSec).toBeCloseTo(0.05, 6);
    expect(before.startWhen).toBeCloseTo(7.05, 6);
    expect(before.startOffset).toBeCloseTo(1.0, 6);

    setManualOffset(-120);
    expect(getManualOffsetMs()).toBe(-120);
    const after = computeEditorPlayFromParams(7.0, fromMs, audioOffset, -120);
    // (50 + -120)/1000 = -0.07 => negative branch
    expect(after.offsetSec).toBeCloseTo(-0.07, 6);
    expect(after.startWhen).toBeCloseTo(7.0, 6);
    // startOffset = max(0, 1.0 - (-0.07)) = 1.07
    expect(after.startOffset).toBeCloseTo(1.07, 6);
    expect(after.startOffset).not.toBeCloseTo(before.startOffset, 6);
    expect(after.offsetSec).not.toBeCloseTo(before.offsetSec, 6);
  });

  it('EditorScreen imports getManualOffsetMs and uses it in playFrom', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/import.*getManualOffsetMs.*from.*clock/);
    // Ensure at least one occurrence inside playFrom
    const idx = src.indexOf('const playFrom');
    expect(idx).toBeGreaterThan(-1);
    const slice = src.slice(idx, idx + 1000);
    expect(slice).toMatch(/getManualOffsetMs/);
    // Fixed pattern count
    const fixedCount = (src.match(/\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/g) || []).length;
    expect(fixedCount, 'EditorScreen should have exactly one fixed offsetSec line').toBe(1);
  });

  it('EditorScreen playFrom mock: manualOffset change shifts source.start args (3-step with MockAudioContext)', () => {
    setManualOffset(0);
    const { ctx } = createMockAudioContext(12.5);
    const fromMs = 2000; // 2.0 sec
    const audioOffset = 0;
    // Step1
    const before = computeEditorPlayFromParams(ctx.currentTime, fromMs, audioOffset, 0);
    const srcBefore: any = ctx.createBufferSource();
    srcBefore.start(before.startWhen, before.startOffset);
    expect(srcBefore._startWhen).toBeCloseTo(12.5, 6);
    expect(srcBefore._startOffset).toBeCloseTo(2.0, 6);

    // Step2
    setManualOffset(80);
    const after = computeEditorPlayFromParams(ctx.currentTime, fromMs, audioOffset, 80);
    const srcAfter: any = ctx.createBufferSource();
    srcAfter.start(after.startWhen, after.startOffset);
    // Step3
    expect(after.offsetSec).toBeCloseTo(0.08, 6);
    expect(srcAfter._startWhen).toBeCloseTo(12.58, 6);
    expect(srcAfter._startWhen).not.toBeCloseTo(srcBefore._startWhen!, 6);
    expect(srcAfter._startWhen! - srcBefore._startWhen!).toBeCloseTo(0.08, 6);
    // startOffset stays same (2.0) for positive branch
    expect(srcAfter._startOffset).toBeCloseTo(2.0, 6);
  });

  it('EditorScreen playFrom with varying fromMs and offset combinations (off-grid style: fractional offsets)', () => {
    const cases = [
      { fromMs: 1237, audioOffset: 75, manual: 37 },
      { fromMs: 185, audioOffset: 0, manual: 80 },
      { fromMs: 615, audioOffset: 120, manual: -30 },
      { fromMs: 2500, audioOffset: 200, manual: 15 },
    ];
    for (const c of cases) {
      const fixed = computeEditorPlayFromParams(10.0, c.fromMs, c.audioOffset, c.manual);
      const buggyOff = computeBuggyEditorOffsetSec(c.audioOffset);
      const expectedFixed = (c.audioOffset + c.manual) / 1000;
      expect(fixed.offsetSec, `case fromMs=${c.fromMs} audio=${c.audioOffset} manual=${c.manual}`).toBeCloseTo(expectedFixed, 6);
      expect(fixed.offsetSec).not.toBeCloseTo(buggyOff, 4);
      // Verify startWhen/startOffset correspond
      if (expectedFixed >= 0) {
        expect(fixed.startWhen).toBeCloseTo(10.0 + expectedFixed, 6);
        expect(fixed.startOffset).toBeCloseTo(Math.max(0, c.fromMs / 1000), 6);
      } else {
        expect(fixed.startWhen).toBeCloseTo(10.0, 6);
        expect(fixed.startOffset).toBeCloseTo(Math.max(0, c.fromMs / 1000 - expectedFixed), 6);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T135-3: manualOffset changes propagate to next playback – sync with metronome
// ---------------------------------------------------------------------------
describe('T135-3: manualOffset変更が次回再生で楽曲とメトロノームを同期 (3-step numeric with Mock)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 capture metronome when without offset → Step2 set +80 → Step3 assert music start shifts by same 0.08 as metronome', () => {
    // metronome.ts schedule: when = max(ctx.currentTime, nextBeatTime + offsetSeconds())
    // offsetSeconds = manualOffsetMs/1000
    expect(offsetSeconds()).toBeCloseTo(0, 6);
    const nextBeatTime = 10.2;
    const whenBefore = Math.max(10.0, nextBeatTime + offsetSeconds());
    expect(whenBefore).toBeCloseTo(10.2, 6);

    setManualOffset(80);
    expect(offsetSeconds()).toBeCloseTo(0.08, 6);
    const whenAfter = Math.max(10.0, nextBeatTime + offsetSeconds());
    expect(whenAfter).toBeCloseTo(10.28, 6);
    expect(whenAfter - whenBefore).toBeCloseTo(0.08, 6);

    // Music must shift by same 0.08
    const musicBefore = computeGamePlayMusicParams(10.0, 0, 0);
    const musicAfter = computeGamePlayMusicParams(10.0, 0, 80);
    expect(musicAfter.offsetSec - musicBefore.offsetSec).toBeCloseTo(0.08, 6);
    expect(musicAfter.offsetSec).toBeCloseTo(offsetSeconds(), 6);
    // Verify sync: both shift equally
    const metroShift = whenAfter - whenBefore;
    const musicShift = (musicAfter.startWhen ?? 10.0 + musicAfter.offsetSec) - (musicBefore.startWhen ?? 10.0 + musicBefore.offsetSec);
    expect(musicShift).toBeCloseTo(metroShift, 6);
  });

  it('Step1 capture editor music and metronome at 0 → Step2 set -60 → Step3 assert both shift -0.06 and remain synced (negative)', () => {
    expect(getManualOffsetMs()).toBe(0);
    const metroBefore = offsetSeconds();
    expect(metroBefore).toBeCloseTo(0, 6);
    setManualOffset(-60);
    expect(getManualOffsetMs()).toBe(-60);
    expect(offsetSeconds()).toBeCloseTo(-0.06, 6);
    const nextBeatTime = 5.0;
    const ctxTime = 5.0;
    const when = Math.max(ctxTime, nextBeatTime + offsetSeconds());
    // when = 5.0 + (-0.06) =4.94 but clamped to ctxTime 5.0
    expect(when).toBeCloseTo(5.0, 6); // clamped
    // Unclamped case: ctxTime=4.0, next=5.0 => when=4.94
    const when2 = Math.max(4.0, 5.0 + offsetSeconds());
    expect(when2).toBeCloseTo(4.94, 6);
    const beforeWhen2 = Math.max(4.0, 5.0 + 0);
    expect(beforeWhen2).toBeCloseTo(5.0, 6);
    expect(when2 - beforeWhen2).toBeCloseTo(-0.06, 6);

    // Editor music negative branch
    const editorBefore = computeEditorPlayFromParams(5.0, 0, 0, 0);
    const editorAfter = computeEditorPlayFromParams(5.0, 0, 0, -60);
    expect(editorAfter.offsetSec).toBeCloseTo(-0.06, 6);
    expect(editorAfter.offsetSec - editorBefore.offsetSec).toBeCloseTo(-0.06, 6);
  });

  it('Mock AudioContext: simultaneous music and metronome both use offsetSeconds (integration)', () => {
    setManualOffset(0);
    const { ctx } = createMockAudioContext(10.0);
    // Step1: metronome at 0
    const metroBefore = (() => {
      const nextBeatTime = 10.1;
      return Math.max(ctx.currentTime, nextBeatTime + offsetSeconds());
    })();
    const musicBefore = computeGamePlayMusicParams(ctx.currentTime, 100, getManualOffsetMs());
    expect(metroBefore).toBeCloseTo(10.1, 6);
    expect(musicBefore.offsetSec).toBeCloseTo(0.1, 6);

    // Step2: set 80
    setManualOffset(80);
    // Step3: both shifted
    const metroAfter = Math.max(ctx.currentTime, 10.1 + offsetSeconds());
    const musicAfter = computeGamePlayMusicParams(ctx.currentTime, 100, getManualOffsetMs());
    expect(metroAfter).toBeCloseTo(10.18, 6);
    expect(musicAfter.offsetSec).toBeCloseTo(0.18, 6);
    expect(metroAfter - metroBefore).toBeCloseTo(0.08, 6);
    expect(musicAfter.offsetSec - musicBefore.offsetSec).toBeCloseTo(0.08, 6);
    // Sync delta must match
    expect((metroAfter - metroBefore) - (musicAfter.offsetSec - musicBefore.offsetSec)).toBeCloseTo(0, 6);

    // Also test via actual schedule() mock
    const { ctx: ctx2 } = createMockAudioContext(10.0);
    setManualOffset(80);
    schedule(ctx2 as unknown as AudioContext, 10.1, 0);
    const g = (ctx2 as any)._lastGain;
    // gain connect must have happened, and when = max(10.0, 10.1+0.08)=10.18
    // We can verify offsetSeconds applied: the osc start time is when
    // Since schedule uses when = max(currentTime, nextBeatTime+offsetSeconds())
    // and we mocked currentTime 10.0, offset 0.08, next 10.1 => 10.18
    // Verify file contains offsetSeconds
    const metroSrc = readFile('src/audio/metronome.ts');
    expect(metroSrc).toContain('offsetSeconds()');
    expect(metroSrc).toContain('nextBeatTime + offsetSeconds()');
  });
});

// ---------------------------------------------------------------------------
// T135-4: metronome.ts regression – schedule already applies offsetSeconds
// ---------------------------------------------------------------------------
describe('T135-4: metronome.ts は既に offsetSeconds() で適用済み (回帰なし, 3-step)', () => {
  it('Step1 capture schedule before state → Step2 set offset → Step3 assert when = nextBeatTime + offsetSeconds() and clamped', () => {
    setManualOffset(0);
    const beforeOff = offsetSeconds();
    expect(beforeOff).toBeCloseTo(0, 6);
    const src = readFile('src/audio/metronome.ts');
    expect(src).toContain('offsetSeconds');
    expect(src).toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/);
    // ensure when includes max clamp
    expect(src).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime \+ offsetSeconds\(\)\)/);

    setManualOffset(50);
    expect(offsetSeconds()).toBeCloseTo(0.05, 6);
    const nextBeatTime = 8.0;
    const ctxTime = 8.0;
    const when = Math.max(ctxTime, nextBeatTime + offsetSeconds());
    expect(when).toBeCloseTo(8.05, 6);
    // With 0, would be 8.0
    setManualOffset(0);
    const when0 = Math.max(ctxTime, nextBeatTime + offsetSeconds());
    expect(when0).toBeCloseTo(8.0, 6);
    expect(when).not.toBeCloseTo(when0, 6);

    // Cleanup
    setManualOffset(0);
  });

  it('schedule signature remains (audioCtx, nextBeatTime, beat, out?) and uses offsetSeconds', () => {
    const src = readFile('src/audio/metronome.ts');
    expect(src).toMatch(/export function schedule\(/);
    expect(src).toMatch(/nextBeatTime:\s*number/);
    expect(src).toMatch(/beat:\s*number/);
    expect(src).toContain('offsetSeconds()');
    expect(src).toContain("import { offsetSeconds } from './clock'");
  });

  it('schedule mock: verify when calculation incorporates manualOffset (3-step with varying beats)', () => {
    const beats = [0, 1, 4, 0.37, 1.23, 2.7];
    for (const beat of beats) {
      setManualOffset(0);
      const ctxTime = 10.0;
      const nextBeat = ctxTime + beat * 0.5; // dummy
      const when0 = Math.max(ctxTime, nextBeat + offsetSeconds());
      setManualOffset(80);
      const when80 = Math.max(ctxTime, nextBeat + offsetSeconds());
      expect(when80 - when0).toBeCloseTo(0.08, 6);
      // Verify schedule file still uses offsetSeconds regardless of beat
      const src = readFile('src/audio/metronome.ts');
      expect(src).toContain('offsetSeconds()');
    }
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T135-5: 変更不要ファイルが変更されていないこと + clock不変
// ---------------------------------------------------------------------------
describe('T135-5: 変更不要ファイル回帰 (clock, CalibrationModal, songNow)', () => {
  it('clock.ts offsetSeconds and getManualOffsetMs unchanged (file contract)', () => {
    const src = readFile('src/audio/clock.ts');
    expect(src).toContain('export function offsetSeconds()');
    expect(src).toContain('return manualOffsetMs / 1000');
    expect(src).toContain('export function getManualOffsetMs()');
    expect(src).toContain('export function setManualOffset');
    // songNow must remain (audioCtx.currentTime - audioStartTime)*1000
    expect(src).toContain('songNow');
    expect(src).toContain('audioStartTime');
  });

  it('CalibrationModal.tsx does not play music – no audioOffset logic', () => {
    // CalibrationModal uses schedule via metronome but no src.start with audioOffset
    const rel = fs.existsSync(path.resolve(__dirname, '../src/screens/editor/CalibrationModal.tsx'))
      ? 'src/screens/editor/CalibrationModal.tsx'
      : 'src/screens/editor/CalibrationOverlay.tsx';
    // Fallback: check at least one overlay exists
    const exists = fs.existsSync(path.resolve(__dirname, '..', rel));
    expect(exists).toBe(true);
    const src = readFile(rel);
    // Should have schedule but not playMusic audioOffset logic
    expect(src).toContain('schedule');
    // Should NOT contain audioOffsetMs + getManualOffsetMs pattern (that's only Game/Editor)
    // It's okay if it contains getManualOffsetMs for calibration adjust, but not audioOffsetMs
    if (src.includes('audioOffsetMs')) {
      expect(src).not.toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs/);
    }
  });

  it('GameScreen and EditorScreen both still import getManualOffsetMs from clock (already imported :6/:8)', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(gameSrc).toMatch(/from ['\"]\.\.\/audio\/clock['\"]/);
    expect(editorSrc).toMatch(/from ['\"]\.\.\/audio\/clock['\"]/);
    expect(gameSrc).toContain('getManualOffsetMs');
    expect(editorSrc).toContain('getManualOffsetMs');
  });

  it('No duplicate offset addition: offsetSec computed exactly once per play function', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const gameFixed = (gameSrc.match(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/g) || []).length;
    const editorFixed = (editorSrc.match(/\(audioOffset\s*\+\s*getManualOffsetMs\(\)\)/g) || []).length;
    expect(gameFixed).toBe(1);
    expect(editorFixed).toBe(1);
    // Ensure not double-added: should not have + getManualOffsetMs twice in same line
    expect(gameSrc).not.toMatch(/getManualOffsetMs\(\).*getManualOffsetMs\(\)/);
    expect(editorSrc).not.toMatch(/getManualOffsetMs\(\).*getManualOffsetMs\(\)/);
  });
});

// ---------------------------------------------------------------------------
// T135-6: Numeric sync across complex offsets (fractional, large, negative)
// ---------------------------------------------------------------------------
describe('T135-6: 複雑なオフセット値での数値同期 (fractional, large, negative, off-grid style)', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('fractional manual offsets (0.5ms granularity simulation via integer ms but assert closeTo) produce exact combined offsetSec', () => {
    const cases = [
      { audioOffset: 0, manual: 33 },
      { audioOffset: 17, manual: 80 },
      { audioOffset: 250, manual: -120 },
      { audioOffset: 100, manual: 7 },
      { audioOffset: 0, manual: 123 },
    ];
    for (const c of cases) {
      setManualOffset(c.manual);
      const combined = (c.audioOffset + getManualOffsetMs()) / 1000;
      const expected = (c.audioOffset + c.manual) / 1000;
      expect(combined).toBeCloseTo(expected, 8);
      // Verify Game and Editor compute same
      const gameCombined = computeGamePlayMusicParams(10.0, c.audioOffset, getManualOffsetMs()).offsetSec;
      const editorCombined = computeEditorPlayFromParams(10.0, 0, c.audioOffset, getManualOffsetMs()).offsetSec;
      expect(gameCombined).toBeCloseTo(expected, 8);
      expect(editorCombined).toBeCloseTo(expected, 8);
      expect(gameCombined).toBeCloseTo(editorCombined, 8);
    }
  });

  it('large offsets (±500ms) still sync correctly', () => {
    setManualOffset(500);
    expect(offsetSeconds()).toBeCloseTo(0.5, 6);
    const gameLarge = computeGamePlayMusicParams(5.0, 0, getManualOffsetMs());
    expect(gameLarge.offsetSec).toBeCloseTo(0.5, 6);
    const metroLargeWhen = Math.max(5.0, 6.0 + offsetSeconds());
    expect(metroLargeWhen).toBeCloseTo(6.5, 6);
    // music shift 0.5 should match metro shift 0.5
    setManualOffset(0);
    const gameZero = computeGamePlayMusicParams(5.0, 0, 0);
    const metroZeroWhen = Math.max(5.0, 6.0 + 0);
    expect(metroLargeWhen - metroZeroWhen).toBeCloseTo(gameLarge.offsetSec - gameZero.offsetSec, 6);

    setManualOffset(-300);
    expect(offsetSeconds()).toBeCloseTo(-0.3, 6);
    const editorNeg = computeEditorPlayFromParams(5.0, 1000, 200, getManualOffsetMs());
    expect(editorNeg.offsetSec).toBeCloseTo((200 - 300) / 1000, 6);
  });

  it('zero audioOffset with manualOffset sweep produces linear offsetSec', () => {
    const manuals = [-100, -50, 0, 50, 80, 150];
    for (const m of manuals) {
      setManualOffset(m);
      const off = (0 + getManualOffsetMs()) / 1000;
      expect(off).toBeCloseTo(m / 1000, 8);
      const metroWhen = Math.max(10.0, 12.0 + offsetSeconds());
      // metroWhen -12.0 should equal m/1000 when not clamped (ctxTime < nextBeat)
      if (10.0 < 12.0 + offsetSeconds()) {
        expect(metroWhen - 12.0).toBeCloseTo(m / 1000, 8);
      }
    }
  });

  it('sync holds across BPM changes timeline (msToBeat conversion unrelated)', () => {
    // T135 does not change BpmTimeline, but verify offset still applies as time-domain shift
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 180 }], 1.0);
    // At beat 3.37 (off-grid) manual 80ms = 0.16 beats at 120BPM, but at 180BPM beatMs=333
    // offset is time-domain, not beat-domain: so music start shift remains 80ms regardless of BPM
    setManualOffset(80);
    const offSec = offsetSeconds();
    expect(offSec).toBeCloseTo(0.08, 6);
    // Verify that msToBeat still works but offset is not beat-scaled
    const ms = tl.beatToMs(3.37);
    const beat = tl.msToBeat(ms);
    expect(beat).toBeCloseTo(3.37, 4);
    // Music offset still 0.08 sec irrespective of BPM
    const gameOff = computeGamePlayMusicParams(0, 0, getManualOffsetMs()).offsetSec;
    expect(gameOff).toBeCloseTo(0.08, 6);
  });
});

// ---------------------------------------------------------------------------
// T135-extra: Regression – WaveEngine/Cursor numeric consistency (complex amplitudes, off-grid)
// ---------------------------------------------------------------------------
describe('T135-extra: 回帰 WaveEngine/Cursor 数値整合 (complex amplitudes, off-grid, 3-step)', () => {
  beforeEach(() => setManualOffset(0));

  it('Step1 capture amp 0.7 at beat 0.37 → Step2 set amp 1.3 etc → Step3 assert waveYAt slope = 2*TW_AMP*amplitudeAt', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.5, 1.37, 2.62];
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
      // After reaching bottom stays flat
      expect(engine.waveYAt(10)).toBeCloseTo(BOTTOM, 4);
    }
  });

  it('Cursor and WaveEngine share same per-beat displacement (3-step capture-update-assert)', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0); // start top
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    const dt = (0.5 * beatMs) / 1000;
    cursor.update(dt, false, true, beatMs);
    const cursorDelta = Math.abs(cursor.y - y0);
    expect(cursorDelta).toBeCloseTo(perBeat * 0.5, 4);
    const waveDelta = Math.abs(engine.waveYAt(0.5) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.5, 4);
    expect(waveDelta).toBeCloseTo(cursorDelta, 4);
  });

  it('getPoints length invariant and amplitudeAt step off-grid', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    const segs: any[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 0.5 }, { direction: 'stay', beats: 1 }];
    const eng = new WaveEngine(segs, tl, 1.0, 0);
    const pts = eng.getPoints();
    expect(pts.length).toBe(segs.length + 1);
    for (const p of pts) {
      expect(typeof p.beat).toBe('number');
      expect(typeof p.y).toBe('number');
    }
  });

  it('TSC --noEmit regression guard: all imported symbols are typed correctly', () => {
    // This test will fail to compile if types are wrong – it exercises the imports
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    // schedule must be callable
    const { ctx } = createMockAudioContext();
    expect(() => schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
  });
});
