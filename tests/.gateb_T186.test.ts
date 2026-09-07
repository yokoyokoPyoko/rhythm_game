/**
 * T186 — セクション設定の型・TOML刷新（zoom追加・bpm/scroll_speed廃止・[[sections]]化） Acceptance Test
 * Vitest (node环境) — pure engine/math, no DOM
 * Strict TDD: must FAIL (Red) before implementation, PASS (Green) after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import type { Chart, BpmChange } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helpers
function hasSingleBpmLine(toml: string): boolean {
  // detect single line "bpm = <number>" not inside [[sections]] context
  // After T186, only valid bpm lines are inside [[sections]] blocks. The old single-line `bpm = 120`
  // at top-level must be absent. We check: lines that are exactly `bpm =` at start and not preceded by [[sections]]
  const lines = toml.split('\n').map(l => l.trim());
  // Find if any line starts with "bpm =" and the chunk before it is not within a [[sections]] block.
  // Simpler: spec says single-line bpm = and scroll_speed = must NOT exist at all outside sections.
  // Since sections also use `bpm =`, we need to distinguish: top-level bpm appears before any [[sections]]/[[bpm_changes]].
  // So check first occurrence before any section header.
  const firstSectionIdx = lines.findIndex(l => l === '[[sections]]' || l === '[[bpm_changes]]');
  const candidateIdx = lines.findIndex(l => /^bpm\s*=\s*[-+\d.]+/.test(l));
  if (candidateIdx === -1) return false;
  if (firstSectionIdx === -1) return true; // no sections, but bpm line exists => old format
  return candidateIdx < firstSectionIdx; // bpm line before any section header => old single value
}

function hasScrollSpeedLine(toml: string): boolean {
  return toml.split('\n').some(l => l.trim().startsWith('scroll_speed'));
}

describe('T186 セクション設定の型・TOML刷新（zoom追加・bpm/scroll_speed廃止・[[sections]]化） Vitest pure acceptance', () => {
  // ========================================================================
  // 1) zoom付きセクションのTOML往復（出力→再読込）が一致すること
  // ========================================================================
  describe('1. zoom付きTOML往復一致 (完了条件1)', () => {
    it('zoom付き sections の serialize→parse round-tripで beat/bpm/amplitude/zoom が一致 (3-step)', () => {
      // [Step1: Capture Initial State] — create base chart concept without zoom
      const beforeToml = `
title = "Before"
artist = "A"
audio = "test.flac"
[[sections]]
beat = 0
bpm = 120
`;
      let beforeChart: Chart | null = null;
      let beforeFailed = false;
      try {
        beforeChart = parseChartText(beforeToml);
      } catch {
        beforeFailed = true;
      }
      // Before implementation, this will fail or lack zoom support. Record state.
      // We don't assert beforeFailed strictly; we assert after has zoom.

      // [Step2: Perform] — build chart with complex zoom + amplitude values, including off-grid beats
      const complexChart: Chart = {
        title: 'Zoom RoundTrip',
        artist: 'Tester',
        audio: 'test.flac',
        audio_offset: 0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, zoom: 1.0 },
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 2.0 },
          { beat: 8.25, bpm: 140, zoom: 0.5 },
          { beat: 12.125, bpm: 180, amplitude: 2.7, zoom: 1.5 },
        ],
        segments: [{ direction: 'down', beats: 2 }],
        rings: [{ beat: 4.0 }],
      } as unknown as Chart; // as unknown to allow missing legacy fields after refactor

      const toml = chartToToml(complexChart as any);

      // [Step3: Assert Resulting Transition] — round-trip preserves all 4 fields
      // New format must use [[sections]], not [[bpm_changes]], and must not have single bpm/scroll_speed lines
      expect(toml).toContain('[[sections]]');
      expect(toml).not.toContain('[[bpm_changes]]');
      expect(hasSingleBpmLine(toml)).toBe(false);
      expect(hasScrollSpeedLine(toml)).toBe(false);

      // zoom lines must appear for entries that have zoom
      expect(toml).toContain('zoom = 1');
      expect(toml).toContain('zoom = 2');
      expect(toml).toContain('zoom = 0.5');
      expect(toml).toContain('zoom = 1.5');

      // amplitude lines must appear for entries that have amplitude
      expect(toml).toContain('amplitude = 1');
      expect(toml).toContain('amplitude = 1.3');
      expect(toml).toContain('amplitude = 2.7');

      const parsed = parseChartText(toml);
      expect(parsed.bpm_changes.length).toBe(4);
      expect(parsed.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsed.bpm_changes[0].bpm).toBeCloseTo(120, 5);
      expect(parsed.bpm_changes[0].amplitude).toBeCloseTo(1.0, 5);
      expect((parsed.bpm_changes[0] as any).zoom).toBeCloseTo(1.0, 5);

      expect(parsed.bpm_changes[1].beat).toBeCloseTo(4.37, 5);
      expect(parsed.bpm_changes[1].bpm).toBeCloseTo(150, 5);
      expect(parsed.bpm_changes[1].amplitude).toBeCloseTo(1.3, 5);
      expect((parsed.bpm_changes[1] as any).zoom).toBeCloseTo(2.0, 5);

      expect(parsed.bpm_changes[2].beat).toBeCloseTo(8.25, 5);
      expect(parsed.bpm_changes[2].bpm).toBeCloseTo(140, 5);
      // entry without amplitude should have undefined amplitude
      expect(parsed.bpm_changes[2].amplitude).toBeUndefined();
      expect((parsed.bpm_changes[2] as any).zoom).toBeCloseTo(0.5, 5);

      expect(parsed.bpm_changes[3].beat).toBeCloseTo(12.125, 5);
      expect((parsed.bpm_changes[3] as any).zoom).toBeCloseTo(1.5, 5);
      expect(parsed.bpm_changes[3].amplitude).toBeCloseTo(2.7, 5);
    });

    it('zoom が未設定のセクションは undefined を維持し、serializeでzoom行を出力しない (3-step)', () => {
      // [Step1] Capture before: chart with one entry no zoom
      const chartNoZoom: Chart = {
        title: 'NoZoom',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const toml1 = chartToToml(chartNoZoom as any);
      const parsed1 = parseChartText(toml1);
      expect(parsed1.bpm_changes[0].zoom).toBeUndefined();
      expect(parsed1.bpm_changes[0].amplitude).toBeUndefined();

      // [Step2] Perform: add zoom to second entry only
      const chartMixed: Chart = {
        title: 'Mixed',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120 },
          { beat: 4, bpm: 150, zoom: 2.5 },
        ],
        segments: [],
        rings: [],
      } as unknown as Chart;
      const toml2 = chartToToml(chartMixed as any);

      // [Step3] Assert
      const lines = toml2.split('\n');
      // Find sections blocks — first block should have no zoom, second should have zoom
      const sectionBlocks = toml2.split('[[sections]]');
      // sectionBlocks[1] is first entry, [2] second entry
      expect(sectionBlocks.length).toBe(3); // 0: header, 1: entry0, 2: entry1
      expect(sectionBlocks[1]).not.toContain('zoom');
      expect(sectionBlocks[2]).toContain('zoom = 2.5');
      const parsed2 = parseChartText(toml2);
      expect(parsed2.bpm_changes[0].zoom).toBeUndefined();
      expect((parsed2.bpm_changes[1] as any).zoom).toBeCloseTo(2.5, 5);
    });

    it('off-grid beat (0.37, 1.23) + complex zoom/amplitude の往復で数値が一致', () => {
      // [Step1] Capture initial with simple
      const simple: Chart = {
        title: 'S', artist: '', audio: 's.flac', audio_offset: 0, start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120, zoom: 1 }],
        segments: [], rings: [],
      } as unknown as Chart;
      const tomlSimple = chartToToml(simple as any);
      const parsedSimple = parseChartText(tomlSimple);
      expect(parsedSimple.bpm_changes[0].beat).toBeCloseTo(0, 5);

      // [Step2] Perform complex off-grid
      const complex: Chart = {
        title: 'OffGrid', artist: '', audio: 's.flac', audio_offset: 10, start_position: 0.5,
        bpm_changes: [
          { beat: 0.37, bpm: 123.456, amplitude: 0.7, zoom: 0.75 },
          { beat: 1.23, bpm: 178.9, amplitude: 3.4, zoom: 1.33 },
        ],
        segments: [], rings: [],
      } as unknown as Chart;
      const toml = chartToToml(complex as any);
      const parsed = parseChartText(toml);

      // [Step3] Assert off-grid preservation within 1e-3
      expect(parsed.bpm_changes[0].beat).toBeCloseTo(0.37, 3);
      expect(parsed.bpm_changes[1].beat).toBeCloseTo(1.23, 3);
      expect(parsed.bpm_changes[0].bpm).toBeCloseTo(123.456, 3);
      expect(parsed.bpm_changes[1].bpm).toBeCloseTo(178.9, 3);
      expect((parsed.bpm_changes[0] as any).zoom).toBeCloseTo(0.75, 3);
      expect((parsed.bpm_changes[1] as any).zoom).toBeCloseTo(1.33, 3);
    });
  });

  // ========================================================================
  // 2) 旧 [[bpm_changes]] 譜面が読め、scroll_speed が無視されること (完了条件2)
  // ========================================================================
  describe('2. 旧譜面読込＋scroll_speed無視 (完了条件2)', () => {
    it('旧 [[bpm_changes]] 形式が [[sections]] と同等に読める (3-step alias)', () => {
      // [Step1] Capture: new format reading
      const newToml = `
title = "New"
artist = ""
audio = "test.flac"
[[sections]]
beat = 4
bpm = 150
amplitude = 1.3
zoom = 2.0
`;
      const newParsed = parseChartText(newToml);
      const newZoom = (newParsed.bpm_changes[0] as any).zoom;

      // [Step2] Perform: old format with [[bpm_changes]] (zoom not present historically)
      const oldToml = `
title = "Old"
artist = ""
audio = "test.flac"
[[bpm_changes]]
beat = 4
bpm = 150
amplitude = 1.3
`;
      const oldParsed = parseChartText(oldToml);

      // [Step3] Assert: both produce bpm_changes with same beat/bpm/amplitude; old may lack zoom
      expect(oldParsed.bpm_changes.length).toBe(1);
      expect(oldParsed.bpm_changes[0].beat).toBeCloseTo(4, 5);
      expect(oldParsed.bpm_changes[0].bpm).toBeCloseTo(150, 5);
      expect(oldParsed.bpm_changes[0].amplitude).toBeCloseTo(1.3, 5);
      // alias must be readable; zoom undefined is acceptable for old format
      expect(oldParsed.bpm_changes[0].zoom).toBeUndefined();
      // new format carries zoom
      expect(newZoom).toBeCloseTo(2.0, 5);
      // both should have bpm_changes populated
      expect(newParsed.bpm_changes.length).toBe(1);
    });

    it('旧譜面に scroll_speed=999 が含まれても無視される (Chartに保持されない) (3-step)', () => {
      // [Step1] Capture before: toml without scroll_speed
      const without = `
title = "A"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
`;
      const parsedWithout = parseChartText(without);
      const hasScrollWithout = (parsedWithout as any).scroll_speed;

      // [Step2] Perform: same but with legacy scroll_speed
      const withLegacy = `
title = "A"
artist = ""
bpm = 120
audio = "a.flac"
scroll_speed = 999
audio_offset = 0
amplitude = 1.0
[[bpm_changes]]
beat = 2
bpm = 140
[[segments]]
direction = "up"
beats = 2
`;
      const parsedWith = parseChartText(withLegacy);

      // [Step3] Assert: scroll_speed must be ignored (undefined or not 999), and bpm single line ignored
      expect((parsedWith as any).scroll_speed).not.toBe(999);
      // After T186, Chart should NOT have bpm single value property at all (or undefined)
      // So parsing bpm=120 old line should have been migrated into sections, not kept as chart.bpm
      expect((parsedWith as any).bpm).toBeUndefined();
      // But the bpm value should appear as a section at beat 0 via migration
      const hasBeat0 = parsedWith.bpm_changes.some(c => c.beat === 0 && c.bpm === 120);
      // If migration creates beat0 from old bpm, hasBeat0 true. If not, at least bpm_changes contains the old bpm_changes entry.
      expect(parsedWith.bpm_changes.length).toBeGreaterThanOrEqual(1);
      // Ensure scroll_speed is not reflected in parsed object
      if (hasScrollWithout !== undefined) {
        // Before implementation has scroll_speed, after it must be undefined
        expect((parsedWith as any).scroll_speed).toBeUndefined();
      } else {
        expect((parsedWith as any).scroll_speed).toBeUndefined();
      }
    });

    it('scroll_speed が含まれても serialize には出力されない (3-step)', () => {
      // [Step1] Parse old toml with scroll_speed
      const oldToml = `
title = "T"
artist = ""
bpm = 120
audio = "a.flac"
scroll_speed = 250
[[bpm_changes]]
beat = 4
bpm = 150
`;
      const parsed = parseChartText(oldToml);

      // [Step2] Serialize
      const out = chartToToml(parsed as any);

      // [Step3] Assert no scroll_speed, no single bpm
      expect(hasScrollSpeedLine(out)).toBe(false);
      expect(hasSingleBpmLine(out)).toBe(false);
      expect(out).toContain('[[sections]]');
      expect(out).not.toContain('[[bpm_changes]]');
    });

    it('旧bpm_changesの beat=0 は現行 parseBpmChanges の >0 フィルタで失われるが新仕様では保持される (3-step)', () => {
      // [Step1] Capture old behavior: beat 0 filtered?
      const tomlBeat0Old = `
title = "Beat0"
artist = ""
audio = "a.flac"
[[bpm_changes]]
beat = 0
bpm = 120
zoom = 1.5
`;
      // Before fix, beat 0 would be filtered (bpm_changes empty). After fix, it must be kept.
      const parsedBeat0 = parseChartText(tomlBeat0Old);
      // [Step2] Also test [[sections]] beat 0
      const tomlBeat0New = `
title = "Beat0New"
artist = ""
audio = "a.flac"
[[sections]]
beat = 0
bpm = 120
zoom = 1.5
`;
      const parsedNew = parseChartText(tomlBeat0New);

      // [Step3] Assert both keep beat 0
      expect(parsedBeat0.bpm_changes.length).toBeGreaterThanOrEqual(1);
      expect(parsedBeat0.bpm_changes.some(c => c.beat === 0)).toBe(true);
      expect((parsedBeat0.bpm_changes.find(c => c.beat === 0) as any).zoom).toBeCloseTo(1.5, 5);

      expect(parsedNew.bpm_changes.length).toBeGreaterThanOrEqual(1);
      expect(parsedNew.bpm_changes.some(c => c.beat === 0)).toBe(true);
      expect((parsedNew.bpm_changes.find(c => c.beat === 0) as any).zoom).toBeCloseTo(1.5, 5);
    });
  });

  // ========================================================================
  // 3) Chart 型から bpm / scroll_speed 削除 & セクション0件時マイグレーション
  // ========================================================================
  describe('3. Chart.bpm / scroll_speed 廃止とセクション0件時マイグレーション', () => {
    it('Chartに bpm / scroll_speed プロパティが存在しないこと (3-step)', () => {
      // [Step1] Create chart via new-form TOML (no single bpm/scroll_speed)
      const toml = `
title = "NoSingle"
artist = ""
audio = "n.flac"
[[sections]]
beat = 0
bpm = 135
zoom = 1.2
`;
      const chart = parseChartText(toml);
      // [Step2] Inspect properties
      const hasBpm = 'bpm' in chart && (chart as any).bpm !== undefined;
      const hasScroll = 'scroll_speed' in chart && (chart as any).scroll_speed !== undefined;

      // [Step3] Assert they are absent (undefined / not present)
      expect(hasBpm).toBe(false);
      expect(hasScroll).toBe(false);
      expect((chart as any).bpm).toBeUndefined();
      expect((chart as any).scroll_speed).toBeUndefined();
    });

    it('chartToToml が bpm= / scroll_speed= 単一行を出力しないこと (3-step)', () => {
      // [Step1] Capture chart with sections
      const chart: Chart = {
        title: 'NoSingleOut',
        artist: '',
        audio: 'n.flac',
        audio_offset: 0,
        start_position: 0,
        bpm_changes: [{ beat: 0, bpm: 120, zoom: 1 }],
        segments: [],
        rings: [],
      } as unknown as Chart;
      // [Step2] Serialize
      const toml = chartToToml(chart as any);
      // [Step3] Assert
      expect(hasSingleBpmLine(toml)).toBe(false);
      expect(hasScrollSpeedLine(toml)).toBe(false);
      // Ensure no top-level bpm = line before sections
      const lines = toml.split('\n');
      const beforeSections = lines.slice(0, lines.findIndex(l => l.trim() === '[[sections]]'));
      expect(beforeSections.some(l => l.trim().startsWith('bpm'))).toBe(false);
      expect(beforeSections.some(l => l.trim().startsWith('scroll_speed'))).toBe(false);
    });

    it('セクション0件時は [{beat:0, bpm:旧bpm or 120}] にマイグレーション (3-step)', () => {
      // [Step1] Capture: toml with no sections and no bpm (should default to 120)
      const noBpmNoSections = `
title = "Empty"
artist = ""
audio = "e.flac"
`;
      const parsedDefault = parseChartText(noBpmNoSections);
      expect(parsedDefault.bpm_changes.length).toBe(1);
      expect(parsedDefault.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedDefault.bpm_changes[0].bpm).toBeCloseTo(120, 5);
      expect((parsedDefault as any).bpm).toBeUndefined();

      // [Step2] Perform: toml with legacy bpm=135 but no sections
      const legacyBpmNoSections = `
title = "LegacyBpm"
artist = ""
bpm = 135
audio = "e.flac"
`;
      const parsedLegacy = parseChartText(legacyBpmNoSections);

      // [Step3] Assert migration uses old bpm
      expect(parsedLegacy.bpm_changes.length).toBe(1);
      expect(parsedLegacy.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedLegacy.bpm_changes[0].bpm).toBeCloseTo(135, 5);
      expect((parsedLegacy as any).bpm).toBeUndefined();

      // Also verify that parsing legacy bpm with empty sections still migrates
      const emptySectionsExplicit = `
title = "EmptySections"
artist = ""
bpm = 142
audio = "e.flac"
bpm_changes = []
`;
      const parsedExplicit = parseChartText(emptySectionsExplicit);
      expect(parsedExplicit.bpm_changes.length).toBe(1);
      expect(parsedExplicit.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedExplicit.bpm_changes[0].bpm).toBeCloseTo(142, 5);
    });

    it('既にセクションがある場合、0件マイグレーションは発動しない (3-step)', () => {
      // [Step1] Capture default migration
      const empty = `
title = "Empty"
artist = ""
audio = "e.flac"
`;
      const parsedEmpty = parseChartText(empty);
      expect(parsedEmpty.bpm_changes.length).toBe(1);

      // [Step2] Perform: with one section, no migration duplicate
      const withSection = `
title = "With"
artist = ""
audio = "e.flac"
[[sections]]
beat = 0
bpm = 150
[[sections]]
beat = 8
bpm = 180
zoom = 2
`;
      const parsedWith = parseChartText(withSection);

      // [Step3] Assert exactly 2, no extra beat0 120 inserted
      expect(parsedWith.bpm_changes.length).toBe(2);
      expect(parsedWith.bpm_changes[0].beat).toBeCloseTo(0, 5);
      expect(parsedWith.bpm_changes[0].bpm).toBeCloseTo(150, 5);
      expect(parsedWith.bpm_changes[1].beat).toBeCloseTo(8, 5);
      expect((parsedWith.bpm_changes[1] as any).zoom).toBeCloseTo(2, 5);
    });

    it('旧 bpm_changes + 新 sections 両方ある場合、sections を優先 (または統合) し scroll_speed は無視', () => {
      // [Step1] Capture sections only
      const sectionsOnly = `
title = "S"
artist = ""
audio = "s.flac"
[[sections]]
beat = 0
bpm = 120
zoom = 1
`;
      const parsedS = parseChartText(sectionsOnly);
      expect(parsedS.bpm_changes[0].bpm).toBeCloseTo(120, 5);

      // [Step2] Perform both headers present (edge case: file has both old and new)
      const both = `
title = "Both"
artist = ""
bpm = 999
scroll_speed = 999
audio = "s.flac"
[[sections]]
beat = 0
bpm = 140
zoom = 2.2
[[bpm_changes]]
beat = 4
bpm = 150
`;
      const parsedBoth = parseChartText(both);

      // [Step3] Assert: sections value (140) is used, not single bpm 999, scroll_speed ignored
      expect((parsedBoth as any).bpm).toBeUndefined();
      expect((parsedBoth as any).scroll_speed).toBeUndefined();
      // At least the sections entry must exist
      expect(parsedBoth.bpm_changes.some(c => c.beat === 0 && c.bpm === 140)).toBe(true);
      expect((parsedBoth.bpm_changes.find(c => c.beat === 0) as any).zoom).toBeCloseTo(2.2, 5);
    });
  });

  // ========================================================================
  // 4) BpmChange 型に zoom?: number が存在し、Chart.amplitude は維持
  // ========================================================================
  describe('4. BpmChange.zoom 型と Chart.amplitude 維持', () => {
    it('BpmChange は zoom を保持し、Chart.amplitude 基本値は維持される (3-step)', () => {
      // [Step1] Capture chart with amplitude base
      const baseToml = `
title = "AmpBase"
artist = ""
audio = "a.flac"
amplitude = 1.5
[[sections]]
beat = 0
bpm = 120
`;
      const baseChart = parseChartText(baseToml);
      expect(baseChart.amplitude).toBeCloseTo(1.5, 5);
      expect(baseChart.bpm_changes[0].amplitude).toBeUndefined();

      // [Step2] Perform: per-entry amplitude + zoom
      const toml = `
title = "AmpZoom"
artist = ""
audio = "a.flac"
amplitude = 1.5
[[sections]]
beat = 0
bpm = 120
amplitude = 1.0
zoom = 1.2
[[sections]]
beat = 4
bpm = 150
amplitude = 2.0
zoom = 2.5
`;
      const chart = parseChartText(toml);

      // [Step3] Assert base amplitude preserved, per-entry amplitude & zoom stored
      expect(chart.amplitude).toBeCloseTo(1.5, 5);
      expect(chart.bpm_changes[0].amplitude).toBeCloseTo(1.0, 5);
      expect((chart.bpm_changes[0] as any).zoom).toBeCloseTo(1.2, 5);
      expect(chart.bpm_changes[1].amplitude).toBeCloseTo(2.0, 5);
      expect((chart.bpm_changes[1] as any).zoom).toBeCloseTo(2.5, 5);

      // Serialize must preserve both
      const out = chartToToml(chart as any);
      expect(out).toContain('amplitude = 1.5'); // base line
      // Count amplitude lines: base + 2 entries = 3
      const ampLines = out.split('\n').filter(l => l.trim().startsWith('amplitude ='));
      expect(ampLines.length).toBe(3);
      expect(out).toContain('zoom = 1.2');
      expect(out).toContain('zoom = 2.5');
    });

    it('zoom は optional で、数値以外は undefined として無視される (3-step)', () => {
      // [Step1] Valid zoom
      const validToml = `
title = "V"
artist = ""
audio = "v.flac"
[[sections]]
beat = 0
bpm = 120
zoom = 1.5
`;
      const valid = parseChartText(validToml);
      expect((valid.bpm_changes[0] as any).zoom).toBeCloseTo(1.5, 5);

      // [Step2] Invalid zoom values should be ignored
      const invalidToml = `
title = "I"
artist = ""
audio = "v.flac"
[[sections]]
beat = 0
bpm = 120
zoom = "bad"
[[sections]]
beat = 4
bpm = 150
amplitude = 1.2
`;
      const invalid = parseChartText(invalidToml);
      expect((invalid.bpm_changes[0] as any).zoom).toBeUndefined();
      expect(invalid.bpm_changes[1].amplitude).toBeCloseTo(1.2, 5);
      expect((invalid.bpm_changes[1] as any).zoom).toBeUndefined();

      // [Step3] Serialize round-trip for invalid should not produce zoom line for first entry
      const out = chartToToml(invalid as any);
      // First block should not contain zoom, second also not
      const blocks = out.split('[[sections]]');
      expect(blocks[1]).not.toContain('zoom');
      expect(blocks[2]).not.toContain('zoom');
    });
  });

  // ========================================================================
  // 5) 総合: 旧TOML→新TOMLへの移行とチャート再生成の整合
  // ========================================================================
  describe('5. 総合整合 — 旧チャートの移行と再出力後の再読込整合 (off-grid必須)', () => {
    it('旧形式 TOML (bpm単一 + scroll_speed + [[bpm_changes]] + [[segments]]/[[rings]]) を読み込み、新形式で再出力→再読込で同等', () => {
      // [Step1] Capture old file content (reply.toml-like legacy)
      const oldToml = `
title = "Reply"
artist = ""
bpm = 120
audio = "/rhythm_game/audio/08.Reply.flac"
scroll_speed = 110
amplitude = 1.0
[[bpm_changes]]
beat = 64
bpm = 150
[[segments]]
direction = "up"
beats = 2
[[segments]]
direction = "down"
beats = 2
[[rings]]
beat = 4.0
[[rings]]
beat = 8.0
`;
      const oldParsed = parseChartText(oldToml);

      // [Step2] Serialize to new format
      const newToml = chartToToml(oldParsed as any);
      const reparsed = parseChartText(newToml);

      // [Step3] Assert migration equivalence
      expect(newToml).toContain('[[sections]]');
      expect(newToml).not.toContain('[[bpm_changes]]');
      expect(hasSingleBpmLine(newToml)).toBe(false);
      expect(hasScrollSpeedLine(newToml)).toBe(false);

      // bpm single should have become section beat 0
      const hasMigratedBeat0 = reparsed.bpm_changes.some(c => c.beat === 0 && c.bpm === 120);
      expect(hasMigratedBeat0).toBe(true);
      // original bpm_changes entry beat 64 preserved
      expect(reparsed.bpm_changes.some(c => c.beat === 64 && c.bpm === 150)).toBe(true);
      expect(reparsed.segments.length).toBe(2);
      expect(reparsed.rings.length).toBe(2);
      // Reparsing newTOML again via placeholder legacy bpm should not create duplicate beat0
      expect(reparsed.bpm_changes.length).toBe(2);
    });

    it('複雑な振幅+zoom (0.7/1.3/2.7) と端数拍(0.37/1.23)でのセクション生成が物理整合', () => {
      // [Step1] Build chart with off-grid sections
      const chart: Chart = {
        title: 'Complex', artist: '', audio: 'c.flac', audio_offset: 5, start_position: 0.5,
        bpm_changes: [
          { beat: 0.37, bpm: 120, amplitude: 0.7, zoom: 0.8 },
          { beat: 1.23, bpm: 150, amplitude: 1.3, zoom: 1.2 },
          { beat: 4.37, bpm: 180, amplitude: 2.7, zoom: 2.0 },
        ],
        segments: [{ direction: 'up', beats: 1 }, { direction: 'down', beats: 1 }],
        rings: [{ beat: 1.23 }, { beat: 4.37 }],
      } as unknown as Chart;

      // [Step2] Round-trip
      const toml = chartToToml(chart as any);
      const parsed = parseChartText(toml);

      // [Step3] Assert off-grid beats preserved within 1e-3
      expect(parsed.bpm_changes[0].beat).toBeCloseTo(0.37, 3);
      expect(parsed.bpm_changes[1].beat).toBeCloseTo(1.23, 3);
      expect(parsed.bpm_changes[2].beat).toBeCloseTo(4.37, 3);
      expect((parsed.bpm_changes[0] as any).zoom).toBeCloseTo(0.8, 3);
      expect((parsed.bpm_changes[1] as any).zoom).toBeCloseTo(1.2, 3);
      expect((parsed.bpm_changes[2] as any).zoom).toBeCloseTo(2.0, 3);
      expect(parsed.bpm_changes[0].amplitude).toBeCloseTo(0.7, 3);
      expect(parsed.bpm_changes[1].amplitude).toBeCloseTo(1.3, 3);
      expect(parsed.bpm_changes[2].amplitude).toBeCloseTo(2.7, 3);
    });
  });
});
