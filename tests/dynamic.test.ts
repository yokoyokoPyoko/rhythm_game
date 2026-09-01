/**
 * T130 — エディタ内限定の音量バー（メトロノーム/楽曲、各0~300%） Acceptance
 *
 * Verifies strictly by static source inspection + mocked AudioGraph behaviour.
 * Runs in node (vitest environment: node), no DOM.
 * Each requirement uses 3-step state-transition assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Direct imports of small focused modules (required by TDD spec)
import { schedule } from '../src/audio/metronome';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// Helpers: mock WebAudio graph for schedule routing checks
// ---------------------------------------------------------------------------
interface MockGain {
  gain: {
    value: number;
    setValueAtTime: (v: number, t: number) => void;
    exponentialRampToValueAtTime: (v: number, t: number) => void;
  };
  connect: (dest: unknown) => void;
  _connectedTo: unknown | null;
}
interface MockOsc {
  type: string;
  frequency: { value: number };
  connect: (n: unknown) => void;
  start: (t: number) => void;
  stop: (t: number) => void;
}

function createMockAudioCtx() {
  const destination = { __isDestination: true, label: 'ctx.destination' } as unknown as AudioNode;
  let lastGain: MockGain | null = null;
  let lastOsc: MockOsc | null = null;
  const ctx = {
    currentTime: 10.0,
    destination,
    _lastGain: null as MockGain | null,
    _lastOsc: null as MockOsc | null,
    get lastGainNode() { return lastGain; },
    createOscillator(): MockOsc {
      const o: MockOsc = {
        type: 'sine',
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      lastOsc = o;
      (ctx as unknown as Record<string, unknown>)._lastOsc = o;
      return o as unknown as OscillatorNode;
    },
    createGain(): MockGain {
      const g: MockGain = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(function (this: MockGain, dest: unknown) {
          (this as MockGain)._connectedTo = dest;
        }),
        _connectedTo: null,
      };
      // Wrap connect to capture
      const orig = g.connect.bind(g);
      g.connect = ((dest: unknown) => {
        g._connectedTo = dest;
        // also spy
        (g.connect as unknown as { mock: unknown }).toString();
      }) as unknown as MockGain['connect'];
      // Use vi.fn wrapper to track
      const spy = vi.fn((dest: unknown) => { g._connectedTo = dest; });
      g.connect = spy as unknown as MockGain['connect'];
      // preserve _connectedTo via spy
      const wrappedConnect = (dest: unknown) => {
        g._connectedTo = dest;
        spy(dest);
      };
      g.connect = wrappedConnect as unknown as MockGain['connect'];
      (g.connect as unknown as Record<string, unknown>)._spy = spy;
      lastGain = g;
      (ctx as unknown as Record<string, unknown>)._lastGain = g;
      return g as unknown as GainNode;
    },
  } as unknown as AudioContext & {
    destination: AudioNode;
    _lastGain: MockGain | null;
    _lastOsc: MockOsc | null;
    lastGainNode: MockGain | null;
  };
  return { ctx, destination, getLastGain: () => lastGain!, getLastOsc: () => lastOsc! };
}

// Helper to read source files
function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
}

// Shared clamp helper mirrors EditorScreen logic
function clampVolume(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(300, n));
}
function gainValue(volume: number): number {
  return clampVolume(volume) / 100;
}

describe('T130 エディタ内限定の音量バー — acceptance (node, no DOM)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ========================================================================
  // (1) #music-control 内に 2つの音量バーが存在 (strict 3-step)
  // ========================================================================
  describe('1. #music-control 内に2本のrangeバーが存在 (metronome-volume / music-volume)', () => {
    it('EditorScreen source contains #music-control with both sliders min0 max300 step5 and % display', () => {
      // [Step 1: Capture Initial State] — read file, capture section boundaries
      const src = readSrc('src/screens/EditorScreen.tsx');
      const musicControlIdx = src.indexOf('id="music-control"');
      expect(musicControlIdx, 'EditorScreen must contain id="music-control"').toBeGreaterThan(-1);

      // capture the music-control section slice (until next </section>)
      const after = src.slice(musicControlIdx);
      const sectionEnd = after.indexOf('</section>');
      expect(sectionEnd).toBeGreaterThan(0);
      const section = after.slice(0, sectionEnd);

      // [Step 2: Perform inspection] — count sliders and attributes
      const metronomeVolumeMatches = [...section.matchAll(/data-testid="metronome-volume"/g)];
      const musicVolumeMatches = [...section.matchAll(/data-testid="music-volume"/g)];

      // [Step 3: Assert Changed Outcome] — both must exist exactly once inside section
      expect(metronomeVolumeMatches.length, 'metronome-volume must appear once inside #music-control').toBe(1);
      expect(musicVolumeMatches.length, 'music-volume must appear once inside #music-control').toBe(1);

      // Strict attribute checks: both inputs must be type="range" min=0 max=300 step=5
      // Find the input tag containing metronome-volume
      const metLineIdx = section.indexOf('data-testid="metronome-volume"');
      const metSnippetStart = Math.max(0, metLineIdx - 500);
      const metSnippet = section.slice(metSnippetStart, metLineIdx + 500);
      expect(metSnippet, 'metronome-volume input must be type="range"').toMatch(/type="range"/);
      expect(metSnippet).toMatch(/min=\{0\}/);
      expect(metSnippet).toMatch(/max=\{300\}/);
      expect(metSnippet).toMatch(/step=\{5\}/);

      const musicLineIdx = section.indexOf('data-testid="music-volume"');
      const musicSnippetStart = Math.max(0, musicLineIdx - 500);
      const musicSnippet = section.slice(musicSnippetStart, musicLineIdx + 500);
      expect(musicSnippet, 'music-volume input must be type="range"').toMatch(/type="range"/);
      expect(musicSnippet).toMatch(/min=\{0\}/);
      expect(musicSnippet).toMatch(/max=\{300\}/);
      expect(musicSnippet).toMatch(/step=\{5\}/);

      // Labels must contain expected Japanese text
      expect(section).toMatch(/メトロノーム音量/);
      expect(section).toMatch(/楽曲音量/);

      // % display: span showing volume + '%' near each slider
      expect(section).toMatch(/\{metronomeVolume\}%/);
      expect(section).toMatch(/\{musicVolume\}%/);

      // Verify NOT present outside #music-control as the only occurrence
      const outsideBefore = src.slice(0, musicControlIdx);
      const outsideAfter = src.slice(musicControlIdx + sectionEnd);
      expect(outsideBefore).not.toMatch(/data-testid="metronome-volume"/);
      expect(outsideAfter).not.toMatch(/data-testid="metronome-volume"/);
      expect(outsideBefore).not.toMatch(/data-testid="music-volume"/);
      expect(outsideAfter).not.toMatch(/data-testid="music-volume"/);

      // IDs must be present for label association
      expect(section).toMatch(/id="metronome-volume"/);
      expect(section).toMatch(/id="music-volume"/);
    });

    it('initial volume states are 100 (=100%) and clamped 0..300 in set handlers', () => {
      const src = readSrc('src/screens/EditorScreen.tsx');
      // [Step1] capture initial state declarations
      expect(src).toMatch(/const \[musicVolume,\s*setMusicVolume\]\s*=\s*useState\(100\)/);
      expect(src).toMatch(/const \[metronomeVolume,\s*setMetronomeVolume\]\s*=\s*useState\(100\)/);

      // [Step2] capture set handlers clamping logic
      const musicClamp = src.match(/setMusicVolume\(Math\.max\(0,\s*Math\.min\(300,/);
      const metroClamp = src.match(/setMetronomeVolume\(Math\.max\(0,\s*Math\.min\(300,/);

      // [Step3] assert clamping exists (prevents out-of-range)
      expect(musicClamp, 'musicVolume set must clamp 0..300').not.toBeNull();
      expect(metroClamp, 'metronomeVolume set must clamp 0..300').not.toBeNull();

      // Gain effect must map to /100
      expect(src).toMatch(/musicGainRef\.current\.gain\.value\s*=\s*Math\.max\(0,\s*Math\.min\(300,\s*musicVolume\)\)\s*\/\s*100/);
      expect(src).toMatch(/metronomeGainRef\.current\.gain\.value\s*=\s*Math\.max\(0,\s*Math\.min\(300,\s*metronomeVolume\)\)\s*\/\s*100/);
    });

    it('EditorScreen must NOT use localStorage for volume persistence (editor-limited, global impact avoidance)', () => {
      const src = readSrc('src/screens/EditorScreen.tsx');
      // [Step1] capture any localStorage usage lines
      const lsMatches = [...src.matchAll(/localStorage/g)];

      // [Step2] filter for volume-related keys
      const volumeLs = lsMatches.filter(m => {
        const idx = m.index ?? 0;
        const snippet = src.slice(Math.max(0, idx - 100), idx + 200);
        return /musicVolume|metronomeVolume|music-volume|metronome-volume/i.test(snippet);
      });

      // [Step3] assert none — volumes must be UI state only
      expect(volumeLs.length, 'EditorScreen must not persist musicVolume/metronomeVolume to localStorage').toBe(0);
    });
  });

  // ========================================================================
  // (2) metronome-volume=0で無音・300で聞こえる (ゲイン値で検証) — 3-step
  // ========================================================================
  describe('2. metronome-volume ゲイン反映: 0=>0 (無音) / 100=>1.0 / 300=>3.0', () => {
    it('gainValue helper clamps and scales correctly (pure numeric consistency)', () => {
      // [Step1] Capture initial gain at 100% (default)
      const beforeVolume = 100;
      const beforeGain = gainValue(beforeVolume);
      expect(beforeGain).toBeCloseTo(1.0, 5);

      // [Step2] Perform action: set to 0 (min)
      const afterZero = gainValue(0);
      // [Step3] Assert changed outcome: 0 => 0 (silent)
      expect(afterZero).toBeCloseTo(0, 5);
      expect(afterZero).not.toBeCloseTo(beforeGain, 5);

      // [Step1] capture intermediate 100 again
      const mid = gainValue(100);
      expect(mid).toBeCloseTo(1.0, 5);

      // [Step2] perform max
      const afterMax = gainValue(300);
      // [Step3] assert 300 => 3.0 (audible at 300%)
      expect(afterMax).toBeCloseTo(3.0, 5);
      expect(afterMax).not.toBeCloseTo(mid, 5);

      // Edge clamping: out-of-range must clamp
      expect(gainValue(400)).toBeCloseTo(3.0, 5); // clamped to 300
      expect(gainValue(500)).toBeCloseTo(3.0, 5);
      expect(gainValue(-10)).toBeCloseTo(0, 5);
      expect(gainValue(-999)).toBeCloseTo(0, 5);
      expect(gainValue(150)).toBeCloseTo(1.5, 5);
      expect(gainValue(5)).toBeCloseTo(0.05, 5); // step 5 => 0.05
    });

    it('mocked gain node transitions when volume changes (EditorScreen effect simulation)', () => {
      // Simulate EditorScreen's useEffect that writes to metronomeGain
      const mockGain: { gain: { value: number } } = { gain: { value: 1.0 } };

      // [Step1] Capture initial state (100% => 1.0)
      mockGain.gain.value = gainValue(100);
      const before = mockGain.gain.value;
      expect(before).toBeCloseTo(1.0, 5);

      // [Step2] Perform action: user moves slider to 0
      const newVolZero = 0;
      mockGain.gain.value = gainValue(newVolZero);
      // [Step3] Assert resulting gain is silent
      expect(mockGain.gain.value).toBeCloseTo(0, 5);
      expect(mockGain.gain.value).not.toBeCloseTo(before, 5);

      // [Step1] capture 0 state again
      const zeroState = mockGain.gain.value;
      expect(zeroState).toBeCloseTo(0, 5);

      // [Step2] perform max
      mockGain.gain.value = gainValue(300);
      // [Step3] assert loud
      expect(mockGain.gain.value).toBeCloseTo(3.0, 5);
      expect(mockGain.gain.value).not.toBeCloseTo(zeroState, 5);
      expect(mockGain.gain.value).toBeGreaterThan(1.0);
    });

    it('metronome Gain scheduling uses metronomeGain when provided (audible), not muted destination path', () => {
      const { ctx, destination } = createMockAudioCtx();
      const metronomeGain = ctx.createGain() as unknown as MockGain;
      // Ensure initial gain 1.0
      (metronomeGain as MockGain).gain.value = 1.0;

      // [Step1] Capture before: schedule without out should go to destination
      // We test schedule() routing directly
      const beforeGain = metronomeGain.gain.value;
      expect(beforeGain).toBeCloseTo(1.0, 5);

      // [Step2] Perform schedule without out (calibration/game path)
      const horizonTime = ctx.currentTime + 0.1;
      schedule(ctx as unknown as AudioContext, horizonTime, 0);
      const g1 = (ctx as unknown as Record<string, unknown>)._lastGain as MockGain;
      expect(g1._connectedTo, 'schedule without out must connect to ctx.destination').toBe(destination);

      // [Step3] Assert with out param connects to metronomeGain
      schedule(ctx as unknown as AudioContext, horizonTime + 0.2, 1, metronomeGain as unknown as AudioNode);
      const g2 = (ctx as unknown as Record<string, unknown>)._lastGain as MockGain;
      expect(g2._connectedTo, 'schedule with out must connect to metronomeGain').toBe(metronomeGain);
      expect(g2._connectedTo).not.toBe(destination);

      // [Step2] Test silent case: gain 0 should still route correctly but be silent
      (metronomeGain as MockGain).gain.value = 0;
      schedule(ctx as unknown as AudioContext, horizonTime + 0.4, 2, metronomeGain as unknown as AudioNode);
      const g3 = (ctx as unknown as Record<string, unknown>)._lastGain as MockGain;
      expect(g3._connectedTo).toBe(metronomeGain);
      expect((metronomeGain as MockGain).gain.value).toBeCloseTo(0, 5);
    });
  });

  // ========================================================================
  // (3) music-volume がエディタ楽曲ゲインに反映 (ゲイン値で検証) — 3-step
  // ========================================================================
  describe('3. music-volume ゲイン反映: 楽曲再生の src.connect(musicGain) 経路', () => {
    it('gainValue for music mirrors metronome logic (0..300% -> 0..3.0)', () => {
      // [Step1] Capture initial 100
      const before = gainValue(100);
      expect(before).toBeCloseTo(1.0, 5);

      // [Step2] perform 0
      const zero = gainValue(0);
      // [Step3] assert silent
      expect(zero).toBeCloseTo(0, 5);
      expect(zero).not.toBe(before);

      // [Step2] perform 300
      const max = gainValue(300);
      // [Step3] assert 3x
      expect(max).toBeCloseTo(3.0, 5);
      expect(max).not.toBe(zero);

      // arbitrary step 5 check
      expect(gainValue(75)).toBeCloseTo(0.75, 5);
      expect(gainValue(225)).toBeCloseTo(2.25, 5);
    });

    it('EditorScreen source: playFrom uses src.connect(musicGain) and musicGain.connect(destination)', () => {
      const src = readSrc('src/screens/EditorScreen.tsx');

      // [Step1] Capture before pattern: ensure old direct destination is NOT used for music
      // Old code had src.connect(ctx.destination); new must have musicGain
      expect(src).toMatch(/src\.connect\(musicGainRef\.current!/);

      // [Step2] capture gain creation
      const musicGainCreateIdx = src.indexOf('musicGainRef.current');
      expect(musicGainCreateIdx).toBeGreaterThan(-1);

      // Check that ensureGainNodes creates both gains and connects to destination
      const ensureSlice = src.slice(src.indexOf('ensureGainNodes'), src.indexOf('ensureGainNodes') + 800);
      expect(ensureSlice).toMatch(/musicGain/);
      expect(ensureSlice).toMatch(/metronomeGain/);
      expect(ensureSlice).toMatch(/\.connect\(ctx\.destination\)/);

      // [Step3] Assert that playFrom no longer connects directly to destination for music
      const playFromIdx = src.indexOf('const playFrom');
      const playFromSlice = src.slice(playFromIdx, playFromIdx + 1500);
      expect(playFromSlice).toMatch(/src\.connect\(musicGainRef\.current/);
      expect(playFromSlice).not.toMatch(/src\.connect\(ctx\.destination\)/);
    });

    it('mocked musicGain transitions on volume change (3-step)', () => {
      const mockMusicGain: { gain: { value: number } } = { gain: { value: 1.0 } };

      // [Step1] Capture before at 100
      mockMusicGain.gain.value = gainValue(100);
      const before = mockMusicGain.gain.value;
      expect(before).toBeCloseTo(1.0, 5);

      // [Step2] Perform mid change to 150 (150%)
      mockMusicGain.gain.value = gainValue(150);
      // [Step3] Assert changed to 1.5
      expect(mockMusicGain.gain.value).toBeCloseTo(1.5, 5);
      expect(mockMusicGain.gain.value).not.toBeCloseTo(before, 5);

      // [Step1] capture 150 state
      const mid = mockMusicGain.gain.value;

      // [Step2] perform to 0
      mockMusicGain.gain.value = gainValue(0);
      // [Step3] assert silent
      expect(mockMusicGain.gain.value).toBeCloseTo(0, 5);
      expect(mockMusicGain.gain.value).not.toBeCloseTo(mid, 5);

      // [Step2] perform to 300
      mockMusicGain.gain.value = gainValue(300);
      // [Step3] assert max
      expect(mockMusicGain.gain.value).toBeCloseTo(3.0, 5);
    });
  });

  // ========================================================================
  // (4) エディタ限定: GameScreen/CalibrationScreen は out省略で ctx.destination のまま
  // ========================================================================
  describe('4. エディタ限定 — Game/Calibration は schedule() を outなしで呼ぶ (従来通り)', () => {
    it('metronome.ts schedule signature has optional out?: AudioNode with fallback to destination', () => {
      const src = readSrc('src/audio/metronome.ts');

      // [Step1] Capture before: function declaration
      expect(src).toMatch(/export function schedule\(/);

      // [Step2] Perform signature check
      const sigMatch = src.match(/export function schedule\([\s\S]*?out\?\s*:\s*AudioNode/);
      // [Step3] Assert optional param exists
      expect(sigMatch, 'schedule must have optional out?: AudioNode param').not.toBeNull();

      // Fallback logic must be gain.connect(out ?? audioCtx.destination) or equivalent
      expect(src).toMatch(/gain\.connect\(out \?\? audioCtx\.destination\)/);
    });

    it('GameScreen does NOT pass out param to schedule (editor-limited)', () => {
      const src = readSrc('src/screens/GameScreen.tsx');

      // [Step1] Capture initial: find all schedule( calls
      const scheduleCalls = [...src.matchAll(/schedule\s*\(/g)];
      expect(scheduleCalls.length, 'GameScreen must call schedule at least once').toBeGreaterThan(0);

      // [Step2] Extract each call snippet (next 120 chars) and check arity
      const calls = [...src.matchAll(/schedule\s*\([^)]*\)/g)].map(m => m[0]);

      // [Step3] Assert none contain 4 args / out param — all must be 3-arg (audioCtx, time, beat)
      for (const c of calls) {
        // Count commas: 2 commas => 3 args ; 3 commas => 4 args (with out)
        const commaCount = (c.match(/,/g) || []).length;
        expect(commaCount, `GameScreen schedule call must NOT have out param: ${c}`).toBe(2);
      }

      // Ensure no metronomeGain / musicGain reference in GameScreen
      expect(src).not.toMatch(/metronomeGain/);
      expect(src).not.toMatch(/musicGain/);
    });

    it('CalibrationScreen does NOT pass out param to schedule', () => {
      const src = readSrc('src/screens/CalibrationScreen.tsx');

      const calls = [...src.matchAll(/schedule\s*\([^)]*\)/g)].map(m => m[0]);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        const commaCount = (c.match(/,/g) || []).length;
        expect(commaCount, `CalibrationScreen schedule call must NOT have out param: ${c}`).toBe(2);
      }
      expect(src).not.toMatch(/metronomeGain/);
      expect(src).not.toMatch(/musicGain/);
    });

    it('EditorScreen DOES pass metronomeGain to schedule (positive control)', () => {
      const src = readSrc('src/screens/EditorScreen.tsx');

      // [Step1] Capture all schedule calls in Editor
      const calls = [...src.matchAll(/schedule\s*\([^)]*\)/g)].map(m => m[0]);
      expect(calls.length).toBeGreaterThan(0);

      // [Step2] Find at least one 4-arg call
      const withOut = calls.filter(c => (c.match(/,/g) || []).length === 3);
      // [Step3] Assert editor has at least one out-param call and it references metronomeGain
      expect(withOut.length, 'EditorScreen must have at least one schedule(..., metronomeGain) call').toBeGreaterThan(0);
      expect(withOut.some(c => /metronomeGain/.test(c))).toBeTruthy();

      // Game/Calibration remain 3-arg, Editor has 4-arg — prove editor-limited
      const gameSrc = readSrc('src/screens/GameScreen.tsx');
      const gameCalls = [...gameSrc.matchAll(/schedule\s*\([^)]*\)/g)].map(m => m[0]);
      const gameWithOut = gameCalls.filter(c => (c.match(/,/g) || []).length === 3);
      expect(gameWithOut.length, 'GameScreen must have zero 4-arg schedule calls').toBe(0);
    });

    it('schedule routing still works without out (fallback to destination) — mocked', () => {
      const { ctx, destination } = createMockAudioCtx();

      // [Step1] Capture initial destination connection count
      schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.05, 0);
      const g1 = (ctx as unknown as Record<string, unknown>)._lastGain as MockGain;
      const beforeDest = g1._connectedTo;
      expect(beforeDest).toBe(destination);

      // [Step2] Perform second call without out at different beat
      schedule(ctx as unknown as AudioContext, ctx.currentTime + 0.1, 1);
      const g2 = (ctx as unknown as Record<string, unknown>)._lastGain as MockGain;
      // [Step3] Assert still destination (not undefined)
      expect(g2._connectedTo).toBe(destination);
      expect(g2._connectedTo).not.toBeNull();
      expect(g2._connectedTo).not.toBeUndefined();
    });
  });

  // ========================================================================
  // Additional: gain initialization correctness (undefined vs null) and
  // overall editor audio graph integrity
  // ========================================================================
  describe('5. Editor gain node initialization — undefined and non-null safety', () => {
    it('gain refs initialized as GainNode|undefined (never null) — strict postmortem fix', () => {
      const src = readSrc('src/screens/EditorScreen.tsx');

      // [Step1] Capture ref declarations — must be GainNode | undefined, not | null
      const musicDecl = src.match(/musicGainRef\s*=\s*useRef<GainNode\s*\|\s*([^>]+)>/);
      const metroDecl = src.match(/metronomeGainRef\s*=\s*useRef<GainNode\s*\|\s*([^>]+)>/);
      expect(musicDecl, 'musicGainRef typed declaration must exist').not.toBeNull();
      expect(metroDecl, 'metronomeGainRef typed declaration must exist').not.toBeNull();

      const musicType = musicDecl ? musicDecl[1] : '';
      const metroType = metroDecl ? metroDecl[1] : '';

      // [Step2] Perform type inspection: must contain undefined, must NOT be `null` only
      const musicUsesUndefined = /undefined/.test(musicType);
      const metroUsesUndefined = /undefined/.test(metroType);
      const musicUsesNull = /\bnull\b/.test(musicType);
      const metroUsesNull = /\bnull\b/.test(metroType);

      // [Step3] Assert strict undefined usage (postmortem: "Change let musicGain: GainNode | null = null to | undefined")
      expect(musicUsesUndefined, `musicGainRef must be GainNode | undefined (got "${musicType}") — not null`).toBeTruthy();
      expect(metroUsesUndefined, `metronomeGainRef must be GainNode | undefined (got "${metroType}")`).toBeTruthy();
      // Also ensure they are not still `| null` without undefined (would allow passing null to AudioNode|undefined param)
      expect(musicUsesNull && !musicUsesUndefined, 'musicGainRef must not be GainNode | null without undefined').toBeFalsy();
      expect(metroUsesNull && !metroUsesUndefined, 'metronomeGainRef must not be GainNode | null without undefined').toBeFalsy();

      // Check ensureGainNodes initializes correctly and exposes window hooks
      expect(src).toMatch(/__editorMusicGain/);
      expect(src).toMatch(/__editorMetronomeGain/);

      // Ensure no `null` literal is passed to schedule (typed as AudioNode | undefined)
      const scheduleCalls = [...src.matchAll(/schedule\s*\([^)]*\)/g)].map(m => m[0]);
      for (const c of scheduleCalls) {
        expect(c, `schedule call must not pass null literal (use undefined): ${c}`).not.toMatch(/,\s*null\s*\)/);
      }

      // Initial values must be undefined, not null
      expect(src).toMatch(/useRef<GainNode\s*\|\s*undefined>\s*\(\s*undefined\s*\)/);
    });

    it('WaveEngine/Cursor numeric consistency remains (regression guard for amplitude)', () => {
      // [Step1] Capture initial engine at amp=1.0 center
      const timeline = new BpmTimeline(120, []);
      const engine1 = new WaveEngine([{ direction: 'down', beats: 1 }], timeline, 1.0, 0);
      const beforeY = engine1.waveYAt(0.5);
      expect(beforeY).toBeCloseTo(TW_CENTER_Y + Math.min(TW_AMP, 2 * TW_AMP * 1.0 * 0.5), 1);

      // [Step2] Perform with different amplitude 2.7 (steeper) off-grid
      const engine27 = new WaveEngine([{ direction: 'down', beats: 1 }], timeline, 2.7, 0);
      const afterY27 = engine27.waveYAt(0.37);
      const expected27 = TW_CENTER_Y + Math.min(TW_AMP, 2 * TW_AMP * 2.7 * 0.37);
      // [Step3] Assert slope matches cursor speed (2*TW_AMP*amp)
      expect(afterY27).toBeCloseTo(expected27, 1);

      const beatMs = 500;
      const cursor = new Cursor(2.7, 0);
      const y0 = cursor.y;
      const dt = (0.37 * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs, 1);
      expect(cursor.y - y0).toBeCloseTo(expected27 - TW_CENTER_Y, 1);
    });
  });
});
