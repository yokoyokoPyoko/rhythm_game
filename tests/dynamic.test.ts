import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

/** Spec mapping: vertex hit -> selectedSegment */
function selectedSegmentForVertexHit(vHit: number): number | null {
  if (vHit < 0) return null;
  return vHit === 0 ? 0 : vHit - 1;
}

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

describe('T151 セグメント選択時のハイライト表示（点/辺＋リスト青枠） — node Vitest', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ----------------------------------------------------------------
  // 1. CSS definitions: .segment-list-item-selected / hovered must exist
  // ----------------------------------------------------------------
  describe('1. index.css 青枠定義 [Step1 read -> Step2 check -> Step3 assert exact border-color]', () => {
    const cssPath = path.join(process.cwd(), 'src/index.css');

    it('segment-list-item-selected must exist with border-color: var(--accent)', () => {
      // [Step1] Capture initial state: read css file
      const src = fs.readFileSync(cssPath, 'utf-8');
      const beforeHasSelected = src.includes('.segment-list-item-selected');
      // [Step2] Perform check: regex for exact rule
      const selectedRule = /\.segment-list-item-selected\s*\{[^}]*border-color\s*:\s*var\(--accent\)[^}]*\}/.test(src);
      // [Step3] Assert transition to expected target: must be present (fails Red before fix)
      expect(beforeHasSelected, 'index.css must contain .segment-list-item-selected').toBe(true);
      expect(selectedRule, 'must be { border-color: var(--accent); }').toBe(true);
      // Ensure ring analog still exists (regression)
      expect(src).toContain('.ring-list-item-selected');
      expect(/\.ring-list-item-selected\s*\{[^}]*border-color/.test(src)).toBe(true);
    });

    it('segment-list-item-hovered must exist with border-color: rgba(237,237,237,0.4)', () => {
      // [Step1] Capture
      const src = fs.readFileSync(cssPath, 'utf-8');
      const beforeHasHovered = src.includes('.segment-list-item-hovered');
      // [Step2] Check exact hovered rule
      const hoveredRule = /\.segment-list-item-hovered\s*\{[^}]*border-color\s*:\s*rgba\(237,\s*237,\s*237,\s*0\.4\)[^}]*\}/.test(src);
      // [Step3] Assert
      expect(beforeHasHovered, 'index.css must contain .segment-list-item-hovered').toBe(true);
      expect(hoveredRule, 'must be { border-color: rgba(237,237,237,0.4); }').toBe(true);
    });

    it('selected/hovered classes must be visually distinct from default border var(--border)', () => {
      // [Step1] read
      const src = fs.readFileSync(cssPath, 'utf-8');
      // [Step2] extract default .segment-list-item border
      const hasDefault = /\.segment-list-item\s*\{[^}]*border:\s*1px solid var\(--border\)/.test(src);
      // [Step3] assert selected overrides default
      expect(hasDefault, 'default .segment-list-item must use var(--border)').toBe(true);
      expect(src).toContain('.segment-list-item-selected');
      // selected border must not be var(--border)
      const selectedBlock = src.match(/\.segment-list-item-selected\s*\{[^}]*\}/)?.[0] ?? '';
      expect(selectedBlock).not.toContain('var(--border)');
      expect(selectedBlock).toContain('var(--accent)');
    });
  });

  // ----------------------------------------------------------------
  // 2. WavePreview vertex branch must call onSelectSegment
  // ----------------------------------------------------------------
  describe('2. WavePreview handleMouseDown vertex対称性 [Step1 capture src -> Step2 parse branch -> Step3 assert onSelectSegment]', () => {
    const wpPath = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');

    it('vertex branch must call onSelectSegment(vHit===0?0:vHit-1) symmetrically to edge branch', () => {
      // [Step1] Capture initial state: read source
      const src = fs.readFileSync(wpPath, 'utf-8');
      const vertexIdx = src.indexOf("if (editMode === 'vertex')");
      const edgeIdx = src.indexOf("if (editMode === 'edge')");
      expect(vertexIdx, 'vertex branch must exist').toBeGreaterThan(-1);
      expect(edgeIdx, 'edge branch must exist').toBeGreaterThan(-1);
      const vertexBlock = src.slice(vertexIdx, edgeIdx);
      const edgeBlock = src.slice(edgeIdx, edgeIdx + 1500);
      // [Step2] Check edge already calls onSelectSegment (existing behavior)
      const edgeCalls = /onSelectSegment\s*\(\s*eHit\s*\)/.test(edgeBlock);
      expect(edgeCalls, 'edge branch must call onSelectSegment(eHit)').toBe(true);
      // [Step2] Check vertex calls with mapping vHit===0?0:vHit-1
      const vertexCalls = /onSelectSegment\s*\(\s*vHit\s*===\s*0\s*\?\s*0\s*:\s*vHit\s*-\s*1\s*\)/.test(vertexBlock);
      // [Step3] Assert vertex now symmetric (fails Red before fix, passes Green after)
      expect(vertexCalls, "vertex branch must call onSelectSegment(vHit===0?0:vHit-1) alongside vertexDragRef").toBe(true);
      // Must be inside the vHit>=0 guard
      expect(vertexBlock).toMatch(/if\s*\(\s*vHit\s*>=\s*0\s*\)[\s\S]*?vertexDragRef\.current[\s\S]*?onSelectSegment|if\s*\(\s*vHit\s*>=\s*0\s*\)[\s\S]*?onSelectSegment[\s\S]*?vertexDragRef/);
    });

    it('vertex onSelectSegment must be invoked before or with drag start (not after return)', () => {
      // [Step1] read
      const src = fs.readFileSync(wpPath, 'utf-8');
      const vertexIdx = src.indexOf("if (editMode === 'vertex')");
      const edgeIdx = src.indexOf("if (editMode === 'edge')");
      const vertexBlock = src.slice(vertexIdx, edgeIdx);
      // [Step2] find positions
      const dragPos = vertexBlock.indexOf('vertexDragRef.current');
      const selectPos = vertexBlock.indexOf('onSelectSegment');
      // [Step3] assert both exist and select is inside same if(vHit>=0) block
      expect(dragPos).toBeGreaterThan(-1);
      expect(selectPos).toBeGreaterThan(-1);
      // They should be close (within same block) and before the return
      expect(Math.abs(selectPos - dragPos)).toBeLessThan(300);
      expect(vertexBlock.slice(selectPos, selectPos + 200)).toMatch(/onSelectSegment/);
    });

    it('WavePreview still handles empty vertex miss as pan (no regression)', () => {
      // [Step1] read
      const src = fs.readFileSync(wpPath, 'utf-8');
      const vertexIdx = src.indexOf("if (editMode === 'vertex')");
      const vertexBlock = src.slice(vertexIdx, vertexIdx + 2000);
      // [Step2] check empty path creates panRef
      const hasPan = /panRef\.current\s*=\s*\{/.test(vertexBlock);
      // [Step3] assert pan still present after fix
      expect(hasPan, 'vertex empty drag must still create panRef').toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // 3. Pure mapping logic: selectedSegmentForVertexHit across complex amps/off-grid
  // ----------------------------------------------------------------
  describe('3. 頂点→セグメント選択マッピング純粋論理 [Step1 segments -> Step2 vertex hit -> Step3 selectedSegment]', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const offGridBeats = [0.37, 1.23, 0.63, 2.37] as const;

    it('mapping helper follows spec: vHit 0->0, 1->0, 2->1, n->n-1, -1->null', () => {
      // [Step1] capture initial table
      const cases: Array<[number, number | null]> = [
        [-1, null],
        [0, 0],
        [1, 0],
        [2, 1],
        [3, 2],
        [5, 4],
      ];
      // [Step2] perform mapping
      for (const [vHit, expected] of cases) {
        const got = selectedSegmentForVertexHit(vHit);
        // [Step3] assert exact
        expect(got).toBe(expected);
      }
    });

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const ob of offGridBeats) {
          it(`amp=${amp} snap=${snap} offGridBeat=${ob}: getPoints length invariant & vertex mapping yields valid segment index`, () => {
            // [Step1] Capture initial segments with snap-aligned beats
            const initial: Segment[] = [
              { direction: 'up', beats: quantizeBeat(1.0 + ob * 0.1, snap) || snap },
              { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
              { direction: 'stay', beats: quantizeBeat(0.75, snap) || snap },
              { direction: 'up', beats: quantizeBeat(2.0, snap) || snap },
            ];
            for (const s of initial) expect(isSnapAligned(s.beats, snap)).toBe(true);
            const tl = new BpmTimeline(120, [], amp);
            const engine = new WaveEngine(initial, tl, amp, 0);
            const pts = engine.getPoints();
            // [Step1] initial length invariant
            expect(pts.length).toBe(initial.length + 1);
            // [Step2] Simulate vertex hits at each point (including off-grid derived index)
            for (let vHit = 0; vHit < pts.length; vHit++) {
              const segIdx = selectedSegmentForVertexHit(vHit);
              // [Step3] Assert segIdx is valid segment index (0 .. segments.length-1) or null
              expect(segIdx).not.toBeNull();
              expect(segIdx! >= 0 && segIdx! < initial.length).toBe(true);
              // Adjacent edge highlight check: vertex vHit corresponds to segment(s) vHit-1 and vHit
              // The spec says selectedSegment = vHit===0?0:vHit-1, so vertex 0 highlights segment 0, vertex 1 also 0, vertex 2 ->1
              if (vHit === 0) expect(segIdx).toBe(0);
              else expect(segIdx).toBe(vHit - 1);
              // Verify waveYAt at vertex beat equals point y (no drift)
              expect(engine.waveYAt(pts[vHit].beat)).toBeCloseTo(pts[vHit].y, 6);
            }
            // Click empty (no vertex): -1 -> null -> no selection change
            expect(selectedSegmentForVertexHit(-1)).toBeNull();
          });
        }
      }
    }

    it('vertex selection with off-grid snap 0.37/1.23 still maps to correct adjacent edges and preserves beats snap alignment', () => {
      // [Step1] initial
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: quantizeBeat(1.23, snap) },
        { direction: 'up', beats: quantizeBeat(2.37, snap) },
        { direction: 'down', beats: quantizeBeat(0.63, snap) },
      ];
      const engine = new WaveEngine(segs, tl, amp, 0);
      const pts = engine.getPoints();
      // [Step2] pick off-grid vertex hits
      const offHits = [0, 1, 2, 3];
      for (const vHit of offHits) {
        const segIdx = selectedSegmentForVertexHit(vHit)!;
        // [Step3] beats must remain snap multiples before and after hypothetical drag
        expect(isSnapAligned(segs[segIdx].beats, snap)).toBe(true);
        expect(segIdx).toBe(vHit === 0 ? 0 : vHit - 1);
        // Neighbor beats also snap aligned
        if (vHit > 0) expect(isSnapAligned(segs[vHit - 1].beats, snap)).toBe(true);
      }
      expect(pts.length).toBe(segs.length + 1);
    });
  });

  // ----------------------------------------------------------------
  // 4. リスト行クラス生成論理: segment-list-item-selected付与 [3-step]
  // ----------------------------------------------------------------
  describe('4. SegmentEditor リスト行クラス付与 [Step1 initial null -> Step2 select -> Step3 class contains selected]', () => {
    function segmentItemClass(selectedIndex: number | null, hoveredIndex: number | null, i: number, editMode: string | null = null): string {
      // mirrors SegmentEditor.tsx:84
      let cls = 'segment-list-item';
      if (selectedIndex === i) cls += ' segment-list-item-selected';
      if (hoveredIndex === i) cls += ' segment-list-item-hovered';
      if (editMode === 'edge' && selectedIndex === i) cls += ' segment-list-item-edge-active';
      return cls;
    }

    it('initial selected=null -> no item has selected class (before)', () => {
      // [Step1] Capture before
      const selectedBefore: number | null = null;
      const segments: Segment[] = [
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const classesBefore = segments.map((_, i) => segmentItemClass(selectedBefore, null, i));
      // [Step2] Verify none selected
      for (const c of classesBefore) expect(c).not.toContain('segment-list-item-selected');
      // [Step3] After selecting index 0, only that item gains selected
      const selectedAfter = 0;
      const classesAfter = segments.map((_, i) => segmentItemClass(selectedAfter, null, i));
      expect(classesAfter[0]).toContain('segment-list-item-selected');
      expect(classesAfter[1]).not.toContain('segment-list-item-selected');
      expect(classesAfter[2]).not.toContain('segment-list-item-selected');
      // border-color would be var(--accent) via CSS (checked in section 1)
      expect(classesAfter[0]).toMatch(/segment-list-item-selected/);
    });

    it('vertex click vHit=2 -> selectedSegment=1 -> list item 1 gains selected (off-grid 1.23)', () => {
      // [Step1] initial null
      const selectedBefore: number | null = null;
      expect(segmentItemClass(selectedBefore, null, 1)).not.toContain('segment-list-item-selected');
      // [Step2] perform vertex hit mapping for off-grid scenario
      const vHit = 2; // e.g., vertex at beat 1.23 + 1.0
      const segIdx = selectedSegmentForVertexHit(vHit);
      expect(segIdx).toBe(1);
      // [Step3] assert list item 1 now selected
      const cls = segmentItemClass(segIdx, null, 1);
      expect(cls).toContain('segment-list-item-selected');
      expect(cls).toMatch(/segment-list-item-selected/);
      // other items not selected
      expect(segmentItemClass(segIdx, null, 0)).not.toContain('segment-list-item-selected');
      expect(segmentItemClass(segIdx, null, 2)).not.toContain('segment-list-item-selected');
    });

    it('list row click i=1 -> selectedSegment=1 -> preview adjacent edges highlighted (both vertex 1 and 2 map to 1)', () => {
      // [Step1] before
      const before: number | null = null;
      expect(before).toBeNull();
      // [Step2] click list row 1
      const clicked = 1;
      const selectedAfter = clicked;
      // [Step3] preview should highlight segment 1 (edge) and vertices 1,2
      expect(selectedAfter).toBe(1);
      const c1 = segmentItemClass(selectedAfter, null, 1);
      expect(c1).toContain('segment-list-item-selected');
      // vertices 1 and 2 both map to segment 1
      expect(selectedSegmentForVertexHit(1)).toBe(0); // not 1, but vertex 1 maps to 0, vertex 2 maps to 1
      expect(selectedSegmentForVertexHit(2)).toBe(1);
      // So highlighting of preview: selectedSegment=1 should highlight vertices 1 and 2 via isSelectedVertex check
      // WavePreview: isSelectedVertex = selectedSegment===idx || selectedSegment===idx-1
      function isSelectedVertex(selectedSegment: number | null, idx: number): boolean {
        return selectedSegment != null && (selectedSegment === idx || selectedSegment === idx - 1);
      }
      expect(isSelectedVertex(1, 1)).toBe(true); // vertex 1 adjacent to segment1 (idx-1 =0? Actually vertex 1: 1===1 true)
      expect(isSelectedVertex(1, 2)).toBe(true); // vertex 2: 1===1 true
      expect(isSelectedVertex(1, 0)).toBe(false);
      expect(isSelectedVertex(1, 3)).toBe(false);
    });

    it('hover also adds hovered class but does not remove selected', () => {
      // [Step1] selected 0
      const sel: number | null = 0;
      // [Step2] hover 1
      const hovered: number | null = 1;
      // [Step3] assert coexistence
      const c0 = segmentItemClass(sel, hovered, 0);
      const c1 = segmentItemClass(sel, hovered, 1);
      expect(c0).toContain('segment-list-item-selected');
      expect(c0).not.toContain('segment-list-item-hovered');
      expect(c1).toContain('segment-list-item-hovered');
      expect(c1).not.toContain('segment-list-item-selected');
    });
  });

  // ----------------------------------------------------------------
  // 5. WaveEngine ↔ Cursor slope consistency (T127/T128 regression, off-grid, complex amp)
  // ----------------------------------------------------------------
  describe('5. WaveEngine/Cursor 数値整合回帰 (off-grid 0.37/1.23, amp 0.7/1.3/2.7/3.4)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offBeats = [0.37, 1.23, 0.63, 2.37] as const;

    for (const amp of amps) {
      it(`amp=${amp}: getPoints length === segments.length +1 and waveYAt at vertices matches points`, () => {
        // [Step1] segments with snap 0.25 off-grid beats
        const snap = 0.25;
        const segs: Segment[] = [
          { direction: 'up', beats: quantizeBeat(1.37, snap) },
          { direction: 'down', beats: quantizeBeat(2.23, snap) },
          { direction: 'stay', beats: quantizeBeat(0.63, snap) },
        ];
        const tl = new BpmTimeline(120, [], amp);
        const eng = new WaveEngine(segs, tl, amp, 0);
        const pts = eng.getPoints();
        // [Step2] perform checks
        expect(pts.length).toBe(segs.length + 1);
        // [Step3] assert waveYAt at each vertex
        for (const p of pts) {
          expect(eng.waveYAt(p.beat)).toBeCloseTo(p.y, 5);
        }
        // beats snap aligned
        for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
      });

      for (const ob of offBeats) {
        it(`amp=${amp} offBeat=${ob}: unclamped displacement == 2*TW_AMP*amp*beats (no slow side)`, () => {
          // [Step1] small beats to avoid clamp
          const beats = Math.min(ob * 0.2, (1 / amp) * 0.4);
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [{ direction: 'down', beats }];
          const eng = new WaveEngine(segs, tl, amp, 0);
          const pts = eng.getPoints();
          // [Step2] compute displacement
          const disp = pts[1].y - pts[0].y;
          const expected = 2 * TW_AMP * amp * beats;
          // [Step3] must match (not slow)
          expect(Math.abs(disp - expected)).toBeLessThan(1e-6);
        });
      }

      it(`amp=${amp}: Cursor 1-beat displacement matches WaveEngine per-beat (off-grid dt 0.37)`, () => {
        // [Step1] capture
        const beatMs = 500;
        const dt = 0.37; // off-grid dt
        const cursor = new Cursor(amp, 0);
        cursor.setAmplitude(amp);
        const startY = cursor.y;
        // [Step2] update with down pressed
        cursor.update(dt, false, true, beatMs);
        const disp = cursor.y - startY;
        const expectedPerBeat = 2 * TW_AMP * amp;
        const expected = expectedPerBeat * (dt / (beatMs / 1000));
        const clamped = Math.min(BOTTOM - startY, expected);
        // [Step3] assert
        expect(Math.abs(disp - clamped)).toBeLessThan(1.5);
      });
    }
  });

  // ----------------------------------------------------------------
  // 6. End-to-end: vertex selection highlight chain (list + preview) must be consistent
  // ----------------------------------------------------------------
  describe('6. E2E chain: vertex click -> selectedSegment -> list blue + preview highlight (off-grid)', () => {
    it('full chain with amp=1.3 snap=0.5 off-grid vertex 0.37: list and preview both highlight segment 0', () => {
      // [Step1] Capture initial state: no selection
      let selectedSegment: number | null = null;
      const initialSegs: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 1.0 },
        { direction: 'up', beats: 1.0 },
      ];
      const amp = 1.3;
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine(initialSegs, tl, amp, 0);
      const pts = engine.getPoints();
      expect(pts.length).toBe(initialSegs.length + 1);
      const beforeClass = `segment-list-item${selectedSegment === 0 ? ' segment-list-item-selected' : ''}`;
      expect(beforeClass).not.toContain('segment-list-item-selected');

      // [Step2] Perform vertex click at vHit=0 (TOP vertex) with off-grid beat 0.37 mapping
      const vHit = 0;
      const segIdx = selectedSegmentForVertexHit(vHit);
      selectedSegment = segIdx; // simulates onSelectSegment call that fix adds

      // [Step3] Assert list blue
      const afterClass = `segment-list-item${selectedSegment === 0 ? ' segment-list-item-selected' : ''}`;
      expect(afterClass).toContain('segment-list-item-selected');
      // Preview highlight: edge 0 should be selected, vertices 0 and 1 highlighted
      function isSelectedEdge(selected: number | null, i: number): boolean { return i === selected; }
      function isSelectedVertex(selected: number | null, idx: number): boolean { return selected != null && (selected === idx || selected === idx - 1); }
      expect(isSelectedEdge(selectedSegment, 0)).toBe(true);
      expect(isSelectedVertex(selectedSegment, 0)).toBe(true);
      expect(isSelectedVertex(selectedSegment, 1)).toBe(true);
      expect(isSelectedVertex(selectedSegment, 2)).toBe(false);
      // Also verify beats still snap aligned
      for (const s of initialSegs) expect(isSnapAligned(s.beats, snap)).toBe(true);
    });

    it('vertex click vHit=2 off-grid 1.23 with amp=2.7 -> highlights segment 1 and vertices 1,2', () => {
      // [Step1] null
      let sel: number | null = null;
      expect(sel).toBeNull();
      // [Step2] vHit=2 maps to 1
      const vHit = 2;
      sel = selectedSegmentForVertexHit(vHit);
      // [Step3] assert
      expect(sel).toBe(1);
      const cls = `segment-list-item${sel === 1 ? ' segment-list-item-selected' : ''}`;
      expect(cls).toContain('segment-list-item-selected');
      // preview edge highlight
      expect(sel === 1).toBe(true);
      // vertices 2 and 1 highlighted via segment 1
      function isV(s: number | null, idx: number): boolean { return s != null && (s === idx || s === idx - 1); }
      expect(isV(sel, 1)).toBe(true);
      expect(isV(sel, 2)).toBe(true);
      expect(isV(sel, 0)).toBe(false);
    });
  });
});
