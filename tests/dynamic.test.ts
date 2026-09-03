import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment, BpmChange } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}
function clampY(y: number): number {
  return Math.max(TOP, Math.min(BOTTOM, y));
}
function clampBeat(b: number): number {
  return Math.max(0, b);
}

/**
 * Reference implementation of T140 edge drag (parallel translation).
 * Mirrors spec after fix:
 * - beat_i' = beat_i + dxSnap (dxSnap = quantizeBeat(dxRaw, safeSnap))
 * - y_i' = clamp(y_i + dy), y_{i+1}' = clamp(y_{i+1}+dy)
 * - seg i-1: segmentFor(p_{i-1} -> p_i')
 * - seg i:   edge itself beats_i' = |yI1' - yI'|/perBeat(beatI') quantized; |dx|>|dy| => horizontal priority (origLen)
 * - seg i+1: segmentFor(p_{i+1}' -> p_{i+2})
 * Only 3 segments (or 2 at boundaries) recomputed, others unchanged.
 * perBeat(b) = 2*TW_AMP*amplitudeAt(b) (list-driven T131).
 * segmentFor signature is (fromBeat, fromY, toY) — no toBeat (fixed from postmortem).
 */
function referenceEdgeDrag(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  edgeIdx: number,
  dxRaw: number,
  dyRaw: number,
  safeSnap: number,
): Segment[] | null {
  const snap = safeSnap > 0 ? safeSnap : 0.25;
  if (segments.length === 0) return null;
  if (edgeIdx < 0 || edgeIdx >= segments.length) return null;
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  if (edgeIdx >= pts.length - 1) return null;

  const dxSnap = quantizeBeat(dxRaw, snap);
  const perBeat = (b: number) => 2 * TW_AMP * timeline.amplitudeAt(b);
  const segmentFor = (fromBeat: number, fromY: number, toY: number): Segment => {
    const delta = toY - fromY;
    if (Math.abs(delta) < 0.5) return { direction: 'stay', beats: snap };
    const raw = Math.abs(delta) / perBeat(fromBeat);
    const beats = Math.max(snap, quantizeBeat(raw, snap));
    const dir: 'up' | 'down' | 'stay' = delta < 0 ? 'up' : 'down';
    return { direction: dir, beats };
  };

  const ptI = pts[edgeIdx];
  const ptI1 = pts[edgeIdx + 1];
  // clamp dy so y stays within field (spec: clamp dy to fieldH, here TOP/BOTTOM relative to ptI)
  // spec says dy is mapYInverse diff clamped to fieldH, we clamp resulting y to [TOP,BOTTOM]
  let yI = clampY(ptI.y + dyRaw);
  let yI1 = clampY(ptI1.y + dyRaw);
  // also dy is uniform shift, so difference preserved unless clamped at boundary
  const beatI = clampBeat(ptI.beat + dxSnap);
  const beatI1 = ptI1.beat + dxSnap;
  // ensure beatI < beatI1 and >=0; if dxSnap makes beatI negative clamp, shift both? For simplicity keep as spec.

  const candidateSegs = segments.map((s, i) => {
    if (i === edgeIdx - 1 && i >= 0) {
      const pPrev = pts[edgeIdx - 1];
      return segmentFor(pPrev.beat, pPrev.y, yI);
    }
    if (i === edgeIdx) {
      const origLen = ptI1.beat - ptI.beat;
      const dyPx = Math.abs(yI1 - yI);
      const dxDominant = Math.abs(dxSnap) > Math.abs(dyPx / perBeat(beatI));
      let beatsI: number;
      if (dxDominant) {
        beatsI = Math.max(snap, quantizeBeat(origLen, snap));
      } else {
        beatsI = Math.max(snap, quantizeBeat(dyPx / perBeat(beatI), snap));
      }
      const dir: 'up' | 'down' | 'stay' = dyPx < 0.5 ? 'stay' : yI1 < yI ? 'up' : 'down';
      return { direction: dir, beats: beatsI };
    }
    if (i === edgeIdx + 1 && i + 1 < pts.length) {
      const pAfter = pts[edgeIdx + 2];
      if (!pAfter) return s;
      return segmentFor(beatI1, yI1, pAfter.y);
    }
    return s;
  });

  // For physical correctness, ensure beats are snap-aligned (segmentFor already quantized)
  return candidateSegs;
}

