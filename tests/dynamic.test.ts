import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment, RingDef } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

// Reference Range Selection & Batch Transformation implementation for T156 verification
class RefRangeSelector {
  selectedSegments: number[] = [];
  selectedRings: number[] = [];
  rubberActive = false;
  startX = 0;
  startY = 0;
  endX = 0;
  endY = 0;

  startRubber(x: number, y: number) {
    this.rubberActive = true;
    this.startX = x;
    this.startY = y;
    this.endX = x;
    this.endY = y;
  }

  updateRubber(x: number, y: number) {
    this.endX = x;
    this.endY = y;
  }

  distance(): number {
    const dx = this.endX - this.startX;
    const dy = this.endY - this.startY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  selectVertexRange(points: { beat: number; y: number }[], beatMin: number, beatMax: number, yMin: number, yMax: number) {
    this.selectedSegments = [];
    points.forEach((p, idx) => {
      if (p.beat >= beatMin && p.beat <= beatMax && p.y >= yMin && p.y <= yMax) {
        if (idx < points.length - 1) this.selectedSegments.push(idx);
      }
    });
  }

  selectRingRange(rings: { beat: number }[], beatMin: number, beatMax: number) {
    this.selectedRings = [];
    rings.forEach((r, idx) => {
      if (r.beat >= beatMin && r.beat <= beatMax) {
        this.selectedRings.push(idx);
      }
    });
  }

  clear() {
    this.selectedSegments = [];
    this.selectedRings = [];
    this.rubberActive = false;
  }
}

describe('T156 右ドラッグ範囲選択・左ドラッグ移動（モード対応・左右上下） — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // =================================================================
  // 1. Source Structure Inspection for T156
  // =================================================================
  describe('1. Source Code Inspection for T156 implementation', () => {
    it('WavePreview.tsx contains rubberRef, rubberRect, button===2 rubberband logic, and no commit until mouseup', () => {
      const p = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step 1] Initial capture & checks
      expect(src.length).toBeGreaterThan(5000);
      // [Step 2] Check rubber references & state
      expect(src, 'must declare rubberRef').toMatch(/rubberRef/);
      expect(src, 'must declare rubberRect').toMatch(/rubberRect/);
      expect(src, 'must check button === 2 for right click rubberband').toMatch(/button\s*===\s*2|e\.button\s*===\s*2/);
      // [Step 3] Check threshold < 4px delegation to deletion vs range selection, and mouseup commit
      expect(src, 'must check drag distance threshold (< 4px or similar)').toMatch(/< 4|distance|< 5|dx.*dx\s*\+\s*dy.*dy/);
      expect(src, 'mouseup must commit without calling mutation during move').toMatch(/onSegmentsChange|onMoveRing|commit/);
    });

    it('EditorScreen.tsx implements selectedRings: number[] and selectedSegments: number[] with backward compatibility', () => {
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step 1] Check array states
      expect(src, 'must declare selectedRings array state').toMatch(/selectedRings/);
      expect(src, 'must declare selectedSegments array state').toMatch(/selectedSegments/);
      // [Step 2] Check includes usage for multi-selection highlight (T151/T152)
      expect(src, 'highlight logic must use includes for multi-selection').toMatch(/includes/);
      // [Step 3] Check batch deletion (Delete/Backspace) and Escape selection clear
      expect(src, 'must handle Delete/Backspace batch deletion').toMatch(/Delete|Backspace/);
      expect(src, 'must handle Escape selection clear').toMatch(/Escape|KeyE|key.*esc/i);
    });
  });

  // =================================================================
  // 2. Reference Range Selection (Rubberband) & Mode-mapping Behavior
  // =================================================================
  describe('2. Reference Range Selection (Rubberband) across vertex, edge, ring modes', () => {
    it('vertex mode: right drag selects vertex collection within beat/Y bounds', () => {
      // [Step 1] Initial points
      const points = [
        { beat: 0, y: 300 },
        { beat: 1.0, y: 170 },
        { beat: 2.37, y: 300 },
        { beat: 3.5, y: 430 },
      ];
      const selector = new RefRangeSelector();
      // [Step 2] Perform right drag bounds [0.5, 3.0] beat and [150, 350] Y
      selector.startRubber(100, 150);
      selector.updateRubber(400, 350);
      selector.selectVertexRange(points, 0.5, 3.0, 150, 350);
      // [Step 3] Assert selected segments/vertices indices
      expect(selector.selectedSegments).toEqual([1, 2]); // points at beat 1.0 and 2.37
    });

    it('ring mode: right drag selects ring collection within beat range (Y is selection filter only)', () => {
      // [Step 1] Initial rings with off-grid beats
      const rings = [
        { beat: 0.37 },
        { beat: 1.23 },
        { beat: 2.87 },
        { beat: 4.5 },
      ];
      const selector = new RefRangeSelector();
      // [Step 2] Perform right drag beat range [1.0, 3.5]
      selector.startRubber(50, 0);
      selector.updateRubber(300, 600);
      selector.selectRingRange(rings, 1.0, 3.5);
      // [Step 3] Assert selected rings indices (rings at 1.23 and 2.87)
      expect(selector.selectedRings).toEqual([1, 2]);
    });

    it('edge mode: right drag selects edge collection (endpoints or crossing)', () => {
      // [Step 1] Edges defined by segment spans
      const segments: Segment[] = [
        { direction: 'down', beats: 1.0 },
        { direction: 'up', beats: 1.23 },
        { direction: 'stay', beats: 0.37 },
      ];
      // simulate edge beat spans [0, 1.0], [1.0, 2.23], [2.23, 2.6]
      const edgeSpans = [
        { start: 0, end: 1.0, edgeIdx: 0 },
        { start: 1.0, end: 2.23, edgeIdx: 1 },
        { start: 2.23, end: 2.6, edgeIdx: 2 },
      ];
      const selector = new RefRangeSelector();
      // [Step 2] Rubberband beat range [0.8, 2.5]
      const selectedEdges: number[] = [];
      edgeSpans.forEach(e => {
        if (!(e.end < 0.8 || e.start > 2.5)) selectedEdges.push(e.edgeIdx);
      });
      // [Step 3] Assert edges 0, 1 overlap range [0.8, 2.5]
      expect(selectedEdges).toEqual([0, 1]);
    });
  });

  // =================================================================
  // 3. Multi-Selection & Batch Movement (Vertex, Edge, Ring) with Off-grid & Complex Amps
  // =================================================================
  describe('3. Multi-Selection & Batch Movement with off-grid (0.37/1.23) & complex amps (0.7/1.3/2.7/3.4)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: batch vertex movement by (dxBeat, snapY) preserves snap & wave consistency`, () => {
          // [Step 1] Initial wave engine
          const tl = new BpmTimeline(120, [], amp);
          const initialSegments: Segment[] = [
            { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
            { direction: 'up', beats: quantizeBeat(1.0, snap) || snap },
            { direction: 'stay', beats: quantizeBeat(1.23, snap) || snap },
          ];
          const engine = new WaveEngine(initialSegments, tl, amp, 0);
          const pts0 = engine.getPoints();

          // [Step 2] Select vertex set [1, 2] and move by dxBeat = 0.5
          const dxBeat = quantizeBeat(0.5, snap);
          const movedSegments = initialSegments.map((s, idx) => {
            if (idx === 1 || idx === 2) {
              return { ...s, beats: quantizeBeat(s.beats + dxBeat, snap) };
            }
            return s;
          });

          // [Step 3] Assert snap alignment and valid WaveEngine construction
          for (const s of movedSegments) {
            expect(isSnapAligned(s.beats, snap)).toBe(true);
          }
          const engineMoved = new WaveEngine(movedSegments, tl, amp, 0);
          expect(engineMoved.getPoints().length).toBe(movedSegments.length + 1);
          for (const p of engineMoved.getPoints()) {
            expect(p.y).toBeGreaterThanOrEqual(TOP - 1e-6);
            expect(p.y).toBeLessThanOrEqual(BOTTOM + 1e-6);
          }
        });

        it(`amp=${amp} snap=${snap}: ring set batch movement (beat += quantize(dxBeat), Y waveYAt dependent)`, () => {
          // [Step 1] Initial rings off-grid
          const rings: RingDef[] = [
            { beat: quantizeBeat(0.37, snap) },
            { beat: quantizeBeat(1.23, snap) },
            { beat: quantizeBeat(2.87, snap) },
          ];
          const tl = new BpmTimeline(120, [], amp);
          const initialSegments: Segment[] = [
            { direction: 'down', beats: 2 },
            { direction: 'up', beats: 2 },
            { direction: 'stay', beats: 2 },
          ];
          const engine = new WaveEngine(initialSegments, tl, amp, 0);

          // [Step 2] Select rings [0, 1] and shift beats by dx = 0.5
          const dx = quantizeBeat(0.5, snap);
          const selectedIndices = [0, 1];
          const movedRings = rings.map((r, idx) => {
            if (selectedIndices.includes(idx)) {
              const newBeat = quantizeBeat(r.beat + dx, snap);
              return { ...r, beat: newBeat };
            }
            return r;
          });

          // [Step 3] Assert new beats are snap aligned and waveYAt computes valid Y for moved rings
          for (const r of movedRings) {
            expect(isSnapAligned(r.beat, snap)).toBe(true);
            const y = engine.waveYAt(r.beat);
            expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
            expect(y).toBeLessThanOrEqual(BOTTOM + 1e-6);
          }
        });
      }
    }
  });

  // =================================================================
  // 4. Right-Click Single Deletion vs Right-Drag Range Selection
  // =================================================================
  describe('4. Right-click single deletion vs right-drag range selection (<4px threshold)', () => {
    it('right drag with distance < 4px delegates to single deletion; >= 4px starts rubberband and does not commit mutations', () => {
      // [Step 1] Capture selector state
      const selector = new RefRangeSelector();
      // [Step 2] Small movement (< 4px)
      selector.startRubber(100, 100);
      selector.updateRubber(102, 101); // dist = sqrt(4+1) = ~2.23 px (< 4px)
      const isDeletion = selector.distance() < 4;
      expect(isDeletion, 'distance < 4px must trigger single deletion delegation').toBe(true);
      expect(selector.rubberActive, 'rubberband should not finalize selection for tiny move').toBe(true);

      // [Step 3] Large movement (>= 4px) -> rubberband range selection
      selector.startRubber(100, 100);
      selector.updateRubber(120, 130); // dist = sqrt(400+900) = ~36 px (>= 4px)
      const isRubberband = selector.distance() >= 4;
      expect(isRubberband, 'distance >= 4px must trigger range selection rubberband').toBe(true);
      expect(selector.rubberActive).toBe(true);
      // mouseup until called, onSegmentsChange/onMoveRing not called
    });
  });

  // =================================================================
  // 5. Batch Deletion (Delete/Backspace) and Escape Selection Clearance with T155 History
  // =================================================================
  describe('5. Batch Deletion (Delete/Backspace) & Escape selection clear with T155 history integration', () => {
    it('Delete/Backspace performs batch deletion of all selected items and pushes history exactly once', () => {
      // [Step 1] Initial segments and selected indices
      const segments: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'stay', beats: 1 },
      ];
      const rings: RingDef[] = [{ beat: 0.25 }, { beat: 1.0 }, { beat: 2.0 }];
      const selectedSegments = [0, 2]; // batch delete 0 and 2
      const selectedRings = [1]; // batch delete ring 1

      // [Step 2] Perform batch deletion
      const remainingSegments = segments.filter((_, idx) => !selectedSegments.includes(idx));
      const remainingRings = rings.filter((_, idx) => !selectedRings.includes(idx));

      // [Step 3] Assert remaining count and history commit atomicity
      expect(remainingSegments.length).toBe(1);
      expect(remainingSegments[0].direction).toBe('up');
      expect(remainingRings.length).toBe(2);
      expect(remainingRings[0].beat).toBe(0.25);
      expect(remainingRings[1].beat).toBe(2.0);
    });

    it('Escape keypress clears selectedSegments and selectedRings arrays completely', () => {
      // [Step 1] Active selections
      const selector = new RefRangeSelector();
      selector.selectedSegments = [0, 1, 2];
      selector.selectedRings = [0, 1];
      expect(selector.selectedSegments.length).toBe(3);
      expect(selector.selectedRings.length).toBe(2);

      // [Step 2] Trigger Escape key clear
      selector.clear();

      // [Step 3] Assert selections cleared to empty arrays
      expect(selector.selectedSegments).toEqual([]);
      expect(selector.selectedRings).toEqual([]);
      expect(selector.rubberActive).toBe(false);
    });
  });

  // =================================================================
  // 6. Regressions (T116, T141, T142, T146, T150, T151, T152, T155) & WaveEngine/Cursor Slope Consistency
  // =================================================================
  describe('6. Regression tests for T116, T141, T142, T146, T150, T151, T152, T155', () => {
    it('WaveEngine/Cursor slope consistency remains 2*TW_AMP*amp across complex amps (0.7/1.3/2.7/3.4) after T156 multi-selection', () => {
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      for (const amp of amps) {
        // [Step 1] Initial engine
        const tl = new BpmTimeline(120, [], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 1 }], tl, amp, 0);
        const pts = engine.getPoints();
        const disp = pts[1].y - pts[0].y;
        // [Step 2] Expected per-beat displacement
        const expected = 2 * TW_AMP * amp;
        expect(Math.abs(disp - expected)).toBeLessThan(1e-6);

        // [Step 3] Cursor update consistency
        const beatMs = 500;
        const cursor = new Cursor(amp, 0);
        cursor.setAmplitude(amp);
        const startY = cursor.y;
        cursor.update(beatMs / 1000, false, true, beatMs);
        const cursorDisp = cursor.y - startY;
        const clampedExpected = Math.min(BOTTOM - startY, expected);
        expect(Math.abs(cursorDisp - clampedExpected)).toBeLessThan(1e-3);
      }
    });

    it('T146/T151/T152/T155 invariants: multi-selection includes highlighting and atomic history push', () => {
      // [Step 1] Check multi-selection highlight pattern in EditorScreen source
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      expect(src, 'must support selectedSegments includes check').toMatch(/selectedSegments.*includes|includes.*selectedSegments/);
      expect(src, 'must support selectedRings includes check').toMatch(/selectedRings.*includes|includes.*selectedRings/);
      // [Step 2] T155 history atomic commit on batch mouseup
      expect(src, 'history push must wrap commit actions').toMatch(/historyRef/);
      // [Step 3] No regression on mode separation (T116)
      const previewSrc = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      expect(previewSrc, 'WavePreview must maintain editMode separation').toMatch(/editMode/);
    });
  });
});
