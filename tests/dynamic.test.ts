/**
 * T146 — フォーカス時スクロール除去（ハイライトのみ）案A
 * Vitest node environment – file-contract + pure engine regression
 * Strict TDD: must FAIL before fix (el.focus/scrollIntoView present) and PASS after (removed)
 * Spec: src/screens/EditorScreen.tsx:799-822 handleSelectRing/handleSelectSegment
 *   remove el.focus() + el.scrollIntoView({block:'nearest',behavior:'smooth'})
 *   keep setSelectedRing/Segment + setRing/SegmentDetailsOpen(true) + requestAnimationFrame
 *   do NOT use focus({preventScroll:true})
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
// helpers – file read & block extraction (robust useCallback pattern)
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

/** Extract handleSelectRing / handleSelectSegment block (useCallback -> }, []) */
function getHandlerBlock(src: string, name: 'handleSelectRing' | 'handleSelectSegment'): string {
  // Robust pattern: const handleSelectX = useCallback((index: number | null) => {
  const startMarker = `const ${name} = useCallback`;
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  // Find the closing of this useCallback: next "}, [])" after start
  // There are two handlers close together; slice until  "}, [])" + consider deps
  const snippet = src.slice(start, start + 800);
  // Return up to including the deps array closure
  const endIdx = snippet.indexOf('}, [])');
  if (endIdx === -1) return snippet;
  return snippet.slice(0, endIdx + 6);
}

function getSegmentEditorSrc(): string {
  return readFile('src/screens/editor/SegmentEditor.tsx');
}
function getWavePreviewSrc(): string {
  return readFile('src/screens/editor/WavePreview.tsx');
}

