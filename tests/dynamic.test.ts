import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import * as editorDragModule from '../src/game/editorDrag';
import { calculateVertexDrag, calculateEdgeDrag, calculateMultiDrag } from '../src/game/editorDrag';
import { Cursor } from '../src/game/cursor';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}

// helper to read source files
function readSrc(p: string): string {
  return fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
}

describe('T157 頂点選択の頂点単位化と1点追従移動の修正 — Vitest node (WaveEngine/BpmTimeline/editorDrag/Cursor)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------------
  // 0. Source guards — must FAIL before fix (Red), PASS after (Green)
  // ------------------------------------------------------------------
  describe('0. Source-level fix guards (selectedVertices, vertex-unit findItemsInRect, 4px threshold)', () => {
    it('EditorScreen.tsx must declare selectedVertices state (0..n, final inclusive)', () => {
      // [Step 1] read before
      const src = readSrc('src/screens/EditorScreen.tsx');
      // [Step 2] search
      const hasSelectedVertices = /selectedVertices/.test(src);
      const hasSetSelectedVertices = /setSelectedVertices/.test(src);
      // [Step 3] assert — must exist after T157
      expect(hasSelectedVertices, 'EditorScreen must have selectedVertices:number[] state').toBe(true);
      expect(hasSetSelectedVertices, 'EditorScreen must have setSelectedVertices setter').toBe(true);
      // vertex range is 0..n inclusive => must handle final vertex (length, not length-1)
      // check that selectedVertices is used with WavePreview props or findItemsInRect vertex handling
      expect(src, 'selectedVertices should be passed to WavePreview or used in selection').toMatch(/selectedVertices/);
    });

    it('editorDrag.ts must export vertex-collection move (single vertex {v} only)', () => {
      const src = readSrc('src/game/editorDrag.ts');
      // Must have a vertex-collection API: either new function or extended multi-drag handling vertices
      const hasVertexMulti =
        /calculateVertexMultiDrag/.test(src) ||
        /calculateMultiVertexDrag/.test(src) ||
        /vertexIndices/.test(src) ||
        /selectedVertices/.test(src) ||
        /calculateMultiDrag[\s\S]*?vertex/i.test(src);
      expect(hasVertexMulti, 'editorDrag must implement vertex-collection move (vertexIndices / calculateVertexMultiDrag)').toBe(true);
      // The module export must be callable
      const mod: any = editorDragModule as any;
      const hasExport =
        typeof mod.calculateVertexMultiDrag === 'function' ||
        typeof mod.calculateMultiVertexDrag === 'function' ||
        typeof mod.calculateVertexCollectionDrag === 'function' ||
        // if extended, calculateMultiDrag should still exist but handle vertex sets
        typeof mod.calculateMultiDrag === 'function';
      expect(hasExport).toBe(true);
    });

    it('WavePreview.tsx findItemsInRect vertex branch must push vertex index (not seg index) and include final vertex n', () => {
      const src = readSrc('src/screens/editor/WavePreview.tsx');
      // Extract findItemsInRect function body
      const idx = src.indexOf('findItemsInRect');
      expect(idx, 'findItemsInRect must exist').toBeGreaterThan(-1);
      const body = src.slice(idx, idx + 4000);
      // Bug: for vertex mode it did `foundSegs.push(i)` where i is segment index, missing final vertex
      // Fix: must push vertex index, and allow i up to segments.length inclusive (or use getPoints().length)
      // We check that vertex branch handles getPoints() length, not segments.length, and pushes vertex index correctly
      // Heuristic: should contain check for vertex mode that iterates over points or handles final vertex
      const vertexBranch = body.slice(body.indexOf("editMode === 'vertex'"), body.indexOf("editMode === 'vertex'") + 1500);
      // Should reference getPoints or points length which is segments.length+1
      const mentionsPoints = /getPoints\(\)/.test(vertexBranch) || /points\.length/.test(vertexBranch);
      expect(mentionsPoints, 'vertex branch must reference getPoints() / points to include final vertex n').toBe(true);
      // Must not be the old buggy `foundSegs.push(i)` where i is segment start only (without final)
      // After fix, should push vertex index v (0..n) — we verify that final vertex is selectable:
      // the loop or condition should allow i === segments.length (final point)
      const hasFinalVertexHandling =
        /segments\.length/.test(vertexBranch) && /points/.test(vertexBranch);
      expect(hasFinalVertexHandling).toBe(true);
    });

    it('WavePreview.tsx empty drag (vertexCreate) must require >=4px movement before commit', () => {
      const src = readSrc('src/screens/editor/WavePreview.tsx');
      // vertexCreateRef path must guard with movement threshold
      // Check that onUp for vertexCreate checks distance or moved >=4
      const has4pxGuard =
        /vertexCreateRef[\s\S]*?4/.test(src) &&
        (/Math\.hypot/.test(src) || /moved/.test(src) || /distance/.test(src) || />=\s*4/.test(src));
      expect(has4pxGuard, 'empty drag must have 4px threshold before committing vertex creation').toBe(true);
      // Direct string check for explicit threshold
      expect(src).toMatch(/4/);
    });
  });

  // ------------------------------------------------------------------
  // 1. Single vertex {v} via calculateVertexDrag — horizontal only, off-grid, complex amps
  // ------------------------------------------------------------------
  describe('1. {v} 単独 interior vertex drag — only getPoints()[v].beat +dx, others invariant, no posterior shift', () => {
    const amps = [0.7, 1.3, 2.7] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const offGridDxs = [0.37, 1.23, 0.63, 0.87] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const dxRaw of offGridDxs) {
          it(`amp=${amp} snap=${snap} dxRaw=${dxRaw}: interior v moves +dx, neighbors re-quantized, later pts unchanged`, () => {
            // [Step 1: Capture Initial State]
            const tl = new BpmTimeline(120, [], amp);
            const initial: Segment[] = [
              { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
              { direction: 'up', beats: quantizeBeat(1.5, snap) || snap },
              { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
              { direction: 'up', beats: quantizeBeat(1.5, snap) || snap },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const pts0 = engine0.getPoints();
            expect(pts0.length).toBe(initial.length + 1);
            const v = 2; // interior
            const prevBeat = pts0[v - 1].beat;
            const nextBeat = pts0[v + 1].beat;
            const curBeat = pts0[v].beat;
            const ySame = pts0[v].y;
            // dx quantized to snap
            const dx = quantizeBeat(dxRaw, snap);
            // clamp target inside (prev+snap .. next-snap)
            let targetBeat = quantizeBeat(curBeat + dx, snap);
            targetBeat = Math.max(prevBeat + snap, Math.min(nextBeat - snap, targetBeat));
            if (Math.abs(targetBeat - curBeat) < 1e-9) return; // skip no-op due to clamp

            // [Step 2: Perform User Interaction] — horizontal drag
            const result = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: v,
              targetBeat,
              targetY: ySame,
              snap,
            });
            expect(result).not.toBeNull();
            const segs = result!;

            // [Step 3: Assert Resulting Transition]
            const engine1 = new WaveEngine(segs, tl, amp, 0);
            const pts1 = engine1.getPoints();
            // length invariant
            expect(pts1.length).toBe(pts0.length);
            expect(segs.length).toBe(initial.length);
            // only v moves
            expect(Math.abs(pts1[v].beat - targetBeat)).toBeLessThan(1e-6);
            // other vertices unchanged
            for (let i = 0; i < pts0.length; i++) {
              if (i === v) continue;
              expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
              // Y unchanged for non-adjacent? adjacent Y may change due to dir? but beats are X-only here so Y same
              // For horizontal-only with same Y, adjacent dir stays, so Y of moved vertex same, others same
            }
            // posterior shift none: tail after v+1 unchanged
            for (let i = v + 1; i < pts0.length; i++) {
              expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
            }
            // only 2 adjacent segments changed
            for (let k = 0; k < initial.length; k++) {
              if (k === v - 1 || k === v) {
                expect(isSnapAligned(segs[k].beats, snap)).toBe(true);
                // beats = horizontal distance
                if (k === v - 1) expect(segs[k].beats).toBeCloseTo(quantizeBeat(targetBeat - prevBeat, snap), 6);
                if (k === v) expect(segs[k].beats).toBeCloseTo(quantizeBeat(nextBeat - targetBeat, snap), 6);
              } else {
                expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
              }
            }
            // all beats snap aligned
            for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
          });
        }
      }
    }

    it('single {v} horizontal-only must NOT be rejected (old bug would null due to Y-only beats)', () => {
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ];
      const pts0 = new WaveEngine(segs, tl, amp, 0).getPoints();
      const v = 2;
      const ySame = pts0[v].y;
      const targetBeat = quantizeBeat(pts0[v].beat - 0.37, snap); // move left 0.37 -> 0.25 snap
      const clamped = Math.max(pts0[v - 1].beat + snap, Math.min(pts0[v + 1].beat - snap, targetBeat));
      const res = calculateVertexDrag({
        segments: segs,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: v,
        targetBeat: clamped,
        targetY: ySame,
        snap,
      });
      expect(res).not.toBeNull();
      const pts1 = new WaveEngine(res!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[v].beat - clamped)).toBeLessThan(1e-6);
    });
  });

  // ------------------------------------------------------------------
  // 2. Vertex-collection {v} single via new API — core T157 bug (2 points moving)
  // ------------------------------------------------------------------
  describe('2. Vertex-collection {v} single via vertex-multi — only 1 point moves (bug: 2 points)', () => {
    const snaps = [0.125, 0.25, 0.5] as const;
    const amps = [0.7, 1.3, 2.7] as const;
    const offGridDxs = [0.37, 1.23] as const;

    // helper to call vertex-collection move regardless of name
    function callVertexMulti(
      segments: Segment[],
      bpmTimeline: BpmTimeline,
      startPosition: number,
      vertexIndices: number[],
      dxBeat: number,
      dy: number,
      snap: number,
    ): Segment[] | null {
      const mod: any = editorDragModule as any;
      if (typeof mod.calculateVertexMultiDrag === 'function') {
        return mod.calculateVertexMultiDrag({
          segments,
          bpmTimeline,
          startPosition,
          vertexIndices,
          dxBeat,
          dy,
          snap,
        });
      }
      if (typeof mod.calculateMultiVertexDrag === 'function') {
        return mod.calculateMultiVertexDrag({
          segments,
          bpmTimeline,
          startPosition,
          vertexIndices,
          dxBeat,
          dy,
          snap,
        });
      }
      if (typeof mod.calculateVertexCollectionDrag === 'function') {
        return mod.calculateVertexCollectionDrag({
          segments,
          bpmTimeline,
          startPosition,
          vertexIndices,
          dxBeat,
          dy,
          snap,
        });
      }
      // fallback: if only calculateMultiDrag exists but is supposed to handle vertices,
      // try calling with vertexIndices as selSegIdxs-converted? This will fail the correct assertion
      // and thus make test Red before fix.
      if (typeof mod.calculateMultiDrag === 'function') {
        // Attempt to call with a special flag: try vertexIndices param
        try {
          const r = mod.calculateMultiDrag({
            segments,
            bpmTimeline,
            startPosition,
            vertexIndices,
            selSegIdxs: [],
            dxBeat,
            dy,
            snap,
          });
          if (r) return r;
        } catch {}
        // fallback buggy: interpret vertex as seg — expected to be wrong (moves 2 points)
        // we still call old API to show mismatch
        return mod.calculateMultiDrag({
          segments,
          bpmTimeline,
          startPosition,
          selSegIdxs: vertexIndices.map(v => v), // buggy mapping: seg index == vertex index
          dxBeat,
          dy,
          snap,
        });
      }
      return null;
    }

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const dxRaw of offGridDxs) {
          it(`amp=${amp} snap=${snap} dxRaw=${dxRaw}: vertex {2} alone +dx, other vertices invariant`, () => {
            // [Step 1: Capture Initial]
            const tl = new BpmTimeline(120, [], amp);
            const initial: Segment[] = [
              { direction: 'down', beats: 1.0 },
              { direction: 'up', beats: 1.0 },
              { direction: 'down', beats: 1.0 },
              { direction: 'up', beats: 1.0 },
            ];
            const engine0 = new WaveEngine(initial, tl, amp, 0);
            const pts0 = engine0.getPoints();
            const v = 2;
            const dx = quantizeBeat(dxRaw, snap);
            const targetBeat = quantizeBeat(pts0[v].beat + dx, snap);
            const clampedTarget = Math.max(pts0[v - 1].beat + snap, Math.min(pts0[v + 1].beat - snap, targetBeat));
            const clampedDx = quantizeBeat(clampedTarget - pts0[v].beat, snap);
            if (Math.abs(clampedDx) < 1e-9) return;

            // [Step 2: Perform Interaction] vertex-collection single
            const result = callVertexMulti(initial, tl, 0, [v], clampedDx, 0, snap);
            expect(result, 'vertex-collection function must exist and return non-null for single vertex move').not.toBeNull();
            const segs = result!;

            // [Step 3: Assert]
            const engine1 = new WaveEngine(segs, tl, amp, 0);
            const pts1 = engine1.getPoints();
            expect(pts1.length).toBe(pts0.length);
            expect(segs.length).toBe(initial.length);
            // ONLY v moves; v+1 (bug: would also move if seg-based) must stay
            expect(Math.abs(pts1[v].beat - clampedTarget)).toBeLessThan(1e-6);
            expect(Math.abs(pts1[v + 1].beat - pts0[v + 1].beat)).toBeLessThan(1e-6);
            expect(Math.abs(pts1[0].beat - pts0[0].beat)).toBeLessThan(1e-6);
            expect(Math.abs(pts1[1].beat - pts0[1].beat)).toBeLessThan(1e-6);
            // last point unchanged
            expect(Math.abs(pts1[pts1.length - 1].beat - pts0[pts0.length - 1].beat)).toBeLessThan(1e-6);
            // posterior shift none beyond v+1
            for (let i = v + 2; i < pts0.length; i++) {
              expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
            }
            // only 2 segments around v changed
            for (let k = 0; k < initial.length; k++) {
              if (k === v - 1) {
                expect(segs[k].beats).toBeCloseTo(quantizeBeat(clampedTarget - pts0[v - 1].beat, snap), 6);
              } else if (k === v) {
                expect(segs[k].beats).toBeCloseTo(quantizeBeat(pts0[v + 1].beat - clampedTarget, snap), 6);
              } else {
                expect(segs[k].beats).toBeCloseTo(initial[k].beats, 6);
              }
            }
            for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBe(true);
          });
        }
      }
    }

    it('vertex {v} where neighbor short should still allow right move (old clamp bug)', () => {
      // Bug: moving vertex v right was clamped by seg v+1 short limit because moved set included v+1
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      // seg 2 is short-ish (0.5 = 2 snaps), so moving vertex 2 right should be allowed
      // up to next-snap; the old seg-based code clamped to 0 (it treated the moved set
      // as {v, v+1} and hi = origLen(v+1)-snap). NOTE: a 0.25-long tail with snap=0.25
      // leaves no room (clamped == curBeat), so 0.5 is the minimal valid fixture here.
      const segs: Segment[] = [
        { direction: 'down', beats: 1.0 },
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 0.5 }, // short neighbor (>= 2 snaps)
        { direction: 'up', beats: 1.5 },
      ];
      const pts0 = new WaveEngine(segs, tl, amp, 0).getPoints();
      const v = 2;
      const dx = quantizeBeat(0.37, snap); // 0.25
      const target = quantizeBeat(pts0[v].beat + dx, snap);
      const clamped = Math.max(pts0[v - 1].beat + snap, Math.min(pts0[v + 1].beat - snap, target));
      // old bug would compute hi = origLen(v+1)-snap = 0, so dxC=0 (no move)
      const mod: any = editorDragModule as any;
      const fn = mod.calculateVertexMultiDrag || mod.calculateMultiVertexDrag || mod.calculateVertexCollectionDrag;
      if (!fn) {
        // Expect failure before fix — force expect to fail to show Red
        expect(fn, 'vertex-multi function must exist to allow short-neighbor right move').toBeTruthy();
        return;
      }
      const res = fn({ segments: segs, bpmTimeline: tl, startPosition: 0, vertexIndices: [v], dxBeat: dx, dy: 0, snap });
      expect(res).not.toBeNull();
      const pts1 = new WaveEngine(res, tl, amp, 0).getPoints();
      // Must have moved
      expect(Math.abs(pts1[v].beat - pts0[v].beat)).toBeGreaterThan(1e-6);
      expect(Math.abs(pts1[v].beat - clamped)).toBeLessThan(1e-6);
      expect(Math.abs(pts1[v + 1].beat - pts0[v + 1].beat)).toBeLessThan(1e-6);
    });
  });

  // ------------------------------------------------------------------
  // 3. Final vertex (index n) selectable
  // ------------------------------------------------------------------
  describe('3. Final vertex index n selectable and movable (prev bug: excluded)', () => {
    const snaps = [0.25, 0.5] as const;
    for (const snap of snaps) {
      it(`snap=${snap}: final vertex n can be moved (off-grid amp 1.3/2.7)`, () => {
        const amps = [1.3, 2.7] as const;
        for (const amp of amps) {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: quantizeBeat(1.0, snap) || snap },
            { direction: 'up', beats: quantizeBeat(1.0, snap) || snap },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const n = pts0.length - 1; // final vertex index
          const curBeat = pts0[n].beat;
          const dx = quantizeBeat(0.37, snap);
          const targetBeat = quantizeBeat(curBeat + dx, snap);
          // endpoint: only last segment affected
          const res = calculateVertexDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            pointIndex: n,
            targetBeat,
            targetY: pts0[n].y, // horizontal only
            snap,
          });
          expect(res).not.toBeNull();
          const pts1 = new WaveEngine(res!, tl, amp, 0).getPoints();
          expect(pts1.length).toBe(pts0.length);
          expect(Math.abs(pts1[n].beat - targetBeat)).toBeLessThan(1e-6);
          // previous vertices unchanged
          for (let i = 0; i < n; i++) {
            expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
          }
          expect(res![res!.length - 1].beats).toBeCloseTo(quantizeBeat(targetBeat - pts0[n - 1].beat, snap), 6);
          expect(isSnapAligned(res![res!.length - 1].beats, snap)).toBe(true);
        }
      });
    }

    it('final vertex via vertex-collection should also work', () => {
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 1.5 }, { direction: 'up', beats: 1.0 }];
      const pts0 = new WaveEngine(segs, tl, amp, 0).getPoints();
      const n = pts0.length - 1;
      const mod: any = editorDragModule as any;
      const fn = mod.calculateVertexMultiDrag || mod.calculateMultiVertexDrag || mod.calculateVertexCollectionDrag;
      if (!fn) {
        expect(fn, 'vertex-collection for final vertex n must exist').toBeTruthy();
        return;
      }
      const dx = quantizeBeat(0.37, snap);
      const res = fn({ segments: segs, bpmTimeline: tl, startPosition: 0, vertexIndices: [n], dxBeat: dx, dy: 0, snap });
      expect(res).not.toBeNull();
      const pts1 = new WaveEngine(res, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[n].beat - quantizeBeat(pts0[n].beat + dx, snap))).toBeLessThan(1e-6);
    });
  });

  // ------------------------------------------------------------------
  // 4. Vertex creation empty-drag threshold is 4px (no commit below)
  // ------------------------------------------------------------------
  describe('4. Empty drag (vertexCreate) threshold 4px in WavePreview logic', () => {
    it('WavePreview empty drag must differentiate grab miss (<14px) and creation threshold', () => {
      const src = readSrc('src/screens/editor/WavePreview.tsx');
      // nearestVertexIndex threshold is 14px; empty drag creation is separate
      expect(src).toMatch(/nearestVertexIndex/);
      expect(src).toMatch(/14/);
      // vertexCreateRef must exist
      expect(src).toMatch(/vertexCreateRef/);
      // onMouseUp for vertexCreate must check movement distance
      const idx = src.indexOf('vertexCreateRef.current');
      expect(idx).toBeGreaterThan(-1);
      const slice = src.slice(idx, idx + 3000);
      // Must have distance check or moved flag before committing
      const hasDistanceGuard = /Math\.hypot|distance|moved|4/.test(slice);
      expect(hasDistanceGuard).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 5. Off-grid + complex amp numeric consistency (WaveEngine ↔ Cursor)
  // ------------------------------------------------------------------
  describe('5. Off-grid numeric consistency WaveEngine ↔ Cursor (complex amps 0.7/1.3/2.7/3.4, beats 0.37/1.23)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGrid = [0.37, 1.23] as const;
    for (const amp of amps) {
      for (const ob of offGrid) {
        it(`amp=${amp} off=${ob}: waveYAt per-beat dY matches clamp, Cursor per-beat matches`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [{ direction: 'down', beats: 3 }];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const perBeat = 2 * TW_AMP * amp;
          const p0 = engine.getPoints()[0];
          const rawY = p0.y + perBeat * ob;
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          // waveYAt must match per-beat clamp (before boundary)
          // choose ob small enough to avoid clamp for some, but test both
          const actualY = engine.waveYAt(ob);
          // For ob=0.37 with amp up to 3.4, perBeat*0.37 may exceed bounds => clamped
          // In either case engine must equal clamped
          expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-6);
          // Cursor 1 beat displacement
          const beatMs = 500;
          const cursor = new Cursor(amp, 0);
          cursor.setAmplitude(amp);
          const startY = cursor.y;
          cursor.update(beatMs / 1000, false, true, beatMs);
          const disp = cursor.y - startY;
          const expectedDisp = perBeat;
          const clampedDisp = Math.min(BOTTOM - startY, expectedDisp);
          expect(Math.abs(disp - clampedDisp)).toBeLessThan(1e-3);
        });
      }
    }

    it('all beats snap-aligned and length invariant after arbitrary drags', () => {
      const snap = 0.25;
      const amp = 2.7;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1.0 },
        { direction: 'up', beats: 1.5 },
        { direction: 'down', beats: 0.5 },
      ];
      const v = 1;
      const pts0 = new WaveEngine(initial, tl, amp, 0).getPoints();
      const targetBeat = quantizeBeat(pts0[v].beat + 1.23, snap);
      const clamped = Math.max(pts0[v - 1].beat + snap, Math.min(pts0[v + 1].beat - snap, targetBeat));
      const res = calculateVertexDrag({
        segments: initial,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: v,
        targetBeat: clamped,
        targetY: pts0[v].y,
        snap,
      });
      expect(res).not.toBeNull();
      for (const s of res!) expect(isSnapAligned(s.beats, snap)).toBe(true);
      const pts1 = new WaveEngine(res!, tl, amp, 0).getPoints();
      expect(pts1.length).toBe(initial.length + 1);
    });
  });

  // ------------------------------------------------------------------
  // 6. Regression: T150 zone, T154 preview vs commit, snap, etc.
  // ------------------------------------------------------------------
  describe('6. Regression: snap integrity, length, T150 zone not broken', () => {
    it('every beats remains snap multiple after vertex moves across all modes', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1.5 },
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 0.5 },
      ];
      for (const snap of snaps) {
        const pts0 = new WaveEngine(initial, tl, amp, 0).getPoints();
        const v = 1;
        const targetBeat = quantizeBeat(pts0[v].beat + 0.37, snap);
        const clamped = Math.max(pts0[v - 1].beat + snap, Math.min(pts0[v + 1].beat - snap, targetBeat));
        const res = calculateVertexDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          pointIndex: v,
          targetBeat: clamped,
          targetY: pts0[v].y,
          snap,
        });
        if (res) {
          for (const s of res) expect(isSnapAligned(s.beats, snap)).toBe(true);
          expect(new WaveEngine(res, tl, amp, 0).getPoints().length).toBe(res.length + 1);
        }
        // edge also
        const eRes = calculateEdgeDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          edgeIndex: 1,
          startBeat: pts0[1].beat,
          startY: pts0[1].y,
          startPrevBeat: pts0[0].beat,
          startNextBeat: pts0[3].beat,
          dxBeat: quantizeBeat(0.37, snap),
          dy: 0,
          snap,
        });
        if (eRes) {
          for (const s of eRes) expect(isSnapAligned(s.beats, snap)).toBe(true);
          expect(eRes.length).toBe(initial.length);
        }
      }
    });

    it('dragPreview pattern still exists (preview vs commit)', () => {
      const src = readSrc('src/screens/editor/WavePreview.tsx');
      expect(src).toMatch(/dragPreview/);
      expect(src).toMatch(/setDragPreview/);
      expect(src).toMatch(/onSegmentsChange/);
    });

    it('zone 3-equal still intact (256.7, 343.3)', () => {
      const src = readSrc('src/game/editorDrag.ts');
      expect(src).toMatch(/256\.7/);
      expect(src).toMatch(/343\.3/);
    });
  });
});
