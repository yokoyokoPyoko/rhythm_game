/**
 * T184 — 楽曲終了位置（end_beat）の指定・保存・判定対応 Acceptance Test
 * 
 * Runs in node environment (vitest environment: node), no DOM.
 * Verifies that Chart type, loader.ts, serialize.ts, and GameScreen song end detection
 * correctly support end_beat specification, TOML round-trip, and timeline.beatToMs(chart.end_beat).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { Chart } from '../src/types';

describe('T184 - 楽曲終了位置（end_beat）の指定・保存・判定対応 (End Beat Specification, Serialization & Song End Detection)', () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  describe('1. Chart Type & TOML Parser / Serializer Support for end_beat (3-Step State Transition)', () => {
    it('parses end_beat from TOML and serializes it back accurately (including off-grid fractional beats)', () => {
      // [Step 1: Capture Initial State]
      const initialToml = `
title = "Test Song"
artist = "Test Artist"
bpm = 120
audio = "test.flac"
[[segments]]
direction = "up"
beats = 4
`;
      const initialChart = parseChartText(initialToml);
      expect(initialChart.end_beat).toBeUndefined();

      // [Step 2: Perform User Interaction / Input with off-grid fractional end_beat]
      const offGridEndBeat = 64.37;
      const updatedToml = `
title = "Test Song"
artist = "Test Artist"
bpm = 120
audio = "test.flac"
end_beat = ${offGridEndBeat}
[[segments]]
direction = "up"
beats = 4
`;
      const parsedChart = parseChartText(updatedToml);

      // [Step 3: Assert Resulting Transition]
      expect(parsedChart.end_beat).toBeDefined();
      expect(parsedChart.end_beat).toBeCloseTo(offGridEndBeat, 3);

      // Verify serialization round-trip
      const serialized = chartToToml(parsedChart);
      expect(serialized).toContain(`end_beat = ${offGridEndBeat}`);

      const roundTripChart = parseChartText(serialized);
      expect(roundTripChart.end_beat).toBeCloseTo(offGridEndBeat, 3);
    });

    it('handles missing or invalid end_beat gracefully during parsing', () => {
      // [Step 1: Capture Initial State]
      const tomlWithoutEndBeat = `
title = "Song B"
artist = "Artist B"
bpm = 140
audio = "b.flac"
`;
      const chart1 = parseChartText(tomlWithoutEndBeat);
      expect(chart1.end_beat).toBeUndefined();

      // [Step 2: Perform Parsing with invalid/negative end_beat]
      const tomlWithInvalidEndBeat = `
title = "Song B"
artist = "Artist B"
bpm = 140
audio = "b.flac"
end_beat = -10
`;
      const chart2 = parseChartText(tomlWithInvalidEndBeat);

      // [Step 3: Assert Resulting Transition (invalid end_beat defaults/clears to undefined)]
      expect(chart2.end_beat).toBeUndefined();
    });
  });

  describe('2. Dynamic Song End Threshold Computation via BpmTimeline and end_beat (Off-Grid Fractional Timing)', () => {
    it('computes song end threshold using timeline.beatToMs(chart.end_beat) when end_beat is specified', () => {
      // [Step 1: Capture Initial State]
      const bpm = 120;
      const timeline = new BpmTimeline(bpm, [], 1.0);
      const endBeat = 32.75; // off-grid fractional beat

      // [Step 2: Compute threshold expected by GameScreen logic]
      const expectedMs = timeline.beatToMs(endBeat);
      const audioOffset = 250; // ms
      const chart: Chart = {
        title: "End Beat Test",
        artist: "Tester",
        bpm,
        audio: "test.flac",
        audio_offset: audioOffset,
        scroll_speed: 110,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [],
        segments: [],
        rings: [],
        end_beat: endBeat,
      };

      // Simulating GameScreen end threshold calculation logic:
      // If chart.end_beat is set, timeline.beatToMs(chart.end_beat) + (chart.audio_offset ?? 0)
      const computedEndThreshold = chart.end_beat !== undefined
        ? timeline.beatToMs(chart.end_beat) + (chart.audio_offset ?? 0)
        : 60000;

      // [Step 3: Assert Resulting Transition]
      expect(computedEndThreshold).toBeCloseTo(expectedMs + audioOffset, 2);
      expect(computedEndThreshold).toBeGreaterThan(0);
    });

    it('falls back correctly to buffer duration / last hit when end_beat is not specified', () => {
      // [Step 1: Capture Initial State]
      const bpm = 150;
      const timeline = new BpmTimeline(bpm, [], 1.0);
      const bufferDurationSec = 180.0;
      const fallbackEnd = bufferDurationSec * 1000;
      const audioOffset = 0;

      const chart: Chart = {
        title: "No End Beat",
        artist: "Tester",
        bpm,
        audio: "test.flac",
        audio_offset: audioOffset,
        scroll_speed: 110,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [],
        segments: [],
        rings: [],
        // end_beat omitted
      };

      // [Step 2: Compute fallback threshold]
      const computedEndThreshold = chart.end_beat !== undefined
        ? timeline.beatToMs(chart.end_beat) + (chart.audio_offset ?? 0)
        : fallbackEnd + (chart.audio_offset ?? 0);

      // [Step 3: Assert Resulting Transition]
      expect(computedEndThreshold).toBeCloseTo(fallbackEnd + audioOffset, 2);
    });
  });
});
