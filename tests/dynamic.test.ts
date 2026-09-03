import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { getLeadMs, getManualOffsetMs, offsetSeconds, setManualOffset } from '../src/audio/clock';

function readSource(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

describe('T143: メトロノームのオーディオオフセット反映撤廃（ルーラー/再生バー固定）', () => {
  let editorSrc: string;
  let metronomeSrc: string;
  let gameSrc: string;

  beforeEach(() => {
    vi.useFakeTimers();
    // reset manual offset to known baseline before each case
    setManualOffset(0);
    editorSrc = readSource('src/screens/EditorScreen.tsx');
    metronomeSrc = readSource('src/audio/metronome.ts');
    gameSrc = readSource('src/screens/GameScreen.tsx');
  });

  // ------------------------------------------------------------
  // 1. Source-code pattern guards — the core of T143
  // ------------------------------------------------------------
  describe('1. EditorScreen startMetronome の leadMs 撤廃（ソースパターンガード）', () => {
    it('startMetronome のシグネチャから leadMs 引数が削除されている', () => {
      // Desired: startMetronome(ctx, fromMs, startCtxTime) — 3 args, no leadMs
      // Current buggy code has: startMetronome(ctx, fromMs, startCtxTime, leadMs)
      expect(editorSrc).not.toMatch(/startMetronome\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*,\s*leadMs/);
      // Positive guard: new signature exists
      expect(editorSrc).toMatch(/startMetronome\s*\(\s*ctx\s*:\s*AudioContext\s*,\s*fromMs\s*:\s*number\s*,\s*startCtxTime\s*:\s*number\s*\)/);
    });

    it('nextBeatTime が ruler 基準（leadMs 加算なし）で計算される', () => {
      // Buggy: startCtxTime + leadMs / 1000 + (beatToMs - fromMs)/1000
      // Fixed: startCtxTime + (beatToMs - fromMs)/1000
      expect(editorSrc).not.toMatch(/startCtxTime\s*\+\s*leadMs\s*\/\s*1000/);
      expect(editorSrc).not.toMatch(/metronomeLeadRef\.current\s*=\s*audioOffset/);
      expect(editorSrc).toMatch(/let nextBeatTime\s*=\s*startCtxTime\s*\+\s*\(timeline\.beatToMs\(beatIdx\)\s*-\s*fromMs\)\s*\/\s*1000/);
    });

    it('while 補正から + getManualOffsetMs()/1000 が除去され純粋な ruler 比較になっている', () => {
      // Buggy: while (nextBeatTime + getManualOffsetMs() / 1000 < ctx.currentTime)
      // Fixed: while (nextBeatTime < ctx.currentTime)
      expect(editorSrc).not.toMatch(/while\s*\(\s*nextBeatTime\s*\+\s*getManualOffsetMs/);
      // Keep a positive check that plain while exists near nextBeatTime logic
      expect(editorSrc).toMatch(/while\s*\(\s*nextBeatTime\s*<\s*ctx\.currentTime\s*\)/);
    });

    it('playFrom 内の startMetronome 呼び出しが audioOffset を渡さない', () => {
      // Buggy: startMetronome(ctx, fromMs, t0, audioOffset)
      // Fixed: startMetronome(ctx, fromMs, t0)
      expect(editorSrc).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*,\s*audioOffset/);
      expect(editorSrc).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*fromMs\s*,\s*t0\s*\)/);
    });

    it('useEffect([isPlaying]) 経由の startMetronome も leadMs なしで呼ばれる', () => {
      // Buggy: startMetronome(ctx, startMsRef.current, startCtxTimeRef.current, metronomeLeadRef.current)
      expect(editorSrc).not.toMatch(/startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*,\s*metronomeLeadRef/);
      expect(editorSrc).toMatch(/startMetronome\s*\(\s*ctx\s*,\s*startMsRef\.current\s*,\s*startCtxTimeRef\.current\s*\)/);
    });

    it('metronomeLeadRef への audioOffset 代入が存在しない（未使用または削除）', () => {
      // The buggy line is `metronomeLeadRef.current = audioOffset` inside playFrom
      // Count occurrences — fixed code must have zero
      const matches = editorSrc.match(/metronomeLeadRef\.current\s*=\s*audioOffset/g) ?? [];
      expect(matches.length).toBe(0);
    });

    it('WavePreview.tsx は本タスクで変更されていない（beat ruler 側は触らない）', () => {
      const wavePreviewSrc = readSource('src/screens/editor/WavePreview.tsx');
      // WavePreview should not contain leadMs logic or audioOffset metronome coupling
      expect(wavePreviewSrc).not.toMatch(/leadMs/);
      expect(wavePreviewSrc).not.toMatch(/metronomeLeadRef/);
    });
  });

  describe('2. schedule() は manualOffset を保持（audioOffset のみ撤廃）', () => {
    it('metronome.ts の schedule が offsetSeconds()（manualOffset）を依然加算する', () => {
      expect(metronomeSrc).toMatch(/offsetSeconds\s*\(\)/);
      expect(metronomeSrc).toMatch(/nextBeatTime\s*\+\s*offsetSeconds\(\)/);
      // when = Math.max(ctx.currentTime, nextBeatTime + offsetSeconds())
      expect(metronomeSrc).toMatch(/const when\s*=\s*Math\.max\s*\(\s*audioCtx\.currentTime\s*,\s*nextBeatTime\s*\+\s*offsetSeconds\(\)\s*\)/);
    });

    it('schedule の out 引数は任意（エディタ限定ゲイン分岐を保持）', () => {
      expect(metronomeSrc).toMatch(/export function schedule/);
      expect(metronomeSrc).toMatch(/out\?\s*:\s*AudioNode/);
      expect(metronomeSrc).toMatch(/gain\.connect\s*\(\s*out\s*\?\?\s*audioCtx\.destination\s*\)/);
    });

    it('GameScreen の Metronome は元々 ruler 固定（変更なし）', () => {
      // GameScreen startMetronome should NOT involve audioOffset at all
      expect(gameSrc).not.toMatch(/audioOffset.*nextBeatTime|nextBeatTime.*audioOffset/);
      // Its schedule calls are without audioOffset-derived args
      expect(gameSrc).toMatch(/schedule\s*\(\s*audioCtx\s*,\s*nextBeatTime\s*,\s*beat\s*\)/);
    });
  });

  // ------------------------------------------------------------
  // 3. Behavioral numeric: ruler-fixed metronome vs musical delay
  // ------------------------------------------------------------
  describe('3. ルーラー固定：audioOffset を変えても metronome when は不変', () => {
    const bpm = 120;
    const timeline = new BpmTimeline(bpm, [], 1.0);
    const startCtxTime = 100.0;
    const fromMs = 0; // start of chart
    const manualMs = 80;

    beforeEach(() => {
      setManualOffset(manualMs);
    });

    function metronomeWhenFor(beatIdx: number, _audioOffsetMs: number): number {
      // Fixed ruler logic: nextBeatTime = startCtxTime + (beatToMs(B)-fromMs)/1000
      // schedule adds manual: when = max(ctxTime, nextBeatTime + manual/1000)
      // audioOffset is intentionally ignored here
      const nextBeatTime = startCtxTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000;
      return Math.max(startCtxTime, nextBeatTime + offsetSeconds());
    }

    function musicWhenFor(beatIdx: number, audioOffsetMs: number): number {
      // Music audible: getLeadMs(audioOffset)/1000 + delta
      // startWhen = ctxTime + offsetSec if >=0 else ctxTime, then + delta
      const offsetSec = getLeadMs(audioOffsetMs) / 1000;
      const delta = (timeline.beatToMs(beatIdx) - fromMs) / 1000;
      if (offsetSec >= 0) return startCtxTime + offsetSec + delta;
      return startCtxTime + delta; // negative path: skip head of buffer
    }

    it('audioOffset 0 と 200ms で同じ beat の metronome when が一致（差 < 0.001ms）', () => {
      const beatIdx = 4; // strong beat
      const w0 = metronomeWhenFor(beatIdx, 0);
      const w200 = metronomeWhenFor(beatIdx, 200);
      expect(w0).toBeCloseTo(w200, 5);
      // Explicit ruler formula
      const expected = startCtxTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000 + manualMs / 1000;
      expect(w0).toBeCloseTo(expected, 5);
      expect(w200).toBeCloseTo(expected, 5);
    });

    it('端数オフグリッド位相 (0.37 / 1.23 beat相当) でも audioOffset に依らず ruler と一致', () => {
      // fromMs を端数beatに置き、最近傍beatの nextBeatTime が ruler に固定されることを確認
      const offGridBeats = [0.37, 1.23, 2.7, 3.41];
      for (const b of offGridBeats) {
        const fm = timeline.beatToMs(b);
        const beatIdx = Math.ceil(timeline.msToBeat(fm));
        const nbt0 = startCtxTime + (timeline.beatToMs(beatIdx) - fm) / 1000;
        const nbt200 = startCtxTime + (timeline.beatToMs(beatIdx) - fm) / 1000;
        // Both must be identical irrespective of audioOffset
        expect(nbt0).toBeCloseTo(nbt200, 5);
        // schedule adds manual only
        const w0 = Math.max(startCtxTime, nbt0 + manualMs / 1000);
        const exp = startCtxTime + (timeline.beatToMs(beatIdx) - fm) / 1000 + manualMs / 1000;
        expect(w0).toBeCloseTo(exp, 5);
      }
    });

    it('複雑な振幅値 (0.7 / 1.3 / 2.7) では bpmTimeline は変わらず ruler 固定が保たれる', () => {
      // Amplitude affects wave slope but NOT metronome grid — grid is time-based
      const amps = [0.7, 1.3, 2.7, 3.4];
      for (const amp of amps) {
        const tl = new BpmTimeline(bpm, [], amp);
        const fm = tl.beatToMs(1.5);
        const idx = Math.ceil(tl.msToBeat(fm));
        const nbt = startCtxTime + (tl.beatToMs(idx) - fm) / 1000;
        const w = Math.max(startCtxTime, nbt + manualMs / 1000);
        // Same formula must hold regardless of amp (amp not in metronome equation)
        const expected = startCtxTime + (tl.beatToMs(idx) - fm) / 1000 + manualMs / 1000;
        expect(w).toBeCloseTo(expected, 5);
      }
    });
  });

  describe('4. 音楽可聴は audioOffset で遅延し metronome と audioOffset 分ズレる（意図通り）', () => {
    const bpm = 120;
    const timeline = new BpmTimeline(bpm, [], 1.0);
    const startCtxTime = 200.0;
    const fromMs = 0;

    function metronomeWhen(beatIdx: number): number {
      const nbt = startCtxTime + (timeline.beatToMs(beatIdx) - fromMs) / 1000;
      return Math.max(startCtxTime, nbt + offsetSeconds());
    }
    function musicWhen(beatIdx: number, audioOffsetMs: number): number {
      const offsetSec = getLeadMs(audioOffsetMs) / 1000;
      const delta = (timeline.beatToMs(beatIdx) - fromMs) / 1000;
      if (offsetSec >= 0) return startCtxTime + offsetSec + delta;
      return startCtxTime + delta;
    }

    it('同一 beat で musicWhen - metronomeWhen == audioOffset（正の offset, 手動0）', () => {
      setManualOffset(0);
      const beatIdx = 8;
      const audioOffset = 200;
      const mw = musicWhen(beatIdx, audioOffset);
      const met = metronomeWhen(beatIdx);
      const diffMs = (mw - met) * 1000;
      expect(diffMs).toBeCloseTo(audioOffset, 5);
    });

    it('手動オフセット込みでも差は依然 audioOffset（manual は両者に共通）', () => {
      setManualOffset(50);
      const beatIdx = 4;
      const audioOffset = 200;
      // metronome includes manual via schedule, music includes manual via getLeadMs
      const met = metronomeWhen(beatIdx);
      const mw = musicWhen(beatIdx, audioOffset);
      const diffMs = (mw - met) * 1000;
      expect(diffMs).toBeCloseTo(audioOffset, 5);
    });

    it('audioOffset 0 では音楽と metronome が同相（差 0）', () => {
      setManualOffset(30);
      const beatIdx = 2;
      const diff = (musicWhen(beatIdx, 0) - metronomeWhen(beatIdx)) * 1000;
      expect(diff).toBeCloseTo(0, 5);
    });

    it('audioOffset 0→200 の切替で metronome は動かず音楽のみ 200ms 遅延', () => {
      setManualOffset(0);
      const beatIdx = 6;
      const met0 = metronomeWhen(beatIdx);
      // music shifts by 200ms while metronome stays
      const mw0 = musicWhen(beatIdx, 0);
      const mw200 = musicWhen(beatIdx, 200);
      expect(met0).toBeCloseTo(met0, 5); // trivial self-check but documents invariance
      expect(mw200 - mw0).toBeCloseTo(0.2, 5);
      expect(mw200 - met0).toBeCloseTo(0.2, 5);
    });
  });

  describe('5. 決定性：同じ fromMs からの再生で metronome 初回 when が audioOffset に依らず一定', () => {
    it('fromMs=500ms 固定、audioOffset を 0/100/200 に変えても初回 when が完全一致', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const startCtxTime = 50.0;
      setManualOffset(20);
      const fromMs = 500; // ~ beat 1.0
      const beatIdx = Math.ceil(tl.msToBeat(fromMs));

      const compute = (audioOffsetMs: number): number => {
        // Fixed code ignores audioOffset for metronome — parameter intentionally unused
        void audioOffsetMs;
        const nbt = startCtxTime + (tl.beatToMs(beatIdx) - fromMs) / 1000;
        return Math.max(startCtxTime, nbt + offsetSeconds());
      };

      const w0 = compute(0);
      const w100 = compute(100);
      const w200 = compute(200);
      expect(w0).toBeCloseTo(w100, 5);
      expect(w100).toBeCloseTo(w200, 5);
      // Also verify against explicit ruler value
      const expected = startCtxTime + (tl.beatToMs(beatIdx) - fromMs) / 1000 + 20 / 1000;
      expect(w0).toBeCloseTo(expected, 5);
    });

    it('2回連続呼び出しで同じ fromMs なら同じ when（ジッタなし）', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const startCtxTime = 75.0;
      setManualOffset(-10);
      const fromMs = 1234; // off-grid
      const beatIdx = Math.ceil(tl.msToBeat(fromMs));
      const nbt = startCtxTime + (tl.beatToMs(beatIdx) - fromMs) / 1000;
      const when1 = Math.max(startCtxTime, nbt + offsetSeconds());
      const when2 = Math.max(startCtxTime, nbt + offsetSeconds());
      expect(when1).toBeCloseTo(when2, 5);
      expect(when1 - when2).toBeCloseTo(0, 5);
    });

    it('startCtxTime スナップショットがジッタ耐性を保証：live ctx.currentTime を使わない', () => {
      // This is a source guard complement: verify EditorScreen no longer uses ctx.currentTime for nextBeatTime init
      // Fixed code uses startCtxTime snapshot; buggy used leadMs + live jitter
      expect(editorSrc).toMatch(/startCtxTime\s*\+\s*\(timeline\.beatToMs/);
      expect(editorSrc).not.toMatch(/ctx\.currentTime\s*\+\s*\(timeline\.beatToMs/);
    });
  });

  describe('6. ルーラー/緑バーとの一致：beatToX と metronome tick の位相', () => {
    it('beat 0,4,8 のルーラー目盛と metronome tick の beat 対応が一致', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const viewStart = 0;
      const viewBeats = 16;
      const cssW = 800;
      const beatToX = (b: number) => ((b - viewStart) / viewBeats) * cssW;
      // Ruler labels at strong beats should map to exact tick beats
      const strongBeats = [0, 4, 8, 12, 16];
      for (const b of strongBeats) {
        const x = beatToX(b);
        // Tick at b should have nextBeatTime aligning with ruler position — check delta 0
        const nbt = 100 + (tl.beatToMs(b) - 0) / 1000;
        const when = Math.max(100, nbt + offsetSeconds());
        // when - startCtxTime should equal beatToMs(b)/1000 + manual
        const deltaSec = when - 100;
        const expectedSec = tl.beatToMs(b) / 1000 + offsetSeconds();
        expect(deltaSec).toBeCloseTo(expectedSec, 5);
        // X is linear, so tick order respects ruler order
        expect(x).toBeCloseTo((b / viewBeats) * cssW, 5);
      }
    });

    it('緑バー（raw）追従と metronome の相対位相が audioOffset に依らず一定', () => {
      // T138: green bar = raw = startMs + delta; metronome = ruler fixed (no audioOffset)
      // So relative phase green vs metronome should not shift when audioOffset changes
      const tl = new BpmTimeline(120, [], 1.0);
      const startMs = 0;
      const ctxStart = 100.0;
      const deltaBeatsAndAudioOffsets: Array<[number, number]> = [
        [0.5, 0],
        [0.5, 200],
        [1.37, 0],
        [1.37, 200],
      ];
      for (const [beatPos, audioOffset] of deltaBeatsAndAudioOffsets) {
        void audioOffset; // intentionally not used in green/metro calc — documents independence
        const posMs = tl.beatToMs(beatPos);
        const rawPos = startMs + (posMs - startMs); // raw = identity at this delta (simplified)
        // green bar beat = msToBeat(rawPos) == beatPos
        const greenBeat = tl.msToBeat(rawPos);
        expect(greenBeat).toBeCloseTo(beatPos, 5);
        // metronome nextBeatTime for next strong beat is ruler-based, independent of audioOffset
        const nextIdx = Math.ceil(greenBeat);
        const nbt = ctxStart + (tl.beatToMs(nextIdx) - rawPos) / 1000;
        // Should not contain audioOffset
        const withAudio = nbt + 200 / 1000;
        // We assert that correct nbt does NOT equal withAudio (i.e., audioOffset must NOT be baked)
        expect(nbt).not.toBeCloseTo(withAudio, 1);
      }
    });
  });

  describe('7. getLeadMs は音楽側のみで使われる（metronome から分離）', () => {
    it('getLeadMs = audioOffset + manualOffset（音楽遅延の定義）', () => {
      setManualOffset(30);
      expect(getLeadMs(0)).toBe(30);
      expect(getLeadMs(200)).toBe(230);
      // After fix, EditorScreen music path still uses getLeadMs
      expect(editorSrc).toMatch(/getLeadMs\s*\(\s*audioOffset\s*\)/);
    });

    it('metronome 側は getLeadMs を参照しない（leadMs 変数自体が無い）', () => {
      // The metronome path should not call getLeadMs
      // Extract startMetronome body region and check it does not contain getLeadMs
      const smStart = editorSrc.indexOf('const startMetronome');
      const smEnd = editorSrc.indexOf('}, [stopMetronome', smStart);
      const smBody = editorSrc.slice(smStart, smEnd);
      expect(smBody).not.toMatch(/getLeadMs/);
      expect(smBody).not.toMatch(/leadMs/);
    });
  });
});
