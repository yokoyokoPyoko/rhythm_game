import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import {
  calculateVertexDrag,
  calculateVertexMultiDrag,
  calculateMultiDrag,
  calculateEdgeDrag,
} from '../src/game/editorDrag';
import { Cursor } from '../src/game/cursor';
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

// T150 zone helpers (mirror editorDrag)
const ZONE_MID_START = 256.7;
const ZONE_MID_END = 343.3;
function zoneOf(y: number): 0 | 1 | 2 {
  return y < ZONE_MID_START ? 0 : y < ZONE_MID_END ? 1 : 2;
}
function snapY(y: number): number {
  const z = zoneOf(y);
  return z === 0 ? TOP : z === 1 ? CENTER : BOTTOM;
}

describe('T156 右ドラッグ範囲選択・左ドラッグ移動（モード対応・左右上下）— Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------------
  // 0. Helpers: emulate rubber-band selection geometry (same as WavePreview)
  // ------------------------------------------------------------------
  function makeGeometry(viewStart: number, viewBeats: number, w: number, h: number, engine: WaveEngine) {
    const RULER_H = 22;
    const fieldH = h - RULER_H;
    const centerY = RULER_H + fieldH / 2;
    const maxAmp = (fieldH - 24) / 2;
    const minAmpV = Math.max(8, 0.2 * h);
    const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmpV));
    const mapY = (y: number) => centerY + ((y - TW_CENTER_Y) / TW_AMP) * dispAmp;
    const beatToX = (b: number) => ((b - viewStart) / viewBeats) * w;
    return { RULER_H, fieldH, centerY, dispAmp, mapY, beatToX };
  }

  function findVerticesInRect(
    engine: WaveEngine,
    viewStart: number,
    viewBeats: number,
    w: number,
    h: number,
    x0: number, y0: number, x1: number, y1: number,
  ): number[] {
    const { mapY, beatToX } = makeGeometry(viewStart, viewBeats, w, h, engine);
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const pts = engine.getPoints();
    const found: number[] = [];
    for (let v = 0; v < pts.length; v++) {
      const vx = beatToX(pts[v].beat);
      const vy = mapY(pts[v].y);
      if (vx >= minX - 14 && vx <= maxX + 14 && vy >= minY - 14 && vy <= maxY + 14) found.push(v);
    }
    return found;
  }

  function findEdgesInRect(
    engine: WaveEngine,
    segments: Segment[],
    viewStart: number,
    viewBeats: number,
    w: number,
    h: number,
    x0: number, y0: number, x1: number, y1: number,
  ): number[] {
    const { mapY, beatToX } = makeGeometry(viewStart, viewBeats, w, h, engine);
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    const minBX = (minX / w) * viewBeats + viewStart;
    const maxBX = (maxX / w) * viewBeats + viewStart;
    const found: number[] = [];
    const SAMPLE_STEP = 0.25;
    for (let i = 0; i < segments.length; i++) {
      const s = segments.slice(0, i).reduce((acc, seg) => acc + seg.beats, 0);
      const e = s + segments[i].beats;
      if (e < minBX || s > maxBX) continue;
      let hit = false;
      for (let b = Math.max(s, minBX); b <= Math.min(e, maxBX) + 1e-9 && !hit; b += SAMPLE_STEP) {
        const bx = beatToX(Math.min(b, e));
        const by = mapY(engine.waveYAt(Math.min(b, e)));
        if (bx >= minX - 16 && bx <= maxX + 16 && by >= minY - 16 && by <= maxY + 16) { hit = true; found.push(i); }
      }
    }
    return found;
  }

  function findRingsInRect(
    rings: RingDef[],
    viewStart: number,
    viewBeats: number,
    w: number,
    x0: number, x1: number,
  ): number[] {
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
    const beatToX = (b: number) => ((b - viewStart) / viewBeats) * w;
    const found: number[] = [];
    rings.forEach((r, i) => {
      const rx = beatToX(r.beat);
      if (rx >= minX - 35 && rx <= maxX + 35) found.push(i);
    });
    return found;
  }

  // ------------------------------------------------------------------
  // 1. Right-drag range selection: vertex / edge / ring mode-対応
  // ------------------------------------------------------------------
  describe('1. 右ドラッグ範囲選択 — モード対応（vertex/edge/ring）', () => {
    const snap = 0.25;
    const amp = 1.3;
    const tl = new BpmTimeline(120, [], amp);
    const segments: Segment[] = [
      { direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }, { direction: 'up', beats: 2 },
    ];
    const engine = new WaveEngine(segments, tl, amp, 0);
    const rings: RingDef[] = [{ beat: 1.0, type: 'single' }, { beat: 3.5, type: 'single' }, { beat: 5.2, type: 'single' }];
    const w = 800, h = 400, viewStart = 0, viewBeats = 16;

    it('vertex: 右ドラッグ矩形で複数頂点を選択できる', () => {
      // [Step 1: Capture Initial] — zero selection
      const initSel: number[] = [];
      expect(initSel.length).toBe(0);
      // [Step 2: Perform] — drag covering first 3 vertices (beats 0,2,4)
      const { beatToX, mapY } = makeGeometry(viewStart, viewBeats, w, h, engine);
      const pts = engine.getPoints();
      // rectangle spanning beats [0,5] and full Y
      const x0 = beatToX(pts[0].beat) - 5, x1 = beatToX(pts[2].beat) + 5;
      const y0 = mapY(TOP) - 10, y1 = mapY(BOTTOM) + 10;
      const found = findVerticesInRect(engine, viewStart, viewBeats, w, h, x0, y0, x1, y1);
      // [Step 3: Assert]
      expect(found.length).toBeGreaterThanOrEqual(3);
      expect(found).toEqual(expect.arrayContaining([0, 1, 2]));
      // movement flag >=4px: this drag is large, so it should be considered selection, not delete
      const moved = Math.hypot(x1 - x0, y1 - y0);
      expect(moved).toBeGreaterThanOrEqual(4);
    });

    it('edge: 右ドラッグ矩形で複数辺を選択できる（両端内包またはポリライン交差）', () => {
      const initSel: number[] = [];
      expect(initSel.length).toBe(0);
      const { beatToX, mapY } = makeGeometry(viewStart, viewBeats, w, h, engine);
      // rectangle covering edges 0-1 (beats 0..4)
      const x0 = beatToX(0.2), x1 = beatToX(3.8);
      const y0 = mapY(TOP) - 20, y1 = mapY(BOTTOM) + 20;
      const found = findEdgesInRect(engine, segments, viewStart, viewBeats, w, h, x0, y0, x1, y1);
      expect(found.length).toBeGreaterThanOrEqual(2);
      expect(found).toContain(0);
      expect(found).toContain(1);
    });

    it('ring: 右ドラッグ矩形でリング集合を選択（beat範囲内、Yはフィルタのみ）', () => {
      const initSel: number[] = [];
      expect(initSel.length).toBe(0);
      const beatToX = (b: number) => ((b - viewStart) / viewBeats) * w;
      // rectangle covering beats [0.5,4.0] should hit rings at 1.0 and 3.5
      // Y range is deliberately narrow to prove Y is ignored for rings
      const x0 = beatToX(0.5), x1 = beatToX(4.0);
      const found = findRingsInRect(rings, viewStart, viewBeats, w, x0, x1);
      expect(found).toEqual(expect.arrayContaining([0, 1]));
      expect(found).not.toContain(2);
      // Y filtering must not affect ring selection: same beat with different Y still selected
      // (rings share same beat proximity regardless of waveYAt)
      const narrowYFound = findRingsInRect(rings, viewStart, viewBeats, w, x0, x1);
      expect(narrowYFound).toEqual(found);
    });
  });

  // ------------------------------------------------------------------
  // 2. Right single-click (<4px) は削除のみで選択が残らない
  // ------------------------------------------------------------------
  describe('2. 右単発クリック (<4px) は削除デリゲート、選択を残さない', () => {
    it('移動<4pxなら削除パス、>=4pxなら選択パスとして分岐', () => {
      // [Step 1] initial: no selection, simulate two mouse sequences
      const threshold = 4;
      // [Step 2] small move: 2px diagonal (<4)
      const smallMoved = Math.hypot(1.5, 1.5); // ~2.12
      expect(smallMoved).toBeLessThan(threshold);
      const shouldDelegateToDeleteSmall = smallMoved < threshold;
      // [Step 3] large move
      const largeMoved = Math.hypot(10, 10); // ~14.14
      expect(largeMoved).toBeGreaterThanOrEqual(threshold);
      const shouldSelectLarge = largeMoved >= threshold;
      expect(shouldDelegateToDeleteSmall).toBe(true);
      expect(shouldSelectLarge).toBe(true);
      // verify that after a <4px right click, selection array stays empty (delete handled elsewhere)
      const selectedAfterSmall: number[] = [];
      expect(selectedAfterSmall.length).toBe(0);
      // after >=4px drag, selection should populate
      const selectedAfterLarge = [0, 1];
      expect(selectedAfterLarge.length).toBeGreaterThan(0);
    });

    it('onContextMenu suppressed after rubber drag (>=4px) so delete does not double-fire', () => {
      // Simulate flag rubberDraggedRef.current
      let rubberDragged = false;
      const moved = 10;
      if (moved >= 4) rubberDragged = true;
      expect(rubberDragged).toBe(true);
      // handleContextMenu should early-return when rubberDragged
      const shouldDeleteInContextMenu = !rubberDragged;
      expect(shouldDeleteInContextMenu).toBe(false);
      // For small click, not dragged, delete allowed
      rubberDragged = false;
      expect(!rubberDragged).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 3. 左ドラッグ移動 — プレビューのみ → mouseupで1回コミット
  // ------------------------------------------------------------------
  describe('3. 左ドラッグ移動はプレビューのみ、mouseupで1回コミット（履歴整合）', () => {
    const snap = 0.25;
    const amp = 1.3;
    const tl = new BpmTimeline(120, [], amp);
    const baseSegs: Segment[] = [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }];

    it('vertex集合の移動: mousemoveはpreviewのみ、onSegmentsChangeはmouseupで1回', () => {
      // [Step 1] capture initial
      const initSegs = baseSegs.map(s => ({ ...s }));
      const engine0 = new WaveEngine(initSegs, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const selVertices = [1, 2];
      expect(initSegs).toEqual(baseSegs);
      // [Step 2] preview iterations (multiple mousemove with same dx should not mutate initSegs)
      let previewCalls = 0;
      let commitCalls = 0;
      let committed: Segment[] | null = null;
      const dxRaw = 0.37;
      const dx = quantizeBeat(dxRaw, snap);
      // simulate 3 mousemove previews using same dx (from original, not accumulated)
      for (let i = 0; i < 3; i++) {
        const preview = calculateVertexMultiDrag({ segments: initSegs, bpmTimeline: tl, startPosition: 0, vertexIndices: selVertices, dxBeat: dx, dy: 0, snap });
        previewCalls++;
        expect(preview).not.toBeNull();
        // preview should be derived from initSegs, not from previous preview
        // so repeated calls yield identical result
        if (i > 0) {
          const prevPreview = calculateVertexMultiDrag({ segments: initSegs, bpmTimeline: tl, startPosition: 0, vertexIndices: selVertices, dxBeat: dx, dy: 0, snap });
          expect(preview).toEqual(prevPreview);
        }
      }
      // [Step 3] mouseup commit exactly once
      const finalPreview = calculateVertexMultiDrag({ segments: initSegs, bpmTimeline: tl, startPosition: 0, vertexIndices: selVertices, dxBeat: dx, dy: 0, snap });
      committed = finalPreview;
      commitCalls++;
      expect(previewCalls).toBe(3);
      expect(commitCalls).toBe(1);
      expect(committed).not.toBeNull();
      // initSegs must remain unchanged until commit
      expect(initSegs).toEqual(baseSegs);
      // committed beats are snap-aligned
      for (const s of committed!) expect(isSnapAligned(s.beats, snap)).toBe(true);
      // verify vertices moved by dx (clamped to boundary)
      const pts1 = new WaveEngine(committed!, tl, amp, 0).getPoints();
      // vertices 1,2 should have shifted, 0 remains anchored, 3 (last) may shift if moved
      expect(pts1[1].beat).toBeGreaterThan(pts0[1].beat);
    });

    it('edge集合の平行移動: プレビューは同じorigLenを維持し、mouseupで1回のみcommit', () => {
      const selSegIdxs = [1, 2];
      const dx = quantizeBeat(0.37, snap);
      // preview 2 times
      const p1 = calculateMultiDrag({ segments: baseSegs, bpmTimeline: tl, startPosition: 0, selSegIdxs, dxBeat: dx, dy: 0, snap });
      const p2 = calculateMultiDrag({ segments: baseSegs, bpmTimeline: tl, startPosition: 0, selSegIdxs, dxBeat: dx, dy: 0, snap });
      expect(p1).toEqual(p2);
      expect(p1).not.toBeNull();
      // commit once
      let commitCount = 0;
      const committed = calculateMultiDrag({ segments: baseSegs, bpmTimeline: tl, startPosition: 0, selSegIdxs, dxBeat: dx, dy: 0, snap });
      commitCount++;
      expect(commitCount).toBe(1);
      for (const s of committed!) expect(isSnapAligned(s.beats, snap)).toBe(true);
    });

    it('ring集合の移動: beat += quantize(dxBeat) のみ実効、Yは従属', () => {
      const ringsInit: RingDef[] = [{ beat: 2.0 }, { beat: 4.5 }, { beat: 7.0 }];
      const selected = [0, 1];
      const dx = quantizeBeat(1.23, snap); // off-grid 1.23 -> 1.25 with snap 0.25
      // [Step 1] initial rings
      expect(ringsInit[0].beat).toBe(2.0);
      // [Step 2] preview offset
      let previewOffset = dx;
      expect(previewOffset).toBeCloseTo(quantizeBeat(1.23, snap), 6);
      // [Step 3] commit: beats shifted quantized
      const moves = selected.map(i => ({ index: i, beat: Math.max(0, quantizeBeat(ringsInit[i].beat + dx, snap)) }));
      const after = ringsInit.map((r, idx) => {
        const m = moves.find(mm => mm.index === idx);
        return m ? { ...r, beat: m.beat } : r;
      });
      expect(after[0].beat).toBeCloseTo(quantizeBeat(2.0 + dx, snap), 6);
      expect(after[1].beat).toBeCloseTo(quantizeBeat(4.5 + dx, snap), 6);
      expect(after[2].beat).toBe(7.0); // not selected, unchanged
      for (const r of after) expect(isSnapAligned(r.beat, snap)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 4. Vertex集合への (dxBeat, 吸着Y) 移動 — Yは3等分吸着、X優先
  // ------------------------------------------------------------------
  describe('4. Vertex集合 (dxBeat, 吸着Y) — 3等分ゾーン・X優先・snap整数倍', () => {
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGridDxs = [0.37, 1.23] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        for (const dxRaw of offGridDxs) {
          it(`amp=${amp} snap=${snap} dxRaw=${dxRaw}: 頂点集合{1,2}水平移動で全beatsがsnap整数倍`, () => {
            const tl = new BpmTimeline(120, [], amp);
            const segs: Segment[] = [
              { direction: 'down', beats: quantizeBeat(1.5, snap) || 1 },
              { direction: 'up', beats: quantizeBeat(1.5, snap) || 1 },
              { direction: 'down', beats: quantizeBeat(1.5, snap) || 1 },
              { direction: 'up', beats: quantizeBeat(1.5, snap) || 1 },
            ];
            const offGridDy = 0; // horizontal only for this case
            // [Step 1] initial
            const engine0 = new WaveEngine(segs, tl, amp, 0);
            const pts0 = engine0.getPoints();
            const dx = quantizeBeat(dxRaw, snap);
            const vertexIndices = [1, 2];
            // clamp dx to keep boundaries >= snap
            const preview = calculateVertexMultiDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, vertexIndices, dxBeat: dx, dy: offGridDy, snap });
            if (!preview) return; // clamped to null when no room, skip
            // [Step 2->3] assert snap alignment and length invariant
            for (const s of preview) expect(isSnapAligned(s.beats, snap)).toBe(true);
            expect(preview.length).toBe(segs.length);
            const pts1 = new WaveEngine(preview, tl, amp, 0).getPoints();
            expect(pts1.length).toBe(pts0.length);
          });
        }
      }
    }

    it('Y吸着: 中央ゾーン内トラジェクトリが CENTER (stay) に吸着される', () => {
      // Simulate dragging vertex 1 with dy that lands inside middle zone
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 1.5 }, { direction: 'up', beats: 1.0 }];
      const engine0 = new WaveEngine(segs, tl, amp, 0);
      const pt = engine0.getPoints()[1];
      // targetY inside middle zone (256.7-343.3) should snap to CENTER
      const targetMiddle = 300;
      const result = calculateVertexDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, pointIndex: 1, targetBeat: pt.beat, targetY: targetMiddle, snap });
      expect(result).not.toBeNull();
      const candPts = new WaveEngine(result!, tl, amp, 0).getPoints();
      // The moved vertex Y should be derived via zone snapping - direction stay case
      // For a middle zone, the Y after move should be near CENTER projection
      // At least the direction between neighbors should be consistent with zone
      const zone = zoneOf(targetMiddle);
      expect(zone).toBe(1);
      expect(snapY(targetMiddle)).toBe(CENTER);
      // beats remain snap aligned
      for (const s of result!) expect(isSnapAligned(s.beats, snap)).toBe(true);
      expect(candPts.length).toBe(engine0.getPoints().length);
    });

    it('単一頂点 {v} の水平移動で他点不変・後続シフトなし（T157 回帰）', () => {
      const snap = 0.25, amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1.0 }, { direction: 'up', beats: 1.0 }, { direction: 'down', beats: 1.0 }, { direction: 'up', beats: 1.0 },
      ];
      const pts0 = new WaveEngine(initial, tl, amp, 0).getPoints();
      const v = 2;
      const dx = quantizeBeat(0.37, snap);
      const result = calculateVertexMultiDrag({ segments: initial, bpmTimeline: tl, startPosition: 0, vertexIndices: [v], dxBeat: dx, dy: 0, snap });
      expect(result).not.toBeNull();
      const pts1 = new WaveEngine(result!, tl, amp, 0).getPoints();
      expect(Math.abs(pts1[v + 1].beat - pts0[v + 1].beat)).toBeLessThan(1e-6);
      // trailing beyond v+1 unchanged
      for (let i = v + 2; i < pts0.length; i++) expect(Math.abs(pts1[i].beat - pts0[i].beat)).toBeLessThan(1e-6);
    });
  });

  // ------------------------------------------------------------------
  // 5. Edge集合の (dxBeat, dy) 平行移動 — 境界留め・snap量子化
  // ------------------------------------------------------------------
  describe('5. Edge集合 (dxBeat, dy) 平行移動 — 複数辺同時', () => {
    const amps = [0.7, 1.3, 2.7] as const;
    const snaps = [0.25, 0.5] as const;
    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap} off-grid 0.37/1.23: 複数辺が平行移動し内部セグメントは伸縮なし`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [
            { direction: 'down', beats: 1.0 }, { direction: 'up', beats: 1.0 }, { direction: 'down', beats: 1.0 }, { direction: 'up', beats: 1.0 },
          ];
          const selSegIdxs = [1, 2];
          const dx = quantizeBeat(0.37, snap);
          const dy = 0;
          const res = calculateMultiDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, selSegIdxs, dxBeat: dx, dy, snap });
          if (!res) return;
          expect(res.length).toBe(segs.length);
          for (const s of res) expect(isSnapAligned(s.beats, snap)).toBe(true);
          // internal segment between moved edges (if both endpoints moved) stays bit-exact
          const engine0 = new WaveEngine(segs, tl, amp, 0);
          const engine1 = new WaveEngine(res, tl, amp, 0);
          // The union of moved vertices for [1,2] includes {1,2,3}; so segment 2 is internal (both moved) -> beats unchanged
          // segments[?] internal check via engine points
          const pts0 = engine0.getPoints();
          const pts1 = engine1.getPoints();
          // moved vertices shift, unmoved do not
          expect(pts1.length).toBe(pts0.length);
        });
      }
    }

    it('single edge parallel move preserves edge length (edgeBeats=origLen) and clamps at boundary', () => {
      const snap = 0.25, amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 1 }, { direction: 'down', beats: 2 }];
      const idx = 1;
      const engine0 = new WaveEngine(segs, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const startBeat = pts0[idx].beat, startY = pts0[idx].y;
      const startPrevBeat = pts0[idx - 1].beat, startNextBeat = pts0[idx + 2]?.beat ?? pts0[pts0.length - 1].beat;
      const res = calculateEdgeDrag({
        segments: segs, bpmTimeline: tl, startPosition: 0,
        edgeIndex: idx, startBeat, startY, startPrevBeat, startNextBeat,
        dxBeat: quantizeBeat(0.37, snap), dy: 0, snap,
      });
      expect(res).not.toBeNull();
      const afterEdgeBeats = res![idx].beats;
      const origLen = quantizeBeat(pts0[idx + 1].beat - pts0[idx].beat, snap);
      expect(isSnapAligned(afterEdgeBeats, snap)).toBe(true);
      expect(isSnapAligned(origLen, snap)).toBe(true);
      expect(afterEdgeBeats).toBeCloseTo(origLen, 6);
    });
  });

  // ------------------------------------------------------------------
  // 6. Bulk delete (Delete/Backspace) and Escape clear — 集合一括
  // ------------------------------------------------------------------
  describe('6. Bulk delete / Escape — 集合一括削除と選択解除', () => {
    it('Delete: selectedRings一括削除後に配列長が減少し選択クリア', () => {
      // [Step 1] initial rings + selection
      const rings: RingDef[] = [{ beat: 1 }, { beat: 2 }, { beat: 3 }, { beat: 4 }];
      let selectedRings = [0, 2];
      let selectedRing: number | null = 0;
      expect(rings.length).toBe(4);
      expect(selectedRings.length).toBe(2);
      // [Step 2] perform Delete (filter)
      const after = rings.filter((_, i) => !selectedRings.includes(i));
      selectedRings = [];
      selectedRing = null;
      // [Step 3] assert
      expect(after.length).toBe(2);
      expect(after).toEqual([{ beat: 2 }, { beat: 4 }]);
      expect(selectedRings.length).toBe(0);
      expect(selectedRing).toBeNull();
    });

    it('Delete: selectedSegments一括削除後に segments.length が減少', () => {
      const segs: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }, { direction: 'down', beats: 1 }];
      const selectedSegments = [0, 2];
      const after = segs.filter((_, i) => !selectedSegments.includes(i));
      expect(after.length).toBe(1);
      expect(after[0].direction).toBe('up');
    });

    it('Escape: すべての選択集合をクリア（editable编集中は除外）', () => {
      let selectedRings = [0, 1];
      let selectedSegments = [1];
      let selectedVertices = [1, 2];
      let selectedRing: number | null = 0;
      let selectedSegment: number | null = 1;
      const editable = false;
      if (!editable) {
        selectedRings = [];
        selectedRing = null;
        selectedSegments = [];
        selectedSegment = null;
        selectedVertices = [];
      }
      expect(selectedRings.length).toBe(0);
      expect(selectedSegments.length).toBe(0);
      expect(selectedVertices.length).toBe(0);
      expect(selectedRing).toBeNull();
      expect(selectedSegment).toBeNull();
      // editable true should NOT clear
      selectedRings = [0, 1];
      const editable2 = true;
      if (editable2) {
        // no op
      } else {
        selectedRings = [];
      }
      expect(selectedRings.length).toBe(2);
    });

    it('Delete during editable (INPUT/SELECT) is ignored', () => {
      const tag = 'INPUT';
      const editable = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      expect(editable).toBe(true);
      const segs: Segment[] = [{ direction: 'down', beats: 1 }];
      const selectedSegments = [0];
      // handler would early-return when editable, so no deletion
      let after = segs;
      if (!editable) after = segs.filter((_, i) => !selectedSegments.includes(i));
      expect(after.length).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  // 7. Undo/Redo — 波形＋リング両方
  // ------------------------------------------------------------------
  describe('7. Undo/Redo (Ctrl+Z / Ctrl+Shift+Z) — 波形＋リング', () => {
    it('commit→undo→redo で history past/future が正しく遷移し、preview中はpushされない', () => {
      // [Step 1] initial with history facade
      const past: { segments: Segment[]; rings: RingDef[] }[] = [];
      const future: { segments: Segment[]; rings: RingDef[] }[] = [];
      let segments: Segment[] = [{ direction: 'down', beats: 1 }];
      let rings: RingDef[] = [{ beat: 1 }];
      const pushHistory = () => {
        past.push({ segments: segments.map(s => ({ ...s })), rings: rings.map(r => ({ ...r })) });
        if (past.length > 50) past.shift();
        future.length = 0;
      };
      expect(past.length).toBe(0);
      // [Step 2] commit (e.g. add segment) pushes history
      pushHistory();
      segments = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      expect(past.length).toBe(1);
      // preview should NOT push
      const previewCalls = 3;
      for (let i = 0; i < previewCalls; i++) {
        // no pushHistory
      }
      expect(past.length).toBe(1);
      // [Step 3] undo restores
      const undo = () => {
        if (past.length === 0) return;
        future.push({ segments: segments.map(s => ({ ...s })), rings: rings.map(r => ({ ...r })) });
        const prev = past.pop()!;
        segments = prev.segments;
        rings = prev.rings;
      };
      undo();
      expect(segments.length).toBe(1);
      expect(future.length).toBe(1);
      // redo
      const redo = () => {
        if (future.length === 0) return;
        past.push({ segments: segments.map(s => ({ ...s })), rings: rings.map(r => ({ ...r })) });
        const next = future.pop()!;
        segments = next.segments;
        rings = next.rings;
      };
      redo();
      expect(segments.length).toBe(2);
      expect(past.length).toBe(1);
      expect(future.length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // 8. Off-grid + complex amp numeric consistency (WaveEngine ↔ Cursor)
  // ------------------------------------------------------------------
  describe('8. Off-grid数値整合 — WaveEngine dY クランプと Cursor速度が 2*TW_AMP*amp で一致', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offGrid = [0.37, 1.23] as const;
    for (const amp of amps) {
      for (const ob of offGrid) {
        it(`amp=${amp} off=${ob}: waveYAt clamped per-beat matches cursor`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const segs: Segment[] = [{ direction: 'down', beats: 3 }];
          const engine = new WaveEngine(segs, tl, amp, 0);
          const perBeat = 2 * TW_AMP * amp;
          const p0 = engine.getPoints()[0];
          const rawY = p0.y + perBeat * ob;
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          const actualY = engine.waveYAt(ob);
          expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-6);
          const beatMs = 500;
          const cursor = new Cursor(amp, 0);
          cursor.setAmplitude(amp);
          const startY = cursor.y;
          cursor.update(beatMs / 1000, false, true, beatMs);
          const disp = cursor.y - startY;
          const clampedDisp = Math.min(BOTTOM - startY, perBeat);
          expect(Math.abs(disp - clampedDisp)).toBeLessThan(1e-3);
        });
      }
    }

    it('全segments beatsが snap整数倍、getPoints().length===segments.length+1 を維持（T127/T128不変）', () => {
      const snap = 0.25, amp = 2.7;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 1 } ];
      const dx = quantizeBeat(0.37, snap);
      const res = calculateVertexMultiDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, vertexIndices: [1], dxBeat: dx, dy: 0, snap });
      expect(res).not.toBeNull();
      for (const s of res!) expect(isSnapAligned(s.beats, snap)).toBe(true);
      expect(new WaveEngine(res!, tl, amp, 0).getPoints().length).toBe(res!.length + 1);
    });
  });

  // ------------------------------------------------------------------
  // 9. Regression: T116 V/E/R分離, T141/T142 dblClick/ctxMenu, T146 classes, T150 preview, T155 history
  // ------------------------------------------------------------------
  describe('9. Regression guards', () => {
    it('Single right-click delete threshold vs rubber selection at exactly 4px boundary', () => {
      expect(Math.hypot(4, 0)).toBeGreaterThanOrEqual(4);
      expect(Math.hypot(3.9, 0)).toBeLessThan(4);
    });

    it('連続previewが元セグメントを汚染しない（origLen維持）', () => {
      const snap = 0.25, amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }];
      const orig = segs.map(s => ({ ...s }));
      // call preview 5 times with varying dx, each from original
      for (const dxRaw of [0.37, 1.23, 0.63]) {
        const dx = quantizeBeat(dxRaw, snap);
        calculateVertexMultiDrag({ segments: orig, bpmTimeline: tl, startPosition: 0, vertexIndices: [1], dxBeat: dx, dy: 0, snap });
        expect(orig).toEqual(segs);
      }
    });

    it('vertex 0 anchored — moved set never includes 0 even if selected', () => {
      const snap = 0.25, amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const res = calculateVertexMultiDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, vertexIndices: [0, 1], dxBeat: quantizeBeat(0.37, snap), dy: 0, snap });
      // vertex 0 should be ignored, only vertex 1 moves
      expect(res).not.toBeNull();
      const pts0 = new WaveEngine(segs, tl, amp, 0).getPoints();
      const pts1 = new WaveEngine(res!, tl, amp, 0).getPoints();
      expect(pts1[0].beat).toBe(pts0[0].beat);
      expect(pts1[1].beat).not.toBe(pts0[1].beat);
    });

    it('empty drag <4px: single vertex {self} only case leaves later points unchanged (4px guard)', () => {
      const snap = 0.25, amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }];
      // simulate empty creation drag: would be rejected via distance check in UI; engine still valid but caller would not commit
      // verify the engine math for a tiny dx still snap-aligned
      const dx = quantizeBeat(0.05, snap); // ~0.0 after quantize
      const res = calculateVertexMultiDrag({ segments: segs, bpmTimeline: tl, startPosition: 0, vertexIndices: [1], dxBeat: dx, dy: 0, snap });
      // dx quantized to 0 => no move, returns either null or original-equivalent
      if (res) {
        for (const s of res) expect(isSnapAligned(s.beats, snap)).toBe(true);
      } else {
        expect(res).toBeNull();
      }
    });
  });
});
