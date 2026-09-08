/**
 * T206 — 楽曲終了判定の優先順位修正（end_beat未設定時は最終リング＋2秒・ホールド終端対応） Acceptance Test
 * Runs in node environment (vitest environment: node), no DOM.
 * Verifies:
 *  1. GameScreen.tsx: lastHitTime includes hold duration (r.beat + (r.duration ?? 0)) via beatToMs
 *  2. GameScreen.tsx: end threshold priority = end_beat -> lastHitTime+2s -> buffer duration/fallback, with audio_offset
 *  3. Dynamic computed correctness with off-grid beats and BPM changes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { Chart, RingDef } from '../src/types';

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf-8');
}

const END_DELAY_MS = 2000;

// Helper mirroring EXPECTED fixed GameScreen logic (red-green target)
function computeLastHitTimeFixed(rings: RingDef[], timeline: BpmTimeline): number | null {
  if (!rings || rings.length === 0) return null;
  const max = rings.reduce((m, r) => Math.max(m, timeline.beatToMs(r.beat + (r.duration ?? 0))), -Infinity);
  return max;
}
function computeLastHitTimeBuggy(rings: RingDef[], timeline: BpmTimeline): number | null {
  if (!rings || rings.length === 0) return null;
  return timeline.beatToMs(rings.reduce((m, r) => Math.max(m, r.beat), -Infinity));
}
function computeBaseEndFixed(params: {
  chart: Chart;
  timeline: BpmTimeline;
  buffer: { duration: number } | null;
  lastHitTime: number | null;
}): number {
  const fallbackEnd = params.lastHitTime !== null ? params.lastHitTime + END_DELAY_MS : 60000;
  const baseEnd =
    params.chart.end_beat !== undefined
      ? params.timeline.beatToMs(params.chart.end_beat)
      : params.lastHitTime !== null
        ? params.lastHitTime + END_DELAY_MS
        : params.buffer
          ? params.buffer.duration * 1000
          : fallbackEnd;
  return baseEnd;
}
function computeBaseEndBuggy(params: {
  chart: Chart;
  timeline: BpmTimeline;
  buffer: { duration: number } | null;
  lastHitTime: number | null;
}): number {
  const fallbackEnd = params.lastHitTime !== null ? params.lastHitTime + END_DELAY_MS : 60000;
  // Buggy: end_beat -> buffer -> fallbackEnd (ignores lastHitTime when buffer exists)
  const baseEnd = params.chart.end_beat !== undefined ? params.timeline.beatToMs(params.chart.end_beat) : params.buffer ? params.buffer.duration * 1000 : fallbackEnd;
  return baseEnd;
}
function computeEndThreshold(baseEnd: number, audioOffset: number): number {
  return baseEnd + (audioOffset ?? 0);
}

function makeChart(overrides: Partial<Chart> & { rings: RingDef[]; end_beat?: number; audio_offset?: number; bpm_changes?: Chart['bpm_changes'] }): Chart {
  return {
    title: 'Test',
    artist: 'Tester',
    audio: 'test.flac',
    audio_offset: overrides.audio_offset ?? 0,
    amplitude: 1.0,
    start_position: 0,
    bpm_changes: overrides.bpm_changes ?? [{ beat: 0, bpm: 120 }],
    segments: [],
    rings: overrides.rings,
    end_beat: overrides.end_beat,
  };
}

describe('T206 - 楽曲終了判定の優先順位修正 (end_beat未設定時は最終リング＋2秒・ホールド終端対応)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('1. Static Source Code Inspection (GameScreen.tsx must implement fixed priority)', () => {
    it('lastHitTime must include hold tail duration: beatToMs(r.beat + (r.duration ?? 0))', () => {
      // [Step 1: Capture Initial State] read source before
      const src = readSrc('src/screens/GameScreen.tsx');
      expect(src).toBeDefined();
      const hasOldLastHit = src.includes('initChart.rings.reduce((m, r) => Math.max(m, r.beat), -Infinity)');
      // For debugging: old pattern exists before fix
      void hasOldLastHit;

      // [Step 2: Perform Inspection] search for fixed pattern
      const lastHitIdx = src.indexOf('lastHitTime');
      expect(lastHitIdx, 'GameScreen must define lastHitTime').toBeGreaterThan(-1);
      const snippet = src.slice(lastHitIdx, lastHitIdx + 600);

      // [Step 3: Assert Resulting Transition] must contain duration-aware reduce
      expect(snippet, 'lastHitTime must compute max of beat+duration').toMatch(/r\.beat\s*\+\s*\(r\.duration\s*\?\?\s*0\)/);
      expect(snippet, 'lastHitTime must wrap with beatToMs').toMatch(/beatToMs\s*\(/);
      // The reduce must directly compute beatToMs(r.beat + (r.duration ?? 0)) not beatToMs(reduce(... r.beat))
      // Verify the outer beatToMs receives the reduce result that already includes duration
      expect(snippet).toMatch(/beatToMs\s*\(\s*[^)]*r\.beat\s*\+\s*\(r\.duration/);
    });

    it('baseEnd priority must be end_beat -> lastHitTime+END_DELAY -> buffer/fallback (not buffer before lastHitTime)', () => {
      // [Step 1: Capture Initial State]
      const src = readSrc('src/screens/GameScreen.tsx');
      expect(src).toBeDefined();

      // [Step 2: Perform Inspection] extract baseEnd section
      const baseEndIdx = src.indexOf('const baseEnd');
      expect(baseEndIdx, 'GameScreen must define baseEnd').toBeGreaterThan(-1);
      const snippet = src.slice(baseEndIdx, baseEndIdx + 800);

      // [Step 3: Assert Resulting Transition]
      // Fixed: chart.end_beat !== undefined ? timeline.beatToMs(chart.end_beat) : lastHitTime !== null ? lastHitTime + END_DELAY_MS : (buffer ? buffer.duration * 1000 : fallbackEnd)
      expect(snippet).toMatch(/chart\.end_beat\s*!==\s*undefined/);
      expect(snippet).toMatch(/timeline\.beatToMs\s*\(\s*chart\.end_beat/);
      // Must contain lastHitTime priority before buffer
      expect(snippet, 'baseEnd must prioritize lastHitTime + END_DELAY before buffer duration').toMatch(/lastHitTime\s*!==\s*null\s*\?\s*lastHitTime\s*\+\s*END_DELAY_MS/);
      // Must still reference buffer.duration only as tertiary fallback
      expect(snippet).toMatch(/buffer\s*\?\s*buffer\.duration\s*\*\s*1000/);
      // Ensure the buggy sole fallback pattern (buffer ? ... : fallbackEnd) directly after end_beat check without lastHitTime is NOT the top-level structure
      // We assert that after end_beat check, the next token is lastHitTime check, not buffer
      const afterEndBeat = snippet.split('chart.end_beat')[1] ?? '';
      // The first ternary after end_beat should be lastHitTime, not buffer
      expect(afterEndBeat).toMatch(/:\s*lastHitTime/);
    });

    it('endThreshold must still add audio_offset', () => {
      // [Step 1: Capture Initial State]
      const src = readSrc('src/screens/GameScreen.tsx');
      const baseEndIdx = src.indexOf('const baseEnd');
      const snippet = src.slice(baseEndIdx, baseEndIdx + 1000);
      // [Step 2: Perform Inspection]
      const hasAudioOffset = snippet.includes('audio_offset') || src.slice(src.indexOf('endThreshold'), src.indexOf('endThreshold') + 500).includes('audio_offset');
      // [Step 3: Assert Resulting Transition]
      expect(hasAudioOffset, 'endThreshold/baseEnd must include chart.audio_offset').toBe(true);
      expect(src).toMatch(/endThreshold\s*=\s*baseEnd\s*\+\s*\(chart\?\.audio_offset/);
    });
  });

  describe('2. Dynamic lastHitTime with hold duration (off-grid fractional)', () => {
    it('hold tail extends lastHitTime beyond head (short press 0.37 vs hold 2.7 beats)', () => {
      // [Step 1: Capture Initial State] single BPM 120, rings without and with hold
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const singleRings: RingDef[] = [{ beat: 8.37 }];
      const holdRings: RingDef[] = [{ beat: 8.37, duration: 2.7, type: 'hold' as const }];

      const lastHead = computeLastHitTimeBuggy(singleRings, timeline);
      const lastTailFixed = computeLastHitTimeFixed(holdRings, timeline);
      const lastTailBuggy = computeLastHitTimeBuggy(holdRings, timeline);

      // [Step 2: Perform Computation] buggy would return same as head
      expect(lastTailBuggy).toBeCloseTo(lastHead!, 2);

      // [Step 3: Assert Resulting Transition] fixed must be larger by duration
      const expectedTail = timeline.beatToMs(8.37 + 2.7);
      expect(lastTailFixed).toBeCloseTo(expectedTail, 2);
      expect(lastTailFixed!).toBeGreaterThan(lastHead! + 1000);
      // Verify 2.7 beats at 120bpm = 1350ms extension
      const headMs = timeline.beatToMs(8.37);
      expect(lastTailFixed! - headMs).toBeCloseTo(timeline.beatToMs(11.07) - timeline.beatToMs(8.37), 1);
    });

    it('multiple rings: lastHitTime is max of hold tails (off-grid 1.23 + duration)', () => {
      // [Step 1: Capture Initial State]
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [
        { beat: 4.0 },
        { beat: 8.23, duration: 1.37, type: 'hold' },
        { beat: 12.37, duration: 0.5, type: 'hold' },
        { beat: 10.0 },
      ];
      // [Step 2: Perform Action] compute fixed max
      const before = computeLastHitTimeBuggy(rings, timeline);
      const after = computeLastHitTimeFixed(rings, timeline);
      // [Step 3: Assert Resulting Transition]
      // Buggy would take max beat = 12.37
      const maxHeadBeat = Math.max(...rings.map(r => r.beat));
      expect(before).toBeCloseTo(timeline.beatToMs(maxHeadBeat), 2);
      // Fixed: hold at 12.37+0.5=12.87 should be max, but 8.23+1.37=9.6, 12.87 >12.37
      const maxTailBeat = Math.max(...rings.map(r => r.beat + (r.duration ?? 0)));
      expect(after).toBeCloseTo(timeline.beatToMs(maxTailBeat), 2);
      expect(maxTailBeat).toBeCloseTo(12.87, 3);
      expect(after!).toBeGreaterThan(before!);
    });

    it('BPM change crossing hold tail (hold spans tempo change)', () => {
      // [Step 1: Capture Initial State] BPM 120 until beat 8, then 180
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 180 }], 1.0);
      // Hold starting at 7.37 with duration 2.7 -> tail crosses BPM boundary
      const rings: RingDef[] = [{ beat: 7.37, duration: 2.7, type: 'hold' }];
      // [Step 2: Perform Action]
      const headMs = timeline.beatToMs(7.37);
      const tailMs = timeline.beatToMs(7.37 + 2.7);
      const fixed = computeLastHitTimeFixed(rings, timeline);
      // [Step 3: Assert Resulting Transition]
      expect(fixed).toBeCloseTo(tailMs, 2);
      expect(fixed!).toBeGreaterThan(headMs);
      // Duration in ms is not simply duration*500 due to BPM change, verify via timeline
      const buggy = computeLastHitTimeBuggy(rings, timeline);
      expect(buggy).toBeCloseTo(headMs, 2);
      expect(fixed! - buggy!).toBeGreaterThan(500); // at least one beat worth
    });
  });

  describe('3. End threshold priority: end_beat vs lastHitTime+2s vs buffer (short chart, long audio)', () => {
    it('end_beat undefined + short chart (last ring 8 beats) + long buffer (180s) should end at lastHit+2s, not buffer end', () => {
      // [Step 1: Capture Initial State] chart with last ring at 8 beats, buffer 180s (much longer)
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 8.0 }, { beat: 8.37 }];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      const buffer = { duration: 180 } as AudioBuffer;
      const chart = makeChart({ rings, audio_offset: 0, end_beat: undefined });

      // [Step 2: Perform Action] compute with fixed vs buggy priority
      const baseFixed = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });
      const baseBuggy = computeBaseEndBuggy({ chart, timeline, buffer, lastHitTime });

      // [Step 3: Assert Resulting Transition]
      const expectedFixed = lastHitTime! + END_DELAY_MS;
      expect(baseFixed).toBeCloseTo(expectedFixed, 2);
      expect(baseBuggy).toBeCloseTo(buffer.duration * 1000, 2);
      expect(baseFixed).toBeLessThan(baseBuggy);
      // Verify short chart ends ~6s (8.37 beats *500ms +2000), not 180s
      expect(baseFixed).toBeCloseTo(timeline.beatToMs(8.37) + 2000, 2);
      expect(baseFixed).toBeLessThan(10000);
    });

    it('end_beat undefined + hold tail (off-grid 1.23 duration) + long buffer should end at tail+2s', () => {
      // [Step 1: Capture Initial State]
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [
        { beat: 4.0 },
        { beat: 8.23, duration: 1.37, type: 'hold' }, // tail 9.6 beats
      ];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      const buffer = { duration: 200 } as AudioBuffer; // 200s audio
      const chart = makeChart({ rings, end_beat: undefined });

      // [Step 2: Perform Action]
      const baseFixed = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });
      const endThresholdFixed = computeEndThreshold(baseFixed, chart.audio_offset);

      // [Step 3: Assert Resulting Transition]
      const expectedTail = timeline.beatToMs(8.23 + 1.37);
      expect(lastHitTime).toBeCloseTo(expectedTail, 2);
      expect(baseFixed).toBeCloseTo(expectedTail + END_DELAY_MS, 2);
      expect(endThresholdFixed).toBeLessThan(buffer.duration * 1000);
      expect(endThresholdFixed).toBeGreaterThan(expectedTail);
    });

    it('end_beat defined should override both lastHitTime and buffer (even with hold and long audio)', () => {
      // [Step 1: Capture Initial State]
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 4.0 }, { beat: 8.23, duration: 2.7, type: 'hold' }];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      const buffer = { duration: 180 } as AudioBuffer;
      const endBeat = 16.37; // off-grid fractional
      const chart = makeChart({ rings, end_beat: endBeat, audio_offset: 150.75 });

      // [Step 2: Perform Action]
      const baseFixed = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });
      const baseBuggy = computeBaseEndBuggy({ chart, timeline, buffer, lastHitTime });

      // [Step 3: Assert Resulting Transition] both fixed and buggy agree when end_beat set
      const expected = timeline.beatToMs(endBeat);
      expect(baseFixed).toBeCloseTo(expected, 2);
      expect(baseBuggy).toBeCloseTo(expected, 2);
      const threshold = computeEndThreshold(baseFixed, chart.audio_offset);
      expect(threshold).toBeCloseTo(expected + 150.75, 2);
    });

    it('ring 0 + end_beat undefined should fallback to buffer duration (or 60s) with audio_offset', () => {
      // [Step 1: Capture Initial State] no rings
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      expect(lastHitTime).toBeNull();

      const buffer = { duration: 90.5 } as AudioBuffer;
      const chartWithBuffer = makeChart({ rings, end_beat: undefined, audio_offset: 200.25 });
      const chartNoBuffer = makeChart({ rings, end_beat: undefined, audio_offset: -80.5 });

      // [Step 2: Perform Action]
      const baseWithBuffer = computeBaseEndFixed({ chart: chartWithBuffer, timeline, buffer, lastHitTime });
      const baseNoBuffer = computeBaseEndFixed({ chart: chartNoBuffer, timeline, buffer: null, lastHitTime });

      // [Step 3: Assert Resulting Transition]
      expect(baseWithBuffer).toBeCloseTo(buffer.duration * 1000, 2);
      expect(computeEndThreshold(baseWithBuffer, chartWithBuffer.audio_offset)).toBeCloseTo(90500 + 200.25, 2);
      expect(baseNoBuffer).toBeCloseTo(60000, 2);
      expect(computeEndThreshold(baseNoBuffer, chartNoBuffer.audio_offset!)).toBeCloseTo(60000 - 80.5, 2);
    });

    it('ring 0 + end_beat defined should use end_beat even without rings', () => {
      // [Step 1: Capture Initial State]
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const lastHitTime = null;
      const chart = makeChart({ rings: [], end_beat: 32.5, audio_offset: 0 });
      const buffer = { duration: 10 } as AudioBuffer;

      // [Step 2: Perform Action]
      const base = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });

      // [Step 3: Assert Resulting Transition]
      expect(base).toBeCloseTo(timeline.beatToMs(32.5), 2);
    });
  });

  describe('4. audio_offset additivity and off-grid fractional offsets', () => {
    it('endThreshold correctly adds audio_offset (positive and negative off-grid)', () => {
      // [Step 1: Capture Initial State]
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 8.23 }];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      const buffer = { duration: 60 } as AudioBuffer;
      const offGridOffsets = [0, 123.37, -80.75, 250.5];

      for (const audioOffset of offGridOffsets) {
        // [Step 2: Perform Action] each offset
        const chart = makeChart({ rings, audio_offset: audioOffset, end_beat: undefined });
        const base = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });
        const threshold = computeEndThreshold(base, audioOffset);
        // [Step 3: Assert Resulting Transition]
        expect(threshold).toBeCloseTo(lastHitTime! + END_DELAY_MS + audioOffset, 2);
      }
    });

    it('with BPM changes, endThreshold still adds audio_offset after lastHit+2s', () => {
      // [Step 1: Capture Initial State] complex BPM: 120 -> 150 at beat 4
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }, { beat: 4, bpm: 150 }], 1.0);
      const rings: RingDef[] = [{ beat: 6.37, duration: 1.23, type: 'hold' }];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      const chart = makeChart({ rings, bpm_changes: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 150 }], audio_offset: 180.25, end_beat: undefined });
      const buffer = { duration: 200 } as AudioBuffer;

      // [Step 2: Perform Action]
      const base = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });
      const threshold = computeEndThreshold(base, chart.audio_offset);

      // [Step 3: Assert Resulting Transition]
      const tailBeat = 6.37 + 1.23;
      const expectedBase = timeline.beatToMs(tailBeat) + END_DELAY_MS;
      expect(base).toBeCloseTo(expectedBase, 2);
      expect(threshold).toBeCloseTo(expectedBase + 180.25, 2);
    });
  });

  describe('5. Simulated song progression with fake timers (priority regression)', () => {
    it('song should trigger end after lastHoldTail+2s even though buffer is much longer', () => {
      // [Step 1: Capture Initial State] setup timeline and chart as if GameScreen init
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [
        { beat: 4.0 },
        { beat: 8.23, duration: 2.7, type: 'hold' }, // tail 10.93
        { beat: 10.0, duration: 0.5, type: 'hold' }, // tail 10.5
      ];
      const lastHitTime = computeLastHitTimeFixed(rings, timeline);
      const buffer = { duration: 180 } as AudioBuffer; // long audio
      const chart = makeChart({ rings, end_beat: undefined, audio_offset: 50.5 });
      const base = computeBaseEndFixed({ chart, timeline, buffer, lastHitTime });
      const endThreshold = computeEndThreshold(base, chart.audio_offset);

      let songTimeMs = 0;
      const advance = (ms: number) => { songTimeMs += ms; vi.advanceTimersByTime(ms); };

      // [Step 2: Perform Action] advance to just before threshold
      const justBefore = endThreshold - 10;
      advance(justBefore);
      const isFinishedBefore = songTimeMs > endThreshold;

      // [Step 3: Assert Resulting Transition] not yet finished
      expect(isFinishedBefore).toBe(false);
      expect(lastHitTime).toBeCloseTo(timeline.beatToMs(10.93), 2); // max hold tail

      // Advance past threshold
      advance(20);
      const isFinishedAfter = songTimeMs > endThreshold;
      expect(isFinishedAfter).toBe(true);
      // Verify threshold is far earlier than buggy buffer-based threshold
      const buggyThreshold = computeEndThreshold(computeBaseEndBuggy({ chart, timeline, buffer, lastHitTime }), chart.audio_offset);
      expect(endThreshold).toBeLessThan(buggyThreshold);
      expect(buggyThreshold).toBeCloseTo(buffer.duration * 1000 + chart.audio_offset, 2);
    });
  });

  describe('6. ringSpawner.ts consistency: releaseTime formula must match GameScreen lastHitTime', () => {
    it('ringSpawner releaseTime and GameScreen lastHitTime use identical beatToMs(beat+duration) formula', () => {
      // [Step 1: Capture Initial State] read ringSpawner source
      const spawnerSrc = readSrc('src/game/ringSpawner.ts');
      expect(spawnerSrc).toContain('releaseTime');
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120 }], 1.0);
      const rings: RingDef[] = [{ beat: 5.37, duration: 1.23, type: 'hold' }];

      // [Step 2: Perform Action] compute both via timeline
      const releaseTimeViaSpawner = timeline.beatToMs(rings[0].beat + (rings[0].duration ?? 0));
      const lastHitViaFixed = computeLastHitTimeFixed(rings, timeline);

      // [Step 3: Assert Resulting Transition] they must be identical
      expect(lastHitViaFixed).toBeCloseTo(releaseTimeViaSpawner, 2);
      // Verify spawner source uses same expression as spec (line 65)
      expect(spawnerSrc).toMatch(/beatToMs\s*\(\s*[^)]*beat\s*\+\s*duration/);
    });
  });
});
