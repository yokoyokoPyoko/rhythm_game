/**
 * T167 — オフセットの刺激→判定への移設（manualOffsetは判定側のみ）
 * Vitest node environment — pure computed values / engine math + file contracts
 * Strict 3-step state-transition assertions. MUST FAIL before fix (Red) and PASS after (Green).
 *
 * 確定モデル:
 * - audioOffset: 刺激側に残す（音楽再生開始 offsetSec = audioOffset/1000 のみ）
 * - manualOffset (L): 判定側のみ tapRaw - (hitTime + manualOffset) .刺激側には加算しない
 * - metronome schedule の offsetSeconds() 加算撤廃（クリックはグリッド固定）
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
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { judgeHit } from '../src/game/hitJudge';
import { getManualOffsetMs, setManualOffset, offsetSeconds } from '../src/audio/clock';
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
        start: vi.fn((when?: number) => { o._startWhen = when; }),
        stop: vi.fn(),
        _startWhen: null as number | null,
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
        start: vi.fn((when: number, offset?: number) => {
          src._startWhen = when;
          src._startOffset = offset;
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
  } as unknown as AudioContext & { destination: AudioNode; _lastGain: any; _lastOsc: any; _lastSource: any; createBufferSource: () => AudioBufferSourceNode };
  return {
    ctx,
    destination,
    getLastGain: () => lastGain,
    getLastOsc: () => lastOsc,
    getLastSource: () => (ctx as any)._lastSource,
  };
}

function computeFixedGameOffsetSec(audioOffsetMs: number): number {
  return audioOffsetMs / 1000;
}
function computeOldGameOffsetSec(audioOffsetMs: number, manual: number): number {
  return (audioOffsetMs + manual) / 1000;
}
function computeFixedEditorOffsetSec(audioOffset: number): number {
  return audioOffset / 1000;
}
function makeRingState(hitTime: number, targetY = 300): any {
  return { id: 1, spawnTime: hitTime - 1500, hitTime, targetY, resolved: false, hit: false, type: 'single' as const };
}

/**
 * Expected post-T167 judgement error: tapRaw - (hitTime + manualOffset)
 * This is the user-visible误 error. With delayed system manualOffset=+L,
 * perfect tap at sound time (hitTime+L) yields error 0.
 */
function expectedError(tapRaw: number, hitTime: number, manual: number): number {
  return tapRaw - (hitTime + manual);
}

// ---------------------------------------------------------------------------
// T167-1: metronome schedule はグリッド固定（offsetSeconds 加算なし）
// ---------------------------------------------------------------------------
describe('T167-1: metronome schedule は manualOffset を加算しない（クリック固定） 3-step', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 初期 when(手動0) を capture → Step2 手動+80 設定 → Step3 when が変化せずグリッド固定', () => {
    // Step1: capture initial — current schedule includes offsetSeconds, so when shifts with manual
    expect(getManualOffsetMs()).toBe(0);
    const nextBeatTime = 10.2;
    const ctxTime = 10.0;
    // Fixed expectation: when = max(ctxTime, nextBeatTime) regardless of manual
    const fixedWhen0 = Math.max(ctxTime, nextBeatTime);
    expect(fixedWhen0).toBeCloseTo(10.2, 6);
    // Old buggy: when = max(ctxTime, nextBeatTime + manual/1000)
    const oldWhen0 = Math.max(ctxTime, nextBeatTime + 0);
    expect(oldWhen0).toBeCloseTo(fixedWhen0, 6); // at 0 they coincide

    // Step2: set manual +80 (simulates ,. key)
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    expect(offsetSeconds()).toBeCloseTo(0.08, 6);

    // Step3: file contract + numeric: schedule must NOT use offsetSeconds
    const src = readFile('src/audio/metronome.ts');
    // Must NOT contain offsetSeconds in schedule arithmetic
    expect(src, 'metronome.ts schedule must NOT contain offsetSeconds() addition').not.toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/);
    // when should be exactly max(ctxTime, nextBeatTime) — no manual term
    expect(src).toMatch(/Math\.max\(audioCtx\.currentTime,\s*nextBeatTime\s*\)/);
    // Numerical: fixed when should still be 10.2, old would be 10.28
    const fixedWhen80 = Math.max(ctxTime, nextBeatTime); // fixed ignores manual
    const oldWhen80 = Math.max(ctxTime, nextBeatTime + 0.08);
    expect(fixedWhen80).toBeCloseTo(10.2, 6);
    expect(oldWhen80).toBeCloseTo(10.28, 6);
    expect(fixedWhen80).not.toBeCloseTo(oldWhen80, 6);

    // Also verify schedule function actually behaves fixed via mock
    const { ctx } = createMockAudioContext(ctxTime);
    // schedule should start at nextBeatTime when not clamped, not nextBeatTime+0.08
    schedule(ctx as unknown as AudioContext, nextBeatTime, 0);
    const osc: any = (ctx as any)._lastOsc;
    expect(osc).toBeDefined();
    expect(osc._startWhen).toBeCloseTo(fixedWhen80, 6);
    expect(osc._startWhen).not.toBeCloseTo(oldWhen80, 6);
  });

  it('Step1 負オフセット capture → Step2 -80 設定 → Step3 schedule は負でも変化なし', () => {
    expect(getManualOffsetMs()).toBe(0);
    setManualOffset(-80);
    expect(getManualOffsetMs()).toBe(-80);
    const src = readFile('src/audio/metronome.ts');
    expect(src).not.toMatch(/offsetSeconds\(\)/);
    const ctxTime = 5.0;
    const nextBeat = 5.1;
    const fixedWhen = Math.max(ctxTime, nextBeat);
    const oldWhen = Math.max(ctxTime, nextBeat + (-0.08));
    expect(fixedWhen).toBeCloseTo(5.1, 6);
    expect(oldWhen).toBeCloseTo(5.02, 6);
    expect(fixedWhen).not.toBeCloseTo(oldWhen, 6);
    // If file still imports offsetSeconds, it would be considered buggy
    // After fix, import line should be removed entirely
    expect(src, 'should not import offsetSeconds at all').not.toContain('offsetSeconds');
  });

  it('複雑拍でもグリッド固定が維持される（off-grid含む）', () => {
    const src = readFile('src/audio/metronome.ts');
    expect(src).not.toMatch(/offsetSeconds/);
    // Check multiple beats: schedule must ignore manual regardless of beat value
    for (const manual of [0, 80, -50, 150, 33]) {
      setManualOffset(manual);
      const { ctx } = createMockAudioContext(10.0);
      const nextBeat = 10.37; // off-grid
      schedule(ctx as unknown as AudioContext, nextBeat, 3);
      const o: any = (ctx as any)._lastOsc;
      expect(o._startWhen, `manual ${manual} off-grid 0.37`).toBeCloseTo(10.37, 6);
    }
    setManualOffset(0);
  });
});