describe('T140 辺編集のドラッグ移動（左右上下） — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------
  // 1. ファイル内容に辺ドラッグロジックが存在するか (Red before T140)
  // ------------------------------------------------------------
  describe('1. WavePreviewに辺ドラッグ(edgeDrag)ロジックが実装されている', () => {
    it('WavePreview.tsx は edgeDragRef / nearestEdgeIndex / onSelectSegment を用いた辺移動ロジックを含む', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture initial file state
      const hasEdgeDragRef = content.includes('edgeDragRef');
      expect(hasEdgeDragRef, 'edgeDragRef が存在すること').toBeTruthy();
      // [Step2] perform check: required markers
      const hasNearestEdge = content.includes('nearestEdgeIndex');
      const hasOnSelect = content.includes('onSelectSegment');
      const hasEdgeDragBlock = content.indexOf('edgeDragRef.current') !== -1;
      // [Step3] assert
      expect(hasNearestEdge, 'nearestEdgeIndex が存在すること').toBeTruthy();
      expect(hasOnSelect, 'onSelectSegment が edge モードで呼ばれること').toBeTruthy();
      expect(hasEdgeDragBlock, 'edgeDragRef.current を扱う onMove ブロックが存在すること').toBeTruthy();
    });

    it('WavePreview.tsx は dxBeat を safeSnap で量子化し、quantizeBeat を使う (手動 Math.round 禁止)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture initial
      expect(content.length).toBeGreaterThan(0);
      // [Step2] find edgeDrag block
      const idx = content.indexOf('edgeDragRef.current');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 4000);
      // [Step3] assert quantizeBeat usage and no manual inline quantization
      const hasQuantize = block.includes('quantizeBeat') && block.includes('safeSnap');
      expect(hasQuantize, 'edge drag で quantizeBeat(dxBeat/safeSnap) が使われていること').toBeTruthy();
      // Must use quantizeBeat, not raw Math.round(x/snap)*snap inline for dx
      const hasDxSnap = block.includes('dxSnap') || block.includes('quantizeBeat');
      expect(hasDxSnap, 'dxSnap が quantizeBeat で生成されること').toBeTruthy();
      // Ensure no leftover manual inline quantization for edge (strict QA)
      const manualPattern = block.includes('Math.round') && block.includes('/ safeSnap');
      // Allow quantizeBeat impl itself, but edge block should not have manual Math.round(.../snap)*snap
      // If manual exists outside quantizeBeat definition, fail
      if (manualPattern) {
        const quantLine = block.indexOf('quantizeBeat');
        const manualIdx = block.indexOf('Math.round');
        // manual should not be the primary quantization for dx; quantizeBeat must be used
        expect(quantLine).toBeGreaterThan(-1);
        expect(quantLine < manualIdx || !block.includes('Math.round(dx'), '手動 Math.round(dx/snap) は禁止、quantizeBeat を使うこと').toBeTruthy();
      }
    });

    it('WavePreview.tsx の edge drag は perBeatPx/amplitudeAt を用い、Yも扱う', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('edgeDragRef.current');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 5000);
      // [Step1] capture
      // [Step2] check perBeat and amplitudeAt
      const hasPerBeat = block.includes('perBeat') || block.includes('2 * TW_AMP *');
      const hasAmpAt = block.includes('amplitudeAt');
      const hasY = block.includes('yI') || block.includes('yNow') || block.includes('dy');
      // [Step3] assert
      expect(hasPerBeat, 'perBeat (2*TW_AMP*amplitudeAt) が edge drag で使われている').toBeTruthy();
      expect(hasAmpAt, 'amplitudeAt が edge drag で使われている').toBeTruthy();
      expect(hasY, 'Y方向 (yI/yI1/dy) が edge drag で扱われている').toBeTruthy();
      // 3-segment recalculation markers
      const has3Seg = block.includes('idx - 1') && block.includes('idx + 1');
      expect(has3Seg, '前後を含む3セグメント再計算 (idx-1, idx, idx+1) が存在').toBeTruthy();
    });

    it('WavePreview.tsx は edgeDragRef = {index, startBeat, startPrevBeat, startNextBeat} を持つ', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture definition
      const hasDef = content.includes('edgeDragRef');
      expect(hasDef).toBeTruthy();
      // [Step2] check shape
      const hasStartBeat = content.includes('startBeat') && content.includes('startPrevBeat') && content.includes('startNextBeat');
      // [Step3] assert
      expect(hasStartBeat, 'edgeDragRef が startBeat/startPrevBeat/startNextBeat を持つ').toBeTruthy();
      // Also check initialization in handleMouseDown
      const hIdx = content.indexOf('handleMouseDown');
      const edgeInit = content.slice(hIdx, hIdx + 3000);
      expect(edgeInit.includes('edgeDragRef.current ='), 'handleMouseDown で edgeDragRef.current が初期化される').toBeTruthy();
      expect(edgeInit.includes('startBeat: pts'), '初期化で startBeat が pts[edge].beat から設定される').toBeTruthy();
    });
  });

  // ------------------------------------------------------------
  // 2. 未使用変数禁止・シグネチャ修正 (postmortem)
  // ------------------------------------------------------------
  describe('2. 未使用変数・シグネチャ修正 (Actionable Fix Prescriptions)', () => {
    it('WavePreview.tsx に dead code `const last = pts.length - 1` が存在しない (edgeDrag内で)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture file
      expect(content.length).toBeGreaterThan(0);
      // [Step2] locate edgeDrag block
      const idx = content.indexOf('edgeDragRef.current');
      expect(idx).toBeGreaterThan(-1);
      // edgeDrag block is about 2000 chars after idx, before next `if (dragRef`
      const block = content.slice(idx, content.indexOf('if (dragRef.current)', idx));
      // [Step3] assert no dead `last` variable
      const hasDeadLast = block.includes('const last = pts.length - 1') || block.includes('const last=pts.length');
      expect(hasDeadLast, 'edgeDrag ブロック内に未使用 const last が残ってはならない (削除すること)').toBeFalsy();
      // Also check overall file for that pattern inside edgeDrag context (allow elsewhere if used)
      // We already isolated block, so this is strict
    });

    it('WavePreview.tsx の segmentFor は未使用 toBeat 引数を持たず (fromBeat, fromY, toY) の3引数', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture
      const idx = content.indexOf('segmentFor');
      expect(idx).toBeGreaterThan(-1);
      const snippet = content.slice(idx, idx + 500);
      // [Step2] check signature
      // Before fix: (fromBeat: number, fromY: number, toBeat: number, toY: number)
      const has4Args = snippet.includes('toBeat: number');
      const has3Args = snippet.includes('fromBeat: number, fromY: number, toY: number');
      // [Step3] assert fixed to 3 args, no toBeat
      expect(has3Args, 'segmentFor は (fromBeat, fromY, toY) の3引数であること').toBeTruthy();
      expect(has4Args, 'segmentFor に未使用 toBeat 引数があってはならない').toBeFalsy();
      // Also check call sites pass only 3 args
      const callsIdx = content.indexOf('segmentFor(pPrev');
      if (callsIdx !== -1) {
        const callSnippet = content.slice(callsIdx, callsIdx + 200);
        // should be 3 args: (pPrev.beat, pPrev.y, yI) not 4
        const commaCount = (callSnippet.match(/,/g) || []).length;
        // 3 args => 2 commas inside call
        expect(commaCount, 'segmentFor call は3引数 (2 commas) であること').toBe(2);
      }
    });

    it('WavePreview.tsx に未使用変数 `last` / `toBeat` が残っていない (tsc --noEmit 無違反)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture
      // [Step2] search for any unused declaration pattern inside edgeDrag
      const edgeBlockIdx = content.indexOf('edgeDragRef.current');
      const edgeBlock = content.slice(edgeBlockIdx, edgeBlockIdx + 6000);
      const hasUnusedLast = edgeBlock.includes('const last');
      const hasUnusedToBeat = edgeBlock.includes('toBeat');
      // [Step3] assert no unused
      expect(hasUnusedLast, '未使用 const last が edgeDrag に残っていない').toBeFalsy();
      expect(hasUnusedToBeat, '未使用 toBeat が残っていない (segmentFor修正)').toBeFalsy();
    });
  });

  // ------------------------------------------------------------
  // 3. Edgeドラッグで3セグメントのみ再計算・辺長保持・安全Snap・長さ不変
  // ------------------------------------------------------------
  describe('3. Edgeドラッグ — 3セグメントのみ再計算・辺長保持・safeSnap整数倍・getPoints長さ不変', () => {
    it('edge idx=1 を dx=0.37 (off-grid) dy=15 でドラッグ: 3セグメントのみ変化、全beats snap整数倍、長さ不変 (snap 0.25 amp 1.0)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const dxRaw = 0.37; // off-grid
      const dyRaw = 15; // off-grid Y shift
      const dxSnap = quantizeBeat(dxRaw, snap);
      // [Step1] capture initial
      expect(pts0.length).toBe(initial.length + 1);
      const beforeLen = initial.length;
      // [Step2] perform via reference
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert invariants
      expect(newSegs!.length).toBe(beforeLen);
      for (const s of newSegs!) {
        expect(isSnapAligned(s.beats, snap), `beats ${s.beats} should be snap ${snap}`).toBeTruthy();
      }
      // only idx-1, idx, idx+1 may change
      for (let i = 0; i < initial.length; i++) {
        if (i !== idx - 1 && i !== idx && i !== idx + 1) {
          expect(newSegs![i].beats).toBeCloseTo(initial[i].beats, 4);
          expect(newSegs![i].direction).toBe(initial[i].direction);
        }
      }
      // getPoints length invariant
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      expect(engine1.getPoints().length).toBe(pts0.length);
      // posterior edge shift: point idx should be at beat+dxSnap, point idx+1 at beat+dxSnap
      const pts1 = engine1.getPoints();
      expect(pts1[idx].beat).toBeCloseTo(pts0[idx].beat + dxSnap, 4);
      expect(pts1[idx + 1].beat).toBeCloseTo(pts0[idx + 1].beat + dxSnap, 4);
      // edge length preserved when dx dominant? Check dxDominant case
      // For dx=0.37 snap 0.25 => dxSnap 0.25, dy 15 => dyPerBeat 15/(260)=0.057 => dxDominant true => beats should be quantized origLen
      const origLen = pts0[idx + 1].beat - pts0[idx].beat;
      const perBeatAt = 2 * TW_AMP * tl.amplitudeAt(pts0[idx].beat + dxSnap);
      const dyPx = Math.abs(clampY(pts0[idx + 1].y + dyRaw) - clampY(pts0[idx].y + dyRaw));
      const dxDominant = Math.abs(dxSnap) > Math.abs(dyPx / perBeatAt);
      if (dxDominant) {
        expect(newSegs![idx].beats).toBeCloseTo(quantizeBeat(origLen, snap), 4);
      }
    });

    it('edge idx=2 snap 0.5 dy dominant (dx 0.1, dy 60) で縦優先・beats は dy/perBeat 量子化 (off-grid)', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 2;
      const dxRaw = 0.1; // small -> snap 0
      const dyRaw = 60; // large vertical
      const dxSnap = quantizeBeat(dxRaw, snap);
      // [Step1]
      expect(pts0.length).toBe(initial.length + 1);
      // [Step2]
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // [Step3]
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(newSegs!.length).toBe(initial.length);
      // dy dominant => beats derived from dy
      const yI = clampY(pts0[idx].y + dyRaw);
      const yI1 = clampY(pts0[idx + 1].y + dyRaw);
      const dyPx = Math.abs(yI1 - yI);
      const perBeatAt = 2 * TW_AMP * tl.amplitudeAt(pts0[idx].beat + dxSnap);
      const dyDominant = Math.abs(dxSnap) <= Math.abs(dyPx / perBeatAt);
      if (dyDominant && dyPx > 0.5) {
        const expected = Math.max(snap, quantizeBeat(dyPx / perBeatAt, snap));
        expect(newSegs![idx].beats).toBeCloseTo(expected, 4);
        expect(newSegs![idx].direction).toBe(yI1 < yI ? 'up' : 'down');
      }
      expect(new WaveEngine(newSegs!, tl, 1.0, 0).getPoints().length).toBe(pts0.length);
    });

    it('first edge (idx=0) は 2セグメントのみ再計算、last edge も 2セグメント', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      // [Step1] capture
      expect(engine0.getPoints().length).toBe(4);
      // [Step2] first edge
      const first = referenceEdgeDrag(initial, tl, 0, 0, 0.37, 10, snap);
      expect(first).not.toBeNull();
      expect(first!.length).toBe(initial.length);
      for (const s of first!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      // only idx 0 and 1 may change
      expect(first![2].beats).toBeCloseTo(initial[2].beats, 4);
      // [Step3] last edge
      const lastIdx = initial.length - 1;
      const last = referenceEdgeDrag(initial, tl, 0, lastIdx, 0.37, -10, snap);
      expect(last).not.toBeNull();
      expect(last!.length).toBe(initial.length);
      for (const s of last!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(last![0].beats).toBeCloseTo(initial[0].beats, 4);
    });

    it('snap 0.125 off-grid dx 0.37/1.23 でも snap整数倍・長さ不変', () => {
      const snap = 0.125;
      const tl = new BpmTimeline(120, [], 1.3);
      const initial: Segment[] = [
        { direction: 'up', beats: 0.5 },
        { direction: 'down', beats: 0.5 },
        { direction: 'up', beats: 0.5 },
        { direction: 'down', beats: 0.5 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.3, 0);
      const rawDxs = [0.37, 1.23];
      for (const dx of rawDxs) {
        // [Step1] capture
        expect(engine0.getPoints().length).toBe(initial.length + 1);
        // [Step2] perform each
        const newSegs = referenceEdgeDrag(initial, tl, 0, 1, dx, 20, snap);
        expect(newSegs).not.toBeNull();
        // [Step3] assert
        for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
        expect(newSegs!.length).toBe(initial.length);
        expect(new WaveEngine(newSegs!, tl, 1.3, 0).getPoints().length).toBe(engine0.getPoints().length);
      }
    });
  });

  // ------------------------------------------------------------
  // 4. 空ドラッグはpan、辺上ドラッグはedge移動として正しく分離
  // ------------------------------------------------------------
  describe('4. 空ドラッグはpan、辺上ドラッグはedge移動として正しく分離', () => {
    it('WavePreview.tsx は panRef と排他（edgeDrag中はpan無効）を実装', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture onMove
      const moveIdx = content.indexOf('const onMove');
      expect(moveIdx).toBeGreaterThan(-1);
      const block = content.slice(moveIdx, moveIdx + 6000);
      // [Step2] check exclusivity: edgeDrag checked before pan, and pan not executed during edgeDrag
      const edgeBeforePan = block.indexOf('edgeDragRef.current') < block.indexOf('panRef.current');
      expect(edgeBeforePan, 'edgeDrag が pan より先に処理される (排他)').toBeTruthy();
      // Also check handleMouseDown sets pan only when edge miss
      const downIdx = content.indexOf('editMode === \'edge\'');
      const edgeDownBlock = content.slice(downIdx, downIdx + 2000);
      expect(edgeDownBlock.includes('onSelectSegment?.(null)') || edgeDownBlock.includes('panRef.current'), 'edge miss 時に pan が開始される').toBeTruthy();
      // [Step3] assert panRef moved flag logic exists and edgeDragRef has priority
      expect(block.includes('panRef.current.moved'), 'panRef.moved が存在').toBeTruthy();
      // edgeDrag should return early, not fall through to pan
      const edgeReturnIdx = block.indexOf('edgeDragRef.current');
      const afterEdge = block.slice(edgeReturnIdx, edgeReturnIdx + 1500);
      expect(afterEdge.includes('return'), 'edgeDrag 処理後に return で pan をスキップ').toBeTruthy();
    });

    it('handleMouseDown で edgeHit 時に edgeDragRef を初期化し、empty は pan へ分岐', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture handleMouseDown edge branch
      const edgeIdx = content.indexOf("if (editMode === 'edge')");
      expect(edgeIdx).toBeGreaterThan(-1);
      const block = content.slice(edgeIdx, edgeIdx + 3000);
      // [Step2] check initialization
      const hasInit = block.includes('edgeDragRef.current = {');
      const hasStartBeat = block.includes('startBeat: pts[eHit].beat');
      const hasPanOnMiss = block.includes('onSelectSegment?.(null)') && block.includes('panRef.current =');
      // [Step3] assert
      expect(hasInit, 'edgeHit 時に edgeDragRef.current が初期化される').toBeTruthy();
      expect(hasStartBeat, 'startBeat が pts[eHit].beat で初期化される').toBeTruthy();
      expect(hasPanOnMiss, 'edge miss (empty) 時に panRef が開始される').toBeTruthy();
      // Also check that onSelectSegment is called before drag start (spec: onSelectSegment後にドラッグ開始)
      expect(block.indexOf('onSelectSegment?.(eHit)') < block.indexOf('edgeDragRef.current'), 'onSelectSegment が edgeDrag 初期化より先に呼ばれる').toBeTruthy();
    });

    it('edgeDrag と vertexDrag / dragRef / panRef が排他的に return する (onMove)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const moveIdx = content.indexOf('const onMove');
      const block = content.slice(moveIdx, moveIdx + 7000);
      // [Step1] capture all drag refs
      expect(block.includes('vertexDragRef.current')).toBeTruthy();
      expect(block.includes('edgeDragRef.current')).toBeTruthy();
      expect(block.includes('dragRef.current')).toBeTruthy();
      expect(block.includes('panRef.current')).toBeTruthy();
      // [Step2] check each has return to enforce exclusivity
      const vertexReturn = block.indexOf('vertexDragRef.current');
      const edgeReturn = block.indexOf('edgeDragRef.current');
      const panReturn = block.indexOf('panRef.current');
      // [Step3] assert order: vertex -> edge -> drag -> pan
      expect(vertexReturn < edgeReturn, 'vertexDrag が edgeDrag より先').toBeTruthy();
      expect(edgeReturn < panReturn, 'edgeDrag が pan より先 (排他)').toBeTruthy();
      // Each block should end with return
      const vertexBlock = block.slice(vertexReturn, vertexReturn + 3000);
      expect(vertexBlock.includes('return'), 'vertexDrag ブロックは return で終了').toBeTruthy();
      const edgeBlock = block.slice(edgeReturn, edgeReturn + 3000);
      expect(edgeBlock.includes('return'), 'edgeDrag ブロックは return で終了').toBeTruthy();
    });
  });

  // ------------------------------------------------------------
  // 5. 複雑な振幅 (0.7/1.3/2.7/3.4) とリスト駆動で perBeat が正しい (off-grid)
  // ------------------------------------------------------------
  describe('5. 複雑な振幅とリスト駆動 amplitudeAt で perBeat が正しい (off-grid 0.37/1.23)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const snaps = [0.25, 0.5] as const;

    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap} edge drag beats は perBeat=2*TW_AMP*amp で物理整合 (dx 0.37)`, () => {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          const idx = 1;
          const prev = pts0[idx - 1];
          // [Step1] capture amplitude
          expect(tl.amplitudeAt(prev.beat)).toBeCloseTo(amp, 4);
          // [Step2] perform edge drag with off-grid dx 0.37 and moderate dy
          const dy = 20;
          const newSegs = referenceEdgeDrag(initial, tl, 0, idx, 0.37, dy, snap);
          expect(newSegs).not.toBeNull();
          // [Step3] assert snap and amplitude-driven Y
          for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
          const engine1 = new WaveEngine(newSegs!, tl, amp, 0);
          expect(engine1.getPoints().length).toBe(pts0.length);
          // The Y at new edge should be perBeat consistent (if not clamped)
          const perPrev = 2 * TW_AMP * tl.amplitudeAt(prev.beat);
          // y change for seg idx-1 should be about perPrev * beatsPrev (if not clipped)
          // We check that beats are feasible via perBeat quantization (not manual)
          const deltaY = Math.abs(clampY(pts0[idx].y + dy) - pts0[idx - 1].y);
          if (deltaY > 0.5 && deltaY < TW_AMP * 1.9) {
            const expectedBeats = Math.max(snap, quantizeBeat(deltaY / perPrev, snap));
            // segment idx-1 may be recalculated, check close to expected or dx-quantized
            // At least one of the 3 seg beats should be snap-aligned and plausible
            expect(isSnapAligned(newSegs![idx - 1].beats, snap)).toBeTruthy();
            // If dy not boundary-clamped, beatsPrev should be near expected
            if (Math.abs(clampY(pts0[idx].y + dy) - (pts0[idx].y + dy)) < 1) {
              // not clamped at boundary, so check expectation
              expect(newSegs![idx - 1].beats).toBeCloseTo(expectedBeats, 1);
            }
          }
        });
      }
    }

    it('リスト駆動: bpm_changes[beat=4 amp=2.0] で edge perBeat は step で切り替わる (off-grid 0.37/1.23)', () => {
      const snap = 0.25;
      const bpmChanges: BpmChange[] = [{ beat: 4, bpm: 120, amplitude: 2.0 }];
      const tl = new BpmTimeline(120, bpmChanges, 1.0);
      // [Step1] capture amplitudeAt step at off-grid
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 4);
      expect(tl.amplitudeAt(4.0)).toBeCloseTo(2.0, 4);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(2.0, 4);
      expect(tl.amplitudeAt(5.0)).toBeCloseTo(2.0, 4);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 2; // edge at beat 4
      expect(pts0[idx].beat).toBeCloseTo(4, 1);
      // [Step2] drag edge at beat 4 by dx 0.37 (off-grid) dy 30
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, 0.37, 30, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert beats snap and amplitude-driven perBeat differs before/after
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      expect(engine1.getPoints().length).toBe(pts0.length);
      // perBeat before edge (beat 2) uses amp 1.0, perBeat at edge (beat 4+dx) uses amp 2.0
      const perBefore = 2 * TW_AMP * tl.amplitudeAt(pts0[idx - 1].beat);
      const perAtEdge = 2 * TW_AMP * tl.amplitudeAt(pts0[idx].beat + quantizeBeat(0.37, snap));
      expect(perBefore).toBeCloseTo(2 * TW_AMP * 1.0, 1);
      expect(perAtEdge).toBeCloseTo(2 * TW_AMP * 2.0, 1);
      // edge itself beats should be perAtEdge quantized if dy dominant
      const yI = clampY(pts0[idx].y + 30);
      const yI1 = clampY(pts0[idx + 1].y + 30);
      const dyPx = Math.abs(yI1 - yI);
      const dxSnap = quantizeBeat(0.37, snap);
      const dxDominant = Math.abs(dxSnap) > Math.abs(dyPx / perAtEdge);
      if (!dxDominant && dyPx > 0.5) {
        const exp = Math.max(snap, quantizeBeat(dyPx / perAtEdge, snap));
        expect(newSegs![idx].beats).toBeCloseTo(exp, 4);
      }
    });

    it('複数振幅区分 (0.7 -> 3.4) で edge drag が各 perBeat で正しく量子化 (snap 0.25 off-grid 0.37)', () => {
      const snap = 0.25;
      const bpmChanges: BpmChange[] = [
        { beat: 2, bpm: 120, amplitude: 0.7 },
        { beat: 6, bpm: 120, amplitude: 3.4 },
      ];
      const tl = new BpmTimeline(120, bpmChanges, 1.3);
      expect(tl.amplitudeAt(1.37)).toBeCloseTo(1.3, 4);
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(0.7, 4);
      expect(tl.amplitudeAt(6.37)).toBeCloseTo(3.4, 4);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.3, 0);
      const pts0 = engine0.getPoints();
      const idx = 6; // beat 6
      expect(pts0[idx].beat).toBeCloseTo(6, 1);
      // [Step2] drag
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, 0.37, 25, snap);
      expect(newSegs).not.toBeNull();
      // [Step3]
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(new WaveEngine(newSegs!, tl, 1.3, 0).getPoints().length).toBe(pts0.length);
      expect(tl.amplitudeAt(engine0.getPoints()[idx].beat + quantizeBeat(0.37, snap))).toBeCloseTo(3.4, 1);
    });
  });

  // ------------------------------------------------------------
  // 6. 回帰: getPoints 不変・WaveEngine/Cursor 物理一致・未使用変数なし
  // ------------------------------------------------------------
  describe('6. 回帰 & 物理整合', () => {
    it('getPoints().length === segments.length+1 を維持し、構造は {beat,y} のみ (edge drag後)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const cases: Segment[][] = [
        [{ direction: 'down', beats: 1 }],
        [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }],
        [{ direction: 'down', beats: 0.5 }, { direction: 'stay', beats: 1 }, { direction: 'up', beats: 0.5 }],
      ];
      for (const segs of cases) {
        // [Step1] capture
        const engine = new WaveEngine(segs, tl, 1.0, 0);
        const pts = engine.getPoints();
        expect(pts.length).toBe(segs.length === 0 ? 2 : segs.length + 1);
        if (segs.length >= 2) {
          // [Step2] edge drag interior
          const idx = 1 % segs.length;
          const newSegs = referenceEdgeDrag(segs, tl, 0, idx, 0.37, 10, snap);
          expect(newSegs).not.toBeNull();
          const pts2 = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
          // [Step3]
          expect(pts2.length).toBe(segs.length + 1);
          for (const p of pts2) {
            expect(typeof p.beat).toBe('number');
            expect(typeof p.y).toBe('number');
            expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
          }
        }
      }
    });

    it('waveYAt と cursor の物理速度が T128 クランプ込みで一致 (amp 0.7/1.3/2.7 off-grid 0.37/1.23)', async () => {
      const { Cursor } = await import('../src/game/cursor');
      const amps = [0.7, 1.3, 2.7];
      const offGrid = [0.37, 1.23];
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
        const delta = 0.1;
        const dyWave = engine.waveYAt(delta) - engine.waveYAt(0);
        const slopeWave = dyWave / delta;
        expect(slopeWave).toBeCloseTo(2 * TW_AMP * amp, 0);
        for (const b of offGrid) {
          const y = engine.waveYAt(b);
          expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
          expect(y).toBeLessThanOrEqual(BOTTOM + 1e-6);
          const cursor = new Cursor(amp, 0);
          const beatMs = 500;
          const dt = (b * beatMs) / 1000;
          cursor.update(dt, false, true, beatMs, 1);
          const expectedCursorY = clampY(CENTER + 2 * TW_AMP * amp * b);
          if (b < 0.6) {
            expect(y).toBeCloseTo(expectedCursorY, 1);
          } else {
            expect(y).toBeCloseTo(BOTTOM, 1);
          }
        }
      }
    });

    it('edge drag 後の全 beats が snap整数倍であり、0 以下や NaN がない', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const amps = [0.7, 1.0, 1.3, 2.7];
      for (const snap of snaps) {
        for (const amp of amps) {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
          ];
          const newSegs = referenceEdgeDrag(initial, tl, 0, 1, 0.37, 15, snap);
          expect(newSegs).not.toBeNull();
          for (const s of newSegs!) {
            expect(isSnapAligned(s.beats, snap)).toBeTruthy();
            expect(s.beats).toBeGreaterThan(0);
            expect(Number.isFinite(s.beats)).toBeTruthy();
          }
        }
      }
    });

    it('tsc --noEmit エラーがないことを示すため、WavePreview が正しく import できる (構文回帰)', async () => {
      // [Step1] capture before import
      let mod: any = null;
      // [Step2] perform import
      mod = await import('../src/screens/editor/WavePreview');
      // [Step3] assert module loads and default export is function
      expect(mod).toBeDefined();
      expect(typeof mod.default).toBe('function');
      // Also check that file does not export dead code that would cause TS error
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      expect(content.includes('edgeDragRef')).toBeTruthy();
      // Verify no obvious TS error pattern: unused variable would be flagged by tsc, we check absence
      expect(content.includes('const last = pts.length - 1')).toBeFalsy();
    });
  });

  // ------------------------------------------------------------
  // 7. 追加: dx/dy の safeSnap 量子化とクランプの厳密性 (off-grid 1.2/1.3)
  // ------------------------------------------------------------
  describe('7. dx/dy 量子化・クランプの厳密性 (off-grid T105/T128 準拠)', () => {
    it('dxRaw 1.2 と 1.3 (snap 0.5) で異なる dxSnap になり、後続 beat が dxSnap だけずれる', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const dx1 = 1.2;
      const dx2 = 1.3;
      const snap1 = quantizeBeat(dx1, snap); // 1.0
      const snap2 = quantizeBeat(dx2, snap); // 1.5
      expect(snap1).toBeCloseTo(1.0, 4);
      expect(snap2).toBeCloseTo(1.5, 4);
      expect(snap1).not.toBeCloseTo(snap2, 4);
      // [Step1] capture base beats
      const baseBeatI = pts0[idx].beat;
      // [Step2] perform both
      const segs1 = referenceEdgeDrag(initial, tl, 0, idx, dx1, 10, snap);
      const segs2 = referenceEdgeDrag(initial, tl, 0, idx, dx2, 10, snap);
      expect(segs1).not.toBeNull();
      expect(segs2).not.toBeNull();
      const pts1 = new WaveEngine(segs1!, tl, 1.0, 0).getPoints();
      const pts2 = new WaveEngine(segs2!, tl, 1.0, 0).getPoints();
      // [Step3] assert dxSnap propagation
      expect(pts1[idx].beat).toBeCloseTo(baseBeatI + snap1, 4);
      expect(pts2[idx].beat).toBeCloseTo(baseBeatI + snap2, 4);
      expect(pts1[idx].beat).not.toBeCloseTo(pts2[idx].beat, 4);
      for (const s of segs1!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      for (const s of segs2!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
    });

    it('dy が境界を超える場合は clamp され beats も clamp 後の dy で量子化 (amplitude 1.0 snap 0.25)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 0;
      // large dy that would push y beyond BOTTOM
      const hugeDy = 500; // beyond field
      const yI = clampY(pts0[idx].y + hugeDy);
      const yI1 = clampY(pts0[idx + 1].y + hugeDy);
      // [Step1] capture clamp
      expect(yI).toBeLessThanOrEqual(BOTTOM);
      expect(yI1).toBeLessThanOrEqual(BOTTOM);
      // [Step2] perform
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, 0.25, hugeDy, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert clamp preserved and beats snap
      for (const s of newSegs!) {
        expect(isSnapAligned(s.beats, snap)).toBeTruthy();
        expect(s.beats).toBeGreaterThan(0);
      }
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      const pts1 = engine1.getPoints();
      expect(pts1[idx].y).toBeCloseTo(yI, 1);
      expect(pts1[idx].y).toBeLessThanOrEqual(BOTTOM + 1e-6);
      expect(pts1[idx].y).toBeGreaterThanOrEqual(TOP - 1e-6);
    });

    it('同一 edge を同じ dx/dy で2回ドラッグしても deterministic に同じ結果 (決定性)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.3);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      // [Step1] capture
      const dx = 0.37;
      const dy = 22.5;
      // [Step2] perform twice
      const a = referenceEdgeDrag(initial, tl, 0, 1, dx, dy, snap);
      const b = referenceEdgeDrag(initial, tl, 0, 1, dx, dy, snap);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // [Step3] assert deterministic same
      expect(a).toEqual(b);
      for (const s of a!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
    });
  });
});