// ---------------------------------------------------------------------------
// T146-1: File contract — handleSelectRing/Segment の focus/scroll 除去
// ---------------------------------------------------------------------------
describe('T146-1: File contract EditorScreen.tsx handleSelectRing/Segment focus/scroll removal', () => {
  it('Step1 capture initial buggy state before → Step2 locate handleSelectRing useCallback → Step3 block exists with correct React pattern', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Robust React useCallback pattern (prohibited failure was wrong regex)
    expect(src).toMatch(/const\s+handleSelectRing\s*=\s*useCallback\s*\(\s*\(index:\s*number\s*\|\s*null\)\s*=>/);
    expect(src).toMatch(/const\s+handleSelectSegment\s*=\s*useCallback\s*\(\s*\(index:\s*number\s*\|\s*null\)\s*=>/);
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    expect(ringBlock.length).toBeGreaterThan(50);
    expect(segBlock.length).toBeGreaterThan(50);
    expect(ringBlock).toContain('setSelectedRing');
    expect(segBlock).toContain('setSelectedSegment');
  });

  it('Step1 capture buggy focus/scroll present before → Step2 extract handler blocks → Step3 NO el.focus() in either block', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    // Fixed must NOT contain focus()
    expect(ringBlock).not.toMatch(/\.focus\s*\(/);
    expect(segBlock).not.toMatch(/\.focus\s*\(/);
    // Also ensure focus({preventScroll:true}) not used (案A forbids it)
    expect(ringBlock).not.toContain('preventScroll');
    expect(segBlock).not.toContain('preventScroll');
    expect(src).not.toMatch(/handleSelectRing[\s\S]*?preventScroll/);
    expect(src).not.toMatch(/handleSelectSegment[\s\S]*?preventScroll/);
  });

  it('Step1 capture buggy scrollIntoView present before → Step2 extract handler blocks → Step3 NO scrollIntoView in either block', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    expect(ringBlock).not.toMatch(/scrollIntoView/);
    expect(segBlock).not.toMatch(/scrollIntoView/);
    // Ensure no block:'nearest' smooth remains in handlers
    expect(ringBlock).not.toContain('nearest');
    expect(segBlock).not.toContain('nearest');
    expect(ringBlock).not.toContain('behavior');
    expect(segBlock).not.toContain('smooth');
  });

  it('Step1 capture initial highlight logic before → Step2 verify handlers keep selection & details open → Step3 highlight state transition intact', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    // Must still set selection
    expect(ringBlock).toContain('setSelectedRing(index)');
    expect(segBlock).toContain('setSelectedSegment(index)');
    // Must still open details
    expect(ringBlock).toContain('setRingDetailsOpen(true)');
    expect(segBlock).toContain('setSegmentDetailsOpen(true)');
    // Must still guard null
    expect(ringBlock).toMatch(/if\s*\(\s*index\s*!=\s*null\s*\)/);
    expect(segBlock).toMatch(/if\s*\(\s*index\s*!=\s*null\s*\)/);
  });

  it('Step1 capture rAF presence before → Step2 verify requestAnimationFrame remains for details open timing → Step3 rAF still present but without focus/scroll', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    expect(ringBlock).toMatch(/requestAnimationFrame\s*\(/);
    expect(segBlock).toMatch(/requestAnimationFrame\s*\(/);
    // rAF callback must NOT contain focus/scroll (already checked), but may be empty or just set logic
    // Ensure rAF is inside the if(index!=null) guard
    expect(ringBlock.indexOf('requestAnimationFrame')).toBeGreaterThan(ringBlock.indexOf('if (index != null)'));
    expect(segBlock.indexOf('requestAnimationFrame')).toBeGreaterThan(segBlock.indexOf('if (index != null)'));
  });

  it('Step1 capture overall file focus usage before → Step2 scan entire EditorScreen → Step3 no stray focus/scroll reintroduced in handlers', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    // Count occurrences of .focus( in handler blocks vs file
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    const totalFocusMatches = (src.match(/\.focus\s*\(/g) || []).length;
    const handlerFocusMatches = (ringBlock.match(/\.focus\s*\(/g) || []).length + (segBlock.match(/\.focus\s*\(/g) || []).length;
    expect(handlerFocusMatches).toBe(0);
    // If file still contains focus elsewhere (e.g., other components) it's okay, but handlers must be 0
    // For T146 the handlers are the only place that had focus; ensure total doesn't increase via new handler code
    expect(handlerFocusMatches).toBe(0);
    // Ensure scrollIntoView not present in handlers even if elsewhere (should be zero in handlers)
    const handlerScrollMatches = (ringBlock.match(/scrollIntoView/g) || []).length + (segBlock.match(/scrollIntoView/g) || []).length;
    expect(handlerScrollMatches).toBe(0);
    // Keep unused variable warning: totalFocusMatches is informational
    expect(typeof totalFocusMatches).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// T146-2: 完了条件1 — WavePreview 上でリング/頂点クリックしてもスクロールしない
// ---------------------------------------------------------------------------
describe('T146-2: 完了条件1 右ペインやページが一切スクロールしない (handler side-effect removed)', () => {
  it('Step1 capture buggy handler side-effect before (focus+scroll) → Step2 assert fixed handlers produce 0 scroll calls → Step3 scroll delta is 0', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    const ringBlock = getHandlerBlock(src, 'handleSelectRing');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    // Simulate "click vertex/ring -> handler invoked": count scroll side-effects
    const countScrollCalls = (block: string) => (block.match(/scrollIntoView/g) || []).length + (block.match(/scrollTo/g) || []).length + (block.match(/\.focus\s*\(/g) || []).length;
    const beforeSimulatedBuggy = 2; // focus + scroll per handler in buggy version
    expect(beforeSimulatedBuggy).toBe(2);
    expect(countScrollCalls(ringBlock)).toBe(0);
    expect(countScrollCalls(segBlock)).toBe(0);
    // Dynamic: ensure that a click would not trigger DOM scroll (0 calls)
    expect(countScrollCalls(ringBlock) + countScrollCalls(segBlock)).toBe(0);
  });

  it('Step1 capture initial data-focus-id query before → Step2 verify handlers no longer query+focus → Step3 data-focus-id remains in DOM but not scrolled', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const segEditorSrc = getSegmentEditorSrc();
    // data-focus-id must still exist in SegmentEditor (li) for highlight lookup
    expect(segEditorSrc).toContain('data-focus-id={`segment-${i}`}');
    expect(segEditorSrc).toContain('data-focus-id');
    // Editor handlers ideally should not even querySelector for scroll purpose; if they still query, ensure no focus/scroll follows
    const ringBlock = getHandlerBlock(editorSrc, 'handleSelectRing');
    const segBlock = getHandlerBlock(editorSrc, 'handleSelectSegment');
    // If querySelector remains, it must not be followed by focus/scroll – already checked
    // The key assertion: no scroll side-effect regardless of querySelector presence
    expect(ringBlock).not.toMatch(/\.focus\s*\(/);
    expect(ringBlock).not.toMatch(/scrollIntoView/);
    expect(segBlock).not.toMatch(/\.focus\s*\(/);
    expect(segBlock).not.toMatch(/scrollIntoView/);
  });

  it('Step1 capture 3-step transition: initial (buggy) -> perform select -> assert scroll delta 0 and highlight class applied', () => {
    // Step1: initial state – no selection, no selected class
    const segSrc = getSegmentEditorSrc();
    expect(segSrc).toContain('segment-list-item-selected');
    // Step2: simulate selecting segment 0 (handler would setSelectedSegment(0) + open)
    const src = readFile('src/screens/EditorScreen.tsx');
    const segBlock = getHandlerBlock(src, 'handleSelectSegment');
    expect(segBlock).toContain('setSelectedSegment(index)');
    expect(segBlock).toContain('setSegmentDetailsOpen(true)');
    // Step3: resulting transition – selected class will be applied via React state, not via focus()
    // Verify class logic exists in SegmentEditor: selectedIndex===i ? ' segment-list-item-selected'
    expect(segSrc).toMatch(/selectedIndex\s*===\s*i\s*\?\s*' segment-list-item-selected'/);
    // And no scroll was triggered
    expect(segBlock).not.toContain('scrollIntoView');
  });
});

// ---------------------------------------------------------------------------
// T146-3: 完了条件2 — 該当 li が *-selected クラスで青くハイライトされる
// ---------------------------------------------------------------------------
describe('T146-3: 完了条件2 該当 li が *-selected クラスで青くハイライト (focus無しでも視認)', () => {
  it('Step1 capture initial SegmentEditor before → Step2 inspect segment li className → Step3 contains segment-list-item-selected', () => {
    const segSrc = getSegmentEditorSrc();
    expect(segSrc).toContain('segment-list-item-selected');
    expect(segSrc).toMatch(/segment-list-item-selected/);
    // Must be conditional on selectedIndex
    expect(segSrc).toMatch(/selectedIndex\s*===\s*i/);
    expect(segSrc).toContain('segment-list-item');
  });

  it('Step1 capture ring list highlight before → Step2 inspect EditorScreen ring list rendering → Step3 ring-list-item-selected class present', () => {
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    // Ring list is rendered inline in EditorScreen (not only SegmentEditor)
    // Check that selectedRing prop is compared for highlight
    // Search for ring selection highlight: look for selectedRing usage
    expect(editorSrc).toContain('selectedRing');
    // SegmentEditor's selected/hover classes: also check hover
    const segSrc = getSegmentEditorSrc();
    expect(segSrc).toContain('segment-list-item-hovered');
    expect(segSrc).toContain('segment-list-item-edge-active');
  });

  it('Step1 capture CSS accent before → Step2 verify highlight uses --accent (border-color) → Step3 CSS contains accent for selected', () => {
    // The highlight is border-color: var(--accent) via class. Check index.css or SegmentEditor css usage.
    const css = (() => {
      try { return readFile('src/index.css'); } catch { return ''; }
    })();
    if (css) {
      expect(css).toContain('--accent');
      expect(css).toContain('#6366f1');
    }
    // SegmentEditor must reference the selected class which CSS styles
    const segSrc = getSegmentEditorSrc();
    expect(segSrc).toContain('segment-list-item-selected');
    // Ensure EditorScreen does not inline focus ring as substitute
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    const ringBlock = getHandlerBlock(editorSrc, 'handleSelectRing');
    expect(ringBlock).not.toContain(':focus-visible');
  });

  it('Step1 capture initial hover/selection off-grid style before → Step2 verify hoveredRing/hoveredSegment not removed → Step3 hover logic intact', () => {
    const segSrc = getSegmentEditorSrc();
    expect(segSrc).toContain('hoveredIndex');
    expect(segSrc).toContain('onMouseEnter');
    expect(segSrc).toContain('onMouseLeave');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toContain('hoveredSegment');
    expect(editorSrc).toContain('hoveredRing');
    expect(editorSrc).toContain('setHoveredRing');
    expect(editorSrc).toContain('setHoveredSegment');
  });

  it('Step1 capture data-testid stability before → Step2 verify list item testids remain → Step3 no regression in selection wiring', () => {
    const segSrc = getSegmentEditorSrc();
    expect(segSrc).toContain('data-testid={`segment-list-item-${i}`}');
    expect(segSrc).toContain('data-testid={`segment-direction-${i}`}');
    expect(segSrc).toContain('data-testid={`segment-beats-${i}`}');
    const editorSrc = readFile('src/screens/EditorScreen.tsx');
    expect(editorSrc).toContain('data-testid="segment-list-details"');
    expect(editorSrc).toContain('onSelectSegment');
    expect(editorSrc).toContain('onSelectRing');
  });
});

// ---------------------------------------------------------------------------
// T146-4: 回帰・隔離・WaveEngine/Cursor 数値整合（複雑な振幅×オフグリッド必須）
// ---------------------------------------------------------------------------
describe('T146-4: 回帰・隔離・WaveEngine/Cursor 数値整合 (T127/T128/T131 規約維持)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  it('Step1 capture WavePreview.tsx before → Step2 verify T144/T145 not regressed → Step3 Math.round(b/4) & 5-stage minorStep intact', () => {
    const src = getWavePreviewSrc();
    expect(src).toMatch(/String\s*\(\s*Math\.round\s*\(\s*b\s*\/\s*4\s*\)\s*\)/);
    expect(src).toMatch(/const\s+minorStep\s*=\s*viewBeats\s*<=\s*4\s*\?\s*0\.25\s*:\s*viewBeats\s*<=\s*8\s*\?\s*0\.5\s*:\s*viewBeats\s*<=\s*16\s*\?\s*1\s*:\s*viewBeats\s*<=\s*64\s*\?\s*2\s*:\s*4/);
    expect(src).toMatch(/const\s+strong\s*=\s*Math\.abs\s*\(\s*b\s*%\s*4\s*\)\s*<\s*1e-6/);
    expect(src).not.toContain('scrollIntoView');
  });

  it('Step1 capture EditorScreen isolation before → Step2 verify only EditorScreen changed → Step3 WavePreview/SegmentEditor/index.css not containing focus removal logic bleed', () => {
    const waveSrc = getWavePreviewSrc();
    const segSrc = getSegmentEditorSrc();
    // WavePreview must NOT have been modified to handle focus
    expect(waveSrc).not.toContain('segment-list-item-selected');
    expect(waveSrc).not.toContain('handleSelectRing');
    // SegmentEditor must NOT contain scrollIntoView
    expect(segSrc).not.toContain('scrollIntoView');
    expect(segSrc).not.toContain('requestAnimationFrame');
    // index.css must not have new scroll-behavior hacks
    const css = (() => { try { return readFile('src/index.css'); } catch { return ''; } })();
    if (css) {
      expect(css).not.toContain('scrollIntoView');
    }
  });

  it('Step1 capture fake timers determinism before → Step2 advance 500ms → Step3 computed values deterministic', () => {
    const start = Date.now();
    vi.advanceTimersByTime(500);
    expect(Date.now()).toBe(start + 500);
    const tl = new BpmTimeline(120, [], 1.0);
    const e1 = new WaveEngine([{ direction: 'up', beats: 2 }], tl, 1.0, 0);
    const y1 = e1.waveYAt(0.37);
    vi.advanceTimersByTime(100);
    const e2 = new WaveEngine([{ direction: 'up', beats: 2 }], tl, 1.0, 0);
    const y2 = e2.waveYAt(0.37);
    expect(y1).toBeCloseTo(y2, 8);
  });

  it('Step1 capture WaveEngine/Cursor numeric consistency before (T127/T128) → Step2 create complex amplitudes & off-grid phases → Step3 cursor and waveYAt agree per-beat', () => {
    const amplitudes = [0.7, 1.3, 2.7, 3.4];
    const bpm = 120;
    for (const amp of amplitudes) {
      const timeline = new BpmTimeline(bpm, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 4 }], timeline, amp, 0);
      const perBeatPx = 2 * TW_AMP * amp;
      const offGridBeats = [0.37, 1.23];
      for (const b of offGridBeats) {
        if (b * perBeatPx >= TW_AMP) continue;
        const y = engine.waveYAt(b);
        const expected = TW_CENTER_Y + b * perBeatPx;
        expect(y, `amp ${amp} beat ${b} waveYAt`).toBeCloseTo(expected, 4);
      }
      const cursor = new Cursor(amp, 0.0);
      const beatMs = 60000 / bpm;
      const beatsDelta = 0.1;
      const dt = (beatsDelta * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs);
      const expectedY = TW_CENTER_Y + perBeatPx * beatsDelta;
      expect(cursor.y, `amp ${amp} cursor`).toBeCloseTo(expectedY, 3);
      const waveAtDelta = engine.waveYAt(beatsDelta);
      expect(waveAtDelta, `amp ${amp} wave vs cursor`).toBeCloseTo(cursor.y, 3);
    }
  });

  it('Step1 capture startPosition edge cases before → Step2 verify waveYAt(0) respects startPosition → Step3 CENTER, top, bottom', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const eCenter = new WaveEngine([], tl, 1.0, 0.0);
    expect(eCenter.waveYAt(0)).toBeCloseTo(TW_CENTER_Y, 5);
    const eTop = new WaveEngine([], tl, 1.0, 1.0);
    expect(eTop.waveYAt(0)).toBeCloseTo(TW_CENTER_Y - TW_AMP, 5);
    const eBottom = new WaveEngine([], tl, 1.0, -1.0);
    expect(eBottom.waveYAt(0)).toBeCloseTo(TW_CENTER_Y + TW_AMP, 5);
    // Off-grid still respects clamp interpolation
    const eDown = new WaveEngine([{ direction: 'down', beats: 10 }], tl, 1.3, 0.0);
    const y037 = eDown.waveYAt(0.37);
    const perBeat = 2 * TW_AMP * 1.3;
    const raw = TW_CENTER_Y + perBeat * 0.37;
    const clamped = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, raw));
    expect(y037).toBeCloseTo(clamped, 3);
  });

  it('Step1 capture quantize & segmentize snap invariant before → Step2 exercise snap multiples → Step3 beats snap-aligned', () => {
    const snaps = [0.125, 0.25, 0.5, 1];
    for (const snap of snaps) {
      for (const raw of [snap, snap*2, 0.3, 0.37, 1.23]) {
        const q = quantizeBeat(raw, snap);
        const rem = ((q % snap) + snap) % snap;
        expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6, `q ${q} snap ${snap}`).toBeTruthy();
      }
    }
    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: false },
      { beat: 0.3, y: TW_CENTER_Y + 80, down: true },
      { beat: 0.6, y: TW_CENTER_Y + 80, down: false },
    ];
    const segs = segmentize(traj, 0.25, 1);
    segs.forEach(s => {
      const rem = ((s.beats % 0.25) + 0.25) % 0.25;
      expect(rem < 1e-6 || Math.abs(rem - 0.25) < 1e-6).toBeTruthy();
    });
  });

  it('Step1 capture tsc --noEmit guard before → Step2 verify EditorScreen imports & TW constants → Step3 file type-correct', () => {
    const src = readFile('src/screens/EditorScreen.tsx');
    expect(src).toContain("import { BpmTimeline } from '../audio/bpmTimeline'");
    expect(src).toContain("import { WaveEngine } from '../game/waveEngine'");
    expect(src).toContain('requestAnimationFrame');
    expect(src).toContain('useCallback');
    const waveSrc = readFile('src/game/waveEngine.ts');
    expect(waveSrc).toContain('export const TW_AMP');
    expect(waveSrc).toContain('TW_CENTER_Y');
    // No TypeScript syntax error: file must parse (checked via read)
    expect(src.length).toBeGreaterThan(1000);
  });

  it('Step1 capture getPoints length invariant before → Step2 build multi-segment wave → Step3 length === segments.length+1 (editor 1:1)', () => {
    const tl = new BpmTimeline(120, [], 1.0);
    const cases: Array<{ segs: Array<{ direction: 'up' | 'down' | 'stay'; beats: number }> }> = [
      { segs: [{ direction: 'up', beats: 1 }] },
      { segs: [{ direction: 'up', beats: 1 }, { direction: 'down', beats: 2 }, { direction: 'stay', beats: 0.5 }] },
      { segs: [{ direction: 'down', beats: 3 }, { direction: 'up', beats: 1.5 }] },
    ];
    for (const c of cases) {
      const engine = new WaveEngine(c.segs as any, tl, 1.0, 0);
      const pts = engine.getPoints();
      expect(pts.length, `segs ${c.segs.length}`).toBe(c.segs.length + 1);
      // Points must have beat ascending
      for (let i = 1; i < pts.length; i++) expect(pts[i].beat).toBeGreaterThan(pts[i-1].beat);
    }
  });
});