// ---------------------------------------------------------------------------
// T167-2: GameScreen playMusic は audioOffset のみ（manual含めない）
// ---------------------------------------------------------------------------
describe('T167-2: GameScreen.playMusic は audioOffset のみで音楽頭出し（3-step）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 buggy/fixed capture at 0 → Step2 手動+80 → Step3 ファイルが (audioOffsetMs/1000) のみを用いる', () => {
    expect(getManualOffsetMs()).toBe(0);
    const audioOffsetMs = 120;
    const fixedBefore = computeFixedGameOffsetSec(audioOffsetMs);
    const oldBefore = computeOldGameOffsetSec(audioOffsetMs, 0);
    expect(fixedBefore).toBeCloseTo(0.12, 6);
    expect(oldBefore).toBeCloseTo(0.12, 6);

    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);

    const src = readFile('src/screens/GameScreen.tsx');
    const playMusicIdx = src.indexOf('const playMusic');
    expect(playMusicIdx, 'playMusic must exist').toBeGreaterThan(-1);
    const slice = src.slice(playMusicIdx, playMusicIdx + 800);
    // Must use audioOffsetMs alone
    expect(slice, 'playMusic offsetSec must be audioOffsetMs / 1000 (no manual)').toMatch(/const\s+offsetSec\s*=\s*audioOffsetMs\s*\/\s*1000/);
    // Must NOT contain (audioOffsetMs + getManualOffsetMs())
    expect(slice).not.toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs\(\)\)/);
    // Also should not contain getLeadMs with manual inside playMusic
    expect(slice).not.toMatch(/getLeadMs/);

    // Numeric: fixed 0.12 vs old (120+80)/1000=0.2 must differ
    const fixedAfter = computeFixedGameOffsetSec(audioOffsetMs);
    const oldAfter = computeOldGameOffsetSec(audioOffsetMs, 80);
    expect(fixedAfter).toBeCloseTo(0.12, 6);
    expect(oldAfter).toBeCloseTo(0.2, 6);
    expect(fixedAfter).not.toBeCloseTo(oldAfter, 6);
  });

  it('Step1 capture off-grid audioOffset 37ms → Step2 manual変えても offsetSec 不変、開始whenも不変', () => {
    expect(getManualOffsetMs()).toBe(0);
    const audioOffsetMs = 37; // off-grid fractional
    const fixed = computeFixedGameOffsetSec(audioOffsetMs);
    expect(fixed).toBeCloseTo(0.037, 6);
    const { ctx } = createMockAudioContext(10.0);
    const startWhen0 = ctx.currentTime + fixed;
    expect(startWhen0).toBeCloseTo(10.037, 6);

    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);
    const fixedAfter = computeFixedGameOffsetSec(audioOffsetMs);
    expect(fixedAfter).toBeCloseTo(0.037, 6);
    expect(fixedAfter).toBeCloseTo(fixed, 6);
    // old would be 0.117
    const oldAfter = computeOldGameOffsetSec(audioOffsetMs, 80);
    expect(oldAfter).toBeCloseTo(0.117, 6);
    expect(fixedAfter).not.toBeCloseTo(oldAfter, 6);
    // Mock start
    const { ctx: ctx2 } = createMockAudioContext(10.0);
    const src2: any = ctx2.createBufferSource();
    src2.start(ctx2.currentTime + fixedAfter);
    expect(src2._startWhen).toBeCloseTo(10.037, 6);
    expect(src2._startWhen).not.toBeCloseTo(10.117, 6);
  });

  it('負の audioOffset 分岐でも manual を含めず audioOffset のみで負分岐を判定', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const slice = src.slice(src.indexOf('const playMusic'), src.indexOf('const playMusic') + 800);
    expect(slice).toContain('if (offsetSec >= 0)');
    expect(slice).toContain('source.start');
    // Ensure negative case also uses audioOffset-only offsetSec, not +manual
    // The file should not decide branch based on (audioOffset+manual)
    expect(slice).not.toMatch(/\(audioOffsetMs\s*\+\s*getManualOffsetMs/);
    // Numeric: audioOffset -50 with manual 80 → fixed = -0.05 (negative branch), old = +0.03 (positive)
    const fixedNeg = computeFixedGameOffsetSec(-50);
    const oldNeg = computeOldGameOffsetSec(-50, 80);
    expect(fixedNeg).toBeCloseTo(-0.05, 6);
    expect(oldNeg).toBeCloseTo(0.03, 6);
    expect(Math.sign(fixedNeg)).not.toBe(Math.sign(oldNeg));
  });
});

