import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment, BpmChange } from '../src/types';

vi.useFakeTimers();

const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;
const CENTER = TW_CENTER_Y;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}
function clampY(y: number): number {
  return Math.max(TOP, Math.min(BOTTOM, y));
}

/**
 * Reference implementation of T141 vertex add (double-click).
 * Mirrors WavePreview.tsx handleDoubleClick vertex branch spec:
 * beatAdd = quantizeBeat(xToBeat, safeSnap)
 * find k where pts[k].beat < beatAdd < pts[k+1].beat, then
 * yAdd = clamp(mapYInverse(mouseY)), segA/B beats = |yAdd - y_k|/perBeat quantized to safeSnap.
 */
function referenceVertexAdd(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  rawBeat: number,
  rawY: number,
  safeSnap: number,
): Segment[] | null {
  const snap = safeSnap > 0 ? safeSnap : 0.25;
  const beatAdd = quantizeBeat(rawBeat, snap);
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  let k = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    if (beatAdd > pts[i].beat + 1e-6 && beatAdd < pts[i + 1].beat - 1e-6) {
      k = i;
      break;
    }
  }
  if (k < 0 || k >= segments.length) return null;
  const yAdd = clampY(rawY);
  const yPrev = pts[k].y;
  const yNext = pts[k + 1].y;
  const perBeatA = 2 * TW_AMP * timeline.amplitudeAt(pts[k].beat);
  const perBeatB = 2 * TW_AMP * timeline.amplitudeAt(beatAdd);
  const dA = yAdd - yPrev;
  const beatsA = Math.max(snap, quantizeBeat(Math.abs(dA) / perBeatA, snap));
  const dirA: Segment['direction'] = Math.abs(dA) < 0.5 ? 'stay' : dA < 0 ? 'up' : 'down';
  const dB = yNext - yAdd;
  const beatsB = Math.max(snap, quantizeBeat(Math.abs(dB) / perBeatB, snap));
  const dirB: Segment['direction'] = Math.abs(dB) < 0.5 ? 'stay' : dB < 0 ? 'up' : 'down';
  const next = [...segments];
  next.splice(k, 1, { direction: dirA, beats: Number(beatsA.toFixed(4)) }, { direction: dirB, beats: Number(beatsB.toFixed(4)) });
  return next;
}

/**
 * Reference implementation of T141 vertex delete (right-click / contextMenu).
 * vi <=0 or vi >= pts.length-1 => no delete (endpoint protection).
 * beats_merged = |y_{i+1} - y_{i-1}| / perBeat(prevBeat), quantized to safeSnap, dir = sign.
 */
function referenceVertexDelete(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  vertexIdx: number,
  safeSnap: number,
): Segment[] | null {
  const snap = safeSnap > 0 ? safeSnap : 0.25;
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  if (vertexIdx <= 0) return null;
  if (vertexIdx >= pts.length - 1) return null;
  const yPrev = pts[vertexIdx - 1].y;
  const yNext = pts[vertexIdx + 1].y;
  const prevBeat = pts[vertexIdx - 1].beat;
  const perBeat = 2 * TW_AMP * timeline.amplitudeAt(prevBeat);
  const d = yNext - yPrev;
  const beats = Math.max(snap, quantizeBeat(Math.abs(d) / perBeat, snap));
  const dir: Segment['direction'] = Math.abs(d) < 0.5 ? 'stay' : d < 0 ? 'up' : 'down';
  const next = [...segments];
  next.splice(vertexIdx - 1, 2, { direction: dir, beats: Number(beats.toFixed(4)) });
  return next;
}

