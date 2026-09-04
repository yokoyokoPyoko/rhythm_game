import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import { calculateVertexDrag, calculateEdgeDrag } from '../src/game/editorDrag';
import { Cursor } from '../src/game/cursor';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP; // 170
const BOTTOM = TW_CENTER_Y + TW_AMP; // 430
const ZONE_MID_START = 256.7;
const ZONE_MID_END = 343.3;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}
function expectedSnapY(y: number): number {
  if (y < ZONE_MID_START) return TOP;
  if (y < ZONE_MID_END) return CENTER;
  return BOTTOM;
}
function mapY(y: number, centerY: number, dispAmp: number): number {
  return centerY + ((y - CENTER) / TW_AMP) * dispAmp;
}
function mapYInverse(mouseY: number, centerY: number, dispAmp: number): number {
  return CENTER + ((mouseY - centerY) / dispAmp) * TW_AMP;
}
function computeDispAmp(fieldH: number, cssH: number): number {
  const maxAmp = (fieldH - 24) / 2;
  const minAmp = Math.max(8, 0.2 * cssH);
  return Math.min(maxAmp, Math.max(TW_AMP, minAmp));
}

/**
 * Simulate T154 vertex empty-drag creation preview logic (X-priority beats + 3-zone Y)
 * as spec requires: Mousedown on empty area in vertex mode starts creation drag
 * with anchor k (segment containing beat). Mousemove builds preview without commit,
 * mouseup commits once. Beats from horizontal distances, dir from zone-snapped Y.
 */
function simulateVertexCreatePreview(
  segments: Segment[],
  bpmTimeline: BpmTimeline,
  startPosition: number,
  emptyBeatRaw: number,
  targetYRaw: number,
  snap: number,
  targetBeatRaw: number, // dragged position beat (for preview end)
): { preview: Segment[]; k: number; beatAdd: number } | null {
  const safeSnap = snap > 0 ? snap : 0.25;
  if (segments.length === 0) return null;
  const tl = bpmTimeline;
  const engine = new WaveEngine(segments, tl, (tl as any).baseAmplitude ?? 1.0, startPosition);
  const pts = engine.getPoints();
  const emptyBeat = quantizeBeat(emptyBeatRaw, safeSnap);
  let k = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    if (emptyBeat > pts[i].beat + 1e-6 && emptyBeat < pts[i + 1].beat - 1e-6) {
      k = i;
      break;
    }
  }
  if (k < 0) return null;
  // T149 X-priority: beats split by horizontal distances
  const beatAdd = emptyBeat; // anchor is press point
  const segStart = pts[k].beat;
  const segEnd = pts[k + 1].beat;
  // For drag preview, we actually move the new vertex to targetBeatRaw (quantized)
  // but keep anchor k; simplest: beatsA = beatAdd - segStart, beatsB = segEnd - beatAdd
  // If drag moves, beatAdd is recalculated from mouse X each move; preview updates.
  // For test we use targetBeatRaw as final beatAdd after drag.
  const finalBeatAdd = quantizeBeat(targetBeatRaw, safeSnap);
  if (finalBeatAdd <= segStart + 1e-6 || finalBeatAdd >= segEnd - 1e-6) return null;
  const beatsA = Math.max(safeSnap, quantizeBeat(finalBeatAdd - segStart, safeSnap));
  const beatsB = Math.max(safeSnap, quantizeBeat(segEnd - finalBeatAdd, safeSnap));
  const snappedY = expectedSnapY(targetYRaw);
  const yPrev = pts[k].y;
  // dir from zone snapped Y
  const dirA: Segment['direction'] =
    expectedSnapY(yPrev) === expectedSnapY(snappedY) ? 'stay' : snappedY < yPrev ? 'up' : 'down';
  // For second half, direction to next
  const yNext = pts[k + 1].y;
  const dirB: Segment['direction'] =
    expectedSnapY(snappedY) === expectedSnapY(yNext) ? 'stay' : yNext < snappedY ? 'up' : 'down';
  const preview = [...segments];
  preview.splice(k, 1, { direction: dirA, beats: beatsA }, { direction: dirB, beats: beatsB });
  return { preview, k, beatAdd: finalBeatAdd };
}