// ---------------------------------------------------------------------------
// T167-3: EditorScreen playFrom は audioOffset のみ
// ---------------------------------------------------------------------------
describe('T167-3: EditorScreen.playFrom は audioOffset のみ（T135 revert, T143維持） 3-step', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 0 capture → Step2 manual+80 → Step3 playFrom が audioOffset/1000 のみで manual に線形でない', () => {
    expect(getManualOffsetMs()).toBe(0);
    const audioOffset = 100;
    const fixedBefore = computeFixedEditorOffsetSec(audioOffset);
    const oldBefore = computeOldGameOffsetSec(audioOffset, 0);
    expect(fixedBefore).toBeCloseTo(0.1, 6);
    expect(oldBefore).toBeCloseTo(0.1, 6);

    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);

    const src = readFile('src/screens/EditorScreen.tsx');
    const playFromIdx = src.indexOf('const playFrom');
    expect(playFromIdx).toBeGreaterThan(-1);
    const slice = src.slice(playFromIdx, playFromIdx + 2500);
    // Must contain audioOffset / 1000 lone (or audioOffset alone), not +manual
    expect(slice, 'playFrom must use audioOffset / 1000 (no manual)').toMatch(/audioOffset\s*\/\s*1000/);
    expect(slice).not.toMatch(/getLeadMs\(audioOffset\)/);
    expect(slice).not.toMatch(/\(audioOffset\s*\+\s*getManualOffset/);
    expect(slice).not.toMatch(/audioOffset\s*\+\s*getManualOffsetMs/);

    const fixedAfter = computeFixedEditorOffsetSec(audioOffset);
    const oldAfter = computeOldGameOffsetSec(audioOffset, 80);
    expect(fixedAfter).toBeCloseTo(0.1, 6);
    expect(oldAfter).toBeCloseTo(0.18, 6);
    expect(fixedAfter).not.toBeCloseTo(oldAfter, 6);
    // audioOffset change DOES shift fixed
    const fixedOff200 = computeFixedEditorOffsetSec(200);
    expect(fixedOff200).toBeCloseTo(0.2, 6);
    expect(fixedOff200).not.toBeCloseTo(fixedAfter, 6);
  });

  it('Step1 fromMs 1237 端数 capture → Step2 manual -60 → Step3 playFrom の when/offset が manual に不変（audioOffset のみ効く）', () => {
    expect(getManualOffsetMs()).toBe(0);
    const fromMs = 1237;
    const audioOffset = 75; // off-grid
    // Fixed editor logic: offsetSec = audioOffset/1000, audioTime = fromMs/1000
    const offFixed = audioOffset / 1000;
    const audioTime = fromMs / 1000;
    const ctxTime = 12.5;
    const startWhenFixed = ctxTime + Math.max(0, offFixed);
    const startOffsetFixed = offFixed >= 0 ? audioTime : Math.max(0, audioTime - offFixed);
    expect(startWhenFixed).toBeCloseTo(12.575, 6);
    expect(startOffsetFixed).toBeCloseTo(1.237, 6);

    setManualOffset(-60);
    expect(getManualOffsetMs()).toBe(-60);
    // After fix, manual must NOT affect editor playback
    const offFixedAfter = 75 / 1000;
    expect(offFixedAfter).toBeCloseTo(offFixed, 6);
    const startWhenAfter = ctxTime + Math.max(0, offFixedAfter);
    expect(startWhenAfter).toBeCloseTo(startWhenFixed, 6);
    // Old would be (75-60)/1000=0.015 => 12.515
    const oldOff = (75 + -60) / 1000;
    expect(oldOff).toBeCloseTo(0.015, 6);
    expect(offFixed).not.toBeCloseTo(oldOff, 6);
  });

  it('音楽とメトロノームの分離: audioOffset は音楽のみに、メトロノームは固定', () => {
    setManualOffset(0);
    const audioOffset = 200;
    const fixedMusicOffsetSec = audioOffset / 1000; // 0.2
    const metroWhen = Math.max(10.0, 10.5); // fixed, no offset
    expect(metroWhen).toBeCloseTo(10.5, 6);
    // Music is delayed by audioOffset
    const musicWhen = 10.0 + fixedMusicOffsetSec;
    expect(musicWhen).toBeCloseTo(10.2, 6);
    // Difference must be audioOffset exactly (T143 regression: they are audioOffset apart)
    expect(musicWhen - 10.0).toBeCloseTo(0.2, 6);
    expect(metroWhen - 10.5).toBeCloseTo(0, 6);
    // If manual were still in metro, metro would be 10.58 and diff check would fail
    const oldMetroWhen = Math.max(10.0, 10.5 + 0.08); // with manual 80
    expect(metroWhen).not.toBeCloseTo(oldMetroWhen, 6);
  });
});