describe('T141 頂点のダブルクリック追加 / 右クリック削除 — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------
  // 1. ファイル実装マーカー (Red before T141 / Green after)
  // ------------------------------------------------------------
  describe('1. WavePreview.tsx 実装マーカー', () => {
    it('onDoubleClick が vertex モードの頂点追加を実装 (beatAdd/quantize/pts[k] スプライス)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture
      expect(content.length).toBeGreaterThan(0);
      // [Step2] search handleDoubleClick vertex branch
      const idx = content.indexOf('handleDoubleClick');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 6000);
      // [Step3] required markers
      expect(block).toMatch(/editMode\s*===\s*['"]vertex['"]/);
      expect(block).toMatch(/quantizeBeat/);
      expect(block).toMatch(/beatAdd/);
      expect(block).toMatch(/pts\[k\]\.beat/);
      expect(block).toMatch(/yAdd/);
      expect(block).toMatch(/perBeatA|perBeat/);
      expect(block).toMatch(/splice\(k,\s*1/);
      expect(block).toMatch(/beatsA|beatsB/);
    });

    it('onContextMenu が vertex 削除を実装 (nearestVertexIndex <14, endpoint保護, beats_merged, preventDefault)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleContextMenu');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 4000);
      // [Step1] capture initial
      expect(block.length).toBeGreaterThan(0);
      // [Step2] required markers
      expect(block).toMatch(/nearestVertexIndex/);
      expect(block).toMatch(/preventDefault/);
      expect(block).toMatch(/vi\s*<=\s*0|vi\s*===\s*0/);
      expect(block).toMatch(/vi\s*>=.*pts\.length/);
      expect(block).toMatch(/yPrev|yNext/);
      expect(block).toMatch(/perBeat/);
      expect(block).toMatch(/beats/);
      expect(block).toMatch(/splice\(vi\s*-\s*1,\s*2/);
      // also check that onContextMenu is bound to canvas
      expect(content).toMatch(/onContextMenu=\{handleContextMenu\}/);
    });

    it('ダブルクリックハンドラ内に未使用変数 centerY / dispAmp が残っていない (lint破綻防止)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleDoubleClick');
      expect(idx).toBeGreaterThan(-1);
      // extract the vertex add sub-block: from "if (editMode === 'vertex'" to next closing of that block
      // we check the 40 lines after beatAdd computation for unused declarations
      const snippet = content.slice(idx, idx + 7000);
      // The buggy lines were:
      // const centerY = RULER_H + (rect.height - RULER_H) / 2
      // const dispAmp = Math.min(maxAmp, Math.max(TW_AMP, minAmp))
      // They are not used in the corrected handler (yAdd uses TW_CENTER_Y/TW_AMP directly)
      // We assert they are absent in the handleDoubleClick vertex block.
      // We check that the specific unused pattern does NOT occur immediately before yRaw.
      // Allow centerY/dispAmp elsewhere (e.g., in nearestVertexIndex/render) — only forbid in handleDoubleClick.
      // Find yRaw line within handleDoubleClick
      const yRawIdx = snippet.indexOf('const yRaw = ((y - RULER_H)');
      expect(yRawIdx).toBeGreaterThan(-1);
      const beforeYRaw = snippet.slice(Math.max(0, yRawIdx - 600), yRawIdx);
      // beforeYRaw should NOT contain const centerY or const dispAmp as standalone declarations for this handler
      // The corrected code goes: let k ... then directly const yRaw (no centerY/dispAmp).
      // So we assert absence.
      expect(beforeYRaw).not.toMatch(/const\s+centerY\s*=/);
      expect(beforeYRaw).not.toMatch(/const\s+dispAmp\s*=/);
      // Also the fieldH/maxAmp/minAmp still needed for fieldH, but centerY/dispAmp specifically removed.
      // Ensure fieldH remains (needed)
      expect(beforeYRaw + snippet.slice(yRawIdx, yRawIdx + 200)).toMatch(/fieldH/);
    });

    it('handleDoubleClick が ring モードでも維持 — 全モード対応に拡張 (ring の onDeleteRing)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleDoubleClick');
      const block = content.slice(idx, idx + 5000);
      expect(block).toMatch(/editMode\s*===\s*['"]ring['"]/);
      expect(block).toMatch(/onDeleteRing/);
    });
  });

  // ------------------------------------------------------------
  // 2. ダブルクリック追加 — 頂点+1, getPoints+1, snap整数倍 (off-grid必須)
  // ------------------------------------------------------------
  describe('2. Vertex ダブルクリック追加: 頂点+1, snap整数倍, off-grid', () => {
    it('snap 0.25 off-grid 1.37で中央にダブルクリック: segments +1, points +1, 全beats snap整数倍, Y-derived挿入', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      // [Step1] capture initial state
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      expect(pts0.length).toBe(initial.length + 1);
      const segCountBefore = initial.length;
      const ptCountBefore = pts0.length;
      const rawBeat = 1.37; // off-grid
      const rawY = CENTER - 42.3; // off-grid Y
      const beatAdd = quantizeBeat(rawBeat, snap);
      expect(beatAdd).toBeCloseTo(1.25, 4); // 1.37 snaps to 1.25 with 0.25
      expect(isSnapAligned(beatAdd, snap)).toBeTruthy();
      // determine expected k and Y-derived beats before insertion
      let expectedK = -1;
      for (let i = 0; i < pts0.length - 1; i++) {
        if (beatAdd > pts0[i].beat + 1e-6 && beatAdd < pts0[i + 1].beat - 1e-6) { expectedK = i; break; }
      }
      expect(expectedK).toBe(1);
      const yPrev = pts0[expectedK].y;
      const perPrev = 2 * TW_AMP * tl.amplitudeAt(pts0[expectedK].beat);
      const expectedBeatsA = Math.max(snap, quantizeBeat(Math.abs(clampY(rawY) - yPrev) / perPrev, snap));
      // [Step2] perform add
      const newSegs = referenceVertexAdd(initial, tl, 0, rawBeat, rawY, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert transition — Y-derived insertion, not horizontal beatAdd
      expect(newSegs!.length).toBe(segCountBefore + 1);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap), `beats ${s.beats} not snap ${snap}`).toBeTruthy();
      expect(newSegs![expectedK].beats).toBeCloseTo(Number(expectedBeatsA.toFixed(4)), 4);
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      const pts1 = engine1.getPoints();
      expect(pts1.length).toBe(ptCountBefore + 1);
      expect(pts1.length).toBe(newSegs!.length + 1);
      // new vertex beat = prevBeat + Y-derived beatsA (not necessarily beatAdd)
      expect(pts1[expectedK + 1].beat).toBeCloseTo(pts0[expectedK].beat + expectedBeatsA, 4);
      // Check that beatAdd was inside the original interval
      expect(beatAdd).toBeGreaterThan(pts0[1].beat);
      expect(beatAdd).toBeLessThan(pts0[2].beat);
    });

    it('snap 0.5 off-grid 0.37で追加: 0.37->0.5 に吸着, segments+1, beats 0.5整数倍', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      // [Step1] capture
      const beforeLen = initial.length;
      const rawBeat = 0.37; // off-grid -> snap 0.5 => 0.5
      const beatAdd = quantizeBeat(rawBeat, snap);
      expect(beatAdd).toBeCloseTo(0.5, 4);
      const rawY = BOTTOM - 13.7;
      // [Step2] perform
      const newSegs = referenceVertexAdd(initial, tl, 0, rawBeat, rawY, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert — Y-derived vertex, not horizontal 0.5
      expect(newSegs!.length).toBe(beforeLen + 1);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      const pts1 = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
      expect(pts1.length).toBe(engine0.getPoints().length + 1);
      // new vertex Y-derived beat check: prev(0) + beatsA
      const pts0 = engine0.getPoints();
      const k = 0; // 0.5 inside [0,1]
      const perPrev = 2 * TW_AMP * tl.amplitudeAt(pts0[k].beat);
      const expectedBeatsA = Math.max(snap, quantizeBeat(Math.abs(clampY(rawY) - pts0[k].y) / perPrev, snap));
      expect(newSegs![k].beats).toBeCloseTo(Number(expectedBeatsA.toFixed(4)), 4);
      expect(pts1[k + 1].beat).toBeCloseTo(pts0[k].beat + expectedBeatsA, 4);
    });

    it('snap 0.125/1.0 でも端数タイミングで snap整数倍 (off-grid 1.23)', () => {
      for (const snap of [0.125, 1.0] as const) {
        const tl = new BpmTimeline(120, [], 1.0);
        const initial: Segment[] = [
          { direction: 'down', beats: 2 },
          { direction: 'up', beats: 2 },
          { direction: 'down', beats: 2 },
        ];
        const rawBeat = 1.23; // off-grid
        const beatAdd = quantizeBeat(rawBeat, snap);
        // [Step1] capture snap alignment of beatAdd
        expect(isSnapAligned(beatAdd, snap)).toBeTruthy();
        // [Step2] perform with off-grid Y
        const newSegs = referenceVertexAdd(initial, tl, 0, rawBeat, CENTER + 77.3, snap);
        // may be null if beatAdd lands on vertex — handle
        if (newSegs === null) {
          // beatAdd on vertex => no split expected; verify beatAdd equals a point
          const pts = new WaveEngine(initial, tl, 1.0, 0).getPoints();
          const onVertex = pts.some(p => Math.abs(p.beat - beatAdd) < 1e-6);
          expect(onVertex).toBeTruthy();
          continue;
        }
        // [Step3] assert
        for (const s of newSegs) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
        expect(newSegs.length).toBe(initial.length + 1);
      }
    });

    it('頂点上にダブルクリック (beatAdd == existing vertex) は追加しない (null)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      // pick existing vertex beat =1.0
      const rawBeat = 1.0; // exactly on vertex
      // [Step1] capture that 1.0 is a vertex
      expect(pts0.some(p => Math.abs(p.beat - 1.0) < 1e-6)).toBeTruthy();
      // [Step2] perform
      const result = referenceVertexAdd(initial, tl, 0, rawBeat, CENTER, snap);
      // [Step3] assert no split
      expect(result).toBeNull();
    });

    it('複雑な振幅 1.3 snap 0.5 off-grid 1.37 で Y自由移動の perBeat が正しい', () => {
      const snap = 0.5;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      // [Step1] capture perBeat
      const perAt1 = 2 * TW_AMP * tl.amplitudeAt(1.0);
      expect(perAt1).toBeCloseTo(2 * TW_AMP * amp, 1);
      const rawBeat = 1.37; // off-grid -> 1.5 with snap 0.5
      const beatAdd = quantizeBeat(rawBeat, snap);
      expect(beatAdd).toBeCloseTo(1.5, 4);
      const rawY = CENTER - 90.2;
      // [Step2] perform
      const newSegs = referenceVertexAdd(initial, tl, 0, rawBeat, rawY, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert beats derived from Y/perBeat are snap-aligned, length +1
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(newSegs!.length).toBe(initial.length + 1);
      const pts0 = engine0.getPoints();
      const k = pts0.findIndex((p, i) => i < pts0.length - 1 && beatAdd > p.beat + 1e-6 && beatAdd < pts0[i + 1].beat - 1e-6);
      expect(k).toBeGreaterThan(-1);
      const yPrev = pts0[k].y;
      const perPrev = 2 * TW_AMP * tl.amplitudeAt(pts0[k].beat);
      const expectedBeatsA = Math.max(snap, quantizeBeat(Math.abs(clampY(rawY) - yPrev) / perPrev, snap));
      expect(newSegs![k].beats).toBeCloseTo(Number(expectedBeatsA.toFixed(4)), 4);
    });
  });

  // ------------------------------------------------------------
  // 3. 右クリック削除 — 頂点-1, 2セグメント→1本マージ, snap整数倍
  // ------------------------------------------------------------
  describe('3. Vertex 右クリック削除: 頂点-1, マージ, snap整数倍', () => {
    it('snap 0.25 内部頂点 idx=1 を削除: segments -1, points -1, beats_merged = |yNext - yPrev|/perBeat(prev)', () => {
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
      const idx = 2; // interior vertex at beat 2.0? Actually segments 0:0-1,1:1-2,2:2-3 so idx2 beat2
      expect(idx).toBeGreaterThan(0);
      expect(idx).toBeLessThan(pts0.length - 1);
      // [Step1] capture initial lengths and Y values
      const segLenBefore = initial.length;
      const ptLenBefore = pts0.length;
      const yPrev = pts0[idx - 1].y;
      const yNext = pts0[idx + 1].y;
      const prevBeat = pts0[idx - 1].beat;
      const perBeat = 2 * TW_AMP * tl.amplitudeAt(prevBeat);
      const expectedBeats = Math.max(snap, quantizeBeat(Math.abs(yNext - yPrev) / perBeat, snap));
      const expectedDir: Segment['direction'] = Math.abs(yNext - yPrev) < 0.5 ? 'stay' : yNext > yPrev ? 'down' : 'up';
      // [Step2] perform delete
      const newSegs = referenceVertexDelete(initial, tl, 0, idx, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert transition
      expect(newSegs!.length).toBe(segLenBefore - 1);
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      const pts1 = engine1.getPoints();
      expect(pts1.length).toBe(ptLenBefore - 1);
      expect(newSegs!.length + 1).toBe(pts1.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(newSegs![idx - 1].beats).toBeCloseTo(Number(expectedBeats.toFixed(4)), 4);
      expect(newSegs![idx - 1].direction).toBe(expectedDir);
      // far segments unchanged
      expect(newSegs![newSegs!.length - 1].direction).toBe(initial[initial.length - 1].direction);
    });

    it('端点 (idx 0 / last) は削除不可 (null 返却)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      // [Step1] capture endpoints
      expect(pts0.length).toBe(3);
      // [Step2] try delete first and last
      const delFirst = referenceVertexDelete(initial, tl, 0, 0, snap);
      const delLast = referenceVertexDelete(initial, tl, 0, pts0.length - 1, snap);
      // [Step3] assert null
      expect(delFirst).toBeNull();
      expect(delLast).toBeNull();
      // also check segment count unchanged
      expect(initial.length).toBe(2);
    });

    it('snap 0.5/0.125/1.0 でも削除後の全beats snap整数倍 (off-grid Y)', () => {
      for (const snap of [0.5, 0.125, 1.0] as const) {
        const tl = new BpmTimeline(120, [], 1.0);
        const initial: Segment[] = [
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
        ];
        const engine0 = new WaveEngine(initial, tl, 1.0, 0);
        const idx = 1; // beat 1
        // [Step1] capture
        expect(engine0.getPoints().length).toBe(initial.length + 1);
        // [Step2] delete
        const newSegs = referenceVertexDelete(initial, tl, 0, idx, snap);
        expect(newSegs).not.toBeNull();
        // [Step3] assert snap
        for (const s of newSegs!) expect(isSnapAligned(s.beats, snap), `snap ${snap} beats ${s.beats}`).toBeTruthy();
        expect(newSegs!.length).toBe(initial.length - 1);
      }
    });

    it('複雑な振幅 2.7 で prevBeat の perBeat が正しく使われる (off-grid 1.23後の削除)', () => {
      const snap = 0.25;
      const amp = 2.7;
      const tl = new BpmTimeline(120, [], amp);
      // create chart where vertex idx sits at amplitude-varying region
      const bpmChanges: BpmChange[] = [{ beat: 2, bpm: 120, amplitude: 0.7 }];
      const tl2 = new BpmTimeline(120, bpmChanges, amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl2, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 3; // beat 3 -> prevBeat 2 has amp 0.7 (changed)
      expect(tl2.amplitudeAt(pts0[idx - 1].beat)).toBeCloseTo(0.7, 2);
      const perPrev = 2 * TW_AMP * tl2.amplitudeAt(pts0[idx - 1].beat);
      expect(perPrev).toBeCloseTo(2 * TW_AMP * 0.7, 1);
      // [Step1] capture Y
      const yPrev = pts0[idx - 1].y;
      const yNext = pts0[idx + 1].y;
      const expectedBeats = Math.max(snap, quantizeBeat(Math.abs(yNext - yPrev) / perPrev, snap));
      // [Step2] perform
      const newSegs = referenceVertexDelete(initial, tl2, 0, idx, snap);
      expect(newSegs).not.toBeNull();
      // [Step3] assert perBeat-driven beats
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(newSegs![idx - 1].beats).toBeCloseTo(Number(expectedBeats.toFixed(4)), 4);
    });
  });

  // ------------------------------------------------------------
  // 4. 追加→削除 ラウンドトリップと undo 整合
  // ------------------------------------------------------------
  describe('4. 追加後削除のラウンドトリップ整合', () => {
    it('snap 0.25 で追加(+1)後に同頂点を削除(-1): 長さが元に戻る・全beats snap整数倍', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      // [Step1] capture initial
      const len0 = initial.length;
      const ptsLen0 = engine0.getPoints().length;
      const rawBeat = 1.37; // ->1.25 inside [1,2]
      const rawY = CENTER + 27.3; // small off-grid Y
      // [Step2] add
      const afterAdd = referenceVertexAdd(initial, tl, 0, rawBeat, rawY, snap);
      expect(afterAdd).not.toBeNull();
      expect(afterAdd!.length).toBe(len0 + 1);
      // find new vertex index: it's the inserted point after k (k=1)
      // Since Y-derived beats determine position, index = k+1 where k is original segment index
      const beatAdd = quantizeBeat(rawBeat, snap);
      let kOrig = -1;
      const pts0 = engine0.getPoints();
      for (let i = 0; i < pts0.length - 1; i++) if (beatAdd > pts0[i].beat + 1e-6 && beatAdd < pts0[i+1].beat - 1e-6) kOrig = i;
      expect(kOrig).toBeGreaterThan(-1);
      const engineAdd = new WaveEngine(afterAdd!, tl, 1.0, 0);
      const ptsAdd = engineAdd.getPoints();
      // inserted vertex is at index kOrig+1 (Y-derived)
      const addIdx = kOrig + 1;
      expect(ptsAdd[addIdx].beat).toBeGreaterThan(pts0[kOrig].beat);
      expect(addIdx).toBeGreaterThan(0);
      // delete that vertex
      const afterDel = referenceVertexDelete(afterAdd!, tl, 0, addIdx, snap);
      expect(afterDel).not.toBeNull();
      // [Step3] assert back to original length (but Y-derived beats may not be identical to initial)
      expect(afterDel!.length).toBe(len0);
      expect(new WaveEngine(afterDel!, tl, 1.0, 0).getPoints().length).toBe(ptsLen0);
      for (const s of afterDel!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
    });

    it('連続追加2回→連続削除2回: 各段階で snap整数倍・長さ不変量維持', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      let segs: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      // [Step1] capture
      expect(segs.length).toBe(2);
      // [Step2] add first at 0.62 (within first segment 0-2) -> quant 0.5 with 0.25
      const after1 = referenceVertexAdd(segs, tl, 0, 0.62, CENTER + 50, snap);
      expect(after1).not.toBeNull();
      segs = after1!;
      expect(segs.length).toBe(3);
      // add second: choose beat guaranteed inside last segment after first insertion
      // after1 points: segment beats Y-derived, not 2. So compute a safe beat inside last segment
      const ptsAfter1 = new WaveEngine(segs, tl, 1.0, 0).getPoints();
      const lastSegStart = ptsAfter1[ptsAfter1.length - 2].beat;
      const lastSegEnd = ptsAfter1[ptsAfter1.length - 1].beat;
      const rawBeat2 = lastSegStart + (lastSegEnd - lastSegStart) * 0.5; // mid of last segment
      const after2 = referenceVertexAdd(segs, tl, 0, rawBeat2, CENTER - 40, snap);
      expect(after2).not.toBeNull();
      segs = after2!;
      expect(segs.length).toBe(4);
      // delete interior idx 1
      const del1 = referenceVertexDelete(segs, tl, 0, 1, snap);
      expect(del1).not.toBeNull();
      segs = del1!;
      expect(segs.length).toBe(3);
      const del2 = referenceVertexDelete(segs, tl, 0, 1, snap);
      expect(del2).not.toBeNull();
      segs = del2!;
      // [Step3] back to 2 and snap
      expect(segs.length).toBe(2);
      for (const s of segs) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(new WaveEngine(segs, tl, 1.0, 0).getPoints().length).toBe(segs.length + 1);
    });
  });

  // ------------------------------------------------------------
  // 5. snap分解能網羅と off-grid 検証原則 (0.37, 1.23拍)
  // ------------------------------------------------------------
  describe('5. snap分解能網羅 & off-grid検証 (0.37/1.23)', () => {
    it('snap 0.125/0.25/0.5/1 で off-grid rawBeat 0.37/1.23 の追加が snap整数倍', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const offGridBeats = [0.37, 1.23] as const;
      for (const snap of snaps) {
        for (const rawBeat of offGridBeats) {
          const tl = new BpmTimeline(120, [], 1.0);
          const initial: Segment[] = [
            { direction: 'down', beats: 2 },
            { direction: 'up', beats: 2 },
            { direction: 'down', beats: 2 },
          ];
          const beatAdd = quantizeBeat(rawBeat, snap);
          // [Step1] capture beatAdd snap
          expect(isSnapAligned(beatAdd, snap)).toBeTruthy();
          const newSegs = referenceVertexAdd(initial, tl, 0, rawBeat, CENTER + 19.7, snap);
          if (newSegs === null) {
            // on-vertex case: verify beatAdd equals existing point
            const pts = new WaveEngine(initial, tl, 1.0, 0).getPoints();
            expect(pts.some(p => Math.abs(p.beat - beatAdd) < 1e-6)).toBeTruthy();
            continue;
          }
          // [Step3] snap
          for (const s of newSegs) expect(isSnapAligned(s.beats, snap), `snap ${snap} raw ${rawBeat}`).toBeTruthy();
        }
      }
    });

    it('削除の off-grid Yでも snap整数倍 (amp 0.7/1.3/2.7/3.4)', () => {
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const snaps = [0.25, 0.5] as const;
      for (const amp of amps) {
        for (const snap of snaps) {
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
          ];
          // need to choose Y that yields off-grid derived beats; but reference delete uses Y diff of existing points
          // So test that deletion still snap-aligned regardless of amp
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const idx = 2; // interior
          const newSegs = referenceVertexDelete(initial, tl, 0, idx, snap);
          expect(newSegs).not.toBeNull();
          for (const s of newSegs!) expect(isSnapAligned(s.beats, snap), `amp ${amp} snap ${snap}`).toBeTruthy();
          expect(newSegs!.length).toBe(initial.length - 1);
          expect(new WaveEngine(newSegs!, tl, amp, 0).getPoints().length).toBe(engine0.getPoints().length - 1);
        }
      }
    });

    it('リスト駆動 amplitudeAt off-grid: 3.37(1.0)/4.37(2.0) で追加/削除の perBeat が step する', () => {
      const snap = 0.25;
      const bpmChanges: BpmChange[] = [{ beat: 4, bpm: 120, amplitude: 2.0 }];
      const tl = new BpmTimeline(120, bpmChanges, 1.0);
      // [Step1] capture step at off-grid
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 4);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(2.0, 4);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const pts0 = new WaveEngine(initial, tl, 1.0, 0).getPoints();
      // add inside segment starting at beat 4 (amp 2.0) with off-grid 4.37 ->4.25 or 4.5?
      const rawBeat = 4.37; // quant 4.25 with snap 0.25
      const beatAdd = quantizeBeat(rawBeat, snap);
      expect(beatAdd).toBeCloseTo(4.25, 4);
      expect(tl.amplitudeAt(beatAdd)).toBeCloseTo(2.0, 2);
      const newSegs = referenceVertexAdd(initial, tl, 0, rawBeat, CENTER + 55, snap);
      expect(newSegs).not.toBeNull();
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      // delete vertex after change (prevBeat amp 2.0)
      const ptsAfter = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
      const delIdx = ptsAfter.findIndex(p => Math.abs(p.beat - beatAdd) < 1e-6);
      expect(delIdx).toBeGreaterThan(0);
      const del = referenceVertexDelete(newSegs!, tl, 0, delIdx, snap);
      expect(del).not.toBeNull();
      for (const s of del!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
    });
  });

  // ------------------------------------------------------------
  // 6. 回帰: getPoints 不変量・上下幅固定・cursor/wave一致 (T127/T128)
  // ------------------------------------------------------------
  describe('6. 回帰: getPoints構造, 上下幅固定, wave/cursor一致', () => {
    it('追加/削除後も getPoints.length === segments.length+1 かつ {beat,y} のみ', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const cases: Segment[][] = [
        [{ direction: 'down', beats: 1 }],
        [
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
        ],
        [
          { direction: 'down', beats: 0.5 },
          { direction: 'stay', beats: 1 },
          { direction: 'up', beats: 0.5 },
        ],
      ];
      for (const initial of cases) {
        // [Step1] capture
        const engine0 = new WaveEngine(initial, tl, 1.0, 0);
        expect(engine0.getPoints().length).toBe(initial.length === 0 ? 2 : initial.length + 1);
        if (initial.length >= 1) {
          // try add in first segment if possible
          const midBeat = quantizeBeat(initial[0].beats / 2, snap);
          if (midBeat > 0 && midBeat < initial[0].beats) {
            const added = referenceVertexAdd(initial, tl, 0, midBeat, CENTER, snap);
            if (added) {
              expect(added.length).toBe(initial.length + 1);
              const pts = new WaveEngine(added, tl, 1.0, 0).getPoints();
              expect(pts.length).toBe(added.length + 1);
              for (const p of pts) {
                expect(typeof p.beat).toBe('number');
                expect(typeof p.y).toBe('number');
                expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
              }
              // try delete added vertex
              const ptsAdd = new WaveEngine(added, tl, 1.0, 0).getPoints();
              const idx = ptsAdd.findIndex(p => Math.abs(p.beat - midBeat) < 1e-6);
              if (idx > 0 && idx < ptsAdd.length - 1) {
                const deleted = referenceVertexDelete(added, tl, 0, idx, snap);
                if (deleted) {
                  expect(deleted.length).toBe(initial.length);
                  expect(new WaveEngine(deleted, tl, 1.0, 0).getPoints().length).toBe(initial.length === 0 ? 2 : initial.length + 1);
                }
              }
            }
          }
        }
      }
    });

    it('振幅変更で上下幅は TW_AMP=130 固定、追加/削除の beats のみ変化', () => {
      const snap = 0.25;
      const amps = [0.7, 2.7] as const;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        const ys = engine.getPoints().map(p => p.y);
        expect(Math.max(...ys)).toBeLessThanOrEqual(BOTTOM + 1e-6);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(TOP - 1e-6);
        // add still snap
        const added = referenceVertexAdd(segs, tl, 0, 0.63, CENTER, snap);
        expect(added).not.toBeNull();
        for (const s of added!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      }
      // perBeat scales, height does not (clipped slope differs)
      const tl07 = new BpmTimeline(120, [], 0.7);
      const tl27 = new BpmTimeline(120, [], 2.7);
      const e07 = new WaveEngine([{ direction: 'down', beats: 10 }], tl07, 0.7, 0);
      const e27 = new WaveEngine([{ direction: 'down', beats: 10 }], tl27, 2.7, 0);
      expect(e07.waveYAt(0.2)).not.toBeCloseTo(e27.waveYAt(0.2), 1);
      expect(e07.waveYAt(10)).toBeCloseTo(BOTTOM, 1);
      expect(e27.waveYAt(10)).toBeCloseTo(BOTTOM, 1);
    });

    it('waveYAt と cursor の perBeat 一致が追加/削除後も維持 (amp 1.3 off-grid)', async () => {
      const { Cursor } = await import('../src/game/cursor');
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      // use Y far from center to ensure non-stay first segment
      const rawY = CENTER + 90; // ensures dA not stay
      const added = referenceVertexAdd(
        [{ direction: 'down', beats: 3 }, { direction: 'up', beats: 3 }],
        tl, 0, 1.37, rawY, snap
      );
      expect(added).not.toBeNull();
      // first segment direction should be down (since rawY > center)
      expect(added![0].direction).toBe('down');
      expect(added![0].beats).toBeGreaterThan(0);
      const engine = new WaveEngine(added!, tl, amp, 0);
      const firstBeats = added![0].beats;
      // choose delta well within first segment and before clip
      const delta = Math.min(0.2, firstBeats * 0.4);
      expect(delta).toBeGreaterThan(0);
      const dy2 = engine.waveYAt(delta) - engine.waveYAt(0);
      expect(Math.abs(dy2 / delta)).toBeCloseTo(2 * TW_AMP * amp, 0);
      const cursor = new Cursor(amp, 0);
      const beatMs = 500;
      cursor.update((delta * beatMs) / 1000, false, true, beatMs, 1);
      const expectedY = clampY(CENTER + 2 * TW_AMP * amp * delta);
      expect(cursor.y).toBeCloseTo(expectedY, 1);
      expect(engine.waveYAt(delta)).toBeCloseTo(expectedY, 1);
    });
  });

  // ------------------------------------------------------------
  // 7. エッジ: 空segments / 単一セグメントでの追加/削除
  // ------------------------------------------------------------
  describe('7. エッジケース: 空・単一・境界Y', () => {
    it('segments=[] では追加不可 (null)', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [];
      // [Step1] capture empty
      expect(new WaveEngine(initial, tl, 1.0, 0).getPoints().length).toBe(2);
      // [Step2] try add at beat 1.37
      const added = referenceVertexAdd(initial, tl, 0, 1.37, CENTER, snap);
      // [Step3] no segment to split
      expect(added).toBeNull();
    });

    it('単一セグメントを off-grid 中央追加: 2分割され両beats snap整数倍', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [{ direction: 'down', beats: 2 }];
      // [Step1] capture
      expect(initial.length).toBe(1);
      const rawBeat = 0.37; // ->0.5 with snap 0.5
      // [Step2] add
      const added = referenceVertexAdd(initial, tl, 0, rawBeat, CENTER, snap);
      expect(added).not.toBeNull();
      // [Step3] assert 2 segments, snap
      expect(added!.length).toBe(2);
      for (const s of added!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(new WaveEngine(added!, tl, 1.0, 0).getPoints().length).toBe(3);
    });

    it('Yが上下端近く (TOP/BOTTOM) でも clamp され beats は snap整数倍', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      for (const rawY of [TOP - 50, BOTTOM + 50] as const) {
        // [Step1] capture clamp
        expect(clampY(rawY)).toBeGreaterThanOrEqual(TOP - 1e-6);
        expect(clampY(rawY)).toBeLessThanOrEqual(BOTTOM + 1e-6);
        // [Step2] add at off-grid 1.23
        const added = referenceVertexAdd(initial, tl, 0, 1.23, rawY, snap);
        if (added === null) continue; // if beat on vertex, skip
        // [Step3] snap
        for (const s of added) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      }
      // delete with extreme Y diff also snap
      const del = referenceVertexDelete(initial, tl, 0, 1, snap);
      expect(del).not.toBeNull();
      for (const s of del!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
    });
  });
});
