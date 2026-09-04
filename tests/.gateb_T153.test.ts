import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { Cursor } from '../src/game/cursor';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

/** Locate exact base .segment-list-item rule (not -selected/-hovered etc) */
function findBaseSegmentItemIndex(css: string): number {
  // Search for `.segment-list-item {` with word boundary after `item` (space or {)
  // Must not match `.segment-list-item-selected` etc.
  const re = /\.segment-list-item\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const after = css.slice(m.index, m.index + 80);
    // ensure the char after `.segment-list-item` is whitespace or `{`, not `-`
    // The regex already excludes `-` because it requires whitespace/`{`, but double check
    if (/\.segment-list-item\s*\{/.test(after)) return m.index;
  }
  return -1;
}

function extractBlock(css: string, selector: string, len = 300): string {
  const idx = css.indexOf(selector);
  if (idx === -1) return '';
  return css.slice(idx, idx + len);
}

describe('T153 セグメントリスト青枠のCSS順序修正（T151残存バグ） — Vitest node', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-01-01T00:00:00Z')));
  afterEach(() => vi.clearAllTimers());

  // ----------------------------------------------------------------
  // 1. index.css must define selection/hover/edge-active with correct border-colors
  // 3-step: [capture css] -> [locate each selector] -> [assert border-color values]
  // ----------------------------------------------------------------
  describe('1. index.css definitions: selected / hovered / edge-active border-color', () => {
    it('defines .segment-list-item-selected with var(--accent) and .segment-list-item-hovered with rgba(237,237,237,0.4)', () => {
      // [Step 1] Capture Initial State
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      expect(css.length).toBeGreaterThan(0);

      // [Step 2] Locate selectors — specific, not generic indexOf
      const selectedIdx = css.indexOf('.segment-list-item-selected');
      const hoveredIdx = css.indexOf('.segment-list-item-hovered');
      const edgeActiveIdx = css.indexOf('.segment-list-item-edge-active');
      expect(selectedIdx, '.segment-list-item-selected must be defined').toBeGreaterThan(-1);
      expect(hoveredIdx, '.segment-list-item-hovered must be defined').toBeGreaterThan(-1);
      // edge-active is required per spec (3ルール)
      expect(edgeActiveIdx, '.segment-list-item-edge-active must be defined (3rd rule)').toBeGreaterThan(-1);

      // [Step 3] Assert resulting computed values: correct border-color declarations
      const selectedBlock = extractBlock(css, '.segment-list-item-selected');
      const hoveredBlock = extractBlock(css, '.segment-list-item-hovered');
      const edgeActiveBlock = extractBlock(css, '.segment-list-item-edge-active');

      expect(selectedBlock).toMatch(/border-color\s*:\s*var\(--accent\)/);
      expect(hoveredBlock).toMatch(/border-color\s*:\s*rgba\(\s*237\s*,\s*237\s*,\s*237\s*,\s*0\.4\s*\)/);
      // edge-active should also use accent (same as selected) — spec says color unchanged
      expect(edgeActiveBlock).toMatch(/border-color\s*:\s*var\(--accent\)/);

      // Ring regression: base→selected order must still be correct
      expect(css).toMatch(/\.ring-list-item-selected/);
    });

    it('SegmentEditor.tsx applies selected/hovered/edge-active classes via selectedIndex/hoveredIndex/editMode', () => {
      // [Step 1] Capture source
      const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/SegmentEditor.tsx'), 'utf-8');

      // [Step 2] Locate class assignment at line ~84 — specific pattern, not generic 'selected'
      // Use precise regex that binds selectedIndex === i to segment-list-item-selected
      expect(src).toMatch(/selectedIndex\s*===\s*i\s*\?\s*['"]\s*segment-list-item-selected['"]/);
      expect(src).toMatch(/hoveredIndex\s*===\s*i\s*\?\s*['"]\s*segment-list-item-hovered['"]/);
      expect(src).toMatch(/editMode\s*===\s*['"]edge['"]\s*&&\s*selectedIndex\s*===\s*i\s*\?\s*['"]\s*segment-list-item-edge-active['"]/);

      // [Step 3] Assert data-testid and data-focus-id linkage for selection
      expect(src).toMatch(/data-testid=\{`segment-list-item-\$\{i\}`\}/);
      expect(src).toMatch(/data-focus-id=\{`segment-\$\{i\}`\}/);
    });
  });

  // ----------------------------------------------------------------
  // 2. CORE BUG: CSS order — selected/hovered/edge-active must be AFTER base .segment-list-item
  //    OR have increased specificity (.segment-list .segment-list-item-selected)
  //    3-step: [capture css positions] -> [compute order vs base] -> [assert not overridden]
  // ----------------------------------------------------------------
  describe('2. CSS cascade order: selected/hovered/edge-active must win over base border (Red->Green core)', () => {
    it('order: .segment-list-item-selected / hovered / edge-active appear AFTER base .segment-list-item or use higher specificity', () => {
      // [Step 1] Capture Initial State: read css and locate base vs variant positions
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      const baseIdx = findBaseSegmentItemIndex(css);
      expect(baseIdx, 'base .segment-list-item { must exist with border: 1px solid var(--border)').toBeGreaterThan(-1);

      // Verify base block actually contains the border shorthand that overrides
      const baseBlock = extractBlock(css, '.segment-list-item {', 400);
      // use more robust: slice from baseIdx
      const baseSlice = css.slice(baseIdx, baseIdx + 400);
      expect(baseSlice).toMatch(/border\s*:\s*1px solid var\(--border\)/);

      const selectedIdx = css.indexOf('.segment-list-item-selected');
      const hoveredIdx = css.indexOf('.segment-list-item-hovered');
      const edgeActiveIdx = css.indexOf('.segment-list-item-edge-active');

      // [Step 2] Compute order / specificity — tolerate higher-specificity alternative
      const hasHighSpecSelected = css.includes('.segment-list .segment-list-item-selected');
      const hasHighSpecHovered = css.includes('.segment-list .segment-list-item-hovered');
      const hasHighSpecEdge = css.includes('.segment-list .segment-list-item-edge-active');

      const selectedAfter = selectedIdx > baseIdx;
      const hoveredAfter = hoveredIdx > baseIdx;
      const edgeAfter = edgeActiveIdx > baseIdx;

      // [Step 3] Assert resulting transition: variants must be AFTER base OR high specificity
      // This FAILS on current bug where 890 < 916 and no high specificity
      expect(hasHighSpecSelected || selectedAfter, '.segment-list-item-selected must be AFTER base .segment-list-item or have higher specificity .segment-list .segment-list-item-selected').toBe(true);
      expect(hasHighSpecHovered || hoveredAfter, '.segment-list-item-hovered must be AFTER base or higher specificity').toBe(true);
      expect(hasHighSpecEdge || edgeAfter, '.segment-list-item-edge-active must be AFTER base or higher specificity').toBe(true);

      // Ensure ring order is correct as reference (base -> selected) — regression guard
      const ringBaseIdx = css.indexOf('.ring-list-item {');
      const ringSelectedIdx = css.indexOf('.ring-list-item-selected');
      // fallback search if exact not found (use base without modifier)
      const ringBaseSearch = css.search(/\.ring-list-item\s*\{/);
      const effectiveRingBase = ringBaseSearch !== -1 ? ringBaseSearch : ringBaseIdx;
      expect(effectiveRingBase).toBeGreaterThan(-1);
      expect(ringSelectedIdx).toBeGreaterThan(-1);
      expect(ringSelectedIdx, 'ring selected must be AFTER ring base (reference correct order)').toBeGreaterThan(effectiveRingBase);
    });

    it('selected and hovered blocks are not immediately overwritten by a later .segment-list-item rule', () => {
      // [Step 1] Capture full CSS
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      const baseIdx = findBaseSegmentItemIndex(css);
      expect(baseIdx).toBeGreaterThan(-1);

      // Find the LAST occurrence of base .segment-list-item { — if multiple, the last one matters for cascade
      const baseRe = /\.segment-list-item\s*\{/g;
      let lastBase = -1;
      let mm: RegExpExecArray | null;
      while ((mm = baseRe.exec(css)) !== null) {
        // ensure not -selected/-hovered
        const ch = css[mm.index + '.segment-list-item'.length];
        if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '{') lastBase = mm.index;
      }
      expect(lastBase).toBeGreaterThan(-1);

      const selIdx = css.indexOf('.segment-list-item-selected');
      const hovIdx = css.indexOf('.segment-list-item-hovered');
      const edgeIdx = css.indexOf('.segment-list-item-edge-active');

      // [Step 2] Perform interaction: locate selected/high-spec
      const highSel = css.includes('.segment-list .segment-list-item-selected');
      const highHov = css.includes('.segment-list .segment-list-item-hovered');
      const highEdge = css.includes('.segment-list .segment-list-item-edge-active');

      // [Step 3] Assert variants are after the LAST base occurrence (or high spec)
      expect(highSel || selIdx > lastBase, 'selected must be after LAST base occurrence or high specificity').toBe(true);
      expect(highHov || hovIdx > lastBase, 'hovered must be after LAST base occurrence or high specificity').toBe(true);
      if (edgeIdx !== -1) {
        expect(highEdge || edgeIdx > lastBase, 'edge-active must be after LAST base occurrence or high specificity').toBe(true);
      }
    });
  });

  // ----------------------------------------------------------------
  // 3. 3-step state-transition: list row click would gain selected class and be visibly blue
  // ----------------------------------------------------------------
  describe('3. End-to-end: selectedIndex state transition yields selected class (visualizable as blue border)', () => {
    it('simulates [null] -> [click index 1] -> [selected class appears] with class generation mirroring SegmentEditor.tsx:84', () => {
      // [Step 1] Capture Initial State: no selection -> no blue border
      const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/SegmentEditor.tsx'), 'utf-8');
      expect(src).toMatch(/segment-list-item-selected/);

      function classFor(i: number, selectedIndex: number | null, hoveredIndex: number | null, editMode: string | undefined): string {
        return `segment-list-item${selectedIndex === i ? ' segment-list-item-selected' : ''}${hoveredIndex === i ? ' segment-list-item-hovered' : ''}${editMode === 'edge' && selectedIndex === i ? ' segment-list-item-edge-active' : ''}`;
      }

      // Before click: null selection -> no item has selected
      expect(classFor(0, null, null, 'edge')).not.toMatch(/segment-list-item-selected/);
      expect(classFor(1, null, null, 'edge')).not.toMatch(/segment-list-item-selected/);
      expect(classFor(2, null, null, 'edge')).not.toMatch(/segment-list-item-selected/);

      // [Step 2] Perform User Interaction: click row 1 -> set selectedIndex=1
      const selectedIndex: number | null = 1;
      const hoveredIndex: number | null = null;

      // [Step 3] Assert Resulting Transition: only row 1 has selected blue border, others do not
      expect(classFor(1, selectedIndex, hoveredIndex, 'edge')).toMatch(/segment-list-item-selected/);
      expect(classFor(0, selectedIndex, hoveredIndex, 'edge')).not.toMatch(/segment-list-item-selected/);
      expect(classFor(2, selectedIndex, hoveredIndex, 'edge')).not.toMatch(/segment-list-item-selected/);
      // edge-active only when editMode==='edge' and selected
      expect(classFor(1, selectedIndex, hoveredIndex, 'edge')).toMatch(/segment-list-item-edge-active/);
      expect(classFor(1, selectedIndex, hoveredIndex, 'vertex')).not.toMatch(/segment-list-item-edge-active/);

      // CSS must now actually make that class visible (not overridden)
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      const baseIdx = findBaseSegmentItemIndex(css);
      const selIdx = css.indexOf('.segment-list-item-selected');
      const highSpec = css.includes('.segment-list .segment-list-item-selected');
      expect(highSpec || selIdx > baseIdx, 'CSS order must allow selected border-color to be visible').toBe(true);
      expect(extractBlock(css, '.segment-list-item-selected')).toMatch(/var\(--accent\)/);
    });

    it('hovered class appears independently and also wins over base (off-grid irrelevant but verifies second variant)', () => {
      // [Step 1] Capture initial hover null
      function classFor(i: number, hovered: number | null): string {
        return `segment-list-item${hovered === i ? ' segment-list-item-hovered' : ''}`;
      }
      expect(classFor(0, null)).not.toMatch(/segment-list-item-hovered/);
      // [Step 2] Hover row 2
      const hov = 2;
      // [Step 3] Row 2 has hovered class, color not overridden
      expect(classFor(2, hov)).toMatch(/segment-list-item-hovered/);
      expect(classFor(1, hov)).not.toMatch(/segment-list-item-hovered/);
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      const baseIdx = findBaseSegmentItemIndex(css);
      const hovIdx = css.indexOf('.segment-list-item-hovered');
      const highSpec = css.includes('.segment-list .segment-list-item-hovered');
      expect(highSpec || hovIdx > baseIdx).toBe(true);
      expect(extractBlock(css, '.segment-list-item-hovered')).toMatch(/rgba\(\s*237/);
    });
  });

  // ----------------------------------------------------------------
  // 4. WaveEngine + Cursor numeric consistency (off-grid, complex amplitudes) — regression guard
  // ----------------------------------------------------------------
  describe('4. WaveEngine-Cursor numeric consistency across complex amplitudes 0.7/1.3/2.7/3.4 and off-grid 0.37/1.23', () => {
    it('waveYAt slope matches Cursor speed (2*TW_AMP*amplitude) and getPoints length invariant', () => {
      // [Step 1] Capture amps and off-grid beats
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const offGridBeats = [0.37, 1.23, 0.63, 2.37] as const;
      for (const amp of amps) {
        // [Step 2] Build engine with small beats to avoid clamp
        const tl = new BpmTimeline(120, [], amp);
        const smallBeats = Math.min(0.37, (1 / amp) * 0.4);
        const segsSmall: Array<{ direction: 'up' | 'down' | 'stay'; beats: number }> = [{ direction: 'down', beats: quantizeBeat(smallBeats, 0.125) || 0.125 }];
        const engSmall = new WaveEngine(segsSmall, tl, amp, 0);
        const pts = engSmall.getPoints();
        expect(pts.length).toBe(segsSmall.length + 1);
        const disp = pts[1].y - pts[0].y;
        const expectedDisp = 2 * TW_AMP * amp * segsSmall[0].beats;
        expect(Math.abs(disp - expectedDisp), `amp=${amp} wave disp mismatch`).toBeLessThan(1e-6);

        // Cursor per-beat vs wave per-beat
        const beatMs = 500;
        const dt = beatMs / 1000;
        const cur = new Cursor(amp, 0);
        cur.setAmplitude(amp);
        const startY = cur.y;
        cur.update(dt, false, true, beatMs);
        const curDisp = cur.y - startY;
        const expectedCur = 2 * TW_AMP * amp;
        const clamped = Math.min(BOTTOM - startY, expectedCur);
        expect(Math.abs(curDisp - clamped), `amp=${amp} cursor disp`).toBeLessThan(1e-3);

        // [Step 3] Off-grid waveYAt interpolation via dY clamp (T128)
        for (const ob of offGridBeats) {
          const segs: Array<{ direction: 'down' | 'up' | 'stay'; beats: number }> = [{ direction: 'down', beats: 3 }, { direction: 'up', beats: 3 }];
          const eng = new WaveEngine(segs, tl, amp, 0);
          const p0 = eng.getPoints()[0];
          const perBeat = 2 * TW_AMP * amp;
          const safeBeat = Math.min(ob, (TW_AMP / perBeat) * 0.5);
          if (safeBeat <= 0 || safeBeat >= eng.getPoints()[1].beat) continue;
          const rawY = p0.y + perBeat * (safeBeat - p0.beat);
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          expect(Math.abs(eng.waveYAt(safeBeat) - expectedY), `amp=${amp} ob=${ob} waveYAt`).toBeLessThan(1e-6);
        }

        // Snap alignment for quantize correctness
        for (const snap of [0.125, 0.25, 0.5] as const) {
          for (const ob of offGridBeats) {
            const tl2 = new BpmTimeline(120, [], amp);
            const segs2 = [
              { direction: 'up' as const, beats: quantizeBeat(1 + ob * 0.3, snap) || snap },
              { direction: 'down' as const, beats: quantizeBeat(1.5, snap) || snap },
            ];
            const eng2 = new WaveEngine(segs2, tl2, amp, 0);
            expect(eng2.getPoints().length).toBe(segs2.length + 1);
            for (const s of segs2) expect(isSnapAligned(s.beats, snap)).toBe(true);
          }
        }
      }
    });
  });
});