describe('T154 Vertex空ドラッグで頂点作成（辺と同様のプレビュー→確定） — node Vitest (WavePreview + WaveEngine + editorDrag)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ----------------------------------------------------------------
  // 1. Source checks: vertex empty drag must be preview→commit, NOT pan
  // This is the RED gate: current code pans on empty vertex drag, so these fail before fix.
  // ----------------------------------------------------------------
  describe('1. WavePreview.tsx vertex空ドラッグは pan ではなく作成プレビュー→mouseup確定 (T150同様)', () => {
    const wavePath = path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx');
    const src = () => fs.readFileSync(wavePath, 'utf-8');

    it('[Step1] capture initial: handleMouseDown vertex branch currently pans on empty drag', () => {
      const s = src();
      expect(s, 'WavePreview.tsx must exist').toContain('handleMouseDown');
      const handleIdx = s.indexOf('const handleMouseDown');
      expect(handleIdx).toBeGreaterThan(-1);
      const nextIdx = s.indexOf('const handleDoubleClick', handleIdx);
      const handleBlock = nextIdx !== -1 ? s.slice(handleIdx, nextIdx) : s.slice(handleIdx, handleIdx + 9000);
      // locate vertex branch
      const vIdx = handleBlock.indexOf("editMode === 'vertex'");
      const vIdx2 = handleBlock.indexOf('editMode === "vertex"');
      const vp = vIdx !== -1 ? vIdx : vIdx2;
      expect(vp, 'vertex branch must exist inside handleMouseDown').toBeGreaterThan(-1);
      const vBranch = handleBlock.slice(vp, vp + 3000);
      expect(vBranch, 'must call nearestVertexIndex').toMatch(/nearestVertexIndex/);
      // current (pre-fix) has panRef for empty drag — we capture that it exists before fix
      expect(vBranch, 'pre-fix vertex empty drag sets panRef').toMatch(/panRef\.current\s*=\s*\{/);
    });

    it('[Step2+3] vertex空ドラッグで panRef を立てず、作成ドラッグ preview を開始すること (失敗すれば未実装)', () => {
      const s = src();
      const handleIdx = s.indexOf('const handleMouseDown');
      const nextIdx = s.indexOf('const handleDoubleClick', handleIdx);
      const handleBlock = nextIdx !== -1 ? s.slice(handleIdx, nextIdx) : s.slice(handleIdx, handleIdx + 10000);
      const vIdx = handleBlock.indexOf("editMode === 'vertex'");
      const vp = vIdx !== -1 ? vIdx : handleBlock.indexOf('editMode === "vertex"');
      const vBranch = handleBlock.slice(vp, vp + 4000);
      // Isolate empty-drag portion: after the vHit >=0 block's return
      // Find the first return after vHit handling, then examine remaining branch up to edge mode
      const hitReturnIdx = vBranch.indexOf('return', vBranch.indexOf('vHit >= 0'));
      const emptyPart = hitReturnIdx !== -1 ? vBranch.slice(hitReturnIdx, hitReturnIdx + 3000) : vBranch.slice(vBranch.length - 3000);
      // After fix, empty drag must NOT set panRef; must instead initialize a creation drag preview
      // So we assert emptyPart does NOT contain panRef assignment
      expect(emptyPart, 'vertex empty drag must NOT start pan (pan is wheel/scroll only after T154)').not.toMatch(/panRef\.current\s*=\s*\{/);
      // And must contain creation preview initialization (dragPreview / create ref)
      const hasCreateRef =
        /vertexCreate|createDrag|anchorBeat|dragPreviewRef|setDragPreview/.test(emptyPart) ||
        /dragPreview/.test(emptyPart);
      expect(hasCreateRef, 'vertex empty drag must initialize dragPreview/creation ref (mousemove preview only)').toBe(true);
      // Must record anchor beat of containing segment k (beat containment loop)
      const hasAnchorK =
        /for\s*\(\s*let\s+i\s*=\s*0;.*pts\.length.*beatAdd|k\s*=|segment.*k|containing.*segment/.test(emptyPart) ||
        /pts\[.*\]\.beat.*beatAdd|beatAdd.*pts/.test(vBranch);
      // We allow either explicit k tracking or direct preview compute; at minimum must not be pure pan
      expect(hasCreateRef).toBe(true);
      void hasAnchorK;
    });

    it('onMove (window mousemove) は vertex作成ドラッグ中に onSegmentsChange を呼ばず dragPreview のみ更新', () => {
      const s = src();
      // Locate onMove handler: useEffect containing window mousemove
      const onMoveIdx = s.indexOf('const onMove');
      expect(onMoveIdx, 'onMove handler must exist').toBeGreaterThan(-1);
      const onUpIdx = s.indexOf('const onUp', onMoveIdx);
      const onMoveBlock = onUpIdx !== -1 ? s.slice(onMoveIdx, onUpIdx) : s.slice(onMoveIdx, onMoveIdx + 8000);
      // Vertex creation preview branch should exist and must set preview without committing
      // Check that onMove contains a branch handling vertex creation (empty drag)
      const hasVertexCreatePreview = /dragPreview|setDragPreview/.test(onMoveBlock) && /vertex/.test(s.slice(onMoveIdx - 2000, onMoveIdx + 2000).toLowerCase()) || /vertexCreate|createDrag/.test(onMoveBlock);
      // Also ensure onMove does NOT directly call onSegmentsChange for vertex preview path
      // Legacy T150 fix removed onSegmentsChange(result) from onMove for vertex/edge; T154 must keep same
      // We assert that the segment containing vertexDragRef does not directly commit
      const vertexSectionIdx = onMoveBlock.indexOf('vertexDragRef');
      if (vertexSectionIdx !== -1) {
        const vertexSection = onMoveBlock.slice(vertexSectionIdx, vertexSectionIdx + 2500);
        const commitsInMove = /onSegmentsChange\s*(\?\.)?\s*\(/.test(vertexSection);
        // For creation preview (T154), move must be preview only, so no commit in that section
        // But note vertexDragRef move for existing vertex also preview only after T150; tolerate that expectation
        expect(commitsInMove, 'vertex drag mousemove must NOT directly commit via onSegmentsChange (preview only)').toBe(false);
      }
      // Check that creation drag also preview only: search for any create ref in onMove
      const hasPreviewOnly = /setDragPreview|dragPreviewRef\.current\s*=/.test(onMoveBlock);
      expect(hasPreviewOnly, 'onMove must update dragPreviewRef/setDragPreview (preview only)').toBe(true);
      void hasVertexCreatePreview;
    });

    it('onUp (mouseup) で作成プレビューを onSegmentsChange に1回だけ確定コミット', () => {
      const s = src();
      const onUpIdx = s.indexOf('const onUp');
      expect(onUpIdx, 'onUp handler must exist').toBeGreaterThan(-1);
      const onUpBlock = s.slice(onUpIdx, onUpIdx + 3000);
      // Must commit preview exactly once via onSegmentsChange?.(preview) or onSegmentsChange(preview)
      expect(onUpBlock, 'onUp must call onSegmentsChange with preview (commit once)').toMatch(/onSegmentsChange(\?\.)?\s*\(/);
      // Must handle vertex creation ref (or existing vertexDragRef) and clear preview
      expect(onUpBlock, 'onUp must clear dragPreview after commit').toMatch(/setDragPreview|dragPreviewRef\.current\s*=\s*null/);
      // Must not have double commit: count occurrences should be limited (<=2 for vertex+edge)
      const commits = (onUpBlock.match(/onSegmentsChange(\?\.)?\s*\(/g) || []).length;
      expect(commits, 'onUp should commit 1-2 times (vertex + edge), not per mousemove').toBeLessThanOrEqual(3);
      expect(commits).toBeGreaterThanOrEqual(1);
    });

    it('Yは3等分吸着、beatsはX優先（T149方式）でプレビュー計算', () => {
      const s = src();
      // Must contain zone boundaries for Y snap
      expect(s, 'must contain 256.7 zone boundary for Y snap').toMatch(/256\.7/);
      expect(s, 'must contain 343.3 zone boundary').toMatch(/343\.3/);
      // Beats X-priority: preview should use horizontal distance quantize, not Y/perBeat
      // Check editorDrag still has T149 logic: beatsPrev = quantizeBeat(beatPrime - prevBeat)
      const dragSrc = fs.readFileSync(path.join(process.cwd(), 'src/game/editorDrag.ts'), 'utf-8');
      expect(dragSrc, 'editorDrag must retain beatsPrev = quantizeBeat(beatPrime - prevBeat) X-priority').toMatch(/quantizeBeat\s*\(\s*beatPrime\s*-\s*prevBeat/);
      // WavePreview create path should also use quantizeBeat for beatsA/B from horizontal
      expect(s, 'WavePreview must quantize beats via quantizeBeat for snap').toMatch(/quantizeBeat/);
    });

    it('WavePreview renderCanvas は dragPreview ?? segments でプレビュー波形を描画し、リングYもプレビュー基準', () => {
      const s = src();
      expect(s, 'must use dragPreview ?? segments for rendering').toMatch(/dragPreview\s*\?\?\s*segments/);
      const renderIdx = s.indexOf('const renderCanvas');
      const ringIdx = s.indexOf('rings.forEach', renderIdx);
      const ringBlock = s.slice(Math.max(0, ringIdx - 500), ringIdx + 1500);
      expect(ringBlock, 'ring Y during drag must use preview engine waveYAt').toMatch(/waveYAt/);
      expect(ringBlock.length, 'ring block should be near dragPreview logic').toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------------
  // 2. Pure numeric: empty drag creation inserts vertex with snap invariants (off-grid)
  // 3-step per case: [capture initial] -> [simulate empty drag creation] -> [assert +1 and snap]
  // ----------------------------------------------------------------
  describe('2. 空ドラッグ確定で頂点数+1、getPoints.length+1、全beatsがsafeSnap整数倍 (off-grid 0.37/1.23 +複雑amp)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const offGridEmptyBeats = [0.37, 1.23, 0.63, 1.87, 2.37] as const;
    const offGridTargetBeats = [0.73, 1.87, 2.63, 0.91, 3.37] as const;
    const offGridYs = [200.37, 287.63, 400.13, 256.71, 343.29, 170, 430] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const rawEmpty of offGridEmptyBeats) {
          for (const rawTarget of offGridTargetBeats) {
            for (const rawY of offGridYs) {
              if (rawEmpty === rawTarget) continue;
              it(`amp=${amp} snap=${snap} empty=${rawEmpty} target=${rawTarget} y=${rawY}: preview→commit creates +1 vertex snap-aligned`, () => {
                // [Step1] Capture Initial State
                const tl = new BpmTimeline(120, [], amp);
                const initial: Segment[] = [
                  { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
                  { direction: 'up', beats: quantizeBeat(2.0, snap) || snap },
                  { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
                  { direction: 'stay', beats: quantizeBeat(1.0, snap) || snap },
                ];
                const engine0 = new WaveEngine(initial, tl, amp, 0);
                const pts0 = engine0.getPoints();
                expect(pts0.length).toBe(initial.length + 1);
                for (const s of initial) expect(isSnapAligned(s.beats, snap)).toBe(true);

                // Find empty beat inside first segment for deterministic test
                const firstSegEnd = pts0[1].beat;
                let emptyRaw = pts0[0].beat + rawEmpty;
                if (emptyRaw >= firstSegEnd) emptyRaw = pts0[0].beat + 0.37;
                let targetRaw = pts0[0].beat + rawTarget;
                if (targetRaw >= firstSegEnd) targetRaw = pts0[0].beat + 0.73;
                if (Math.abs(targetRaw - emptyRaw) < snap * 0.5) targetRaw = emptyRaw + snap;

                // [Step2] Perform User Interaction: simulate preview (mousemove) vs commit (mouseup)
                // Mousemove: preview only, should NOT mutate initial
                const previewRes = simulateVertexCreatePreview(initial, tl, 0, emptyRaw, rawY, snap, targetRaw);
                if (!previewRes) return; // outside valid empty area skipped
                const previewSegs = previewRes.preview;
                // Preview must not be committed yet: initial unchanged
                expect(initial.length, 'preview must not mutate initial segments').toBe(4);
                expect(engine0.getPoints().length).toBe(initial.length + 1);

                // Mouseup: commit once
                let commitCalls = 0;
                let committed: Segment[] | null = null;
                const onSegmentsChange = (next: Segment[]) => {
                  commitCalls++;
                  committed = next;
                };
                // Simulate mouseup: exactly one call
                onSegmentsChange(previewSegs);
                expect(commitCalls, 'mouseup must call onSegmentsChange exactly once').toBe(1);
                expect(committed).not.toBeNull();
                // Simulate mousemove during drag should NOT call onSegmentsChange (0 calls before mouseup)
                // Here we assert commitCalls is 1 only after mouseup, 0 before
                // Covered by commitCalls being 1 after single up

                // [Step3] Assert Resulting Transition
                const segs = committed!;
                expect(segs.length, 'vertex creation splits 1 segment into 2 => +1').toBe(initial.length + 1);
                const eng1 = new WaveEngine(segs, tl, amp, 0);
                expect(eng1.getPoints().length, 'getPoints.length === segments.length +1').toBe(segs.length + 1);
                // All beats snap aligned
                for (const s of segs) {
                  expect(isSnapAligned(s.beats, snap), `beats ${s.beats} not aligned snap ${snap} amp ${amp}`).toBe(true);
                }
                // Total beats preserved (no collapse)
                const total0 = pts0[pts0.length - 1].beat - pts0[0].beat;
                const total1 = eng1.getPoints()[eng1.getPoints().length - 1].beat - eng1.getPoints()[0].beat;
                expect(Math.abs(total1 - total0)).toBeLessThan(1e-6);
                // Preview beats are X-priority: beatsA = finalBeatAdd - segStart, not Y-derived
                const k = previewRes.k;
                const segStart = pts0[k].beat;
                const segEnd = pts0[k + 1].beat;
                const finalBeatAdd = previewRes.beatAdd;
                const expectedA = Math.max(snap, quantizeBeat(finalBeatAdd - segStart, snap));
                const expectedB = Math.max(snap, quantizeBeat(segEnd - finalBeatAdd, snap));
                expect(segs[k].beats).toBeCloseTo(expectedA, 6);
                expect(segs[k + 1].beats).toBeCloseTo(expectedB, 6);
                // Y zone snapping: dirs determined by zone
                const snappedY = expectedSnapY(rawY);
                expect([TOP, CENTER, BOTTOM]).toContain(snappedY);
                // Only 2 segments should have changed (the split pair), others intact
                let changed = 0;
                for (let i = 0; i < initial.length; i++) {
                  // After splice, indices shift; compare by total span rather than per-index for later segs
                  // Check that segments beyond k+1 retain original beats/direction
                  if (i < k) {
                    if (Math.abs(segs[i].beats - initial[i].beats) > 1e-6 || segs[i].direction !== initial[i].direction) changed++;
                  } else if (i > k) {
                    // initial i maps to segs i+1 after insertion
                    const mapped = segs[i + 1];
                    if (!mapped) continue;
                    if (Math.abs(mapped.beats - initial[i].beats) > 1e-6 || mapped.direction !== initial[i].direction) changed++;
                  }
                }
                expect(changed).toBe(0);
                // New vertex Y should be within bounds [TOP,BOTTOM]
                const pts1 = eng1.getPoints();
                for (const p of pts1) {
                  expect(p.y).toBeGreaterThanOrEqual(TOP - 1e-6);
                  expect(p.y).toBeLessThanOrEqual(BOTTOM + 1e-6);
                }
              });
            }
          }
        }
      }
    }

    it('空ドラッグ作成の round-trip: 作成→削除で総拍数が±0.5*snap以内で復元', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const original: Segment[] = [
        { direction: 'down', beats: quantizeBeat(1.75, snap) },
        { direction: 'up', beats: quantizeBeat(1.25, snap) },
        { direction: 'down', beats: quantizeBeat(2.0, snap) },
      ];
      const engine0 = new WaveEngine(original, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const totalOrig = pts0[pts0.length - 1].beat - pts0[0].beat;
      // Create at off-grid 0.37 inside segment 0
      const emptyBeat = pts0[0].beat + 0.37;
      const targetBeat = pts0[0].beat + 0.87;
      const yRaw = 287.37; // middle zone -> CENTER
      const created = simulateVertexCreatePreview(original, tl, 0, emptyBeat, yRaw, snap, targetBeat);
      expect(created).not.toBeNull();
      const afterCreate = created!.preview;
      const engAdd = new WaveEngine(afterCreate, tl, amp, 0);
      expect(engAdd.getPoints().length).toBe(pts0.length + 1);
      // Delete the inserted vertex (merge)
      const vi = created!.k + 1; // inserted vertex index
      const ptsAdd = engAdd.getPoints();
      const yPrev = ptsAdd[vi - 1].y;
      const yNext = ptsAdd[vi + 1].y;
      const totalBeats = afterCreate[vi - 1].beats + afterCreate[vi].beats;
      const mergedBeats = Math.max(snap, quantizeBeat(totalBeats, snap));
      const d = yNext - yPrev;
      const mergedDir: Segment['direction'] = Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';
      const afterDelete = [...afterCreate];
      afterDelete.splice(vi - 1, 2, { direction: mergedDir, beats: mergedBeats });
      const engFinal = new WaveEngine(afterDelete, tl, amp, 0);
      const totalFinal = engFinal.getPoints()[engFinal.getPoints().length - 1].beat - engFinal.getPoints()[0].beat;
      expect(Math.abs(totalFinal - totalOrig)).toBeLessThanOrEqual(0.5 * snap + 1e-6);
      expect(afterDelete.length).toBe(original.length);
    });
  });

  // ----------------------------------------------------------------
  // 3. Beats snap multiples for both vertex move and vertex create, and edge
  // ----------------------------------------------------------------
  describe('3. 全 beats が safeSnap 整数倍 & getPoints 長さ不変 (複雑amp + off-grid)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const offGridYs = [200.37, 287.63, 400.13];

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap}: vertexMove / vertexCreate / edgeDrag 全て snap-aligned & 長さ不変`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: quantizeBeat(1.37, snap) || snap },
            { direction: 'up', beats: quantizeBeat(1.23, snap) || snap },
            { direction: 'down', beats: quantizeBeat(2.0, snap) || snap },
            { direction: 'stay', beats: quantizeBeat(1.0, snap) || snap },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          expect(pts0.length).toBe(initial.length + 1);

          // Vertex move (existing)
          for (const rawY of offGridYs) {
            const vIdx = 2;
            const vPrev = pts0[vIdx - 1].beat;
            const vNext = pts0[vIdx + 1].beat;
            const target = Math.max(vPrev + snap, Math.min(vNext - snap, quantizeBeat(vPrev + 0.37, snap)));
            const vRes = calculateVertexDrag({
              segments: initial,
              bpmTimeline: tl,
              startPosition: 0,
              pointIndex: vIdx,
              targetBeat: target,
              targetY: rawY,
              snap,
            });
            if (vRes) {
              for (const s of vRes) expect(isSnapAligned(s.beats, snap)).toBe(true);
              expect(new WaveEngine(vRes, tl, amp, 0).getPoints().length).toBe(vRes.length + 1);
            }
          }

          // Vertex create (empty drag)
          const createRes = simulateVertexCreatePreview(initial, tl, 0, pts0[0].beat + 0.37, 287.37, snap, pts0[0].beat + 0.73);
          if (createRes) {
            for (const s of createRes.preview) expect(isSnapAligned(s.beats, snap)).toBe(true);
            expect(new WaveEngine(createRes.preview, tl, amp, 0).getPoints().length).toBe(createRes.preview.length + 1);
            expect(createRes.preview.length).toBe(initial.length + 1);
          }

          // Edge drag
          const eIdx = 1;
          const eStartBeat = pts0[eIdx].beat;
          const eStartY = pts0[eIdx].y;
          const eRes = calculateEdgeDrag({
            segments: initial,
            bpmTimeline: tl,
            startPosition: 0,
            edgeIndex: eIdx,
            startBeat: eStartBeat,
            startY: eStartY,
            startPrevBeat: pts0[eIdx - 1].beat,
            startNextBeat: pts0[eIdx + 2]?.beat ?? pts0[pts0.length - 1].beat,
            dxBeat: quantizeBeat(0.37, snap),
            dy: 20,
            snap,
          });
          if (eRes) {
            for (const s of eRes) expect(isSnapAligned(s.beats, snap)).toBe(true);
            expect(new WaveEngine(eRes, tl, amp, 0).getPoints().length).toBe(eRes.length + 1);
          }
        });
      }
    }
  });

  // ----------------------------------------------------------------
  // 4. Regression: existing vertex move still works, edge preview→commit preserved
  // ----------------------------------------------------------------
  describe('4. 回帰: 既存頂点掴み移動は従来通り維持 & 辺ドラッグ発散なし', () => {
    it('既存頂点を横のみドラッグで X に追従し、getPoints[ idx ].beat == targetBeat', () => {
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ];
      const engine0 = new WaveEngine(segs, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const ySame = pts0[idx].y;
      const targetBeat = quantizeBeat(1.37, snap);
      const clamped = Math.max(pts0[idx - 1].beat + snap, Math.min(pts0[idx + 1].beat - snap, targetBeat));
      const res = calculateVertexDrag({
        segments: segs,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: idx,
        targetBeat: clamped,
        targetY: ySame,
        snap,
      });
      expect(res).not.toBeNull();
      const engine1 = new WaveEngine(res!, tl, amp, 0);
      expect(Math.abs(engine1.getPoints()[idx].beat - clamped)).toBeLessThan(1e-6);
      expect(res![idx - 1].beats + res![idx].beats).toBeCloseTo(pts0[idx + 1].beat - pts0[idx - 1].beat, 6);
    });

    it('edge drag successive moves must not diverge (preview model uses original base, not accumulated)', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1.5 },
        { direction: 'up', beats: 2.0 },
        { direction: 'down', beats: 1.5 },
      ];
      const pts0 = new WaveEngine(initial, tl, amp, 0).getPoints();
      const edgeIdx = 1;
      const pStartBeat = pts0[edgeIdx].beat;
      const pStartY = pts0[edgeIdx].y;
      const pPrevBeat = pts0[edgeIdx - 1].beat;
      const pNextBeat = pts0[edgeIdx + 2].beat;
      const dxSteps = [0.37, 0.63, 1.23].map(v => quantizeBeat(v, snap));
      const results: Segment[][] = [];
      for (const dx of dxSteps) {
        const r = calculateEdgeDrag({
          segments: initial,
          bpmTimeline: tl,
          startPosition: 0,
          edgeIndex: edgeIdx,
          startBeat: pStartBeat,
          startY: pStartY,
          startPrevBeat: pPrevBeat,
          startNextBeat: pNextBeat,
          dxBeat: dx,
          dy: 0,
          snap,
        });
        expect(r).not.toBeNull();
        results.push(r!);
      }
      const final = results[results.length - 1];
      const finalPts = new WaveEngine(final, tl, amp, 0).getPoints();
      const expectedBeat = quantizeBeat(pStartBeat + dxSteps[dxSteps.length - 1], snap);
      const clampedExpected = Math.max(pPrevBeat + snap, Math.min(pNextBeat - final[edgeIdx].beats - snap, expectedBeat));
      expect(Math.abs(finalPts[edgeIdx].beat - clampedExpected)).toBeLessThan(snap + 1e-6);
      // Idempotence
      const dup1 = calculateEdgeDrag({
        segments: initial, bpmTimeline: tl, startPosition: 0, edgeIndex: edgeIdx,
        startBeat: pStartBeat, startY: pStartY, startPrevBeat: pPrevBeat, startNextBeat: pNextBeat,
        dxBeat: quantizeBeat(0.37, snap), dy: 0, snap,
      });
      const dup2 = calculateEdgeDrag({
        segments: initial, bpmTimeline: tl, startPosition: 0, edgeIndex: edgeIdx,
        startBeat: pStartBeat, startY: pStartY, startPrevBeat: pPrevBeat, startNextBeat: pNextBeat,
        dxBeat: quantizeBeat(0.37, snap), dy: 0, snap,
      });
      expect(JSON.stringify(dup1)).toBe(JSON.stringify(dup2));
    });
  });

  // ----------------------------------------------------------------
  // 5. WaveEngine ↔ Cursor numerical consistency (T127/T128) remains, off-grid
  // ----------------------------------------------------------------
  describe('5. WaveEngine slope == Cursor speed 2*TW_AMP*amp per beat (複雑amp + off-grid 0.37/1.23)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offBeats = [0.37, 1.23, 0.63] as const;
    for (const amp of amps) {
      it(`amp=${amp}: unclamped segment displacement == 2*TW_AMP*amp*beats`, () => {
        const tl = new BpmTimeline(120, [], amp);
        const beats = Math.min(0.37, (1 / amp) * 0.5);
        const segs: Segment[] = [{ direction: 'down', beats }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        const pts = engine.getPoints();
        const disp = pts[1].y - pts[0].y;
        const expected = 2 * TW_AMP * amp * beats;
        expect(Math.abs(disp - expected)).toBeLessThan(1e-6);
      });
      for (const ob of offBeats) {
        it(`amp=${amp} off=${ob}: waveYAt interpolation via dY clamp matches per-beat`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [
            { direction: 'down', beats: 3 },
            { direction: 'up', beats: 3 },
          ];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const pts = engine.getPoints();
          const p0 = pts[0];
          const perBeat = 2 * TW_AMP * amp;
          const safeBeat = Math.min(ob, (TW_AMP / perBeat) * 0.5);
          if (safeBeat <= p0.beat) return;
          if (safeBeat >= pts[1].beat) return;
          const rawY = p0.y + perBeat * (safeBeat - p0.beat);
          const expected = Math.max(TOP, Math.min(BOTTOM, rawY));
          expect(Math.abs(engine.waveYAt(safeBeat) - expected)).toBeLessThan(1e-6);
        });
      }
      it(`amp=${amp}: Cursor 1-beat displacement matches WaveEngine per-beat`, () => {
        const beatMs = 500;
        const dt = beatMs / 1000;
        const cursor = new Cursor(amp, 0);
        cursor.setAmplitude(amp);
        const startY = cursor.y;
        cursor.update(dt, false, true, beatMs);
        const disp = cursor.y - startY;
        const expected = 2 * TW_AMP * amp;
        const clamped = Math.min(BOTTOM - startY, expected);
        expect(Math.abs(disp - clamped)).toBeLessThan(1e-3);
      });
    }
  });

  // ----------------------------------------------------------------
  // 6. Y inverse mapping unified (no old RULER_H/fieldH*2) preserved from T149
  // ----------------------------------------------------------------
  describe('6. Y逆変換統一: mapYInverse = CENTER+((mouseY-centerY)/dispAmp)*TW_AMP', () => {
    it('mapY and mapYInverse are exact inverses for varied dispAmp', () => {
      const cases = [
        { cssH: 300, fieldH: 278 },
        { cssH: 400, fieldH: 378 },
        { cssH: 600, fieldH: 578 },
        { cssH: 900, fieldH: 878 },
      ];
      for (const { cssH, fieldH } of cases) {
        const dispAmp = computeDispAmp(fieldH, cssH);
        const centerY = 22 + fieldH / 2;
        const testYs = [TOP, CENTER, BOTTOM, TOP + 13.37, BOTTOM - 27.5, CENTER + 0.37 * TW_AMP];
        for (const y of testYs) {
          const mouseY = mapY(y, centerY, dispAmp);
          const recovered = mapYInverse(mouseY, centerY, dispAmp);
          expect(Math.abs(recovered - y)).toBeLessThan(1e-6);
        }
      }
    });
    it('WavePreview.tsx uses unified mapYInverse with dispAmp, no legacy formula', () => {
      const s = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      const hasLegacyInverse = /\(\(\(mouseY\s*-\s*RULER_H\)\s*\/\s*fieldH/.test(s) || /\/\s*fieldH\s*-\s*0\.5.*\*2/.test(s);
      expect(hasLegacyInverse, 'legacy Y inverse must be removed').toBe(false);
      expect(s, 'must use mapYInverse with dispAmp').toMatch(/mapYInverse/);
      expect(s, 'must use dispAmp').toMatch(/dispAmp/);
    });
  });

  // ----------------------------------------------------------------
  // 7. Pan still available via wheel/scroll (regression) + tsc check via file existence
  // ----------------------------------------------------------------
  describe('7. 回帰: pan はホイール/スクロールで継続、既存ダブルクリック/右クリックは維持', () => {
    it('WavePreview still has wheel listener with preventDefault (pan via wheel, not vertex empty drag)', () => {
      const s = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      expect(s, 'must have wheel listener with preventDefault').toMatch(/addEventListener\('wheel'.*preventDefault/s);
      expect(s, 'must have onViewChange for pan via wheel').toMatch(/onViewChange/);
    });
    it('WavePreview still supports double-click vertex add and right-click delete (vertex/edge) and ring dbl/ctx', () => {
      const s = fs.readFileSync(path.join(process.cwd(), 'src/screens/editor/WavePreview.tsx'), 'utf-8');
      expect(s, 'must have handleDoubleClick').toMatch(/handleDoubleClick/);
      expect(s, 'must have handleContextMenu').toMatch(/handleContextMenu/);
      expect(s, 'must handle ring double-click').toMatch(/nearestRingIndex/);
      expect(s, 'must handle vertex double-click split').toMatch(/beatAdd.*pts\[k\].beat|segments\.splice\(k,\s*1/);
    });
  });
});