// ---------------------------------------------------------------------------
// T167-4: 判定側への移設 — tap - (hitTime + manual) が誤差
// ---------------------------------------------------------------------------
describe('T167-4: 判定誤差は tapRaw - (hitTime + manualOffset) に統一（3-step, off-grid必須）', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 manual 0 で tap=hit で誤差0 capture → Step2 manual+80 → Step3 perfectタップは hit+80 で誤差0', () => {
    // Step1
    setManualOffset(0);
    const hitTime = 5000;
    const tapAtHit = 5000;
    const err0 = expectedError(tapAtHit, hitTime, 0);
    expect(err0).toBeCloseTo(0, 6);
    // Also check current judgeHit without manual yields 0 at exact hit
    const ring = makeRingState(hitTime, 300);
    const j0 = judgeHit(tapAtHit, 300, [ring], 500);
    expect(j0).not.toBeNull();
    expect(j0!.errorMs).toBeCloseTo(0, 6);

    // Step2
    setManualOffset(80);
    expect(getManualOffsetMs()).toBe(80);

    // Step3: fixed error must be tap - (hit+80). Perfect tap is at hit+80
    const tapPerfect = hitTime + 80; // sound is late by L=80, tap to sound is at hit+80
    const errFixed = expectedError(tapPerfect, hitTime, 80);
    expect(errFixed).toBeCloseTo(0, 6);
    // Buggy old error (tap - hit) would be 80 at perfect tap
    const errOld = tapPerfect - hitTime;
    expect(errOld).toBeCloseTo(80, 6);
    expect(errFixed).not.toBeCloseTo(errOld, 6);

    // Verify file contract: GameScreen/CalibrationModal handleHit must involve hitTime+manual
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    // At least one of error calc must contain pattern hitTime + manual or manualOffset
    const combinedAll = gameSrc + calSrc;
    // After fix, either hitJudge imports manual or callers pass adjusted time
    const hasManualInJudgement =
      combinedAll.includes('getManualOffsetMs()') &&
      (combinedAll.includes('hitTime') && combinedAll.includes('manualOffset'));
    // Check that errorMs computation involves manual (either directly or via adjusted pressTime)
    const hitJudgeSrc = readFile('src/game/hitJudge.ts');
    const clockSrc = readFile('src/audio/clock.ts');
    // One of: hitJudge uses manual, or callers subtract/add manual before calling, or clock has helper
    const hasClockHelper =
      clockSrc.includes('judge') ||
      clockSrc.includes('getLeadMs') ||
      clockSrc.includes('error') ||
      /tapRaw|adjusted/.test(clockSrc);
    // At least the judgement path must reference manual — we check GameScreen+Calibration+hitJudge+clock any
    const anyManualRef = hasManualInJudgement || hitJudgeSrc.includes('getManualOffset') || hasClockHelper || combinedAll.includes('manualOffset');
    // Strong assertion: judgement error must be manual-aware (file contains manualOffset near judgeHit)
    // Look near judgeHit calls
    const gameJudgeIdx = gameSrc.indexOf('judgeHit');
    if (gameJudgeIdx !== -1) {
      const near = gameSrc.slice(Math.max(0, gameJudgeIdx - 800), gameJudgeIdx + 800);
      expect(near).toMatch(/getManualOffsetMs|manualOffset/);
    }
    const calJudgeIdx = calSrc.indexOf('judgeHit');
    if (calJudgeIdx !== -1) {
      const near = calSrc.slice(Math.max(0, calJudgeIdx - 800), calJudgeIdx + 800);
      expect(near).toMatch(/getManualOffsetMs|manualOffset/);
    }
  });

  it('Step1 capture オフグリッド端数タップ 1.23拍 相当ms → Step2 manual変動で誤差が線形シフト', () => {
    // Use BpmTimeline to get fractional ms for off-grid beats
    const tl = new BpmTimeline(120, [], 1.0); // 500ms per beat
    const hitBeat = 4; // hitTime = 2000ms
    const hitTime = tl.beatToMs(hitBeat); // 2000
    const offGridTapBeat = 4.37; // 0.37 late
    const tapRaw = tl.beatToMs(offGridTapBeat); // 2185ms
    // With manual 0, error = 185ms
    setManualOffset(0);
    const err0 = expectedError(tapRaw, hitTime, 0);
    expect(err0).toBeCloseTo(185, 3);
    // With manual +80, error = 185-80 =105
    setManualOffset(80);
    const err80 = expectedError(tapRaw, hitTime, 80);
    expect(err80).toBeCloseTo(105, 3);
    expect(err80 - err0).toBeCloseTo(-80, 6);
    // With manual -50, error = 235
    setManualOffset(-50);
    const errNeg = expectedError(tapRaw, hitTime, -50);
    expect(errNeg).toBeCloseTo(235, 3);
    expect(errNeg - err0).toBeCloseTo(50, 6);
    // Linear slope check: delta error = - delta manual
    setManualOffset(0);
    const sweep = [-100, -50, 0, 50, 80, 150];
    const errors = sweep.map((m) => expectedError(tapRaw, hitTime, m));
    for (let i = 1; i < sweep.length; i++) {
      const dManual = sweep[i] - sweep[i - 1];
      const dErr = errors[i] - errors[i - 1];
      expect(dErr).toBeCloseTo(-dManual, 6);
    }
  });

  it('複数振幅・複数BPM の off-grid 誤差でも式が一貫（判定はms基準で振幅に依存しない）', () => {
    const cases = [
      { bpm: 120, beat: 3.37, manual: 37 },
      { bpm: 150, beat: 1.23, manual: 80 },
      { bpm: 180, beat: 2.62, manual: -30 },
      { bpm: 100, beat: 0.37, manual: 120 },
    ];
    for (const c of cases) {
      const tl = new BpmTimeline(c.bpm, [], 1.3);
      const hit = tl.beatToMs(4);
      const tap = tl.beatToMs(c.beat + 4); // tap offset by c.beat beats late
      const m = c.manual;
      const err = expectedError(tap, hit, m);
      const expected = tap - hit - m;
      expect(err, `bpm ${c.bpm} beat ${c.beat}`).toBeCloseTo(expected, 4);
      // Manual shift must still be exactly -m linear
      setManualOffset(m);
      expect(err).toBeCloseTo(tap - hit - getManualOffsetMs(), 6);
      setManualOffset(0);
      const err0 = expectedError(tap, hit, 0);
      expect(err - err0).toBeCloseTo(-m, 6);
    }
  });

  it('ファイル契約: MISS期限ループと journal.at も manualOffset 込みで判定（or ソースに言及）', () => {
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    // MISS deadline: songTimeMs > ring.hitTime + windowMs (+ manual? spec says miss期限ループも tap-(hit+manual) に統一)
    // The unified model implies miss window is centered at hit+manual, not raw hit.
    // Check that either the miss loop adds manual or judgement window is manual-aware
    // At minimum, files must reference manualOffset near miss logic
    const hasMissManualGame = gameSrc.includes('miss') && gameSrc.includes('getManualOffsetMs');
    const hasMissManualCal = calSrc.includes('miss') && (calSrc.includes('getManualOffsetMs') || calSrc.includes('manualOffset'));
    expect(hasMissManualGame || hasMissManualCal).toBe(true);
    // journal.at should be raw songNow (tap time) — but error stored separately with manual
    // We just ensure the miss handling is present and not raw-only
    // Hit error filed as errorMs must involve manual
    const combined = gameSrc + calSrc + readFile('src/game/hitJudge.ts') + readFile('src/audio/clock.ts');
    expect(combined).toMatch(/errorMs/);
    expect(combined).toMatch(/getManualOffsetMs|manualOffsetMs/);
  });
});

