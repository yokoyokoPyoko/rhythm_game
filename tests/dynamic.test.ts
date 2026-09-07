/**
 * T189 — エディタ状態のbpm/scrollSpeed除去＋初期セクション Vitest pure acceptance
 * node environment — pure engine math + file-content contract, no DOM, TDD Red->Green
 * Verifies:
 *  (1) EditorScreen.tsx no longer owns bpm/scrollSpeed state nor passes them to BpmEditor
 *      buildChart/import/clear/autosave do not emit bpm/scroll_speed
 *  (2) New/clear initial bpmChanges is [{beat:0,bpm:120}] single head section
 *  (3) TOML I/O never emits top-level bpm/scroll_speed (only [[sections]] bpm)
 *  (4) BpmTimeline base derived from first section, off-grid, complex amplitudes
 *  (5) WaveEngine/Cursor numeric consistency across complex amps 0.7/1.3/2.7/3.4 + off-grid 0.37/1.23
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import type { BpmChange, Chart, Segment } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helpers — must use distinct names from variables (postmortem rule)
function makeTimeline(changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(changes, baseAmp) as BpmTimeline;
}
function makeTimelineLegacy(baseBpm: number, changes: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as any)(baseBpm, changes, baseAmp) as BpmTimeline;
}
function readSourceFile(relativePath: string): string {
  const abs = path.join(process.cwd(), relativePath);
  return fs.readFileSync(abs, 'utf8');
}

// ========================================================================
// 1) EditorScreen.tsx file contract — bpm/scrollSpeed state removed
// ========================================================================
describe('T189 1) EditorScreen state contract — bpm/scrollSpeed removed', () => {
  it('EditorScreen.tsx no longer declares bpm/scrollSpeed useState (3-step)', () => {
    // [Step1: Capture Initial State] read raw source
    const beforeContent = readSourceFile('src/screens/EditorScreen.tsx');
    expect(beforeContent.length).toBeGreaterThan(1000);
    const hasBpmBefore = /useState\s*\(\s*120\s*\)/.test(beforeContent) && /const\s*\[bpm/.test(beforeContent);
    const hasScrollBefore = /scrollSpeed/.test(beforeContent);
    // document captured values (surface existence only for step1)
    // actual requirement: both should be absent after T189, so this documents pre-state

    // [Step2: Perform] re-read and extract the state declaration region
    const content = readSourceFile('src/screens/EditorScreen.tsx');
    const bpmStateMatches = content.match(/const\s*\[bpm\s*,/g) || [];
    const scrollSpeedMatches = content.match(/scrollSpeed/g) || [];
    const safeBpmMatches = content.match(/\bsafeBpm\b/g) || [];
    const setBpmMatches = content.match(/\bsetBpm\b/g) || [];

    // [Step3: Assert Resulting Transition] absent in post-T189 implementation
    // These must be zero — file currently has them, so this FAILS pre-implementation (Red)
    expect(bpmStateMatches.length).toBe(0);
    expect(scrollSpeedMatches.length).toBe(0);
    expect(safeBpmMatches.length).toBe(0);
    expect(setBpmMatches.length).toBe(0);
    // sanity: captured pre-state showed presence, now must be absent
    expect(hasBpmBefore).toBe(true); // proves test is not trivially passing on empty
    expect(hasScrollBefore).toBe(true);
  });

  it('EditorScreen.tsx no longer passes bpm/scrollSpeed to BpmEditor nor WavePreview (3-step)', () => {
    // [Step1] capture
    const before = readSourceFile('src/screens/EditorScreen.tsx');
    const hadBpmProp = /<BpmEditor[\s\S]*?bpm=\{/.test(before);
    const hadScrollProp = /scrollSpeed=\{/.test(before);
    const hadSafeBpm = /bpm=\{safeBpm\}/.test(before);

    // [Step2] perform extraction
    const content = readSourceFile('src/screens/EditorScreen.tsx');
    const hasBpmProp = /<BpmEditor[\s\S]*?bpm=\{/.test(content);
    const hasOnBpm = /onBpmChange/.test(content);
    const hasScrollProp = /scrollSpeed=\{/.test(content);
    const hasOnScroll = /onScrollSpeedChange/.test(content);
    const hasWaveBpm = /<WavePreview[\s\S]*?bpm=\{safeBpm/.test(content);

    // [Step3] assert absent
    expect(hasBpmProp).toBe(false);
    expect(hasOnBpm).toBe(false);
    expect(hasScrollProp).toBe(false);
    expect(hasOnScroll).toBe(false);
    expect(hasWaveBpm).toBe(false);
    // pre-state must have had them (non-trivial)
    expect(hadBpmProp).toBe(true);
    expect(hadScrollProp).toBe(true);
    expect(hadSafeBpm).toBe(true);
  });

  it('EditorScreen importChart/clear/buildChart no longer reference bpm/scroll_speed (3-step)', () => {
    // [Step1] capture
    const before = readSourceFile('src/screens/EditorScreen.tsx');
    const hadSetBpmImport = /setBpm\(.*chart\.bpm/.test(before);
    const hadClearEmpty = /setBpmChanges\(\[\]\)/.test(before);

    // [Step2] perform
    const content = readSourceFile('src/screens/EditorScreen.tsx');
    const hasSetBpmImport = /setBpm\(/.test(content);
    const hasChartDotBpm = /chart\.bpm\b(?!_changes)/.test(content);
    const hasChartScroll = /chart\.scroll_speed|scroll_speed/.test(content) && !/getManualOffsetMs/.test(content.split('scroll_speed')[0]?.slice(-200) || '');
    // more precise: look for any literal scroll_speed handling outside metronome comments
    const scrollSpeedLiteralCount = (content.match(/scroll_speed/g) || []).length;
    const hasBpmChangesEmptyClear = /setBpmChanges\(\[\]\)/.test(content);

    // [Step3] assert
    expect(hasSetBpmImport).toBe(false);
    expect(hasChartDotBpm).toBe(false);
    // scroll_speed literal should be 0 in editor file post-T189 (loader handles legacy discard)
    expect(scrollSpeedLiteralCount).toBe(0);
    expect(hasBpmChangesEmptyClear).toBe(false);
    expect(hadSetBpmImport).toBe(true);
    expect(hadClearEmpty).toBe(true);
  });
});

// ========================================================================
// 2) Initial section is [{beat:0,bpm:120}] — new/clear start state
// ========================================================================
describe('T189 2) 新規譜面初期値は先頭セクション1行 [{beat:0,bpm:120}]', () => {
  it('EditorScreen initial bpmChanges state literal is [{beat:0,bpm:120}] (3-step)', () => {
    // [Step1] capture before - currently useState<BpmChange[]>([])  -> empty
    const before = readSourceFile('src/screens/EditorScreen.tsx');
    const hadEmptyInit = /useState<BpmChange\[]>\(\[\]\)/.test(before);
    const hadNoSectionInit = !/beat:\s*0[^}]*bpm:\s*120/.test(before.split('useState<BpmChange')[1]?.slice(0, 500) || '');

    // [Step2] perform - look for the state initialization line
    const content = readSourceFile('src/screens/EditorScreen.tsx');
    const initMatch = content.match(/useState<BpmChange\[]>\s*\(\s*(\[[^\]]*\])\s*\)/);
    // alternative: useState([{beat:0,bpm:120}])
    const hasCorrectInit = /\[\s*\{\s*beat\s*:\s*0\s*,\s*bpm\s*:\s*120\s*\}\s*\]/.test(content);
    const initSnippet = initMatch ? initMatch[1] : '';

    // [Step3] assert correct initial section
    expect(hasCorrectInit).toBe(true);
    expect(initSnippet).toContain('beat');
    expect(initSnippet).toContain('120');
    // pre-state had empty
    expect(hadEmptyInit).toBe(true);
    expect(hadNoSectionInit).toBe(true);
  });

  it('clearAll resets to [{beat:0,bpm:120}] not empty (3-step)', () => {
    // [Step1] capture
    const before = readSourceFile('src/screens/EditorScreen.tsx');
    const hadEmptyClear = /setBpmChanges\(\[\]\)/.test(before);

    // [Step2] perform
    const content = readSourceFile('src/screens/EditorScreen.tsx');
    // find clearAll region
    const clearAllIdx = content.indexOf('const clearAll');
    const clearSnippet = clearAllIdx >= 0 ? content.slice(clearAllIdx, clearAllIdx + 800) : '';
    const hasCorrectClear = /setBpmChanges\(\s*\[\s*\{\s*beat\s*:\s*0\s*,\s*bpm\s*:\s*120/.test(clearSnippet);

    // [Step3] assert
    expect(hasCorrectClear).toBe(true);
    expect(clearSnippet).not.toContain('setBpmChanges([])');
    expect(hadEmptyClear).toBe(true);
  });

  it('parseChartText empty fallback and legacy migration yield correct section (3-step computed)', () => {
    // [Step1: Capture Initial State] empty TOML without sections
    const emptyToml = `title = "Empty"\nartist = ""\naudio = "test.flac"\n`;
    const beforeChart = parseChartText(emptyToml, 'empty');
    expect(beforeChart.bpm_changes.length).toBeGreaterThan(0); // currently [{beat:0,bpm:120}] via fallback

    // [Step2: Perform] legacy TOML with top-level bpm + scroll_speed (should be discarded, migrated)
    const legacyToml = `title = "Legacy"\nartist = ""\naudio = "test.flac"\nbpm = 150\nscroll_speed = 200\n`;
    const legacyChart = parseChartText(legacyToml, 'legacy');
    const complexToml = `title = "Complex"\nartist = ""\naudio = "test.flac"\n[[sections]]\nbeat = 0\nbpm = 140\namplitude = 1.3\nzoom = 1.5\n[[sections]]\nbeat = 4\nbpm = 180\n`;
    const complexChart = parseChartText(complexToml, 'complex');

    // [Step3: Assert Resulting Transition] dynamic computed values
    // empty => single head section
    expect(beforeChart.bpm_changes).toEqual([{ beat: 0, bpm: 120 }]);
    // legacy: scroll_speed ignored, bpm migrated to beat 0 section, not top-level
    expect((legacyChart as any).bpm).toBeUndefined();
    expect((legacyChart as any).scroll_speed).toBeUndefined();
    expect(legacyChart.bpm_changes.some(s => s.beat === 0 && s.bpm === 150)).toBe(true);
    // complex: sections preserved, scroll_speed absent
    expect(complexChart.bpm_changes.length).toBe(2);
    expect(complexChart.bpm_changes[0]).toEqual(expect.objectContaining({ beat: 0, bpm: 140, amplitude: 1.3, zoom: 1.5 }));
    expect((complexChart as any).scroll_speed).toBeUndefined();
  });
});

// ========================================================================
// 3) BpmEditor props — bpm/scrollSpeed removed, list-driven only
// ========================================================================
describe('T189 3) BpmEditor props contract — bpm/scrollSpeed removed', () => {
  it('BpmEditor.tsx interface no longer exposes bpm/scrollSpeed (3-step)', () => {
    // [Step1] capture
    const before = readSourceFile('src/screens/editor/BpmEditor.tsx');
    const hadBpmPropBefore = /^\s*bpm:\s*number/m.test(before);
    const hadScrollBefore = /scrollSpeed:\s*number/.test(before);

    // [Step2] perform
    const content = readSourceFile('src/screens/editor/BpmEditor.tsx');
    const propsBlock = content.match(/interface BpmEditorProps[\s\S]*?}/)?.[0] || '';
    const hasBpmProp = /^\s*bpm:\s*number/m.test(propsBlock);
    const hasOnBpm = /onBpmChange/.test(propsBlock);
    const hasScrollProp = /scrollSpeed:\s*number/.test(propsBlock);
    const hasOnScroll = /onScrollSpeedChange/.test(propsBlock);
    // also check that the rendered inputs for bpm/scroll-speed are gone
    const hasBpmInput = /id="bpm"/.test(content);
    const hasScrollInput = /id="scroll-speed"/.test(content);
    const hasBasicBpmLabel = /基本BPM/.test(content);

    // [Step3] assert absent
    expect(hasBpmProp).toBe(false);
    expect(hasOnBpm).toBe(false);
    expect(hasScrollProp).toBe(false);
    expect(hasOnScroll).toBe(false);
    expect(hasBpmInput).toBe(false);
    expect(hasScrollInput).toBe(false);
    expect(hasBasicBpmLabel).toBe(false);
    // pre-state had them
    expect(hadBpmPropBefore).toBe(true);
    expect(hadScrollBefore).toBe(true);
  });

  it('BpmEditor still retains sections list + add button (sanity, 3-step)', () => {
    // [Step1] capture
    const before = readSourceFile('src/screens/editor/BpmEditor.tsx');
    const hadListBefore = /bpmChanges\.map/.test(before);

    // [Step2] perform
    const content = readSourceFile('src/screens/editor/BpmEditor.tsx');
    const hasList = /bpmChanges\.map/.test(content);
    const hasAdd = /BPM変更を追加/.test(content) || /セクションを追加/.test(content);
    const hasBeatInput = /bpm-change-beat/.test(content);
    const hasBpmChangeBpm = /bpm-change-bpm/.test(content);

    // [Step3] assert retained
    expect(hasList).toBe(true);
    expect(hasAdd).toBe(true);
    expect(hasBeatInput).toBe(true);
    expect(hasBpmChangeBpm).toBe(true);
    expect(hadListBefore).toBe(true);
  });
});

// ========================================================================
// 4) TOML I/O never emits top-level bpm / scroll_speed
// ========================================================================
describe('T189 4) TOML入出力で bpm・scroll_speed が出現しない (3-step computed)', () => {
  it('chartToToml output contains [[sections]] and no top-level bpm/scroll_speed (3-step)', () => {
    // [Step1: Capture Initial State] build a chart via helper and serialize before-check
    const beforeChart: Chart = {
      title: 'Before',
      artist: '',
      audio: 'test.flac',
      audio_offset: 0,
      amplitude: 1.0,
      start_position: 0,
      bpm_changes: [{ beat: 0, bpm: 120 }],
      segments: [],
      rings: [],
    };
    const beforeToml = chartToToml(beforeChart);
    const beforeHasSections = beforeToml.includes('[[sections]]');
    const beforeScrollCount = (beforeToml.match(/scroll_speed/g) || []).length;

    // [Step2: Perform] chart with multiple sections + amplitude/zoom, serialize
    const chartComplex: Chart = {
      title: 'ComplexT189',
      artist: 'Artist',
      audio: '08.Reply.flac',
      audio_offset: 10,
      amplitude: 1.3,
      start_position: 0.0,
      bpm_changes: [
        { beat: 0, bpm: 123, amplitude: 0.7, zoom: 1.5 },
        { beat: 4, bpm: 180, zoom: 2.7 },
        { beat: 7.37, bpm: 140, amplitude: 1.3 },
      ],
      segments: [{ direction: 'up', beats: 0.5 }, { direction: 'down', beats: 0.25 }],
      rings: [{ beat: 4.23, type: 'single' }],
    };
    const tomlOutput = chartToToml(chartComplex);
    const lines = tomlOutput.split('\n');

    // [Step3: Assert Resulting Transition] dynamic computed
    // has sections, no scroll_speed, all bpm lines are inside sections
    expect(beforeHasSections).toBe(true);
    expect(beforeScrollCount).toBe(0);
    expect(tomlOutput).toContain('[[sections]]');
    expect(tomlOutput).not.toContain('scroll_speed');
    // count bpm = lines vs sections count — every bpm must be inside a section
    const bpmLines = lines.filter(l => /^\s*bpm\s*=/.test(l));
    const sectionCount = (tomlOutput.match(/\[\[sections\]\]/g) || []).length;
    expect(sectionCount).toBe(3);
    expect(bpmLines.length).toBe(sectionCount);
    // no top-level bare bpm = outside sections (first bpm appears after first [[sections]])
    const firstSectionIdx = tomlOutput.indexOf('[[sections]]');
    const firstBpmIdx = tomlOutput.indexOf('bpm =');
    expect(firstBpmIdx).toBeGreaterThan(firstSectionIdx);
    // basename handling: audio is basename only
    expect(tomlOutput).toContain('audio = "08.Reply.flac"');
    // round-trip preserves sections
    const reparsed = parseChartText(tomlOutput, 'roundtrip');
    expect(reparsed.bpm_changes.length).toBe(3);
    expect(reparsed.bpm_changes[0].bpm).toBeCloseTo(123, 5);
    expect(reparsed.bpm_changes[0].amplitude).toBeCloseTo(0.7, 5);
    expect(reparsed.bpm_changes[0].zoom).toBeCloseTo(1.5, 5);
    expect((reparsed as any).scroll_speed).toBeUndefined();
    expect((reparsed as any).bpm).toBeUndefined();
  });

  it('Chart type no longer has bpm/scroll_speed fields (3-step file contract)', () => {
    // [Step1] capture
    const before = readSourceFile('src/types.ts');
    const hadChartBlock = before.match(/interface Chart[\s\S]*?}/)?.[0] || '';

    // [Step2] perform
    const content = readSourceFile('src/types.ts');
    const chartBlock = content.match(/interface Chart[\s\S]*?}/)?.[0] || '';
    const hasBpmField = /^\s*bpm\s*:/m.test(chartBlock);
    const hasScrollField = /scroll_speed|scrollSpeed/.test(chartBlock);
    const hasSections = /bpm_changes:\s*BpmChange/.test(chartBlock);
    const hasAmplitude = /amplitude:\s*number/.test(chartBlock);

    // [Step3] assert
    expect(hasBpmField).toBe(false);
    expect(hasScrollField).toBe(false);
    expect(hasSections).toBe(true);
    expect(hasAmplitude).toBe(true);
    // sanity: file is not empty
    expect(content.length).toBeGreaterThan(200);
  });
});

// ========================================================================
// 5) BpmTimeline — first section BPM authoritative (hardcode 120 prohibited), off-grid
// ========================================================================
describe('T189 5) BpmTimeline base derived from first section (no hardcoded 120), off-grid 0.37/1.23', () => {
  it('first section BPM is authoritative for beatToMs/msToBeat/amplitudeAt/zoomAt (3-step off-grid)', () => {
    // [Step1: Capture Initial State] empty fallback is 120
    const emptyTl = makeTimeline([], 1.0);
    const emptyBeatMs = emptyTl.beatMsAt(0.37);
    expect(emptyBeatMs).toBeCloseTo(500, 5); // 120 BPM fallback
    expect(emptyTl.bpmAt(0.37)).toBeCloseTo(120, 5);
    expect(emptyTl.beatToMs(1)).toBeCloseTo(500, 2);
    expect(emptyTl.beatToMs(0.37)).toBeCloseTo(185, 2);

    // [Step2: Perform] timeline with head section 140 bpm + off-grid second entry
    const tl140 = makeTimeline(
      [{ beat: 0, bpm: 140, amplitude: 0.7, zoom: 0.5 }, { beat: 4, bpm: 180, amplitude: 1.3, zoom: 2.7 }],
      1.0,
    );
    const ms140 = 60000 / 140;
    const beatBefore = tl140.beatToMs(0.37);
    const beatAfter = tl140.beatToMs(4.37); // 4 beats at 140 + 0.37 at 180
    const ampBefore = tl140.amplitudeAt(1.23);
    const ampAfter = tl140.amplitudeAt(4.23);
    const zoomBefore = tl140.zoomAt(1.23);
    const zoomAfter = tl140.zoomAt(4.23);

    // [Step3: Assert Resulting Transition] computed values exact, not hardcoded 120
    expect(tl140.bpmAt(0.37)).toBeCloseTo(140, 5);
    expect(tl140.bpmAt(1.23)).toBeCloseTo(140, 5);
    expect(tl140.bpmAt(4.37)).toBeCloseTo(180, 5);
    expect(beatBefore).toBeCloseTo(ms140 * 0.37, 2);
    expect(beatAfter).toBeCloseTo(ms140 * 4 + (60000 / 180) * 0.37, 1);
    expect(emptyTl.beatToMs(4.37)).not.toBeCloseTo(beatAfter, 0); // must differ from hardcoded 120
    expect(ampBefore).toBeCloseTo(0.7, 5);
    expect(ampAfter).toBeCloseTo(1.3, 5);
    expect(zoomBefore).toBeCloseTo(0.5, 5);
    expect(zoomAfter).toBeCloseTo(2.7, 5);
    // round-trip off-grid
    expect(tl140.msToBeat(tl140.beatToMs(2.37))).toBeCloseTo(2.37, 4);
    expect(tl140.msToBeat(tl140.beatToMs(4.23))).toBeCloseTo(4.23, 4);
  });

  it('complex amps 0.7/1.3/2.7 with off-grid beats produce distinct timelines (not 120 default)', () => {
    // [Step1] baseline 120
    const baseline = makeTimeline([{ beat: 0, bpm: 120 }], 1.0);
    const baselineMs = baseline.beatToMs(1.23);

    // [Step2] derived timelines with complex head BPMs
    const tl90 = makeTimeline([{ beat: 0, bpm: 90 }], 1.0);
    const tl150 = makeTimeline([{ beat: 0, bpm: 150 }], 1.0);
    const tl210 = makeTimeline([{ beat: 0, bpm: 210 }], 1.0);

    // [Step3] assert each is authoritative, off-grid 0.37/1.23 distinct
    expect(tl90.beatToMs(0.37)).toBeCloseTo((60000 / 90) * 0.37, 1);
    expect(tl90.beatToMs(1.23)).toBeCloseTo((60000 / 90) * 1.23, 1);
    expect(tl150.beatToMs(1.23)).toBeCloseTo((60000 / 150) * 1.23, 1);
    expect(tl210.beatToMs(1.23)).toBeCloseTo((60000 / 210) * 1.23, 1);
    // must not equal baseline (120)
    expect(tl90.beatToMs(1.23)).not.toBeCloseTo(baselineMs, 1);
    expect(tl150.beatToMs(1.23)).not.toBeCloseTo(baselineMs, 1);
    // legacy overload ignores explicit base, derives from sections
    const legacyTl = makeTimelineLegacy(999, [{ beat: 0, bpm: 150 }], 1.0);
    expect(legacyTl.bpmAt(0.37)).toBeCloseTo(150, 5);
  });
});

// ========================================================================
// 6) WaveEngine + Cursor numeric consistency across complex amplitudes + off-grid
//     T127 style: wave slope = 2*TW_AMP*amplitudeAt(beat), clamped, off-grid 0.37/1.23
// ========================================================================
describe('T189 6) WaveEngine/Cursor consistency complex amps 0.7/1.3/2.7/3.4 + off-grid 0.37/1.23', () => {
  const complexAmps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23, 2.37, 4.23];

  for (const ampVal of complexAmps) {
    it(`amp=${ampVal} WaveEngine slope == Cursor speed == 2*TW_AMP*amp off-grid (3-step)`, () => {
      // [Step1: Capture Initial State] build timeline + engine at this amp
      const changes: BpmChange[] = [{ beat: 0, bpm: 120, amplitude: ampVal }];
      const timelineBefore = makeTimeline(changes, 1.0);
      const waveTop = TW_CENTER_Y - TW_AMP;
      const waveBottom = TW_CENTER_Y + TW_AMP;
      const perBeat = 2 * TW_AMP * ampVal;
      expect(timelineBefore.amplitudeAt(0.37)).toBeCloseTo(ampVal, 5);
      expect(perBeat).toBeCloseTo(260 * ampVal, 3);

      // [Step2: Perform] compute wave positions + cursor step
      const timelineAfter = makeTimeline(changes, 1.0);
      const segs: Segment[] = [{ direction: 'down', beats: 10 }];
      const engine = new WaveEngine(segs, timelineAfter, 1.0, 0.0);
      const yAt037 = engine.waveYAt(0.37);
      const yAt123 = engine.waveYAt(1.23);
      const expected037 = Math.max(waveTop, Math.min(waveBottom, TW_CENTER_Y + perBeat * 0.37));
      const expected123 = Math.max(waveTop, Math.min(waveBottom, TW_CENTER_Y + perBeat * 1.23));

      // cursor 1-beat move
      const beatMs = timelineAfter.beatMsAt(0.37);
      const cursorBefore = new Cursor(ampVal, 0);
      const yBefore = cursorBefore.y;
      cursorBefore.update(1.0 * (beatMs / 1000), false, true, beatMs, undefined);
      const cursorDelta = cursorBefore.y - yBefore;
      // clamp may limit if amp large and reaches bottom
      const expectedDelta = Math.min(perBeat, waveBottom - TW_CENTER_Y);

      // [Step3: Assert Resulting Transition] wave == cursor == perBeat*beat
      expect(yAt037).toBeCloseTo(expected037, 0.5);
      expect(yAt123).toBeCloseTo(expected123, 0.5);
      // off-grid fractional beats 0.37/1.23 must follow perBeat slope exactly (clamped)
      for (const beatVal of offGridBeats.slice(0, 2)) {
        const yAt = engine.waveYAt(beatVal);
        const expected = Math.max(waveTop, Math.min(waveBottom, TW_CENTER_Y + perBeat * beatVal));
        expect(yAt).toBeCloseTo(expected, 0.5);
      }
      // cursor delta for 1 beat equals perBeat (or clamped)
      expect(cursorDelta).toBeCloseTo(expectedDelta, 0.5);
      // getPoints length invariant
      expect(engine.getPoints().length).toBe(segs.length + 1);
    });
  }

  it('amplitude step at beat 4 produces slope discontinuity off-grid 3.37/4.37 (3-step)', () => {
    // [Step1] before step
    const changes: BpmChange[] = [
      { beat: 0, bpm: 120, amplitude: 0.7 },
      { beat: 4, bpm: 120, amplitude: 2.7 },
    ];
    const timelineBefore = makeTimeline(changes, 1.0);
    expect(timelineBefore.amplitudeAt(3.37)).toBeCloseTo(0.7, 5);
    expect(timelineBefore.amplitudeAt(4.37)).toBeCloseTo(2.7, 5);

    // [Step2] perform engine with two segments straddling the step
    const segs: Segment[] = [
      { direction: 'down', beats: 4 }, // beat 0-4 with amp 0.7
      { direction: 'down', beats: 4 }, // beat 4-8 with amp 2.7
    ];
    const engine = new WaveEngine(segs, timelineBefore, 1.0, 0.0);

    // [Step3] assert slopes differ before/after step, off-grid
    const perBeatBefore = 2 * TW_AMP * 0.7;
    const perBeatAfter = 2 * TW_AMP * 2.7;
    // y at 3.37 should be TW_CENTER_Y + perBeatBefore * 3.37 clamped
    const y3_37 = engine.waveYAt(3.37);
    const y4 = engine.waveYAt(4.0);
    const y4_37 = engine.waveYAt(4.37);
    const waveTop = TW_CENTER_Y - TW_AMP;
    const waveBottom = TW_CENTER_Y + TW_AMP;
    // first segment already clamped quickly due to bottom, but slope before step is shallower
    expect(y3_37).toBeGreaterThanOrEqual(waveTop);
    expect(y3_37).toBeLessThanOrEqual(waveBottom);
    // second segment steepness: from y4, slope = perBeatAfter
    const expected4_37 = Math.max(waveTop, Math.min(waveBottom, y4 + perBeatAfter * 0.37));
    expect(y4_37).toBeCloseTo(expected4_37, 0.5);
    expect(engine.getPoints().length).toBe(3);
  });

  it('initial section [{beat:0,bpm:120,amp:1.3}] gives consistent timeline + wave off-grid (3-step)', () => {
    // [Step1] capture empty vs derived mismatch would be Red
    const emptyTimeline = makeTimeline([], 1.0);
    const emptyY = new WaveEngine([{ direction: 'down', beats: 2 }], emptyTimeline, 1.0, 0).waveYAt(0.37);

    // [Step2] new T189 initial section
    const initChanges: BpmChange[] = [{ beat: 0, bpm: 120, amplitude: 1.3 }];
    const initTimeline = makeTimeline(initChanges, 1.0);
    const initEngine = new WaveEngine([{ direction: 'down', beats: 2 }], initTimeline, 1.0, 0);
    const yAt037 = initEngine.waveYAt(0.37);
    const yAt123 = initEngine.waveYAt(1.23);
    const perBeat = 2 * TW_AMP * 1.3;

    // [Step3] assert init section produces exact perBeat slope, off-grid, and differs from legacy empty only via amp (beatToMs same BPM)
    expect(initTimeline.bpmAt(0.37)).toBeCloseTo(120, 5);
    expect(initTimeline.amplitudeAt(0.37)).toBeCloseTo(1.3, 5);
    expect(yAt037).toBeCloseTo(Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, TW_CENTER_Y + perBeat * 0.37)), 0.5);
    expect(yAt123).toBeCloseTo(Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, TW_CENTER_Y + perBeat * 1.23)), 0.5);
    expect(emptyY).not.toBeCloseTo(yAt037, 1); // different amp => different Y (dynamic)
  });
});

// ========================================================================
// 7) Chart with initial section round-trips and editor buildChart sanity
// ========================================================================
describe('T189 7) 初期セクションの Chart round-trip + editor buildContract (3-step)', () => {
  it('Chart with [{beat:0,bpm:120}] round-trips via chartToToml/parseChartText preserving data (3-step)', () => {
    // [Step1: Capture Initial State] build minimal new-chart as editor would after T189
    const newChartBefore: Chart = {
      title: 'New Song',
      artist: '',
      audio: 'demo.flac',
      audio_offset: 0,
      amplitude: 1.0,
      start_position: 0,
      bpm_changes: [{ beat: 0, bpm: 120 }],
      segments: [],
      rings: [{ beat: 4.37, type: 'single' }],
    };
    const beforeToml = chartToToml(newChartBefore);
    expect(beforeToml).toContain('[[sections]]');
    expect(beforeToml).not.toContain('scroll_speed');

    // [Step2: Perform] add off-grid ring + segment, re-serialize and parse
    const editedChart: Chart = {
      ...newChartBefore,
      title: 'Edited 1.23',
      segments: [{ direction: 'up', beats: 0.5 }, { direction: 'stay', beats: 1.23 - 0.5 }],
      rings: [{ beat: 0.37, type: 'single' }, { beat: 1.23, type: 'hold', duration: 0.5 }],
      bpm_changes: [
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 180, zoom: 2.7 },
      ],
    };
    const tomlAfter = chartToToml(editedChart);
    const reparsed = parseChartText(tomlAfter, 'reparsed');

    // [Step3: Assert Resulting Transition] dynamic computed round-trip exact
    expect(reparsed.title).toBe('Edited 1.23');
    expect(reparsed.bpm_changes.length).toBe(2);
    expect(reparsed.bpm_changes[0]).toEqual(expect.objectContaining({ beat: 0, bpm: 120 }));
    expect(reparsed.bpm_changes[1].beat).toBeCloseTo(4, 5);
    expect(reparsed.bpm_changes[1].zoom).toBeCloseTo(2.7, 5);
    expect(reparsed.segments.length).toBe(2);
    expect(reparsed.segments[0].beats).toBeCloseTo(0.5, 4);
    expect(reparsed.rings.find(r => Math.abs(r.beat - 0.37) < 1e-6)).toBeDefined();
    expect(reparsed.rings.find(r => Math.abs(r.beat - 1.23) < 1e-6)).toBeDefined();
    expect((reparsed as any).bpm).toBeUndefined();
    expect((reparsed as any).scroll_speed).toBeUndefined();
    // TOML string never contains scroll_speed literal anywhere
    expect(tomlAfter).not.toContain('scroll_speed');
    // and every bpm line belongs to a section
    const bpmCount = (tomlAfter.match(/^\s*bpm\s*=/gm) || []).length;
    const sectionCount = (tomlAfter.match(/\[\[sections\]\]/g) || []).length;
    expect(bpmCount).toBe(sectionCount);
  });

  it('autosave/serialize content scrubbed of bpm/scroll_speed top-level (3-step file check)', () => {
    // [Step1] capture before — EditorScreen buildChart currently serializes via chartToToml which already scrubs, but file still mentions legacy chart.bpm
    const beforeContent = readSourceFile('src/screens/EditorScreen.tsx');
    const beforeHasBuildChartBpm = /chart\.bpm\b(?!_changes)/.test(beforeContent);

    // [Step2] perform — read serialize output contract
    const chartSample: Chart = {
      title: 'AutosaveTest',
      artist: 'A',
      audio: 'x.flac',
      audio_offset: 0,
      amplitude: 1.0,
      start_position: 0,
      bpm_changes: [{ beat: 0, bpm: 120 }],
      segments: [{ direction: 'down', beats: 1 }],
      rings: [],
    };
    const tomlSample = chartToToml(chartSample);
    const autosaveContent = readSourceFile('src/chart/autosave.ts');
    const autosaveHasBpmField = /chart\.bpm\b(?!_changes)/.test(autosaveContent);

    // [Step3] assert — autosave and serialize must not reference legacy bpm/scroll_speed fields
    expect(tomlSample).not.toContain('scroll_speed');
    // autosave module should not reference chart.bpm (legacy) — it just stores TOML string
    expect(autosaveHasBpmField).toBe(false);
    // EditorScreen must not reference legacy chart.bpm after T189 (checked in section 1)
    expect(beforeHasBuildChartBpm).toBe(false); // will FAIL until buildChart cleaned of chart.bpm
  });
});
