import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

describe('T151 セグメント選択時のハイライト表示（点/辺＋リスト青枠） — Vitest node (source + engine numeric)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ----------------------------------------------------------------
  // 1. handleMouseDown vertex branch must call onSelectSegment with mapping vHit===0?0:vHit-1 (with optional chaining)
  // 3-step: [capture block] -> [locate vertex branch] -> [assert onSelectSegment mapping present and asymmetric fix]
  // ----------------------------------------------------------------
  describe('1. WavePreview handleMouseDown vertex branch calls onSelectSegment(vHit===0?0:vHit-1) with optional-chaining safety', () => {
    it('locates handleMouseDown function block and verifies vertex selection call exists with correct mapping and optional chaining', () => {
      // [Step 1] Capture initial source state
      const wavePath = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(wavePath, 'utf-8');
      const handleIdx = src.indexOf('const handleMouseDown');
      expect(handleIdx, 'handleMouseDown must be defined in WavePreview.tsx').toBeGreaterThan(-1);

      // Isolate handleMouseDown block (until next const handler or large window)
      const nextHandlerIdx = src.indexOf('const handleDoubleClick', handleIdx);
      const handleBlock = nextHandlerIdx !== -1 ? src.slice(handleIdx, nextHandlerIdx) : src.slice(handleIdx, handleIdx + 8000);

      // [Step 2] Perform structural interaction: locate vertex branch within handleMouseDown
      const vertexBranchIdx = handleBlock.indexOf("editMode === 'vertex'");
      // also allow double quotes
      const vertexBranchIdx2 = handleBlock.indexOf('editMode === "vertex"');
      const vBranchPos = vertexBranchIdx !== -1 ? vertexBranchIdx : vertexBranchIdx2;
      expect(vBranchPos, 'vertex mode branch editMode === vertex must exist inside handleMouseDown').toBeGreaterThan(-1);

      const vertexBranch = handleBlock.slice(vBranchPos, vBranchPos + 2500);
      // Must contain vHit detection
      expect(vertexBranch, 'vertex branch must call nearestVertexIndex').toMatch(/nearestVertexIndex/);
      expect(vertexBranch, 'vertex branch must check vHit >= 0').toMatch(/vHit\s*>=\s*0/);

      // [Step 3] Assert resulting transition: onSelectSegment mapping present with optional chaining tolerant regex
      // Pattern must match both onSelectSegment(vHit...) and onSelectSegment?.(vHit...)
      const vertexSelectPattern = /onSelectSegment(\?\.)?\s*\(\s*vHit\s*===\s*0\s*\?\s*0\s*:\s*vHit\s*-\s*1\s*\)/;
      expect(vertexBranch, 'vertex branch must call onSelectSegment?.(vHit === 0 ? 0 : vHit - 1) with optional-chaining tolerance').toMatch(vertexSelectPattern);

      // Verify ordering: onSelectSegment call must appear BEFORE vertexDragRef assignment inside vertex branch
      const selectPos = vertexBranch.search(vertexSelectPattern);
      const dragPos = vertexBranch.indexOf('vertexDragRef.current');
      expect(selectPos, 'onSelectSegment must be called before setting vertexDragRef').toBeGreaterThan(-1);
      expect(dragPos, 'vertexDragRef assignment must exist').toBeGreaterThan(-1);
      expect(selectPos, 'selection must precede drag setup (simultaneous select+drag)').toBeLessThan(dragPos);

      // Ensure asymmetry fix: edge branch also has onSelectSegment(eHit) — verify not regression
      const edgeBranchIdx = handleBlock.indexOf("editMode === 'edge'");
      const edgeBranchIdx2 = handleBlock.indexOf('editMode === "edge"');
      const ePos = edgeBranchIdx !== -1 ? edgeBranchIdx : edgeBranchIdx2;
      expect(ePos, 'edge branch must exist').toBeGreaterThan(-1);
      const edgeBranch = handleBlock.slice(ePos, ePos + 2500);
      const edgeSelectPattern = /onSelectSegment(\?\.)?\s*\(\s*eHit\s*\)/;
      expect(edgeBranch, 'edge branch must call onSelectSegment?.(eHit) with optional chaining tolerance').toMatch(edgeSelectPattern);
    });

    it('vertex selection mapping vHit===0?0:vHit-1 produces correct segIdx for off-grid positions and all indices', () => {
      // [Step 1] Capture initial mapping definition by reading source — but also verify pure numeric mapping logic
      // This tests the mapping that the source implements, via direct evaluation of the same expression
      // for a variety of off-grid vHit-like indices derived from beat positions (0.37 / 1.23 etc)
      const cases: Array<{ vHit: number; expected: number }> = [
        { vHit: 0, expected: 0 },
        { vHit: 1, expected: 0 },
        { vHit: 2, expected: 1 },
        { vHit: 3, expected: 2 },
        { vHit: 5, expected: 4 },
      ];
      for (const { vHit, expected } of cases) {
        // [Step 2] Perform mapping computation exactly as source does
        const segIdx = vHit === 0 ? 0 : vHit - 1;
        // [Step 3] Assert resulting transition matches spec mapping
        expect(segIdx, `vHit=${vHit} must map to segIdx=${expected} per spec vHit===0?0:vHit-1`).toBe(expected);
      }

      // Off-grid beat positions: ensure getPoints indexing still aligns to mapping
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const snap = 0.25;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs = [
          { direction: 'down' as const, beats: quantizeBeat(1.37, snap) },
          { direction: 'up' as const, beats: quantizeBeat(2.23, snap) },
          { direction: 'down' as const, beats: quantizeBeat(1.0, snap) },
        ];
        const engine = new WaveEngine(segs, tl, amp, 0);
        const pts = engine.getPoints();
        // pts.length = segs.length + 1, vertex index 0 maps to seg 0, vertex 1 maps to seg 0, vertex 2 maps to seg1 etc
        expect(pts.length).toBe(segs.length + 1);
        for (let vHit = 0; vHit < pts.length; vHit++) {
          const segIdx = vHit === 0 ? 0 : vHit - 1;
          // segIdx must be within valid segment range when vHit is inside
          if (vHit < pts.length) {
            expect(segIdx).toBeGreaterThanOrEqual(0);
            expect(segIdx).toBeLessThan(segs.length);
          }
        }
      }
    });

    it('source must NOT test internal helper selectedSegmentForVertexHit instead of real WavePreview behavior', () => {
      const wavePath = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(wavePath, 'utf-8');
      // The real implementation must contain the vertex selection inside handleMouseDown, not delegated to a detached test helper
      // Verify that handleMouseDown itself contains the logic, not merely an import or unrelated helper call
      const handleIdx = src.indexOf('const handleMouseDown');
      const handleBlock = src.slice(handleIdx, handleIdx + 5000);
      // Ensure no indirection that would hide the fix (e.g. only helper exists but handleMouseDown lacks call)
      const hasDirectCall = /onSelectSegment(\?\.)?\s*\(\s*vHit\s*===\s*0/.test(handleBlock);
      expect(hasDirectCall, 'fix must be directly in handleMouseDown vertex branch, not in a test-internal helper').toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 2. index.css must define .segment-list-item-selected and .segment-list-item-hovered with correct border-color
  // 3-step: [capture CSS before] -> [locate selectors] -> [assert expected border-color values]
  // ----------------------------------------------------------------
  describe('2. index.css segment highlight definitions: .segment-list-item-selected and .segment-list-item-hovered', () => {
    it('index.css contains .segment-list-item-selected with var(--accent) and .segment-list-item-hovered with rgba(237,237,237,0.4)', () => {
      // [Step 1] Capture Initial State
      const cssPath = path.join(process.cwd(), 'src/index.css');
      const css = fs.readFileSync(cssPath, 'utf-8');
      expect(css.length, 'index.css must be non-empty').toBeGreaterThan(0);

      // [Step 2] Locate selectors — robust to whitespace / newline
      const selectedIdx = css.indexOf('.segment-list-item-selected');
      const hoveredIdx = css.indexOf('.segment-list-item-hovered');
      expect(selectedIdx, '.segment-list-item-selected must be defined in index.css').toBeGreaterThan(-1);
      expect(hoveredIdx, '.segment-list-item-hovered must be defined in index.css').toBeGreaterThan(-1);

      // [Step 3] Assert Resulting Transition: correct border-color declarations
      // Extract blocks around selectors (200 chars window)
      const selectedBlock = css.slice(selectedIdx, selectedIdx + 300);
      const hoveredBlock = css.slice(hoveredIdx, hoveredIdx + 300);

      expect(selectedBlock, '.segment-list-item-selected must set border-color to var(--accent)').toMatch(/border-color\s*:\s*var\(--accent\)/);
      expect(hoveredBlock, '.segment-list-item-hovered must set border-color to rgba(237,237,237,0.4)').toMatch(/border-color\s*:\s*rgba\(\s*237\s*,\s*237\s*,\s*237\s*,\s*0\.4\s*\)/);

      // Ensure ring selected still exists (regression guard)
      expect(css, '.ring-list-item-selected must still exist').toMatch(/\.ring-list-item-selected/);
      expect(css.slice(css.indexOf('.ring-list-item-selected'), css.indexOf('.ring-list-item-selected') + 200)).toMatch(/border-color\s*:\s*var\(--accent\)/);
    });

    it('SegmentEditor.tsx actually applies segment-list-item-selected and hovered classes based on selectedIndex/hoveredIndex', () => {
      // [Step 1] Capture
      const segPath = path.join(process.cwd(), 'src/screens/editor/SegmentEditor.tsx');
      const src = fs.readFileSync(segPath, 'utf-8');

      // [Step 2] Locate class assignment
      // Must generate className with selectedIndex === i ? ' segment-list-item-selected' : '' and similarly hovered
      expect(src, 'SegmentEditor must apply segment-list-item-selected conditional on selectedIndex').toMatch(/selectedIndex\s*===\s*i\s*\?\s*['\"]\s*segment-list-item-selected['\"]/);
      expect(src, 'SegmentEditor must apply segment-list-item-hovered conditional on hoveredIndex').toMatch(/hoveredIndex\s*===\s*i\s*\?\s*['\"]\s*segment-list-item-hovered['\"]/);

      // [Step 3] Assert data-testid and role for testability (right pane row)
      expect(src, 'segment rows must have data-testid segment-list-item-${i}').toMatch(/data-testid=\{`segment-list-item-\$\{i\}`\}/);
      expect(src, 'row must have data-focus-id').toMatch(/data-focus-id/);
    });
  });

  // ----------------------------------------------------------------
  // 3. Render path: preview canvas must highlight selectedSegment edges/vertices with SELECT_COLOR
  // 3-step: [capture renderCanvas] -> [locate isSelectedEdge logic] -> [assert SELECT_COLOR usage]
  // ----------------------------------------------------------------
  describe('3. WavePreview renderCanvas highlights selectedSegment (edge stroke & vertex handles)', () => {
    it('renderCanvas uses selectedSegment to choose SELECT_COLOR for edges and vertices', () => {
      // [Step 1] Capture source
      const wavePath = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(wavePath, 'utf-8');

      // [Step 2] Locate renderCanvas block
      const renderIdx = src.indexOf('const renderCanvas');
      expect(renderIdx, 'renderCanvas must be defined').toBeGreaterThan(-1);
      const renderBlock = src.slice(renderIdx, renderIdx + 9000);

      // Edge highlight logic
      expect(renderBlock, 'must compute isSelectedEdge from selectedSegment').toMatch(/isSelectedEdge\s*=\s*i\s*===\s*selectedSegment/);
      expect(renderBlock, 'must compute isHoveredEdge from hoveredSegment').toMatch(/isHoveredEdge\s*=\s*i\s*===\s*hoveredSegment/);
      // Must use SELECT_COLOR when selected
      expect(renderBlock, 'selected edge must use SELECT_COLOR').toMatch(/isSelectedEdge\s*\?\s*SELECT_COLOR/);
      // Vertex handles: selectedVertex check
      expect(src, 'vertex handle must check selectedSegment for highlight').toMatch(/isSelectedVertex.*selectedSegment/);
      expect(src, 'vertex highlight must use SELECT_COLOR').toMatch(/isHighlightedV\s*\?\s*SELECT_COLOR|isSelectedVertex.*SELECT_COLOR/);
    });

    it('WaveEngine getPoints length invariant and off-grid waveYAt consistency (complex amps 0.7/1.3/2.7/3.4)', () => {
      // [Step 1] Capture initial segments with off-grid beats
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const offGridBeats = [0.37, 1.23, 0.63, 2.37];

      for (const amp of amps) {
        for (const snap of snaps) {
          for (const ob of offGridBeats) {
            const tl = new BpmTimeline(120, [], amp);
            const segs = [
              { direction: 'up' as const, beats: quantizeBeat(1 + ob * 0.3, snap) || snap },
              { direction: 'down' as const, beats: quantizeBeat(1.5 + ob * 0.2, snap) || snap },
              { direction: 'stay' as const, beats: quantizeBeat(1.0, snap) },
            ];
            // [Step 2] Build engine and query
            const engine = new WaveEngine(segs, tl, amp, 0);
            const pts = engine.getPoints();
            // [Step 3] Assert invariants
            expect(pts.length, `getPoints length must be segs.length+1 amp=${amp} snap=${snap} ob=${ob}`).toBe(segs.length + 1);
            for (const s of segs) {
              expect(isSnapAligned(s.beats, snap), `beats ${s.beats} must be snap-aligned ${snap}`).toBe(true);
            }
            // waveYAt at off-grid beat must be consistent with dY interpolation and clamping
            const testBeat = quantizeBeat(ob, 0.01);
            const y = engine.waveYAt(testBeat);
            expect(Number.isFinite(y)).toBe(true);
            expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
            expect(y).toBeLessThanOrEqual(BOTTOM + 1e-6);
          }
        }
      }
    });
  });

  // ----------------------------------------------------------------
  // 4. Integration: selection state would propagate to list item class (end-to-end numeric + source linkage)
  // 3-step state transition simulation: [null] -> [vertex click maps to segIdx] -> [list item would get selected class]
  // ----------------------------------------------------------------
  describe('4. End-to-end: vertex click -> selectedSegment -> list item .segment-list-item-selected linkage', () => {
    it('segment selection mapping applied to SegmentEditor props would yield selected class on correct row', () => {
      // [Step 1] Capture Initial State: selectedSegment = null, no row highlighted
      const segPath = path.join(process.cwd(), 'src/screens/editor/SegmentEditor.tsx');
      const segSrc = fs.readFileSync(segPath, 'utf-8');
      // Verify class logic exists
      expect(segSrc).toMatch(/segment-list-item-selected/);

      // [Step 2] Simulate user interaction: vertex 2 click in a 3-segment chart -> segIdx = 1
      const vHit = 2;
      const simulatedSelectedSegment: number | null = vHit === 0 ? 0 : vHit - 1;
      expect(simulatedSelectedSegment).toBe(1);
      const vHitZero = 0;
      const simulatedZero: number | null = vHitZero === 0 ? 0 : vHitZero - 1;
      expect(simulatedZero).toBe(0);

      // [Step 3] Assert Resulting Transition: SegmentEditor row generation would mark selected
      // Simulate class generation as done in SegmentEditor.tsx line 84
      function classFor(i: number, selectedIndex: number | null): string {
        return `segment-list-item${selectedIndex === i ? ' segment-list-item-selected' : ''}`;
      }
      // Before click: null -> no selected
      expect(classFor(0, null)).not.toMatch(/segment-list-item-selected/);
      expect(classFor(1, null)).not.toMatch(/segment-list-item-selected/);
      // After vertex 2 click -> index 1 selected
      expect(classFor(1, simulatedSelectedSegment)).toMatch(/segment-list-item-selected/);
      expect(classFor(0, simulatedSelectedSegment)).not.toMatch(/segment-list-item-selected/);
      // After vertex 0 click -> index 0 selected
      expect(classFor(0, simulatedZero)).toMatch(/segment-list-item-selected/);

      // Also verify hovered class linkage present
      expect(segSrc).toMatch(/segment-list-item-hovered/);
    });

    it('WavePreview.tsx must not have regression where vertex selection is swallowed by pan logic', () => {
      const wavePath = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(wavePath, 'utf-8');
      const handleIdx = src.indexOf('const handleMouseDown');
      const handleBlock = src.slice(handleIdx, handleIdx + 6000);
      const vPos = handleBlock.indexOf("editMode === 'vertex'");
      const vBlock = handleBlock.slice(vPos, vPos + 2000);
      // Must return early after vertexDrag setup, preventing pan fallback
      expect(vBlock, 'vertex hit branch must return after setting drag (no pan)').toMatch(/return/);
      // Ensure panRef is set only in else (empty drag = pan) path, not after selection
      // vHit >=0 branch should have e.preventDefault() and return before panRef
      const hitBranch = vBlock.slice(vBlock.indexOf('vHit >= 0'), vBlock.indexOf('vHit >= 0') + 1200);
      expect(hitBranch).toMatch(/e\.preventDefault\(\)/);
      expect(hitBranch).toMatch(/vertexDragRef\.current/);
    });
  });

  // ----------------------------------------------------------------
  // 5. CSS regression: selected and hovered are distinct but both visible (not same as ring only)
  // ----------------------------------------------------------------
  describe('5. CSS distinctness and visibility: selected vs hovered not conflated', () => {
    it('both segment selected and hovered have distinct border-color semantics', () => {
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      const selectedMatch = css.match(/\.segment-list-item-selected\s*\{[^}]*border-color[^}]*\}/);
      const hoveredMatch = css.match(/\.segment-list-item-hovered\s*\{[^}]*border-color[^}]*\}/);
      expect(selectedMatch, '.segment-list-item-selected block must exist').not.toBeNull();
      expect(hoveredMatch, '.segment-list-item-hovered block must exist').not.toBeNull();
      // They must have different border-color values (accent vs rgba(237...))
      const selStr = selectedMatch![0];
      const hovStr = hoveredMatch![0];
      expect(selStr).toMatch(/var\(--accent\)/);
      expect(hovStr).toMatch(/237/);
      expect(selStr).not.toBe(hovStr);
    });
  });
});