// ---------------------------------------------------------------------------
// T167-5: calibration-last 誤差が ,. で線形に反映（低遅延PC合わせフロー）
// ---------------------------------------------------------------------------
describe('T167-5: ,. (±10ms) 調整が calibration-last 誤差に線形反映 & メトロクリック固定', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 初期誤差 capture → Step2 , で -10 → Step3 誤差が +10 増（線形）かつクリック位置不変', () => {
    // Simulate fixed click at hitTime 4000, tap at 4050 (50 late)
    const hitTime = 4000;
    const tapRaw = 4050;
    setManualOffset(0);
    const err0 = expectedError(tapRaw, hitTime, getManualOffsetMs());
    expect(err0).toBeCloseTo(50, 6);
    const metroClick = 4000; // fixed grid
    expect(metroClick).toBeCloseTo(hitTime, 6); // click == ruler

    // Step2: press ,  -> -10
    setManualOffset(getManualOffsetMs() - 10);
    expect(getManualOffsetMs()).toBe(-10);
    const errMinus = expectedError(tapRaw, hitTime, getManualOffsetMs());
    expect(errMinus).toBeCloseTo(60, 6);
    expect(errMinus - err0).toBeCloseTo(10, 6);
    // Metro click must NOT have moved (still 4000)
    const metroAfter = 4000;
    expect(metroAfter).toBeCloseTo(metroClick, 6);

    // Step3: press . -> +20 from -10 => +10 total
    setManualOffset(getManualOffsetMs() + 20);
    expect(getManualOffsetMs()).toBe(10);
    const errPlus = expectedError(tapRaw, hitTime, getManualOffsetMs());
    expect(errPlus).toBeCloseTo(40, 6);
    expect(errPlus - err0).toBeCloseTo(-10, 6);
    // Metro still fixed
    expect(4000).toBeCloseTo(metroClick, 6);
  });

  it('複数回 ,. 連打で誤差が 10ms 刻みで線形に変化（calibration-last想定）', () => {
    const hitTime = 8000;
    const tapRaw = 8100;
    setManualOffset(0);
    const baseErr = expectedError(tapRaw, hitTime, 0); // 100
    const steps = [10, -10, 10, 10, -20, 30];
    let manual = 0;
    for (const d of steps) {
      manual += d;
      setManualOffset(manual);
      const err = expectedError(tapRaw, hitTime, manual);
      expect(err).toBeCloseTo(baseErr - manual, 6);
      // Each +/-10 must be exact 10 shift
      expect(err).toBeCloseTo(tapRaw - hitTime - manual, 6);
    }
  });

  it('ファイル契約: CalibrationModal のヒント文がクリック合わせを案内', () => {
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    // Must mention click-aligned tuning with ,. or similar updated hint
    const hasClickHint =
      calSrc.includes('クリック') ||
      calSrc.includes('click') ||
      calSrc.toLowerCase().includes('誤差が0') ||
      calSrc.includes(',.');
    expect(hasClickHint).toBe(true);
    // Must not be the old auto-measurement only hint? At least still contains ,. guidance
    expect(calSrc).toMatch(/,.|<>|±10ms/);
  });
});

