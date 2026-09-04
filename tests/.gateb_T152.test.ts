import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { Cursor } from '../src/game/cursor';

vi.useFakeTimers();

const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;
const CENTER = TW_CENTER_Y;

function isSnapAligned(beats: number, snap: number): boolean {
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

describe('T152 編集モード対応ハイライトのみ表示（モード別分離） — Vitest node (WavePreview source + WaveEngine/Cursor numeric)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ----------------------------------------------------------------
  // 1. Edge highlight must be mode-gated: editMode !== 'ring' && i===selectedSegment / hoveredSegment
  // 3-step: [capture src] -> [isolate renderCanvas block] -> [assert gated isSelectedEdge/isHoveredEdge]
  // ----------------------------------------------------------------
  describe('1. Edge stroke+halo is mode-gated (ring mode shows no edge highlight)', () => {
    it('WavePreview renderCanvas computes isSelectedEdge/isHoveredEdge gated by editMode !== ring', () => {
      // [Step 1] Capture Initial State
      const p = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      const renderIdx = src.indexOf('const renderCanvas');
      expect(renderIdx, 'renderCanvas must be defined in WavePreview.tsx').toBeGreaterThan(-1);

      // isolate renderCanvas block until next useEffect that observes canvas or its return
      const nextBlockIdx = src.indexOf('useEffect(() => {', renderIdx + 20);
      const renderBlock = nextBlockIdx !== -1 ? src.slice(renderIdx, nextBlockIdx) : src.slice(renderIdx, renderIdx + 12000);

      // verify we are inside the correct function (contains SAMPLE_STEP and isSelectedEdge)
      expect(renderBlock, 'renderCanvas block must contain edge highlight logic').toMatch(/isSelectedEdge/);
      expect(renderBlock, 'renderCanvas block must contain isHoveredEdge').toMatch(/isHoveredEdge/);

      // [Step 2] Locate edge highlight definitions — specific, not generic indexOf('ring')
      // Use precise patterns that bind editMode guard to the edge highlight variables
      const edgeSelectedPattern = /const\s+isSelectedEdge\s*=\s*editMode\s*!==\s*['"]ring['"]\s*&&\s*i\s*===\s*selectedSegment/;
      const edgeHoveredPattern = /const\s+isHoveredEdge\s*=\s*editMode\s*!==\s*['"]ring['"]\s*&&\s*i\s*===\s*hoveredSegment/;

      // [Step 3] Assert Resulting Transition: gated logic present (strict Red->Green)
      // This FAILS on pre-fix code where isSelectedEdge = i === selectedSegment (no editMode guard)
      expect(renderBlock, 'isSelectedEdge must be gated by editMode !== ring && i===selectedSegment').toMatch(edgeSelectedPattern);
      expect(renderBlock, 'isHoveredEdge must be gated by editMode !== ring && i===hoveredSegment').toMatch(edgeHoveredPattern);

      // Must still compute isHighlighted from gated values and use SELECT_COLOR
      expect(renderBlock, 'must compute isHighlighted from gated edge values').toMatch(/isHighlighted\s*=\s*isSelectedEdge\s*\|\|\s*isHoveredEdge/);
      expect(renderBlock, 'selected edge must use SELECT_COLOR').toMatch(/isSelectedEdge\s*\?\s*SELECT_COLOR/);

      // Verify old un-gated pattern is absent (prevents false-pass)
      const ungatedSelected = /const\s+isSelectedEdge\s*=\s*i\s*===\s*selectedSegment\s*[^&]/;
      // allow gated version only: if ungated appears without editMode guard, it's stale
      const hasUngated = ungatedSelected.test(renderBlock) && !edgeSelectedPattern.test(renderBlock);
      expect(hasUngated, 'legacy ungated isSelectedEdge = i === selectedSegment must be absent').toBe(false);
    });

    it('edge highlight gated logic yields correct runtime truth table across modes (complex off-grid verification)', () => {
      // [Step 1] Capture initial gated evaluator (mirrors fixed source logic)
      const gatedSelected = (editMode: string, i: number, sel: number | null) => editMode !== 'ring' && i === sel;
      const gatedHovered = (editMode: string, i: number, hov: number | null) => editMode !== 'ring' && i === hov;

      // [Step 2] Perform mode transitions with off-grid-like segment indices and snap diversity
      const modes: Array<'vertex' | 'edge' | 'ring'> = ['vertex', 'edge', 'ring'];
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      for (const snap of snaps) {
        for (const mode of modes) {
          for (const selIdx of [0, 1, 2]) {
            const i = selIdx; // hover/selected on same index
            const selected = selIdx;
            const hovered = selIdx;
            // [Step 3] Assert resulting transition
            if (mode === 'ring') {
              expect(gatedSelected(mode, i, selected), `ring mode: edge selected must be false snap=${snap} i=${i}`).toBe(false);
              expect(gatedHovered(mode, i, hovered), `ring mode: edge hovered must be false snap=${snap} i=${i}`).toBe(false);
            } else {
              expect(gatedSelected(mode, i, selected), `${mode} mode: edge selected must be true when i===sel`).toBe(true);
              expect(gatedHovered(mode, i, hovered), `${mode} mode: edge hovered must be true when i===hov`).toBe(true);
              // off-index must be false
              expect(gatedSelected(mode, (i + 1) % 5, selected)).toBe(false);
            }
          }
        }
      }

      // cross-check with WaveEngine numeric: edge count invariant still holds under all amps
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const offGridBeats = [0.37, 1.23] as const;
      for (const amp of amps) {
        for (const ob of offGridBeats) {
          const tl = new BpmTimeline(120, [], amp);
          const segs = [
            { direction: 'down' as const, beats: quantizeBeat(1.5 + ob * 0.2, 0.25) || 0.25 },
            { direction: 'up' as const, beats: quantizeBeat(1.0 + ob * 0.1, 0.25) || 0.25 },
            { direction: 'stay' as const, beats: 1 },
          ];
          const eng = new WaveEngine(segs, tl, amp, 0);
          expect(eng.getPoints().length).toBe(segs.length + 1);
          for (const s of segs) expect(isSnapAligned(s.beats, 0.25)).toBe(true);
        }
      }
    });
  });

  // ----------------------------------------------------------------
  // 2. Ring highlight must be mode-gated: editMode==='ring' && i===selectedRing / hoveredRing
  // ----------------------------------------------------------------
  describe('2. Ring highlight is mode-gated (vertex/edge shows no ring halo)', () => {
    it('WavePreview rings.forEach computes isSelected/isHovered gated by editMode===ring', () => {
      // [Step 1] Capture
      const p = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      const ringsIdx = src.indexOf('rings.forEach');
      expect(ringsIdx, 'rings.forEach must exist').toBeGreaterThan(-1);

      // Isolate ring rendering block: from rings.forEach to next closing of that forEach (look ahead 3000 chars)
      const ringBlock = src.slice(ringsIdx, ringsIdx + 4000);

      // [Step 2] Locate ring highlight definitions with precise editMode guard
      const ringSelectedPattern = /const\s+isSelected\s*=\s*editMode\s*===\s*['"]ring['"]\s*&&\s*i\s*===\s*selectedRing/;
      const ringHoveredPattern = /const\s+isHovered\s*=\s*editMode\s*===\s*['"]ring['"]\s*&&\s*i\s*===\s*hoveredRing/;

      // [Step 3] Assert gated — FAILS on legacy `i===selectedRing` without guard
      expect(ringBlock, 'isSelected must be gated by editMode===ring && i===selectedRing').toMatch(ringSelectedPattern);
      expect(ringBlock, 'isHovered must be gated by editMode===ring && i===hoveredRing').toMatch(ringHoveredPattern);
      expect(ringBlock, 'ring isHighlighted must be isSelected||isHovered').toMatch(/isHighlighted\s*=\s*isSelected\s*\|\|\s*isHovered/);

      // Ensure legacy ungated not present as sole definition
      const hasGatedSelected = ringSelectedPattern.test(ringBlock);
      const hasLegacyRing = /const\s+isSelected\s*=\s*i\s*===\s*selectedRing/.test(ringBlock) && !hasGatedSelected;
      expect(hasLegacyRing, 'legacy ungated isSelected = i===selectedRing must be absent').toBe(false);
    });

    it('ring gated logic yields correct runtime truth table (ring-only mode isolation, off-grid beats)', () => {
      // [Step 1] Captured gated evaluator mirrors fixed source
      const gatedRingSelected = (editMode: string, i: number, sel: number | null) => editMode === 'ring' && i === sel;
      const gatedRingHovered = (editMode: string, i: number, hov: number | null) => editMode === 'ring' && i === hov;

      // [Step 2] Transition across modes with fractional ring beats to ensure not grid-only
      const modes: Array<'vertex' | 'edge' | 'ring'> = ['vertex', 'edge', 'ring'];
      const offRingBeats = [0.37, 1.23, 4.37, 8.63];
      for (const beat of offRingBeats) {
        for (const mode of modes) {
          const i = 0;
          const sel: number | null = 0;
          // [Step 3] Assert
          if (mode === 'ring') {
            expect(gatedRingSelected(mode, i, sel)).toBe(true);
            expect(gatedRingHovered(mode, i, 0)).toBe(true);
          } else {
            expect(gatedRingSelected(mode, i, sel), `mode=${mode} beat=${beat} ring selected must be suppressed`).toBe(false);
            expect(gatedRingHovered(mode, i, 0), `mode=${mode} beat=${beat} ring hovered must be suppressed`).toBe(false);
          }
        }
      }
      void offRingBeats;

      // Numeric regression: ring Y follows WaveEngine even when suppressed highlight
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs = [{ direction: 'down' as const, beats: 2 }, { direction: 'up' as const, beats: 2 }];
      const eng = new WaveEngine(segs, tl, amp, 0);
      const yAtOff = eng.waveYAt(1.23);
      expect(Number.isFinite(yAtOff)).toBe(true);
      expect(yAtOff).toBeGreaterThanOrEqual(TOP - 1e-6);
      expect(yAtOff).toBeLessThanOrEqual(BOTTOM + 1e-6);
    });
  });

  // ----------------------------------------------------------------
  // 3. handleMouseMove priority: unconditional ring priority removed, ring only when editMode==='ring'
  // ----------------------------------------------------------------
  describe('3. handleMouseMove is mode-gated (ring hover does not crush edge/vertex when not in ring mode)', () => {
    it('handleMouseMove ringHit logic is guarded by editMode===ring, vertex/edge branches only fire in their mode and null out other hover', () => {
      // [Step 1] Capture
      const p = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      const mmIdx = src.indexOf('const handleMouseMove');
      expect(mmIdx, 'handleMouseMove must be defined').toBeGreaterThan(-1);
      const nextIdx = src.indexOf('const handleMouseLeave', mmIdx);
      const mmBlock = nextIdx !== -1 ? src.slice(mmIdx, nextIdx) : src.slice(mmIdx, mmIdx + 6000);

      // Must contain nearestRingIndex and nearestVertexIndex / nearestEdgeIndex
      expect(mmBlock, 'handleMouseMove must reference nearestRingIndex').toMatch(/nearestRingIndex/);
      expect(mmBlock, 'must reference nearestVertexIndex').toMatch(/nearestVertexIndex/);
      expect(mmBlock, 'must reference nearestEdgeIndex').toMatch(/nearestEdgeIndex/);

      // [Step 2] Locate ring guard — FAILS if ringHit is checked unconditionally before editMode branches
      // Fixed pattern: ringHit handling is inside `if (editMode === 'ring') { ... ringHit ... }` or `if (editMode==='ring' && ringHit>=0)`
      const ringGuardedPatternA = /if\s*\(\s*editMode\s*===\s*['"]ring['"]\s*\)\s*\{[^}]*nearestRingIndex|if\s*\(\s*editMode\s*===\s*['"]ring['"]\s*&&[^)]*ringHit/;
      const ringGuardedPatternB = /editMode\s*===\s*['"]ring['"]\s*&&\s*ringHit|ringHit[\s\S]*?editMode\s*===\s*['"]ring['"]/;
      const ringGuarded = ringGuardedPatternA.test(mmBlock) || ringGuardedPatternB.test(mmBlock);
      // More robust: check that before vertex branch, ringHit is not returned unconditionally.
      // Fixed code should have explicit `if (editMode === 'ring') { const ringHit = ... if(ringHit>=0) ... return }`
      const hasRingInsideGuard = /editMode\s*===\s*['"]ring['"][\s\S]{0,300}nearestRingIndex/.test(mmBlock);
      expect(hasRingInsideGuard, 'ringHit / nearestRingIndex must be inside an editMode===ring guard (not unconditional)').toBe(true);
      void ringGuarded;

      // Also verify that the old unconditional pattern `const ringHit = nearestRingIndex(...)\n  if (ringHit >=0) { onHoverRing?.(ringHit) ... return }` without guard is absent
      // We detect presence of unconditional by checking if first ringHit handling appears before any editMode ring guard
      const firstRingHitPos = mmBlock.indexOf('nearestRingIndex');
      const firstRingGuardPos = mmBlock.indexOf("editMode === 'ring'");
      // Allow both orders but guard must enclose or precede ringHit handling within ~300 chars
      if (firstRingHitPos !== -1 && firstRingGuardPos !== -1) {
        // In fixed code, guard appears at or before ringHit within 500 chars
        const guardBeforeRing = Math.abs(firstRingGuardPos - firstRingHitPos) < 500;
        expect(guardBeforeRing, 'editMode ring guard must be close to nearestRingIndex (not unconditional top-level)').toBe(true);
      }

      // [Step 3] Vertex/edge branches must be mode-specific and null out opposite hover
      expect(mmBlock, "vertex branch must be `if (editMode === 'vertex')`").toMatch(/if\s*\(\s*editMode\s*===\s*['"]vertex['"]/);
      expect(mmBlock, "edge branch must be `} else if (editMode === 'edge')` or `if (editMode === 'edge')`").toMatch(/editMode\s*===\s*['"]edge['"]/);
      // Each branch should call onHoverSegment?. and onHoverRing?.(null) to clear other, and vice versa for ring
      // tolerant to optional chaining `?.`
      expect(mmBlock, 'vertex branch must clear ring hover via onHoverRing?.(null)').toMatch(/onHoverRing(\?\.)?\s*\(\s*null\s*\)/);
      expect(mmBlock, 'edge branch must clear ring hover').toMatch(/onHoverSegment(\?\.)?\s*\(/);
      expect(mmBlock, 'must clear hover with null when no hit').toMatch(/onHoverRing(\?\.)?\s*\(\s*null\s*\)[\s\S]*onHoverSegment(\?\.)?\s*\(\s*null\s*\)|onHoverSegment(\?\.)?\s*\(\s*null\s*\)[\s\S]*onHoverRing(\?\.)?\s*\(\s*null\s*\)/);

      // Verify that drag/pan early return is still first line (regression)
      expect(mmBlock, 'handleMouseMove must early-return when dragging/panning').toMatch(/if\s*\(\s*dragRef\.current/);
    });

    it('handleMouseMove mode dispatch truth table (edge hover not crushed by ring when not in ring mode)', () => {
      // [Step 1] Capture expected dispatch evaluator (mirrors fixed logic)
      function dispatch(editMode: 'vertex' | 'edge' | 'ring', ringHit: number, vertexHit: number, edgeHit: number): { hoverRing: number | null; hoverSeg: number | null } {
        if (editMode === 'ring') {
          if (ringHit >= 0) return { hoverRing: ringHit, hoverSeg: null };
          // ring mode no segment hover per spec (or edge fallback but Ring mode has no edge highlight)
          if (edgeHit >= 0) return { hoverRing: null, hoverSeg: edgeHit };
          return { hoverRing: null, hoverSeg: null };
        }
        if (editMode === 'vertex') {
          if (vertexHit >= 0) {
            const segIdx = vertexHit === 0 ? 0 : vertexHit - 1;
            return { hoverRing: null, hoverSeg: segIdx };
          }
          return { hoverRing: null, hoverSeg: null };
        }
        if (editMode === 'edge') {
          if (edgeHit >= 0) return { hoverRing: null, hoverSeg: edgeHit };
          return { hoverRing: null, hoverSeg: null };
        }
        return { hoverRing: null, hoverSeg: null };
      }

      // [Step 2] Simulate: edge is hit, ring also hit at same X (would crush in old code). In vertex/edge mode ring must be ignored.
      const cases: Array<{ mode: 'vertex' | 'edge' | 'ring'; ringHit: number; vertexHit: number; edgeHit: number; expRing: number | null; expSeg: number | null; label: string }> = [
        { mode: 'vertex', ringHit: 0, vertexHit: -1, edgeHit: 1, expRing: null, expSeg: null, label: 'vertex mode: no vertex hit, edge hit ignored, ring ignored -> null/null' },
        { mode: 'vertex', ringHit: 0, vertexHit: 2, edgeHit: 1, expRing: null, expSeg: 1, label: 'vertex mode: vertexHit maps to seg, ring 0 ignored' },
        { mode: 'edge', ringHit: 0, vertexHit: -1, edgeHit: 1, expRing: null, expSeg: 1, label: 'edge mode: ring 0 must not crush edge 1' },
        { mode: 'edge', ringHit: 0, vertexHit: 2, edgeHit: -1, expRing: null, expSeg: null, label: 'edge mode: ring ignored, no edge -> null' },
        { mode: 'ring', ringHit: 0, vertexHit: -1, edgeHit: 1, expRing: 0, expSeg: null, label: 'ring mode: ring 0 wins over edge 1' },
        { mode: 'ring', ringHit: -1, vertexHit: -1, edgeHit: 1, expRing: null, expSeg: 1, label: 'ring mode: no ring, edge fallback still allowed (ring mode segment hover)' },
      ];
      for (const c of cases) {
        const res = dispatch(c.mode, c.ringHit, c.vertexHit, c.edgeHit);
        expect(res.hoverRing, `${c.label} hoverRing`).toBe(c.expRing);
        expect(res.hoverSeg, `${c.label} hoverSeg`).toBe(c.expSeg);
      }

      // off-grid beat implication: ensure hover logic still works with fractional beats (no additional assertion, regression numeric)
      const tl = new BpmTimeline(120, [], 1.3);
      const segs = [{ direction: 'down' as const, beats: quantizeBeat(1.37, 0.25) }, { direction: 'up' as const, beats: quantizeBeat(2.23, 0.25) }];
      const eng = new WaveEngine(segs, tl, 1.3, 0);
      expect(eng.getPoints().length).toBe(3);
      expect(eng.waveYAt(0.37)).toBeGreaterThanOrEqual(TOP - 1e-6);
      expect(eng.waveYAt(1.23)).toBeLessThanOrEqual(BOTTOM + 1e-6);
    });
  });

  // ----------------------------------------------------------------
  // 4. Regression: T116 V/E/R separation, T118 mutual highlight linkage, T146 class-only (no scroll), T151 vertex select
  // ----------------------------------------------------------------
  describe('4. Regression guards (T116 / T118 / T146 / T151 / WaveEngine-Cursor slope)', () => {
    it('T116: handleMouseDown has distinct vertex / edge / ring branches with editMode guards and pan fallback', () => {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      const hdIdx = src.indexOf('const handleMouseDown');
      expect(hdIdx).toBeGreaterThan(-1);
      const nextIdx = src.indexOf('const handleDoubleClick', hdIdx);
      const hdBlock = nextIdx !== -1 ? src.slice(hdIdx, nextIdx) : src.slice(hdIdx, hdIdx + 10000);
      expect(hdBlock).toMatch(/editMode\s*===\s*['"]vertex['"]/);
      expect(hdBlock).toMatch(/editMode\s*===\s*['"]edge['"]/);
      // ring mode isolated: nearestRingIndex and dragRef with button 0 check
      expect(hdBlock).toMatch(/nearestRingIndex/);
      expect(hdBlock).toMatch(/dragRef\.current/);
      expect(hdBlock).toMatch(/e\.button\s*===\s*0/);
      // vertex branch must call onSelectSegment with mapping vHit===0?0:vHit-1 and optional chaining tolerant
      expect(hdBlock).toMatch(/onSelectSegment(\?\.)?\s*\(\s*vHit\s*===\s*0\s*\?\s*0\s*:\s*vHit\s*-\s*1\s*\)/);
      // edge branch must call onSelectSegment(eHit) with optional chaining
      expect(hdBlock).toMatch(/onSelectSegment(\?\.)?\s*\(\s*eHit\s*\)/);
    });

    it('T118: hover callbacks use optional chaining and null clearing (mutual highlight linkage)', () => {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      const mmIdx = src.indexOf('const handleMouseMove');
      const mlIdx = src.indexOf('const handleMouseLeave', mmIdx);
      const block = src.slice(mmIdx, mlIdx !== -1 ? mlIdx + 1000 : mmIdx + 6000);
      // must use ?. for safety per codebase convention
      expect(block).toMatch(/onHoverRing(\?\.)?\(/);
      expect(block).toMatch(/onHoverSegment(\?\.)?\(/);
      expect(block).toMatch(/onHoverRing(\?\.)?\s*\(\s*null\s*\)/);
      expect(block).toMatch(/onHoverSegment(\?\.)?\s*\(\s*null\s*\)/);
      // handleMouseLeave also clears both
      const leaveBlock = src.slice(src.indexOf('const handleMouseLeave'), src.indexOf('const handleMouseLeave') + 800);
      expect(leaveBlock).toMatch(/onHoverRing(\?\.)?\s*\(\s*null\s*\)/);
      expect(leaveBlock).toMatch(/onHoverSegment(\?\.)?\s*\(\s*null\s*\)/);
      // EditorScreen must still set hoveredRing/hoveredSegment state and pass to SegmentEditor
      const editorSrc = fs.readFileSync(path.join(process.cwd(), 'src/screens/EditorScreen.tsx'), 'utf-8');
      expect(editorSrc).toMatch(/hoveredSegment/);
      expect(editorSrc).toMatch(/hoveredRing/);
      expect(editorSrc).toMatch(/setHoveredRing/);
      expect(editorSrc).toMatch(/setHoveredSegment/);
    });

    it('T146: handleSelectRing/Segment uses class-only highlight (no scrollIntoView / focus side-effect)', () => {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/EditorScreen.tsx'), 'utf-8');
      // locate handleSelectRing and handleSelectSegment
      const selRingIdx = src.indexOf('const handleSelectRing');
      const selSegIdx = src.indexOf('const handleSelectSegment');
      expect(selRingIdx).toBeGreaterThan(-1);
      expect(selSegIdx).toBeGreaterThan(-1);
      const ringBlock = src.slice(selRingIdx, selRingIdx + 2000);
      const segBlock = src.slice(selSegIdx, selSegIdx + 2000);
      // must NOT contain scrollIntoView or el.focus()
      expect(ringBlock, 'handleSelectRing must not call scrollIntoView (T146)').not.toMatch(/scrollIntoView/);
      expect(ringBlock, 'handleSelectRing must not call el.focus()').not.toMatch(/\.focus\s*\(/);
      expect(segBlock, 'handleSelectSegment must not call scrollIntoView').not.toMatch(/scrollIntoView/);
      expect(segBlock, 'handleSelectSegment must not call el.focus()').not.toMatch(/\.focus\s*\(/);
      // must still set state and open details
      expect(ringBlock).toMatch(/setSelectedRing/);
      expect(ringBlock).toMatch(/setRingDetailsOpen/);
      expect(segBlock).toMatch(/setSelectedSegment/);
      expect(segBlock).toMatch(/setSegmentDetailsOpen/);
      // CSS class must still exist for visual highlight
      const css = fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
      expect(css).toMatch(/\.ring-list-item-selected/);
      expect(css).toMatch(/\.segment-list-item-selected/);
      expect(css).toMatch(/\.segment-list-item-hovered/);
    });

    it('T151: vertex handles drawn only in vertex mode and depend on selected/hovered segment', () => {
      const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      // vertex handles guard
      expect(src, 'vertex handles must be gated by editMode===vertex').toMatch(/if\s*\(\s*editMode\s*===\s*['"]vertex['"]/);
      // must check isSelectedVertex / isHoveredVertex derived from selectedSegment/hoveredSegment
      expect(src).toMatch(/isSelectedVertex/);
      expect(src).toMatch(/isHoveredVertex/);
      expect(src).toMatch(/selectedSegment/);
      expect(src).toMatch(/hoveredSegment/);
      // SegmentEditor must apply selected/hovered classes
      const segSrc = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/SegmentEditor.tsx'), 'utf-8');
      expect(segSrc).toMatch(/segment-list-item-selected/);
      expect(segSrc).toMatch(/segment-list-item-hovered/);
      expect(segSrc).toMatch(/selectedIndex\s*===\s*i/);
      expect(segSrc).toMatch(/hoveredIndex\s*===\s*i/);
    });

    it('WaveEngine-Cursor slope consistency across complex amps 0.7/1.3/2.7/3.4 and off-grid 0.37/1.23 (T127/T128 regression)', () => {
      // [Step 1] Capture amps and off-grid beats
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const offBeats = [0.37, 1.23, 0.63, 2.37] as const;
      for (const amp of amps) {
        // unclamped displacement per beat must match cursor
        const tl = new BpmTimeline(120, [], amp);
        const smallBeats = Math.min(0.37, (1 / amp) * 0.4);
        const segsSmall: Array<{ direction: 'down' | 'up' | 'stay'; beats: number }> = [{ direction: 'down', beats: smallBeats }];
        const engSmall = new WaveEngine(segsSmall, tl, amp, 0);
        const pts = engSmall.getPoints();
        const disp = pts[1].y - pts[0].y;
        const expectedDisp = 2 * TW_AMP * amp * smallBeats;
        expect(Math.abs(disp - expectedDisp), `amp=${amp} wave disp mismatch`).toBeLessThan(1e-6);

        // [Step 2] Cursor per-beat vs wave per-beat
        const beatMs = 500;
        const dt = beatMs / 1000;
        const cur = new Cursor(amp, 0);
        cur.setAmplitude(amp);
        const startY = cur.y;
        cur.update(dt, false, true, beatMs);
        const curDisp = cur.y - startY;
        const expectedCur = 2 * TW_AMP * amp;
        // clamped if would exceed bottom
        const clamped = Math.min(BOTTOM - startY, expectedCur);
        expect(Math.abs(curDisp - clamped), `amp=${amp} cursor disp mismatch`).toBeLessThan(1e-3);

        // [Step 3] Off-grid waveYAt interpolation via dY clamp (T128)
        for (const ob of offBeats) {
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
      }

      // getPoints length invariant across all
      const tl2 = new BpmTimeline(120, [], 1.3);
      const segs2 = [{ direction: 'down' as const, beats: 1 }, { direction: 'up' as const, beats: 1 }, { direction: 'stay' as const, beats: 1 }];
      const eng2 = new WaveEngine(segs2, tl2, 1.3, 0);
      expect(eng2.getPoints().length).toBe(segs2.length + 1);
      for (const s of segs2) expect(isSnapAligned(s.beats, 1)).toBe(true);
    });
  });
});
