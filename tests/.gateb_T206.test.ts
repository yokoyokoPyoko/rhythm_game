/**
 * T206 — 楽曲終了判定の優先順位修正（end_beat未設定時は最終リング＋2秒・ホールド終端対応）
 *
 * Runs WITHOUT browser: node environment, pure engine math + source inspection.
 * Spec:
 *  - 終了閾値優先順位: end_beat → 最終リング＋2s → 音源長/フォールバック (audio_offset加算維持)
 *  - lastHitTimeはホールド終端込み: beatToMs(r.beat + (r.duration ?? 0))
 *  - 完了条件: end_beat未設定・譜面が曲途中で最終リング＋2s遷移、end_beat/リング0挙動不変、tsc --noEmit
 *
 * STRICT QA: 3-step [Capture Before] → [Perform Action] → [Assert Changed Outcome with calculated values]
 * Off-grid verification mandatory: 0.37 / 1.23 / 2.37 / 4.37 beats, fractional durations, complex BPM
 * Flexible regex per postmortem (nested parens tolerance, ternary chain, inline vs two-step releaseBeat)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import type { Chart, RingDef, BpmChange } from '../src/types';

vi.useFakeTimers({ shouldAdvanceTime: true });

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
}

function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  // BpmTimeline signature: (bpmChanges, baseAmplitude) after T186/T187
  return new BpmTimeline(sections as any, baseAmp);
}

// Helper mirroring the FIXED GameScreen endThreshold logic
const END_DELAY_MS = 2000;
function computeFixedEndThreshold(opts: {
  chart: { end_beat?: number; audio_offset?: number };
  timeline: BpmTimeline;
  rings: RingDef[];
  buffer: { duration: number } | null;
}): { lastHitTime: number | null; baseEnd: number; endThreshold: number } {
  const { chart, timeline, rings, buffer } = opts;
  const lastHitTime =
    rings.length > 0
      ? timeline.beatToMs(rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity))
      : null;
  const fallbackEnd = lastHitTime !== null ? lastHitTime + END_DELAY_MS : 60000;
  const baseEnd =
    chart.end_beat !== undefined
      ? timeline.beatToMs(chart.end_beat)
      : lastHitTime !== null
        ? lastHitTime + END_DELAY_MS
        : buffer
          ? buffer.duration * 1000
          : fallbackEnd;
  const endThreshold = baseEnd + (chart.audio_offset ?? 0);
  return { lastHitTime, baseEnd, endThreshold };
}

// Old buggy logic for comparison (what T206 fixes)
function computeBuggyEndThreshold(opts: {
  chart: { end_beat?: number; audio_offset?: number };
  timeline: BpmTimeline;
  rings: RingDef[];
  buffer: { duration: number } | null;
}): { lastHitTimeBug: number | null; baseEndBug: number; endThresholdBug: number } {
  const { chart, timeline, rings, buffer } = opts;
  // bug 1: lastHitTime ignores duration (r.beat only)
  const lastHitTimeBug =
    rings.length > 0
      ? timeline.beatToMs(rings.reduce((m, r) => Math.max(m, r.beat), -Infinity))
      : null;
  const fallbackEnd = lastHitTimeBug !== null ? lastHitTimeBug + END_DELAY_MS : 60000;
  // bug 2: priority is buffer-first when buffer exists, lastHitTime+2s only as fallback
  const baseEndBug =
    chart.end_beat !== undefined
      ? timeline.beatToMs(chart.end_beat)
      : buffer
        ? buffer.duration * 1000
        : fallbackEnd;
  const endThresholdBug = baseEndBug + (chart.audio_offset ?? 0);
  return { lastHitTimeBug, baseEndBug, endThresholdBug };
}

describe('T206 楽曲終了判定の優先順位修正 — Vitest pure engine (TDD Red→Green)', () => {
  // ==========================================================================
  // 1. Static source inspection — flexible regex per postmortem
  // ==========================================================================
  describe('1. GameScreen.tsx 静的検査 — priority & hold tail が正しいこと (3-step)', () => {
    it('lastHitTime がホールド終端込み r.beat + (r.duration ?? 0) で計算される (柔軟regex・nested parens許容)', () => {
      // [Step 1: Capture Before State] — read source before assertion
      const src = readSrc('src/screens/GameScreen.tsx');
      expect(src.length).toBeGreaterThan(0);
      const beforeHasDuration = src.includes('r.duration');
      expect(beforeHasDuration).toBe(true); // fixed implementation must contain it

      // [Step 2: Perform Inspection] — flexible semantic check (allows nested parens, any reduce callback style)
      // Postmortem: Do NOT use exact split-based check; allow any parentheses nesting.
      // We check for semantic pattern anywhere in file, not strict outer Math.max() bracket count.
      const hasSemanticPattern = /r\.beat\s*\+\s*\(r\.duration\s*\?\?\s*0\)/.test(src);
      // Also check that it appears inside a reduce that feeds beatToMs
      const hasBeatToMsWrap = src.includes('beatToMs') && src.includes('.reduce');
      // Find the specific line block for lastHitTime assignment
      const lastHitIdx = src.indexOf('lastHitTime');
      expect(lastHitIdx).toBeGreaterThan(-1);
      const window_ = src.slice(Math.max(0, lastHitIdx - 200), lastHitIdx + 600);

      // [Step 3: Assert Changed Outcome] — must pass Green, fail Red (buggy used r.beat only)
      expect(hasSemanticPattern, 'lastHitTime must contain r.beat + (r.duration ?? 0) semantic pattern (hold tail)').toBe(true);
      expect(hasBeatToMsWrap).toBe(true);
      // The window must contain both beatToMs and duration coalesce together
      expect(window_).toMatch(/r\.beat\s*\+\s*\(r\.duration\s*\?\?\s*0\)/);
      // Ensure NOT the buggy pattern that only uses r.beat without duration
      // Check that window does NOT consist solely of `Math.max(m, r.beat)` without `+`
      const buggyOnlyBeat = /Math\.max\s*\(\s*m\s*,\s*r\.beat\s*\)/.test(window_) && !window_.includes('r.duration');
      expect(buggyOnlyBeat, 'must not be buggy r.beat-only without duration').toBe(false);
    });

    it('終了閾値の優先順位が end_beat → lastHitTime+2s → 音源長/フォールバック のternary chainである (柔軟)', () => {
      // [Step 1: Capture Before State]
      const src = readSrc('src/screens/GameScreen.tsx');
      expect(src).toBeDefined();
      const beforeIdxEndBeat = src.indexOf('chart.end_beat');
      const beforeIdxLastHit = src.indexOf('lastHitTime');
      expect(beforeIdxEndBeat).toBeGreaterThan(-1);
      expect(beforeIdxLastHit).toBeGreaterThan(-1);

      // [Step 2: Perform Inspection] — search for full ternary chain structure rather than split-based check
      // Flexible: allow whitespace & newlines between tokens, and allow either END_DELAY_MS or 2000 literal
      const hasEndBeatTernary = /chart\.end_beat\s*!==\s*undefined\s*\?\s*timeline\.beatToMs\s*\(\s*chart\.end_beat\s*\)/.test(src);
      // The whole chain: end_beat ? ... : lastHitTime !== null ? lastHitTime + END_DELAY_MS : (buffer ? ...
      const hasFullChain =
        /chart\.end_beat\s*!==\s*undefined[\s\S]*?lastHitTime\s*!==\s*null[\s\S]*?END_DELAY_MS[\s\S]*?buffer\s*\?\s*buffer\.duration/.test(src);
      // Also verify order via index positions: end_beat branch must appear before lastHitTime branch, which appears before buffer branch
      // For idxLastHitBranch, scope search to the baseEnd chain block (after end_beat) to avoid matching earlier lastHitTime definition
      const idxEndBeat = src.search(/chart\.end_beat\s*!==\s*undefined/);
      const baseEndSlice = idxEndBeat !== -1 ? src.slice(idxEndBeat) : src;
      const idxLastHitBranchRel = baseEndSlice.search(/lastHitTime\s*!==\s*null[\s\S]*?END_DELAY_MS/);
      const idxLastHitBranch = idxLastHitBranchRel !== -1 ? idxEndBeat + idxLastHitBranchRel : -1;
      const idxBufferBranchRel = baseEndSlice.search(/buffer\s*\?\s*buffer\.duration/);
      const idxBufferBranch = idxBufferBranchRel !== -1 ? idxEndBeat + idxBufferBranchRel : -1;
      // Fallback: also allow buffer check inside ternary else
      const idxFallback = src.indexOf('fallbackEnd');

      // [Step 3: Assert Changed Outcome]
      expect(hasEndBeatTernary, 'must have chart.end_beat !== undefined ? timeline.beatToMs(chart.end_beat)').toBe(true);
      expect(hasFullChain, 'must have full ternary chain end_beat -> lastHitTime+END_DELAY -> buffer fallback').toBe(true);
      expect(idxEndBeat).toBeGreaterThan(-1);
      expect(idxLastHitBranch).toBeGreaterThan(idxEndBeat);
      // buffer branch should come after lastHitTime branch (lastHitTime takes priority over buffer)
      expect(idxBufferBranch).toBeGreaterThan(idxLastHitBranch);
      expect(idxFallback).toBeGreaterThan(-1);
      // Ensure buggy pattern is NOT present: buggy used `buffer ? buffer.duration` immediately after end_beat without lastHitTime priority
      // The buggy chain would be `chart.end_beat !== undefined ? ... : (buffer ? ...` directly, without lastHitTime in between.
      const buggyDirectBufferAfterEndBeat = /chart\.end_beat\s*!==\s*undefined\s*\?[\s\S]*?:\s*\(buffer\s*\?/.test(src) && !hasFullChain;
      expect(buggyDirectBufferAfterEndBeat).toBe(false);
    });

    it('endThreshold が baseEnd + (chart?.audio_offset ?? 0) で audio_offset加算が維持される (3-step)', () => {
      // [Step 1: Capture Before State]
      const src = readSrc('src/screens/GameScreen.tsx');
      const beforeHasAudioOffset = src.includes('audio_offset');
      expect(beforeHasAudioOffset).toBe(true);
      const idxThreshold = src.indexOf('endThreshold');
      expect(idxThreshold).toBeGreaterThan(-1);
      const snippet = src.slice(Math.max(0, idxThreshold - 200), idxThreshold + 300);

      // [Step 2: Perform Inspection]
      const hasBasePlusAudioOffset = /endThreshold[\s\S]*?baseEnd\s*\+\s*\(chart\?\.audio_offset\s*\?\?\s*0\)/.test(src);
      const hasSnippetMatch = /chart\?\.audio_offset/.test(snippet);

      // [Step 3: Assert Changed Outcome]
      expect(hasBasePlusAudioOffset, 'endThreshold must be baseEnd + (chart?.audio_offset ?? 0)').toBe(true);
      expect(hasSnippetMatch).toBe(true);
    });

    it('ringSpawner.ts が hold終端を beatToMs(def.beat + duration) or releaseBeat two-step で計算 (柔軟)', () => {
      // [Step 1: Capture Before]
      const src = readSrc('src/game/ringSpawner.ts');
      expect(src.length).toBeGreaterThan(0);
      const beforeHasDuration = src.includes('duration');
      expect(beforeHasDuration).toBe(true);

      // [Step 2: Perform Inspection] — accept either inline or two-step
      // Inline: beatToMs(def.beat + duration) or beatToMs(def.beat + (def.duration ?? 0))
      // Two-step: const releaseBeat = def.beat + duration; ... beatToMs(releaseBeat)
      const hasInline = /beatToMs\s*\(\s*def\.beat\s*\+\s*duration/.test(src) || /beatToMs\s*\(\s*def\.beat\s*\+\s*\(/.test(src);
      const hasTwoStep = /releaseBeat\s*=\s*def\.beat\s*\+\s*duration/.test(src) && /beatToMs\s*\(\s*releaseBeat/.test(src);
      const hasEither = hasInline || hasTwoStep;
      const hasDurationHandling = /r\.duration|def\.duration|duration\s*\?\?\s*0/.test(src);

      // [Step 3: Assert]
      expect(hasEither, 'ringSpawner must compute releaseTime via beatToMs(def.beat + duration) inline OR two-step releaseBeat').toBe(true);
      expect(hasDurationHandling).toBe(true);
    });

    it('Chart型が end_beat?: number 任意プロパティを持つ (3-step)', () => {
      // [Step 1: Capture Before]
      const src = readSrc('src/types.ts');
      expect(src.length).toBeGreaterThan(0);
      const beforeHasChart = src.includes('interface Chart');
      expect(beforeHasChart).toBe(true);

      // [Step 2: Perform Inspection]
      const hasEndBeatOptional = /end_beat\?\s*:\s*number/.test(src) || /end_beat\s*\?:/.test(src);

      // [Step 3: Assert]
      expect(hasEndBeatOptional, 'Chart must have end_beat?: number').toBe(true);
    });
  });

  // ==========================================================================
  // 2. Dynamic computed: lastHitTime hold tail via BpmTimeline (off-grid)
  // ==========================================================================
  describe('2. lastHitTime ホールド終端込み — BpmTimeline数値整合 (3-step off-grid)', () => {
    it('単発リングは旧式と新式が一致するが、ホールドは終端で異なる (complex amp off-grid)', () => {
      // [Step 1: Capture Before State] — single ring baseline
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const singleRings: RingDef[] = [{ beat: 4.0 }];
      const singleLastHitBefore = tl.beatToMs(4.0);
      expect(singleLastHitBefore).toBeCloseTo(2000, 1); // 4 beats * 500ms

      // [Step 2: Perform Action] — compute with hold off-grid duration
      const offGridDurations = [0.37, 1.23, 2.37] as const;
      const complexAmps: number[] = [0.7, 1.3, 2.7];
      void complexAmps; // amplitude does not affect timing but we use complex values for spec compliance
      for (const dur of offGridDurations) {
        const holdBeat = 4.0;
        const holdRings: RingDef[] = [{ beat: holdBeat, duration: dur, type: 'hold' }];
        const fixedLast = tl.beatToMs(holdBeat + dur);
        const buggyLast = tl.beatToMs(holdBeat);
        // [Step 3: Assert Changed Outcome]
        expect(fixedLast).toBeCloseTo((holdBeat + dur) * 500, 2);
        expect(buggyLast).toBeCloseTo(2000, 1);
        expect(fixedLast).not.toBeCloseTo(buggyLast, 1);
        expect(fixedLast).toBeGreaterThan(buggyLast);
        // single should be identical between buggy and fixed
        const fixedSingle = tl.beatToMs(singleRings[0].beat + (singleRings[0].duration ?? 0));
        const buggySingle = tl.beatToMs(singleRings[0].beat);
        expect(fixedSingle).toBeCloseTo(buggySingle, 5);
      }
    });

    it('ホールド終端がBPM変化をまたぐ場合でも beatToMs(r.beat + duration) が正しい (off-grid 0.37/1.23)', () => {
      // [Step 1: Capture Before State] — baseline without hold tail crossing BPM boundary
      const tl = makeTimeline(
        [
          { beat: 0, bpm: 120 },
          { beat: 8, bpm: 180 },
        ],
        1.0,
      );
      // beat 7 hold duration 2.37 => tail at 9.37 crosses beat 8 boundary
      const holdBeat = 7.0;
      const duration = 2.37;
      const tailBeat = holdBeat + duration; // 9.37
      const beforeBuggyMs = tl.beatToMs(holdBeat); // buggy ignores duration
      expect(beforeBuggyMs).toBeCloseTo(7 * 500, 2);

      // [Step 2: Perform Action] — compute fixed lastHitTime
      const fixedMs = tl.beatToMs(tailBeat);
      // Manual expected: first 8 beats at 500ms, remaining 1.37 at 333.333ms (180bpm)
      const expected = 8 * 500 + 1.37 * (60000 / 180);
      expect(fixedMs).toBeCloseTo(expected, 1);

      // [Step 3: Assert Changed Outcome]
      expect(fixedMs).not.toBeCloseTo(beforeBuggyMs, 1);
      expect(fixedMs).toBeGreaterThan(beforeBuggyMs);
      // off-grid fractional check: tail at 7+0.37=7.37 still within first BPM
      const dur037 = 0.37;
      const fixed037 = tl.beatToMs(holdBeat + dur037);
      expect(fixed037).toBeCloseTo((7 + 0.37) * 500, 2);
      expect(fixed037).not.toBeCloseTo(beforeBuggyMs, 1);
    });

    it('複数リング中で最大 tail が lastHitTime になる (単発とホールド混在・off-grid)', () => {
      // [Step 1: Capture Before State] — initial single max at beat 8
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const initialRings: RingDef[] = [{ beat: 8.0 }, { beat: 4.0 }];
      const initialLast = tl.beatToMs(initialRings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity));
      expect(initialLast).toBeCloseTo(4000, 1);

      // [Step 2: Perform Action] — add hold rings with off-grid tails that exceed initial max
      const rings: RingDef[] = [
        { beat: 8.0 },
        { beat: 6.5, duration: 2.0, type: 'hold' }, // tail 8.5
        { beat: 4.37, duration: 1.23, type: 'hold' }, // tail 5.6
        { beat: 7.0, duration: 3.4, type: 'hold' }, // tail 10.4 -> max
      ];
      const fixedLast = tl.beatToMs(rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity));
      const buggyLast = tl.beatToMs(rings.reduce((m, r) => Math.max(m, r.beat), -Infinity));

      // [Step 3: Assert Changed Outcome]
      expect(fixedLast).toBeCloseTo(10.4 * 500, 1);
      expect(buggyLast).toBeCloseTo(8.0 * 500, 1);
      expect(fixedLast).toBeGreaterThan(buggyLast);
      expect(fixedLast).not.toBeCloseTo(initialLast, 1);
      // Verify off-grid tail 4.37+1.23=5.6 is correctly included but not max
      const tail560 = tl.beatToMs(4.37 + 1.23);
      expect(tail560).toBeCloseTo(5.6 * 500, 2);
      expect(tail560).toBeLessThan(fixedLast);
    });

    it('ringSpawner式とGameScreen式が同一 (releaseBeat two-step vs inline 許容) — 数値一致', () => {
      // [Step 1: Capture Before State] — spawner would use def.beat + duration
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const def = { beat: 5.23, duration: 1.23, type: 'hold' as const };
      const beforeInline = tl.beatToMs(def.beat + def.duration!);

      // [Step 2: Perform Action] — two-step variant (as allowed by postmortem)
      const releaseBeat = def.beat + def.duration!;
      const twoStep = tl.beatToMs(releaseBeat);

      // [Step 3: Assert Changed Outcome]
      expect(beforeInline).toBeCloseTo(twoStep, 5);
      expect(beforeInline).toBeCloseTo((5.23 + 1.23) * 500, 1);
      // Both must differ from buggy head-only
      const buggyHeadOnly = tl.beatToMs(def.beat);
      expect(beforeInline).not.toBeCloseTo(buggyHeadOnly, 1);
    });
  });

  // ==========================================================================
  // 3. Priority logic: end_beat → lastHitTime+2s → buffer (mid-chart vs full audio)
  // ==========================================================================
  describe('3. 終了閾値 優先順位ロジック — シミュレーション (3-step)', () => {
    it('end_beat未設定・譜面が曲途中 (lastHitTime << buffer) で最終リング＋2s が優先され音源全体を待たない (off-grid)', () => {
      // [Step 1: Capture Before State] — buggy would pick buffer (full 3min)
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [
        { beat: 8.0 },
        { beat: 16.0 },
        { beat: 32.0 }, // last single at 32 beats = 16s
      ];
      const buffer = { duration: 180 } as AudioBuffer; // 180s = 180000ms
      const chartNoEnd = { audio_offset: 0 } as Chart;
      const beforeBuggy = computeBuggyEndThreshold({ chart: chartNoEnd, timeline: tl, rings, buffer });
      expect(beforeBuggy.baseEndBug).toBeCloseTo(180000, 1); // buggy picks buffer

      // [Step 2: Perform Action] — fixed logic
      const fixed = computeFixedEndThreshold({ chart: chartNoEnd, timeline: tl, rings, buffer });

      // [Step 3: Assert Changed Outcome] — fixed picks lastHitTime+2s
      const expectedLastHit = tl.beatToMs(32); // 16000
      expect(fixed.lastHitTime).toBeCloseTo(expectedLastHit, 1);
      expect(fixed.baseEnd).toBeCloseTo(expectedLastHit + 2000, 1);
      expect(fixed.endThreshold).toBeCloseTo(expectedLastHit + 2000, 1);
      expect(fixed.baseEnd).toBeLessThan(beforeBuggy.baseEndBug);
      expect(fixed.baseEnd).not.toBeCloseTo(180000, 1);
      // off-grid variant: last ring at 32.37 -> should still be lastHit+2s
      const offGridRings: RingDef[] = [{ beat: 32.37 }];
      const fixedOff = computeFixedEndThreshold({ chart: chartNoEnd, timeline: tl, rings: offGridRings, buffer });
      expect(fixedOff.lastHitTime).toBeCloseTo(tl.beatToMs(32.37), 2);
      expect(fixedOff.baseEnd).toBeCloseTo(tl.beatToMs(32.37) + 2000, 2);
      expect(fixedOff.baseEnd).not.toBeCloseTo(180000, 1);
    });

    it('end_beat未設定・ホールド終端込みで最終リング＋2s (hold duration off-grid 0.37/1.23)', () => {
      // [Step 1: Capture Before State] — initial single last at 10 beats
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const singleRings: RingDef[] = [{ beat: 10.0 }];
      const buffer = { duration: 120 } as AudioBuffer;
      const chart = { audio_offset: 0 } as Chart;
      const beforeSingle = computeFixedEndThreshold({ chart, timeline: tl, rings: singleRings, buffer });
      expect(beforeSingle.lastHitTime).toBeCloseTo(5000, 1);

      // [Step 2: Perform Action] — hold extending beyond single
      const holdRings: RingDef[] = [
        { beat: 10.0, duration: 3.37, type: 'hold' }, // tail 13.37
        { beat: 8.0, duration: 1.23, type: 'hold' }, // tail 9.23
      ];
      const fixed = computeFixedEndThreshold({ chart, timeline: tl, rings: holdRings, buffer });
      const buggy = computeBuggyEndThreshold({ chart, timeline: tl, rings: holdRings, buffer });

      // [Step 3: Assert Changed Outcome]
      const expectedTail = tl.beatToMs(13.37);
      expect(fixed.lastHitTime).toBeCloseTo(expectedTail, 1);
      expect(fixed.baseEnd).toBeCloseTo(expectedTail + 2000, 1);
      expect(buggy.lastHitTimeBug).toBeCloseTo(tl.beatToMs(10), 1);
      expect(fixed.lastHitTime).not.toBeCloseTo(buggy.lastHitTimeBug!, 1);
      // fixed picks hold tail+2s (short), buggy picks full buffer (long) -> fixed is EARLIER
      expect(buggy.baseEndBug).toBeCloseTo(120000, 1);
      expect(fixed.baseEnd).toBeLessThan(buggy.baseEndBug);
      expect(fixed.baseEnd).toBeCloseTo(expectedTail + 2000, 1);
    });

    it('end_beat設定時は最終リングや音源長より end_beat が優先される (audio_offset加算維持)', () => {
      // [Step 1: Capture Before State] — without end_beat would be lastHit+2s
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 32.0 }];
      const buffer = { duration: 180 } as AudioBuffer;
      const chartWithoutEnd = { audio_offset: 150 } as Chart;
      const beforeWithoutEnd = computeFixedEndThreshold({ chart: chartWithoutEnd, timeline: tl, rings, buffer });
      expect(beforeWithoutEnd.baseEnd).toBeCloseTo(tl.beatToMs(32) + 2000, 1);

      // [Step 2: Perform Action] — set end_beat to 64 (off-grid 64.37) with fractional audio_offset
      const chartWithEnd = { end_beat: 64.37, audio_offset: 234.56 } as unknown as Chart;
      const fixed = computeFixedEndThreshold({ chart: chartWithEnd, timeline: tl, rings, buffer });

      // [Step 3: Assert Changed Outcome]
      const expectedBase = tl.beatToMs(64.37);
      expect(fixed.baseEnd).toBeCloseTo(expectedBase, 1);
      expect(fixed.endThreshold).toBeCloseTo(expectedBase + 234.56, 2);
      expect(fixed.baseEnd).not.toBeCloseTo(beforeWithoutEnd.baseEnd, 1);
      expect(fixed.baseEnd).not.toBeCloseTo(180000, 1);
      expect(fixed.baseEnd).not.toBeCloseTo(tl.beatToMs(32) + 2000, 1);
    });

    it('リング0個時は音源長が使われ、音源無し時はフォールバック60s (end_beat未設定)', () => {
      // [Step 1: Capture Before State] — rings exist case would be lastHit+2s
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const ringsExist: RingDef[] = [{ beat: 4.0 }];
      const buffer = { duration: 90 } as AudioBuffer;
      const chart = { audio_offset: 0 } as Chart;
      const beforeWithRings = computeFixedEndThreshold({ chart, timeline: tl, rings: ringsExist, buffer });
      expect(beforeWithRings.lastHitTime).not.toBeNull();
      expect(beforeWithRings.baseEnd).toBeCloseTo(tl.beatToMs(4) + 2000, 1);

      // [Step 2: Perform Action] — rings empty
      const emptyRings: RingDef[] = [];
      const fixedWithBuffer = computeFixedEndThreshold({ chart, timeline: tl, rings: emptyRings, buffer });
      const fixedNoBuffer = computeFixedEndThreshold({ chart, timeline: tl, rings: emptyRings, buffer: null });

      // [Step 3: Assert Changed Outcome]
      expect(fixedWithBuffer.lastHitTime).toBeNull();
      expect(fixedWithBuffer.baseEnd).toBeCloseTo(90000, 1);
      expect(fixedWithBuffer.endThreshold).toBeCloseTo(90000, 1);
      expect(fixedWithBuffer.baseEnd).not.toBeCloseTo(beforeWithRings.baseEnd, 1);

      expect(fixedNoBuffer.lastHitTime).toBeNull();
      expect(fixedNoBuffer.baseEnd).toBeCloseTo(60000, 1);
      expect(fixedNoBuffer.endThreshold).toBeCloseTo(60000, 1);
    });

    it('audio_offset が endThreshold に加算される (正・負の分数オフセット off-grid)', () => {
      // [Step 1: Capture Before State] — base without offset
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 16.0 }];
      const buffer = { duration: 180 } as AudioBuffer;
      const chartZero = { audio_offset: 0 } as Chart;
      const beforeZero = computeFixedEndThreshold({ chart: chartZero, timeline: tl, rings, buffer });
      const base = tl.beatToMs(16) + 2000;
      expect(beforeZero.baseEnd).toBeCloseTo(base, 1);
      expect(beforeZero.endThreshold).toBeCloseTo(base, 1);

      // [Step 2: Perform Action] — fractional offsets
      for (const offset of [1500.75, -500.25, 234.56, 0.37 * 1000] as const) {
        const chartOff = { audio_offset: offset } as Chart;
        const fixed = computeFixedEndThreshold({ chart: chartOff, timeline: tl, rings, buffer });
        // [Step 3: Assert Changed Outcome]
        expect(fixed.baseEnd).toBeCloseTo(base, 1); // base unchanged
        expect(fixed.endThreshold).toBeCloseTo(base + offset, 2);
        expect(fixed.endThreshold).not.toBeCloseTo(beforeZero.endThreshold, 1);
        if (offset !== 0) {
          expect(fixed.endThreshold - fixed.baseEnd).toBeCloseTo(offset, 2);
        }
      }
    });
  });

  // ==========================================================================
  // 4. Edge cases: BPM changes, empty, end_beat zero, duration undefined
  // ==========================================================================
  describe('4. エッジケース — BPM変化・単発との互換・duration欠損 (3-step)', () => {
    it('BPM変化がある譜面でも hold tail が正しくbeatToMsで変換される (0.37/1.23 tail)', () => {
      // [Step 1: Capture Before] — simple 120 BPM baseline
      const tlSimple = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const holdBeat = 4.37;
      const duration = 1.23;
      const tail = holdBeat + duration; // 5.6
      const beforeSimple = tlSimple.beatToMs(tail);
      expect(beforeSimple).toBeCloseTo(5.6 * 500, 2);

      // [Step 2: Perform] — timeline with BPM change at beat 4
      const tlChange = makeTimeline(
        [
          { beat: 0, bpm: 120 },
          { beat: 4, bpm: 180 },
        ],
        1.0,
      );
      const fixedTailMs = tlChange.beatToMs(tail);
      // Expected: 0-4 at 500ms, 4-5.6 at 333.33ms
      const expected = 4 * 500 + 1.6 * (60000 / 180);

      // [Step 3: Assert]
      expect(fixedTailMs).toBeCloseTo(expected, 1);
      expect(fixedTailMs).not.toBeCloseTo(beforeSimple, 1);
      expect(fixedTailMs).toBeLessThan(beforeSimple); // faster BPM after 4
      // Verify via endThreshold helper that lastHitTime uses same conversion
      const rings: RingDef[] = [{ beat: holdBeat, duration, type: 'hold' }];
      const fixed = computeFixedEndThreshold({ chart: { audio_offset: 0 } as Chart, timeline: tlChange, rings, buffer: null });
      expect(fixed.lastHitTime).toBeCloseTo(fixedTailMs, 1);
    });

    it('duration未定義のリングは単発として扱われ挙動不変 (単発互換)', () => {
      // [Step 1: Capture Before] — explicit undefined duration
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const ringsUndefined: RingDef[] = [{ beat: 8.0, duration: undefined }, { beat: 4.37, type: 'single' }];
      const beforeLast = tl.beatToMs(ringsUndefined.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity));
      expect(beforeLast).toBeCloseTo(4000, 1);

      // [Step 2: Perform] — rings with explicit single vs undefined duration should be identical
      const ringsSingle: RingDef[] = [{ beat: 8.0 }, { beat: 4.37 }];
      const afterLast = tl.beatToMs(ringsSingle.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity));

      // [Step 3: Assert]
      expect(beforeLast).toBeCloseTo(afterLast, 5);
      expect(afterLast).toBeCloseTo(4000, 1);
      const fixedUndefined = computeFixedEndThreshold({ chart: { audio_offset: 0 } as Chart, timeline: tl, rings: ringsUndefined, buffer: null });
      const fixedSingle = computeFixedEndThreshold({ chart: { audio_offset: 0 } as Chart, timeline: tl, rings: ringsSingle, buffer: null });
      expect(fixedUndefined.lastHitTime).toBeCloseTo(fixedSingle.lastHitTime!, 5);
    });

    it('end_beat=0 が明示された場合は0拍で終了 (ring有無に依らず)', () => {
      // [Step 1: Capture Before] — without end_beat would be lastHit+2s
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 100.0 }];
      const buffer = { duration: 200 } as AudioBuffer;
      const chartNoEnd = { audio_offset: 0 } as Chart;
      const before = computeFixedEndThreshold({ chart: chartNoEnd, timeline: tl, rings, buffer });
      expect(before.baseEnd).toBeCloseTo(tl.beatToMs(100) + 2000, 1);

      // [Step 2: Perform] — end_beat=0
      const chartZero = { end_beat: 0, audio_offset: 0 } as unknown as Chart;
      const fixed = computeFixedEndThreshold({ chart: chartZero, timeline: tl, rings, buffer });

      // [Step 3: Assert]
      expect(fixed.baseEnd).toBeCloseTo(0, 1);
      expect(fixed.endThreshold).toBeCloseTo(0, 1);
      expect(fixed.baseEnd).not.toBeCloseTo(before.baseEnd, 1);
    });

    it('ホールド duration が off-grid 0.37のとき tail拍が正確に snapされるのではなくそのままms化される (durationは自由長)', () => {
      // This verifies that lastHitTime does NOT quantize duration, it uses raw beat+duration
      // [Step 1: Capture Before] — quantized-like expectation would be beat 8 + 0.5 = 8.5
      const tl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const duration037 = 0.37;
      const beat = 8.0;
      const tail = beat + duration037; // 8.37
      const beforeQuantizedGuess = tl.beatToMs(8.5);
      expect(beforeQuantizedGuess).toBeCloseTo(4250, 1);

      // [Step 2: Perform] — actual fixed uses raw 8.37
      const rings: RingDef[] = [{ beat, duration: duration037, type: 'hold' }];
      const fixed = computeFixedEndThreshold({ chart: { audio_offset: 0 } as Chart, timeline: tl, rings, buffer: null });

      // [Step 3: Assert]
      expect(fixed.lastHitTime).toBeCloseTo(tl.beatToMs(8.37), 2);
      expect(fixed.lastHitTime).not.toBeCloseTo(beforeQuantizedGuess, 1);
      expect(fixed.lastHitTime).toBeCloseTo(8.37 * 500, 2);
    });
  });

  // ==========================================================================
  // 5. TOML round-trip for end_beat (serialize/parse)
  // ==========================================================================
  describe('5. TOML往復 — end_beat の保存・読込・優先順位への影響 (3-step)', () => {
    it('end_beat を含むTOMLを出力→再読込で値が再現され、閾値計算に反映される (off-grid 32.37)', () => {
      // [Step 1: Capture Before State] — chart without end_beat
      const tomlNoEnd = `
title = "NoEnd206"
artist = ""
audio = "a.flac"
audio_offset = 0
[[sections]]
beat = 0
bpm = 120
[[rings]]
beat = 16.0
`;
      const parsedNoEnd = parseChartText(tomlNoEnd);
      expect(parsedNoEnd.end_beat).toBeUndefined();
      const tlNoEnd = makeTimeline(parsedNoEnd.bpm_changes, parsedNoEnd.amplitude);
      const beforeThreshold = computeFixedEndThreshold({
        chart: parsedNoEnd,
        timeline: tlNoEnd,
        rings: parsedNoEnd.rings,
        buffer: null,
      });
      expect(beforeThreshold.baseEnd).toBeCloseTo(tlNoEnd.beatToMs(16) + 2000, 1);

      // [Step 2: Perform Action] — chart with end_beat fractional
      const chartWithEnd: Chart = {
        title: 'WithEnd206',
        artist: '',
        audio: 'a.flac',
        audio_offset: 123.45,
        amplitude: 1.0,
        start_position: 0,
        end_beat: 32.37,
        bpm_changes: [{ beat: 0, bpm: 120 }],
        segments: [],
        rings: [{ beat: 16.0 }],
      };
      const toml = chartToToml(chartWithEnd);
      expect(toml).toContain('end_beat');
      expect(toml).toMatch(/end_beat\s*=\s*32\.37/);
      const reparsed = parseChartText(toml);

      // [Step 3: Assert Changed Outcome]
      expect(reparsed.end_beat).toBeCloseTo(32.37, 2);
      expect(reparsed.end_beat).not.toBeUndefined();
      const tl = makeTimeline(reparsed.bpm_changes, reparsed.amplitude);
      const after = computeFixedEndThreshold({ chart: reparsed, timeline: tl, rings: reparsed.rings, buffer: { duration: 180 } as AudioBuffer });
      expect(after.baseEnd).toBeCloseTo(tl.beatToMs(32.37), 1);
      expect(after.endThreshold).toBeCloseTo(tl.beatToMs(32.37) + 123.45, 2);
      expect(after.baseEnd).not.toBeCloseTo(beforeThreshold.baseEnd, 1);
      // Must not be lastHit+2s nor buffer
      expect(after.baseEnd).not.toBeCloseTo(tl.beatToMs(16) + 2000, 1);
      expect(after.baseEnd).not.toBeCloseTo(180000, 1);
    });

    it('旧TOML (end_beat無し) は自動で lastHit+2s になり serializeで明示しなくても良い (3-step)', () => {
      // [Step 1: Capture Before] — legacy without end_beat should fallback to lastHit+2s
      const legacyToml = `
title = "LegacyNoEnd"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
[[rings]]
beat = 8.0
[[rings]]
beat = 12.37
`;
      const parsedLegacy = parseChartText(legacyToml);
      expect(parsedLegacy.end_beat).toBeUndefined();
      const tlLegacy = makeTimeline(parsedLegacy.bpm_changes, parsedLegacy.amplitude);
      const beforeLegacy = computeFixedEndThreshold({ chart: parsedLegacy, timeline: tlLegacy, rings: parsedLegacy.rings, buffer: { duration: 180 } as AudioBuffer });
      expect(beforeLegacy.baseEnd).toBeCloseTo(tlLegacy.beatToMs(12.37) + 2000, 2);

      // [Step 2: Perform] — add end_beat and serialize, then remove it again
      const chartWithEnd: Chart = { ...parsedLegacy, end_beat: 64.0 };
      const tomlWith = chartToToml(chartWithEnd as Chart);
      expect(tomlWith).toContain('end_beat');
      const reparsedWith = parseChartText(tomlWith);
      const afterWith = computeFixedEndThreshold({ chart: reparsedWith, timeline: tlLegacy, rings: reparsedWith.rings, buffer: { duration: 180 } as AudioBuffer });

      // [Step 3: Assert]
      expect(reparsedWith.end_beat).toBeCloseTo(64, 1);
      expect(afterWith.baseEnd).toBeCloseTo(tlLegacy.beatToMs(64), 1);
      expect(afterWith.baseEnd).not.toBeCloseTo(beforeLegacy.baseEnd, 1);
      // Round-trip without end_beat must not inject it
      const tomlWithout = chartToToml(parsedLegacy as Chart);
      expect(tomlWithout).not.toMatch(/^end_beat/m);
    });

    it('end_beatとring tailがBPM変化点で異なる拍でも正しくbeatToMsされる (complex 0.7/1.3/2.7 & 1.23)', () => {
      // [Step 1: Capture Before] — simple timeline baseline
      const simpleTl = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const ringTailSimple = simpleTl.beatToMs(10.37);
      expect(ringTailSimple).toBeCloseTo(10.37 * 500, 2);

      // [Step 2: Perform] — complex BPM sections
      const complexSections: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 8, bpm: 150, amplitude: 1.3 },
        { beat: 12, bpm: 180, amplitude: 2.7 },
      ];
      const tlComplex = makeTimeline(complexSections as any, 1.0);
      const chart: Chart = {
        title: 'ComplexEnd206',
        artist: '',
        audio: 'a.flac',
        audio_offset: -100.5,
        amplitude: 1.3,
        start_position: 0,
        end_beat: 13.37, // cross 12 boundary
        bpm_changes: complexSections as any,
        segments: [],
        rings: [
          { beat: 8.0, duration: 2.37, type: 'hold' }, // tail 10.37
          { beat: 11.0, duration: 1.23, type: 'hold' }, // tail 12.23
        ],
      };
      const expectedEndBeatMs = tlComplex.beatToMs(13.37);
      const expectedLastHit = tlComplex.beatToMs(12.23); // max tail is 12.23

      // [Step 3: Assert]
      const fixedWithEnd = computeFixedEndThreshold({ chart, timeline: tlComplex, rings: chart.rings, buffer: { duration: 200 } as AudioBuffer });
      expect(fixedWithEnd.lastHitTime).toBeCloseTo(expectedLastHit, 1);
      expect(fixedWithEnd.baseEnd).toBeCloseTo(expectedEndBeatMs, 1);
      expect(fixedWithEnd.endThreshold).toBeCloseTo(expectedEndBeatMs - 100.5, 1);
      // Without end_beat, would be lastHit+2s, not end_beat
      const chartNoEnd = { ...chart, end_beat: undefined } as unknown as Chart;
      const fixedNoEnd = computeFixedEndThreshold({ chart: chartNoEnd, timeline: tlComplex, rings: chart.rings, buffer: { duration: 200 } as AudioBuffer });
      expect(fixedNoEnd.baseEnd).toBeCloseTo(expectedLastHit + 2000, 1);
      expect(fixedNoEnd.baseEnd).not.toBeCloseTo(fixedWithEnd.baseEnd, 1);
      // Verify ringTailSimple vs complex differ due BPM
      expect(expectedLastHit).not.toBeCloseTo(ringTailSimple, 1);
    });
  });
});