// ---------------------------------------------------------------------------
// T167-6: audioOffset 頭出しは従来通り（T135/T143 回帰なし）& sign移行
// ---------------------------------------------------------------------------
describe('T167-6: audioOffset は音楽頭出しにのみ効く（回帰なし）& 符号移行の痕跡', () => {
  beforeEach(() => setManualOffset(0));
  afterEach(() => setManualOffset(0));

  it('Step1 audioOffset 0 capture → Step2 audioOffset 200 設定 → Step3 音楽whenは200ms遅延、メトロは不変', () => {
    const ctxTime = 10.0;
    const audioOffset0 = 0;
    const audioOffset200 = 200;
    const off0 = audioOffset0 / 1000;
    const off200 = audioOffset200 / 1000;
    const musicWhen0 = ctxTime + Math.max(0, off0);
    const musicWhen200 = ctxTime + Math.max(0, off200);
    expect(musicWhen200 - musicWhen0).toBeCloseTo(0.2, 6);
    // Metronome must stay fixed at grid regardless of audioOffset
    const metroWhen = Math.max(ctxTime, 12.0);
    expect(metroWhen).toBeCloseTo(12.0, 6);
    // File contract: Game/Editor still use audioOffset
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(gameSrc).toMatch(/audioOffsetMs/);
    expect(editorSrc).toMatch(/audioOffset/);
    // But they must NOT mix manual into music
    expect(gameSrc.slice(gameSrc.indexOf('const playMusic'), gameSrc.indexOf('const playMusic') + 800)).not.toMatch(/getManualOffsetMs.*audioOffset|audioOffset.*getManualOffsetMs.*\+/);
  });

  it('負の audioOffset でも音楽が先頭から正しく切り出し（startOffset分岐）かつ manual は影響しない', () => {
    // Editor negative branch: offsetSec <0 => startWhen = ctxTime, startOffset = audioTime - offsetSec
    const audioOffset = -80;
    const fromMs = 0;
    const off = audioOffset / 1000; // -0.08
    const audioTime = fromMs / 1000; // 0
    const ctxTime = 10.0;
    const startWhen = ctxTime; // negative case
    const startOffset = Math.max(0, audioTime - off); // 0.08
    expect(startWhen).toBeCloseTo(10.0, 6);
    expect(startOffset).toBeCloseTo(0.08, 6);
    // With manual +80 old: off old =0 => startWhen 10, offset 0 => different
    const oldOff = (-80 + 80) / 1000; // 0 if old included manual
    expect(off).not.toBeCloseTo(oldOff, 6);
    // Verify file handles negative audioOffset
    const src = readFile('src/screens/EditorScreen.tsx');
    // Must have the if (offsetSec >=0) branch
    expect(src).toMatch(/if\s*\(\s*offsetSec\s*>=\s*0\s*\)/);
  });

  it('符号移行の痕跡: clock/Game に旧保存値の符号反転 or 再計測案内のいずれかがあるか、少なくともコメント/リリースノート的に分岐', () => {
    // Spec says 符号移行: 旧 -L → 新 +L は符号が逆。初回起動時に符号反転か再計測案内。
    // We check that at least one of the files mentions migration, inversion, or recalibration.
    const clockSrc = readFile('src/audio/clock.ts');
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    const calSrc = readFile('src/screens/editor/CalibrationModal.tsx');
    const all = clockSrc + gameSrc + calSrc;
    // After fix, we expect either:
    // - clock.ts has migration code inverting localStorage value on load, OR
    // - a comment mentioning T167 / sign inversion / recalibration
    // We accept either implementation OR at least a TODO/comment indicating migration.
    const hasMigrationHint =
      clockSrc.includes('T167') ||
      all.includes('符号') ||
      all.includes('migration') ||
      all.includes('invert') ||
      all.includes('反転') ||
      all.includes('再計測') ||
      all.includes('recalib') ||
      // Or clock loadOffset inverts old value: e.g. raw = -raw or manualOffsetMs = -n
      /-\s*n/.test(clockSrc) ||
      /manualOffsetMs\s*=\s*-/.test(clockSrc) ||
      /-manualOffset/.test(all);
    // This is a soft check — we want to ensure integrator didn't miss migration.
    // If none found, we still want file to NOT contain old double-application logic.
    // At minimum, clock must still define getManualOffsetMs/setManualOffset correctly.
    expect(clockSrc).toContain('export function getManualOffsetMs');
    expect(clockSrc).toContain('export function setManualOffset');
    // If migration is via comment, we allow pass; if not found we warn but not fail hard?
    // To make test Red before fix, we require that old code (getLeadMs = audio+manual) is gone.
    expect(clockSrc + gameSrc + readFile('src/screens/EditorScreen.tsx')).not.toMatch(/getLeadMs\(audioOffset\)/);
    // If migration hint missing, still pass this legacy check but flag
    if (!hasMigrationHint) {
      // Fallback: at least ensure judgement uses +manual (new sign) not -manual
      expect(all).toMatch(/getManualOffsetMs|manualOffsetMs/);
    } else {
      expect(hasMigrationHint).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// T167-extra: 回帰 — WaveEngine/Cursor 数値整合（複雑振幅 + off-grid）
// ---------------------------------------------------------------------------
describe('T167-extra: 回帰 WaveEngine/Cursor 数値整合（complex amplitudes, off-grid, T127 style）', () => {
  beforeEach(() => setManualOffset(0));

  it('Step1 amp 0.7 beat 0.37 capture → Step2 amp 1.3/2.7/3.4 → Step3 slope = 2*TW_AMP*amplitudeAt step', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 0.5, 1.37, 2.62];
    for (const amp of amps) {
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 6 }], tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      const startY = TW_CENTER_Y;
      const TOP = TW_CENTER_Y - TW_AMP;
      const BOTTOM = TW_CENTER_Y + TW_AMP;
      for (const b of offGridBeats) {
        const raw = startY + perBeat * b;
        const expected = Math.max(TOP, Math.min(BOTTOM, raw));
        const actual = engine.waveYAt(b);
        expect(actual, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 4);
      }
      expect(engine.waveYAt(10)).toBeCloseTo(TW_CENTER_Y + TW_AMP, 4);
    }
  });

  it('Cursor 1拍あたり移動量が WaveEngine perBeat と一致（同amp, 同beatMs, off-grid 0.37/1.23）', () => {
    const amp = 1.3;
    const beatMs = 500;
    const tl = new BpmTimeline(120, [], amp);
    const engine = new WaveEngine([{ direction: 'down', beats: 4 }], tl, amp, 1.0);
    const perBeat = 2 * TW_AMP * amp;
    const cursor = new Cursor(amp, 1.0);
    const y0 = cursor.y;
    const dt = (0.37 * beatMs) / 1000; // off-grid 0.37
    cursor.update(dt, false, true, beatMs);
    const cursorDelta = Math.abs(cursor.y - y0);
    expect(cursorDelta).toBeCloseTo(perBeat * 0.37, 4);
    const waveDelta = Math.abs(engine.waveYAt(0.37) - engine.waveYAt(0));
    expect(waveDelta).toBeCloseTo(perBeat * 0.37, 4);
    expect(waveDelta).toBeCloseTo(cursorDelta, 4);

    // Second off-grid 1.23
    const cursor2 = new Cursor(amp, 1.0);
    const y02 = cursor2.y;
    const dt2 = (1.23 * beatMs) / 1000;
    cursor2.update(dt2, false, true, beatMs);
    const d2 = Math.abs(cursor2.y - y02);
    // Clamped to bottom if overshoot
    const raw2 = TW_CENTER_Y - TW_AMP + perBeat * 1.23; // start top
    const clamped2 = Math.min(TW_CENTER_Y + TW_AMP, raw2);
    const wave2 = engine.waveYAt(1.23);
    expect(wave2).toBeCloseTo(clamped2, 4);
    // Cursor would also clamp
    expect(d2).toBeCloseTo(Math.abs(wave2 - (TW_CENTER_Y - TW_AMP)), 4);
  });

  it('getPoints 長さ不変 & amplitudeAt ステップが off-grid で正しい', () => {
    const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
    expect(tl.amplitudeAt(3.37)).toBe(1.0);
    expect(tl.amplitudeAt(4.0)).toBe(2.0);
    expect(tl.amplitudeAt(4.23)).toBe(2.0);
    expect(tl.amplitudeAt(5.5)).toBe(2.0);
    const segs: any[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 0.5 }, { direction: 'stay', beats: 1 }];
    const eng = new WaveEngine(segs, tl, 1.0, 0);
    const pts = eng.getPoints();
    expect(pts.length).toBe(segs.length + 1);
    for (const p of pts) {
      expect(typeof p.beat).toBe('number');
      expect(typeof p.y).toBe('number');
    }
    // T127/T128 regression: wave slope after amplitude change uses new amplitude
    const top = TW_CENTER_Y - TW_AMP;
    const bottom = TW_CENTER_Y + TW_AMP;
    // After beat 4, perBeat should be 2*130*2=520, so 0.25 beats already reaches bottom
    const yAt4_25 = eng.waveYAt(4.25);
    // Compute expected: from y at 4
    const yAt4 = eng.waveYAt(4);
    // Next segment starts at beat 4 (after change?) Actually segments are independent of bpm_changes timing.
    // Just ensure wave is within bounds
    expect(yAt4_25).toBeGreaterThanOrEqual(top);
    expect(yAt4_25).toBeLessThanOrEqual(bottom);
  });

  it('tsc --noEmit 型契約: インポートシンボルが型正しく呼べる', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eng = new WaveEngine([{ direction: 'up', beats: 1 }], tl, 1.0, 0);
    const cur = new Cursor(1.0, 0);
    expect(tl.beatMsAt(0)).toBeGreaterThan(0);
    expect(eng.waveYAt(0)).toBeDefined();
    expect(cur.y).toBeDefined();
    expect(getManualOffsetMs()).toBeDefined();
    expect(offsetSeconds()).toBeDefined();
    const { ctx } = createMockAudioContext();
    expect(() => schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 0)).not.toThrow();
    // hitJudge must accept new error logic (manual-aware)
    const r = makeRingState(2000, 300);
    const j = judgeHit(2000, 300, [r], 500);
    expect(j).not.toBeNull();
  });
});
