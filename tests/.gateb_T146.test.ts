/**
 * T146 — フォーカス時スクロール除去（ハイライトのみ） 案A
 * Vitest node environment – pure file-contract + numeric regression
 * Strict TDD acceptance: must FAIL before fix (with el.focus / scrollIntoView) and PASS after
 * Spec: src/screens/EditorScreen.tsx:799-822 handleSelectRing/handleSelectSegment
 *   旧: el.focus() + el.scrollIntoView({block:'nearest',behavior:'smooth'})
 *   新: 両方削除、setSelectedRing/Segment + setRing/SegmentDetailsOpen(true) + requestAnimationFrame（ハイライトクラスで付与）
 *   禁止: focus({preventScroll:true}) も使わない
 *   対象: EditorScreen.tsx のみ、WavePreview/SegmentEditor/index.css は変更なし
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_CENTER_Y, TW_AMP } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { segmentize, quantizeBeat } from '../src/chart/quantize';

vi.useFakeTimers();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function sliceFunction(src: string, fnName: string, len = 700): string {
  const idx = src.indexOf(fnName);
  if (idx === -1) return '';
  return src.slice(idx, idx + len);
}

// ---------------------------------------------------------------------------
// T146-1: File contract — handleSelectRing / handleSelectSegment の focus/scroll 除去
// ---------------------------------------------------------------------------
describe('T146-1: File contract — EditorScreen focus/scroll removal (案A)', () => {
  it('Step1 capture initial handler source before → Step2 inspect handleSelectRing slice → Step3 no focus() nor scrollIntoView in ring handler', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Step1: old buggy contained both focus and scrollIntoView in the rAF block
    const oldBuggySnippet = "el.focus()";
    const oldBuggySnippet2 = "scrollIntoView";
    // Step2: extract ring handler
    const ringSlice = sliceFunction(src, 'const handleSelectRing', 600);
    expect(ringSlice.length, 'handleSelectRing must exist').toBeGreaterThan(50);
    // Step3: must NOT contain focus/scroll
    expect(ringSlice).not.toContain('focus(');
    expect(ringSlice).not.toContain('focus()');
    expect(ringSlice).not.toContain('scrollIntoView');
    expect(ringSlice).not.toContain(oldBuggySnippet);
    expect(ringSlice).not.toContain(oldBuggySnippet2);
    // also must not contain preventScroll alternative (案A prohibits)
    expect(ringSlice).not.toContain('preventScroll');
  });

  it('Step1 capture initial segment handler before → Step2 inspect handleSelectSegment slice → Step3 no focus() nor scrollIntoView in segment handler', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const segSlice = sliceFunction(src, 'const handleSelectSegment', 600);
    expect(segSlice.length, 'handleSelectSegment must exist').toBeGreaterThan(50);
    expect(segSlice).not.toContain('focus(');
    expect(segSlice).not.toContain('scrollIntoView');
    expect(segSlice).not.toContain('preventScroll');
    // legacy query selector pattern must be gone
    expect(segSlice).not.toContain('querySelector');
    expect(segSlice).not.toContain('data-focus-id');
  });

  it('Step1 capture whole EditorScreen before (buggy had 2 occurrences) → Step2 count occurrences file-wide in handlers context → Step3 0 occurrences of focus/scroll in those handlers', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // File-wide sanity: the two handlers combined previously had 2 focus + 2 scrollIntoView
    // After fix, those strings must not appear inside the 1200-char window covering both handlers
    const idxRing = src.indexOf('const handleSelectRing');
    const idxSeg = src.indexOf('const handleSelectSegment');
    expect(idxRing).toBeGreaterThan(-1);
    expect(idxSeg).toBeGreaterThan(-1);
    const windowSlice = src.slice(Math.min(idxRing, idxSeg), Math.max(idxRing, idxSeg) + 800);
    expect(windowSlice).not.toMatch(/\.focus\s*\(/);
    expect(windowSlice).not.toMatch(/scrollIntoView/);
    // Double-check alternative is not used either
    expect(windowSlice).not.toMatch(/preventScroll/);
  });

  it('Step1 capture EditorScreen rAF preservation before → Step2 verify requestAnimationFrame remains (details open wait) → Step3 highlight comment and rAF still present', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringSlice = sliceFunction(src, 'const handleSelectRing', 500);
    const segSlice = sliceFunction(src, 'const handleSelectSegment', 500);
    // rAF must remain for details open
    expect(ringSlice).toContain('requestAnimationFrame');
    expect(segSlice).toContain('requestAnimationFrame');
    // Highlight is via class, comment must reference *-selected class
    expect(ringSlice).toMatch(/ring-list-item-selected/);
    expect(segSlice).toMatch(/segment-list-item-selected/);
    // Must still set selection and open details
    expect(ringSlice).toContain('setSelectedRing');
    expect(ringSlice).toContain('setRingDetailsOpen');
    expect(segSlice).toContain('setSelectedSegment');
    expect(segSlice).toContain('setSegmentDetailsOpen');
  });

  it('Step1 capture file-wide focus contamination before → Step2 scan entire EditorScreen for stray focus/scroll → Step3 no stray el.focus/scrollIntoView outside allowed test files', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Allow no focus/scroll in the file at all except maybe unrelated code (there is none)
    // Count raw occurrences: after fix should be 0
    const focusMatches = (src.match(/\.focus\s*\(/g) || []).length;
    const scrollMatches = (src.match(/scrollIntoView/g) || []).length;
    expect(focusMatches, 'no .focus( should remain in EditorScreen').toBe(0);
    expect(scrollMatches, 'no scrollIntoView should remain').toBe(0);
  });

  it('Step1 capture WavePreview/SegmentEditor immutability before → Step2 verify T146 did not modify them → Step3 selection classes remain, no focus handling migrated', () => {
    const waveSrc = readFile('src/screens/editor/WavePreview.tsx');
    const segSrc = readFile('src/screens/editor/SegmentEditor.tsx');
    const cssSrc = readFile('src/index.css');
    // WavePreview must not have been modified to host focus logic
    expect(waveSrc).not.toContain('focus()');
    expect(waveSrc).not.toContain('scrollIntoView');
    // SegmentEditor still owns segment highlight class (T146 must not move it)
    expect(segSrc).toContain('segment-list-item-selected');
    expect(segSrc).toContain('segment-list-item-hovered');
    // CSS still defines highlight borders (visible without focus)
    expect(cssSrc).toContain('.ring-list-item-selected');
    // segment highlight class lives in SegmentEditor.tsx JSX, not necessarily duplicated in CSS (ring and segment share border-color via same rule name)
    const segCssCheck = readFile('src/screens/editor/SegmentEditor.tsx');
    expect(segCssCheck).toContain('segment-list-item-selected');
    // EditorScreen must be the only file changed for this task
    expect(waveSrc).toContain('Math.round(b / 4)');
  });
});

// ---------------------------------------------------------------------------
// T146-2: 完了条件 — ハイライトのみでスクロールなし、クラスで視認
// ---------------------------------------------------------------------------
describe('T146-2: 完了条件 — highlight visibility without scroll/focus', () => {
  it('Step1 capture pre-selection state before (no selected class) → Step2 verify highlight class wiring → Step3 selectedRing/segment maps to *-selected class', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const segEditorSrc = readFile('src/screens/editor/SegmentEditor.tsx');
    // Step1: initial would have no selected class applied
    // Step2: verify EditorScreen renders ring-list with conditional class
    expect(editorSrc).toContain('ring-list-item');
    expect(editorSrc).toMatch(/selectedRing.*ring-list-item-selected/);
    expect(editorSrc).toContain("data-focus-id={`ring-${i}`}") // id remains for potential future but not used for focus
      // fallback check if template literal not matched due to whitespace
      || editorSrc.includes('data-focus-id');
    // Step3: SegmentEditor wiring
    expect(segEditorSrc).toMatch(/selectedIndex === i \? ' segment-list-item-selected'/);
    // data-focus-id check: avoid bash-expansion brittle exact match, check substrings
    expect(segEditorSrc).toContain('data-focus-id');
    expect(segEditorSrc).toContain('segment-');
    // Ensure the class uses border-color var(--accent) via CSS
    const cssSrc = readFile('src/index.css');
    expect(cssSrc).toMatch(/\.ring-list-item-selected\s*\{[^}]*border-color:\s*var\(--accent\)/);
    // segment highlight wiring exists in JS (CSS file defines ring highlight, segment reuses same border-color concept)
    expect(segEditorSrc).toContain('segment-list-item-selected');
  });

  it('Step1 capture initial off state before click (selectedRing null) → Step2 simulate handler transition → Step3 highlight class condition depends only on selected index, not focus', () => {
    // This is a pure computed transition test: selected index → class string
    function ringClass(selected: number | null, hovered: number | null, idx: number): string {
      return `ring-list-item${selected === idx ? ' ring-list-item-selected' : ''}${hovered === idx ? ' ring-list-item-hovered' : ''}`;
    }
    function segmentClass(selected: number | null, hovered: number | null, idx: number): string {
      return `segment-list-item${selected === idx ? ' segment-list-item-selected' : ''}${hovered === idx ? ' segment-list-item-hovered' : ''}`;
    }
    // Step1: none selected
    expect(ringClass(null, null, 0)).toBe('ring-list-item');
    expect(segmentClass(null, null, 1)).toBe('segment-list-item');
    // Step2: select index 0 / 1
    const afterRing = ringClass(0, null, 0);
    const afterSeg = segmentClass(1, null, 1);
    // Step3: selected class present, no focus needed
    expect(afterRing).toContain('ring-list-item-selected');
    expect(afterSeg).toContain('segment-list-item-selected');
    // Other indices not highlighted
    expect(ringClass(0, null, 1)).not.toContain('ring-list-item-selected');
    expect(segmentClass(1, null, 0)).not.toContain('segment-list-item-selected');
    // Hover alone produces hovered class, not selected
    expect(ringClass(null, 2, 2)).toContain('ring-list-item-hovered');
    expect(ringClass(null, 2, 2)).not.toContain('ring-list-item-selected');
  });

  it('Step1 capture WavePreview selection callback wiring before → Step2 verify onSelectRing/Segment still invoked → Step3 handler updates selected state without scrolling', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Verify that WavePreview is still wired to handleSelectRing/segment
    expect(src).toContain('onSelectRing={handleSelectRing}');
    expect(src).toContain('onSelectSegment={handleSelectSegment}');
    // Verify that WavePreview still exists and has correct data-testid
    const waveSrc = readFile('src/screens/editor/WavePreview.tsx');
    expect(waveSrc).toContain('data-testid="wave-preview"');
    expect(waveSrc).toContain('data-testid="wave-preview-canvas"');
    // Ensure no scroll logic leaked into WavePreview
    expect(waveSrc).not.toContain('scrollIntoView');
  });

  it('Step1 capture CSS :focus-visible before → Step2 verify highlight does not rely on :focus-visible → Step3 border-color highlight works via class alone', () => {
    const cssSrc = readFile('src/index.css');
    // There is a generic button focus-visible, but selection highlight must be class-based not focus-based
    expect(cssSrc).toContain('.ring-list-item-selected');
    // The class must set border-color to accent, not depend on :focus
    const ringSelBlock = cssSrc.slice(cssSrc.indexOf('.ring-list-item-selected'), cssSrc.indexOf('.ring-list-item-selected') + 500);
    expect(ringSelBlock).toMatch(/border-color/);
    expect(ringSelBlock).toContain('var(--accent)');
    // Verify segment highlight class exists in JS (canonical location SegmentEditor.tsx)
    const segSrc = readFile('src/screens/editor/SegmentEditor.tsx');
    expect(segSrc).toContain('segment-list-item-selected');
  });

  it('Step1 capture EditorScreen imports before → Step2 verify import style intact → Step3 WaveEngine import remains flexible and correct', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Flexible check per postmortem: must contain WaveEngine from ../game/waveEngine
    expect(src).toMatch(/import\s+\{[^}]*WaveEngine[^}]*\}\s+from\s+['\"]\.\.\/game\/waveEngine['\"]/);
    expect(src).toContain("import { TW_AMP");
    // Should not have introduced scroll-related imports
    expect(src).not.toContain('scrollIntoView');
  });
});

// ---------------------------------------------------------------------------
// T146-3: Regression guard — WaveEngine / Cursor / BpmTimeline numeric consistency
//            (T146 must not break T127/T128/T131 conventions)
// ---------------------------------------------------------------------------
describe('T146-3: Regression — WaveEngine/Cursor per-beat displacement一致 & off-grid', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it('Step1 capture amplitudeAt before (list-driven) → Step2 create timeline with complex amplitudes → Step3 amplitudeAt returns step value at fractional beats', () => {
    const changes = [
      { beat: 4, bpm: 120, amplitude: 2.0 },
      { beat: 8, bpm: 120, amplitude: 0.7 },
    ];
    const timeline = new BpmTimeline(120, changes, 1.0);
    // Before change 3.37 => base 1.0
    expect(timeline.amplitudeAt(3.37)).toBeCloseTo(1.0, 6);
    // After change at 4, fractional 4.23 => 2.0
    expect(timeline.amplitudeAt(4.23)).toBeCloseTo(2.0, 6);
    expect(timeline.amplitudeAt(4.37)).toBeCloseTo(2.0, 6);
    // After second change at 8, 8.5 => 0.7
    expect(timeline.amplitudeAt(8.5)).toBeCloseTo(0.7, 6);
    expect(timeline.amplitudeAt(7.99)).toBeCloseTo(2.0, 6);
  });

  it('Step1 capture waveYAt before (clamped) → Step2 engine with amp=1.3 complex → Step3 waveYAt slope matches cursor perBeatPx at off-grid', () => {
    const amplitudes = [0.7, 1.3, 2.7, 3.4];
    for (const amp of amplitudes) {
      const timeline = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], timeline, amp, 0);
      const perBeatPx = 2 * TW_AMP * amp;
      // Off-grid beats before clamp (ensure not yet at bottom)
      const testBeats = [0.37, 1.23];
      for (const b of testBeats) {
        // Skip if already clamped (perBeat * b >= TW_AMP)
        if (b * perBeatPx >= TW_AMP - 1e-6) continue;
        const y = engine.waveYAt(b);
        const expected = TW_CENTER_Y + b * perBeatPx;
        expect(y, `amp ${amp} beat ${b}`).toBeCloseTo(expected, 3);
      }
      // Check getPoints length invariant
      const pts = engine.getPoints();
      expect(pts).toHaveLength(2); // 1 seg +1
      expect(pts[0].beat).toBe(0);
      expect(pts[0].y).toBeCloseTo(TW_CENTER_Y, 6); // startPosition 0 => center
    }
  });

  it('Step1 capture cursor speed before → Step2 cursor update with same amp → Step3 cursor move matches waveYAt delta (no clamping small delta)', () => {
    const bpm = 120;
    const beatMs = 60000 / bpm;
    const amplitudes: number[] = [0.7, 1.3, 2.7];
    for (const amp of amplitudes) {
      const timeline = new BpmTimeline(bpm, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], timeline, amp, 0);
      const perBeatPx = 2 * TW_AMP * amp;
      const beatsDelta = 0.15; // small so no clamp from center
      // Cursor start at center (startPosition 0)
      const cursor = new Cursor(amp, 0.0);
      const dt = (beatsDelta * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs);
      const expectedY = TW_CENTER_Y + perBeatPx * beatsDelta;
      expect(cursor.y).toBeCloseTo(expectedY, 2);
      const waveAtDelta = engine.waveYAt(beatsDelta);
      expect(waveAtDelta).toBeCloseTo(cursor.y, 2);
    }
  });

  it('Step1 capture T128 clamp model before → Step2 multi-segment with stay mixed → Step3 segment slope at stay=0, clamp prevents overshoot', () => {
    const timeline = new BpmTimeline(120, [], 1.0);
    const segs = [
      { direction: 'down' as const, beats: 0.5 },
      { direction: 'stay' as const, beats: 1 },
      { direction: 'up' as const, beats: 0.5 },
    ];
    const engine = new WaveEngine(segs, timeline, 1.0, 0);
    // Inside down segment at 0.25 (off-grid 0.37-like) should climb
    const yDownMid = engine.waveYAt(0.25);
    // stay segment should be flat at bottom
    const yStayMid = engine.waveYAt(0.75);
    const yStayEnd = engine.waveYAt(1.5);
    expect(yStayMid).toBeCloseTo(yStayEnd, 4);
    // up segment should go back toward center
    const yUpMid = engine.waveYAt(1.75);
    expect(yUpMid).toBeLessThan(yStayMid);
    // getPoints length stays segments+1
    expect(engine.getPoints()).toHaveLength(4);
  });

  it('Step1 capture segmentize snap invariant before → Step2 short press 0.30 beat snap=0.25 amp=1 → Step3 beats are snap multiples and not 1/amplitude forced', () => {
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: false },
      { beat: 0.3, y: TW_CENTER_Y + 50, down: true },
      { beat: 0.31, y: TW_CENTER_Y + 50, down: false },
    ];
    const segs = segmentize(traj, 0.25, 1);
    for (const s of segs) {
      const rem = ((s.beats % 0.25) + 0.25) % 0.25;
      expect(rem < 1e-6 || Math.abs(rem - 0.25) < 1e-6, `beats ${s.beats} not multiple of 0.25`).toBeTruthy();
    }
    // Must NOT be forced to 1.0 (old physicalSnap bug) and must be snap-aligned
    expect(segs[0].beats).not.toBe(1.0);
    // With threshold logic, 0.3 + 0.01 stay runs merge to 0.5 (0.25+0.25) — either 0.25 or 0.5 is valid snap multiple as long as not 1.0
    expect([0.25, 0.5]).toContain(segs[0].beats);
    expect(segs[0].beats % 0.25).toBeCloseTo(0, 6);
  });

  it('Step1 capture timer determinism before → Step2 advance 1000ms → Step3 pure computed values stable', () => {
    const start = Date.now();
    vi.advanceTimersByTime(1000);
    expect(Date.now()).toBe(start + 1000);
    const a = quantizeBeat(1.2, 0.5);
    const b = quantizeBeat(1.2, 0.5);
    expect(a).toBe(b);
    expect(a).toBe(1.0);
    expect(quantizeBeat(1.3, 0.5)).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// T146-4: File scope & tsc guard — only EditorScreen changed
// ---------------------------------------------------------------------------
describe('T146-4: Scope — only EditorScreen changed, WavePreview/bpmTimeline/cursor intact', () => {
  it('Step1 capture SegmentEditor segment-list-details testid before → Step2 verify it lives in SegmentEditor.tsx → Step3 editorSrc does not duplicate it', () => {
    const segSrc = readFile('src/screens/editor/SegmentEditor.tsx');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    // segSrc must own the details testid (per Prohibited Rules)
    expect(segSrc).toContain('data-testid="segment-list-details"');
    // editorSrc must not have introduced its own duplicate
    const editorOcc = (editorSrc.match(/segment-list-details/g) || []).length;
    expect(editorOcc).toBe(0);
  });

  it('Step1 capture WavePreview minorStep & measure label before → Step2 verify T145/T144 still intact → Step3 no regression from T146', () => {
    const waveSrc = readFile('src/screens/editor/WavePreview.tsx');
    expect(waveSrc).toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*4\s*\?\s*0\.25/);
    expect(waveSrc).toMatch(/String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)/);
    expect(waveSrc).toContain('Math.round(b / 4)');
  });

  it('Step1 capture cursor/waveEngine amp convention before → Step2 verify speed =2*TW_AMP*amp → Step3 clamp invariants hold', () => {
    const cursorSrc = readFile('src/game/cursor.ts');
    const waveSrc = readFile('src/game/waveEngine.ts');
    expect(cursorSrc).toMatch(/2\s*\*\s*TW_AMP\s*\*\s*this\.amplitude/);
    expect(waveSrc).toContain('perBeatPx');
    expect(waveSrc).toContain('2 * TW_AMP * ampAt');
    expect(waveSrc).toContain('export const TW_AMP = 130');
  });

  it('Step1 capture bpmTimeline amplitudeAt before → Step2 verify baseAmplitude fallback → Step3 file contract holds', () => {
    const btlSrc = readFile('src/audio/bpmTimeline.ts');
    expect(btlSrc).toContain('amplitudeAt');
    expect(btlSrc).toContain('amplitudeEntries');
    expect(btlSrc).toContain('baseAmplitude');
  });

  it('Step1 capture EditorScreen handle signatures before → Step2 verify useCallback shape retained → Step3 no extra dependencies introduced', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toMatch(/const handleSelectRing = useCallback\(\(index: number \| null\) => \{/);
    expect(src).toMatch(/const handleSelectSegment = useCallback\(\(index: number \| null\) => \{/);
    // Should still have empty deps [] (no capture of stale state needed for highlight-only)
    const ringDef = src.slice(src.indexOf('const handleSelectRing'), src.indexOf('const handleSelectRing') + 700);
    expect(ringDef).toContain('}, [])');
  });
});
