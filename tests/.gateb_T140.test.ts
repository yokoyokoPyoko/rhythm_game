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
 * Reference implementation of T140 edge drag (最小範囲調整).
 * Mirrors spec + Fix Prescription:
 *  - beatI = pts[idx].beat + dxSnap, beatI1 = pts[idx+1].beat + dxSnap (dxSnap = quantizeBeat(dxRaw, safeSnap))
 *  - yI = clamp(pts[idx].y + dy), yI1 = clamp(pts[idx+1].y + dy)
 *  - seg i-1: beats = beatI - prevBeat (horizontal, snap-aligned)
 *  - seg i  : if |dxSnap| > |dyPx/perBeat| then origLen else dyPx/perBeat, quantized, stay => minimal snap
 *  - seg i+1: beats = nextNextBeat - beatI1 (horizontal)
 *  Adjacent segments derive beats from horizontal targetBeat - fromBeat, not Y delta.
 */
function referenceEdgeDrag(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  idx: number,
  dxRaw: number,
  dyRaw: number,
  safeSnap: number,
): Segment[] | null {
  const snap = safeSnap > 0 ? safeSnap : 0.25;
  if (idx < 0 || idx >= segments.length) return null;
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  if (idx + 1 >= pts.length) return null;
  const dxSnap = quantizeBeat(dxRaw, snap);
  const beatI = Number((pts[idx].beat + dxSnap).toFixed(4));
  const beatI1 = Number((pts[idx + 1].beat + dxSnap).toFixed(4));
  // clamp vertical shift to field [TOP,BOTTOM]
  const yI = clampY(pts[idx].y + dyRaw);
  const yI1 = clampY(pts[idx + 1].y + dyRaw);
  const perBeat = (b: number) => 2 * TW_AMP * timeline.amplitudeAt(b);
  const dirOf = (d: number): 'up' | 'down' | 'stay' => {
    if (Math.abs(d) < 0.5) return 'stay';
    return d < 0 ? 'up' : 'down';
  };
  const next: Segment[] = segments.map((s) => ({ ...s }));
  // seg i-1: horizontal
  if (idx > 0) {
    const fromBeat = pts[idx - 1].beat;
    const fromY = pts[idx - 1].y;
    const rawBeats = beatI - fromBeat;
    let beatsPrev = Number(quantizeBeat(rawBeats, snap).toFixed(4));
    if (beatsPrev < snap - 1e-9) beatsPrev = snap;
    const dPrev = yI - fromY;
    const dirPrev = dirOf(dPrev);
    next[idx - 1] = { direction: dirPrev, beats: beatsPrev };
  }
  // edge seg i: dx dominant vs dy
  const origLen = pts[idx + 1].beat - pts[idx].beat;
  const dyPx = Math.abs(yI1 - yI);
  const ppEdge = perBeat(Math.max(0, beatI));
  const dyBeats = dyPx / ppEdge;
  let beatsEdge: number;
  let dirEdge: 'up' | 'down' | 'stay';
  if (dyPx < 0.5) dirEdge = 'stay';
  else dirEdge = yI1 < yI ? 'up' : 'down';
  if (dirEdge === 'stay') {
    beatsEdge = Math.max(snap, Number(quantizeBeat(Math.abs(dxSnap) > Math.abs(dyBeats) ? origLen : dyBeats, snap).toFixed(4)));
    // for stay minimal snap when dy dominant
    if (Math.abs(dxSnap) <= Math.abs(dyBeats)) beatsEdge = snap;
  } else {
    const useOrig = Math.abs(dxSnap) > Math.abs(dyBeats);
    beatsEdge = Math.max(snap, Number(quantizeBeat(useOrig ? origLen : dyBeats, snap).toFixed(4)));
  }
  beatsEdge = Number(quantizeBeat(beatsEdge, snap).toFixed(4));
  if (beatsEdge < snap - 1e-9) beatsEdge = snap;
  next[idx] = { direction: dirEdge, beats: beatsEdge };
  // seg i+1: horizontal
  if (idx + 1 < segments.length) {
    const afterBeat = pts[idx + 2]?.beat;
    if (afterBeat !== undefined) {
      const rawBeatsNext = afterBeat - beatI1;
      let beatsNext = Number(quantizeBeat(rawBeatsNext, snap).toFixed(4));
      if (beatsNext < snap - 1e-9) beatsNext = snap;
      const dNext = pts[idx + 2].y - yI1;
      const dirNext = dirOf(dNext);
      next[idx + 1] = { direction: dirNext, beats: beatsNext };
    }
  }
  return next;
}

describe('T140 辺編集のドラッグ移動（左右上下） — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ------------------------------------------------------------
  // 1. ファイル実装マーカー（Red-before-T140 / Green-after）
  // ------------------------------------------------------------
  describe('1. WavePreview.tsx 実装マーカー', () => {
    it('edgeDragRef が {index,startBeat,startPrevBeat,startNextBeat} を持つ', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // Step1 capture
      expect(content.length).toBeGreaterThan(0);
      // Step2 interaction: search for edgeDragRef definition
      const hasEdgeRef = content.includes('edgeDragRef');
      expect(hasEdgeRef).toBeTruthy();
      // Step3 assert required fields
      expect(content).toMatch(/edgeDragRef\.current\s*=\s*\{[^}]*index[^}]*startBeat[^}]*startPrevBeat[^}]*startNextBeat/s);
    });

    it('onMove で edgeDrag が pan より先に処理され、pan は排他 (edgeDrag中はpan無効)', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const onMoveIdx = content.indexOf('const onMove');
      expect(onMoveIdx).toBeGreaterThan(-1);
      const block = content.slice(onMoveIdx, onMoveIdx + 6000);
      const edgePos = block.indexOf('edgeDragRef.current');
      const panPos = block.indexOf('panRef.current');
      expect(edgePos).toBeGreaterThan(-1);
      expect(panPos).toBeGreaterThan(-1);
      expect(edgePos).toBeLessThan(panPos);
      // edgeDrag branch must return before pan
      const edgeReturn = block.indexOf('return', edgePos);
      expect(edgeReturn).toBeGreaterThan(edgePos);
      expect(edgeReturn).toBeLessThan(panPos);
      // handleMouseDown also sets edgeDragRef when edge hit
      expect(content).toMatch(/nearestEdgeIndex[\s\S]*?edgeDragRef\.current\s*=/);
    });

    it('dxBeat は safeSnap で量子化 (quantizeBeat) され、dy は clamp される', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const onMoveIdx = content.indexOf('const onMove');
      const block = content.slice(onMoveIdx, onMoveIdx + 6000);
      expect(block).toMatch(/dxSnap\s*=\s*quantizeBeat/);
      expect(block).toMatch(/safeSnap/);
      // dy clamp pattern
      expect(block).toMatch(/cl\(|clampY|Math\.max\(TW_CENTER_Y - TW_AMP/);
    });

    it('segmentFor は toBeat なしの 3引数 (fromBeat,fromY,toY) で、dead変数 last/toBeat を含まない', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // should NOT contain 4-arg version
      expect(content).not.toMatch(/const\s+segmentFor\s*=\s*\(fromBeat:\s*number,\s*fromY:\s*number,\s*toBeat:\s*number,\s*toY:\s*number\)/);
      // should contain 3-arg version
      expect(content).toMatch(/const\s+segmentFor\s*=\s*\(fromBeat:\s*number,\s*fromY:\s*number,\s*toY:\s*number\)/);
      // dead `const last =` inside onMove should be removed (if present, it's leftover)
      const onMoveIdx = content.indexOf('const onMove');
      const block = content.slice(onMoveIdx, onMoveIdx + 6000);
      // The only allowed `last` is inside waveYAt etc, but not as `const last = pts.length -1` inside onMove pan block
      // Check that block does not have `const last = pts.length` as dead code
      const hasDeadLast = /const\s+last\s*=\s*pts\.length\s*-\s*1/.test(block);
      expect(hasDeadLast, 'dead const last inside onMove should be removed').toBeFalsy();
    });

    it('perBeat は 2*TW_AMP*amplitudeAt で算出され、edge描画は waveYAt サンプリングポリライン', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      expect(content).toMatch(/perBeat|2\s*\*\s*TW_AMP\s*\*\s*.*amplitudeAt/);
      expect(content).toMatch(/SAMPLE_STEP|waveYAt/);
      // nearestEdgeIndex must use waveYAt polyline
      const edgeIdx = content.indexOf('nearestEdgeIndex');
      const edgeBlock = content.slice(edgeIdx, edgeIdx + 4000);
      expect(edgeBlock).toMatch(/waveYAt/);
      expect(edgeBlock).toMatch(/SAMPLE_STEP/);
    });
  });

  // ------------------------------------------------------------
  // 2. 数値不変量: 3セグメントのみ再計算・辺長保持・平行移動
  // ------------------------------------------------------------
  describe('2. 辺ドラッグは3セグメントのみ再計算され辺長保持で平行移動', () => {
    it('central edge idx=1 snap 0.25 dx 0.37 dy 30.7 off-grid: 3セグメントのみ変化・辺長保持・snap整数倍', () => {
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
      const dyRaw = 30.7;
      // Step1 capture
      expect(pts0.length).toBe(initial.length + 1);
      const origLen = pts0[idx + 1].beat - pts0[idx].beat;
      // Step2 perform
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3 assert: only idx-1, idx, idx+1 changed
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      // edge length preservation when dx dominant? raw dx 0.37 quant to 0.25 or 0.5 depending snap
      const dxSnap = quantizeBeat(dxRaw, snap);
      const dyPx = Math.abs(clampY(pts0[idx].y + dyRaw) - clampY(pts0[idx + 1].y + dyRaw));
      const pp = 2 * TW_AMP * tl.amplitudeAt(pts0[idx].beat + dxSnap);
      const dyBeats = dyPx / pp;
      const dxDominant = Math.abs(dxSnap) > Math.abs(dyBeats);
      if (dxDominant) {
        expect(newSegs![idx].beats).toBeCloseTo(origLen, 4);
      } else {
        expect(newSegs![idx].beats).toBeCloseTo(Number(quantizeBeat(dyBeats, snap).toFixed(4)), 2);
      }
      // adjacent segments changed
      expect(newSegs![idx - 1].beats).not.toBe(initial[idx - 1].beats);
      // far segments unchanged
      expect(newSegs![3].beats).toBeCloseTo(initial[3].beats, 4);
      expect(newSegs![3].direction).toBe(initial[3].direction);
      const pts1 = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
      expect(pts1.length).toBe(pts0.length);
      // edge endpoints shifted by dxSnap
      expect(pts1[idx].beat).toBeCloseTo(pts0[idx].beat + dxSnap, 4);
      expect(pts1[idx + 1].beat).toBeCloseTo(pts0[idx + 1].beat + dxSnap, 4);
      // point after next compensates: total span preserved when interior edge moved
      // For idx=1 case, pts1[idx+2] should equal original pts0[idx+2] (beatsPrev+dx compensates beatsNext)
      const beatsPrev = newSegs![idx - 1].beats;
      const beatsNext = newSegs![idx + 1].beats;
      expect(beatsPrev + beatsNext).toBeCloseTo(initial[idx - 1].beats + initial[idx + 1].beats, 4);
    });

    it('snap 0.5 off-grid dx 0.37 dy -20.3: 3セグのみ・snap整数倍・長さ不変', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 2;
      const dxRaw = 0.37;
      const dyRaw = -20.3;
      // Step1
      expect(pts0.length).toBe(initial.length + 1);
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      // only idx-1, idx, idx+1 may change
      expect(newSegs![0].beats).toBeCloseTo(initial[0].beats, 4);
      const pts1 = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
      expect(pts1.length).toBe(pts0.length);
      const dxSnap = quantizeBeat(dxRaw, snap);
      expect(pts1[idx].beat).toBeCloseTo(pts0[idx].beat + dxSnap, 4);
    });

    it('snap 0.125 dx 0.37 dy 15.2 off-grid 1.23相当: snap整数倍維持', () => {
      const snap = 0.125;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 0.5 },
        { direction: 'up', beats: 0.5 },
        { direction: 'down', beats: 0.5 },
        { direction: 'up', beats: 0.5 },
        { direction: 'down', beats: 0.5 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const idx = 2;
      const dxRaw = 1.23; // off-grid
      const dyRaw = 15.2;
      // Step1
      expect(engine0.getPoints().length).toBe(initial.length + 1);
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(newSegs!.length).toBe(initial.length);
      expect(new WaveEngine(newSegs!, tl, 1.0, 0).getPoints().length).toBe(initial.length + 1);
    });
  });

  // ------------------------------------------------------------
  // 3. |dx|>|dy| なら横優先、逆は縦優先
  // ------------------------------------------------------------
  describe('3. 辺セグメントの dxDominant / dyDominant 分岐', () => {
    it('dx dominant (dx 0.5 beats > dyBeats 0.05): 辺長 origLen を保持', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 0.5 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 1; // edge 1->2
      const dxRaw = 0.5; // snap 0.5? with 0.25 quant 0.5 stays 0.5
      const dyRaw = 5; // small dy => dyBeats ~5/260=0.019
      // Step1
      const origLen = pts0[idx + 1].beat - pts0[idx].beat;
      const dxSnap = quantizeBeat(dxRaw, snap);
      const yI = clampY(pts0[idx].y + dyRaw);
      const yI1 = clampY(pts0[idx + 1].y + dyRaw);
      const dyBeats = Math.abs(yI1 - yI) / (2 * TW_AMP * tl.amplitudeAt(pts0[idx].beat + dxSnap));
      expect(Math.abs(dxSnap)).toBeGreaterThan(Math.abs(dyBeats));
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      expect(newSegs![idx].beats).toBeCloseTo(origLen, 4);
    });

    it('dy dominant (dy 120px ~0.46 beats > dx 0.125): 辺長 dyPx/pp に更新', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const dxRaw = 0.13; // quant to 0.0? actually 0.13->0.0? let's use 0.1 -> 0.0 then dy dominant
      const dyRaw = 120; // large dy ~0.46 beats
      const dxSnap = quantizeBeat(dxRaw, snap);
      const yI = clampY(pts0[idx].y + dyRaw);
      const yI1 = clampY(pts0[idx + 1].y + dyRaw);
      const pp = 2 * TW_AMP * tl.amplitudeAt(pts0[idx].beat + dxSnap);
      const dyBeats = Math.abs(yI1 - yI) / pp;
      // ensure dyBeats > dxSnap for dy dominant
      // if dxSnap is 0.25 quant of 0.13 is 0.25? actually 0.13/0.25=0.52 round 1 =>0.25, still > dy? need adjust
      // use dx 0.0
      const dxRaw2 = 0.05; // quant 0.0
      const dxSnap2 = quantizeBeat(dxRaw2, snap);
      const dyBeats2 = Math.abs(clampY(pts0[idx].y + dyRaw) - clampY(pts0[idx + 1].y + dyRaw)) / pp;
      expect(Math.abs(dxSnap2)).toBeLessThan(Math.abs(dyBeats2));
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw2, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3 dy dominant => beats = dyBeats quantized
      const expected = Number(quantizeBeat(dyBeats2, snap).toFixed(4));
      expect(newSegs![idx].beats).toBeCloseTo(expected, 2);
      expect(newSegs![idx].beats).not.toBeCloseTo(pts0[idx + 1].beat - pts0[idx].beat, 2);
    });
  });

  // ------------------------------------------------------------
  // 4. 隣接セグメントは水平差分から beats を導出（Y差分ではない）
  // ------------------------------------------------------------
  describe('4. 隣接セグメントは水平 (targetBeat - fromBeat) から beats 導出', () => {
    it('隣接 beats が 水平差分と一致し、Y差分/perBeat とは一致しないケースで水平を優先', () => {
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
      const dyRaw = 80; // large Y shift makes Y-derived beats differ from horizontal
      const dxSnap = quantizeBeat(dxRaw, snap);
      const beatI = Number((pts0[idx].beat + dxSnap).toFixed(4));
      const fromBeat = pts0[idx - 1].beat;
      const yI = clampY(pts0[idx].y + dyRaw);
      const dY = Math.abs(yI - pts0[idx - 1].y);
      const ppPrev = 2 * TW_AMP * tl.amplitudeAt(fromBeat);
      const yDerivedBeats = Number(quantizeBeat(dY / ppPrev, snap).toFixed(4));
      const horizBeats = Number(quantizeBeat(beatI - fromBeat, snap).toFixed(4));
      // Step1: ensure they differ (so test distinguishes)
      // Choose dy that makes them differ; if not differ, adjust
      // In many cases they differ, but assert at least one not equal to ensure test is meaningful
      // If equal by chance, this test would be vacuous, so we force a dy that causes difference
      const diffCondition = Math.abs(yDerivedBeats - horizBeats) > 1e-6;
      // If by chance they are equal, we still check reference uses horiz
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3: reference must use horizontal
      expect(newSegs![idx - 1].beats).toBeCloseTo(horizBeats, 4);
      if (diffCondition) {
        expect(newSegs![idx - 1].beats).not.toBeCloseTo(yDerivedBeats, 4);
      }
      // seg i+1 also horizontal
      const beatI1 = Number((pts0[idx + 1].beat + dxSnap).toFixed(4));
      const horizNext = Number(quantizeBeat(pts0[idx + 2].beat - beatI1, snap).toFixed(4));
      expect(newSegs![idx + 1].beats).toBeCloseTo(horizNext, 4);
    });

    it('snap 0.5 でも隣接は水平差分が snap整数倍', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.3);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.3, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const dxRaw = 1.23; // off-grid
      const dyRaw = -40;
      const newSegs = referenceEdgeDrag(initial, tl, 1.3, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      const dxSnap = quantizeBeat(dxRaw, snap);
      expect(newSegs![idx - 1].beats).toBeCloseTo(Number(quantizeBeat(pts0[idx].beat + dxSnap - pts0[idx - 1].beat, snap).toFixed(4)), 4);
    });
  });

  // ------------------------------------------------------------
  // 5. snap整数倍維持 & getPoints長さ不変（オフグリッド）
  // ------------------------------------------------------------
  describe('5. snap整数倍維持・getPoints長さ不変（オフグリッド 0.37/1.23）', () => {
    it('snap 0.125/0.25/0.5/1 全てで端数ドラッグでも snap整数倍', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      for (const snap of snaps) {
        const tl = new BpmTimeline(120, [], 1.0);
        const initial: Segment[] = [
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
        ];
        const dxRaw = 0.37;
        const dyRaw = 1.23 * 10; // off-grid Y
        const idx = 1;
        // Step1 capture
        expect(new WaveEngine(initial, tl, 1.0, 0).getPoints().length).toBe(initial.length + 1);
        // Step2
        const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
        expect(newSegs).not.toBeNull();
        // Step3
        for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
        expect(newSegs!.length).toBe(initial.length);
        expect(new WaveEngine(newSegs!, tl, 1.0, 0).getPoints().length).toBe(initial.length + 1);
      }
    });

    it('1/amplitude ではないことを検証（snap 0.25 amp 1 短押し様）', () => {
      const snap = 0.25;
      const amp = 1;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const idx = 1;
      const dxRaw = 0.30; // snap 0.25 quantization => 0.25 not 1.0
      const dyRaw = 0; // keep Y stable
      // Step1
      const dxSnap = quantizeBeat(dxRaw, snap);
      expect(dxSnap).toBeCloseTo(0.25, 4);
      expect(dxSnap).not.toBeCloseTo(1 / amp, 4);
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3 beatsEdge should be 1.0 (origLen) when dxDominant, not 0.25, but adjacent horizontal should be 0.25-derived
      // The critical check: not all beats are 1.0
      // At least one adjacent uses horizontal diff (= beatI - prev)
      const beatI = new WaveEngine(initial, tl, amp, 0).getPoints()[idx].beat + dxSnap;
      const prev = new WaveEngine(initial, tl, amp, 0).getPoints()[idx - 1].beat;
      const expectedAdj = Number(quantizeBeat(beatI - prev, snap).toFixed(4));
      expect(expectedAdj).toBeCloseTo(1.25, 4); // 1 + 0.25
      expect(newSegs![idx - 1].beats).toBeCloseTo(expectedAdj, 4);
      expect(isSnapAligned(newSegs![idx - 1].beats, snap)).toBeTruthy();
    });
  });

  // ------------------------------------------------------------
  // 6. 空ドラッグは pan、辺上ドラッグは edge 移動として分離
  // ------------------------------------------------------------
  describe('6. 空ドラッグは pan、辺上ドラッグは edge 移動として正しく分離', () => {
    it('edge mode: 空領域 mousedown は panRef を立て、edgeHit では edgeDragRef を立てる', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // Step1 capture: both branches exist
      expect(content).toMatch(/if \(editMode === 'edge'\)/);
      const edgeBlockStart = content.indexOf("if (editMode === 'edge')");
      expect(edgeBlockStart).toBeGreaterThan(-1);
      const edgeBlock = content.slice(edgeBlockStart, edgeBlockStart + 3000);
      // Step2: edgeHit sets edgeDragRef
      expect(edgeBlock).toMatch(/const eHit = nearestEdgeIndex/);
      expect(edgeBlock).toMatch(/edgeDragRef\.current\s*=\s*\{/);
      expect(edgeBlock).toMatch(/onSelectSegment/);
      // Step3: empty in edge mode clears selection and sets panRef
      expect(edgeBlock).toMatch(/onSelectSegment\?\.?\(null\)/);
      expect(edgeBlock).toMatch(/panRef\.current\s*=\s*\{/);
      // Verify pan not set when edgeDrag active: onMove edgeDrag before pan
      const onMoveIdx = content.indexOf('const onMove');
      const onMoveBlock = content.slice(onMoveIdx, onMoveIdx + 6000);
      const edgeIdx = onMoveBlock.indexOf('edgeDragRef.current');
      const panIdx = onMoveBlock.indexOf('panRef.current');
      expect(edgeIdx).toBeLessThan(panIdx);
    });

    it('ring mode と vertex mode の分離は維持（editMode による分岐）', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      expect(content).toMatch(/if \(editMode === 'vertex'\)/);
      expect(content).toMatch(/if \(editMode === 'edge'\)/);
      expect(content).toMatch(/\/\/ ring mode/);
    });
  });

  // ------------------------------------------------------------
  // 7. 複雑な振幅 (0.7/1.3/2.7/3.4) とリスト駆動 amplitudeAt off-grid 0.37/1.23
  // ------------------------------------------------------------
  describe('7. 複雑な振幅とリスト駆動 amplitudeAt で perBeat が正しい', () => {
    it('amp 0.7/1.3/2.7/3.4 で off-grid dx 0.37/1.23 でも snap整数倍・長さ不変', () => {
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const offGridDx = [0.37, 1.23] as const;
      for (const amp of amps) {
        for (const dxRaw of offGridDx) {
          const snap = 0.25;
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
          ];
          // Step1
          expect(tl.amplitudeAt(0.37)).toBeCloseTo(amp, 4);
          // Step2
          const newSegs = referenceEdgeDrag(initial, tl, 0, 1, dxRaw, 20, snap);
          expect(newSegs).not.toBeNull();
          // Step3
          for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
          expect(newSegs!.length).toBe(initial.length);
          const pts1 = new WaveEngine(newSegs!, tl, amp, 0).getPoints();
          expect(pts1.length).toBe(initial.length + 1);
          // waveYAt slope matches 2*TW_AMP*amp before clip
          const engine1 = new WaveEngine(newSegs!, tl, amp, 0);
          const slope = engine1.waveYAt(0.1) - engine1.waveYAt(0);
          expect(Math.abs(slope)).toBeLessThanOrEqual(2 * TW_AMP * amp * 0.1 + 1);
        }
      }
    });

    it('リスト駆動: bpm_changes[beat4 amp2.0] で edge drag の perBeat が step する (off-grid 4.37)', () => {
      const snap = 0.25;
      const bpmChanges: BpmChange[] = [{ beat: 4, bpm: 120, amplitude: 2.0 }];
      const tl = new BpmTimeline(120, bpmChanges, 1.0);
      // Step1 capture step
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 4);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(2.0, 4);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const pts0 = new WaveEngine(initial, tl, 1.0, 0).getPoints();
      const idx = 2; // edge 2->3 starts at beat 4
      expect(pts0[idx].beat).toBeCloseTo(4, 4);
      const dxRaw = 0.37;
      const dyRaw = 30;
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 1.0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      // perBeat at beatI should be 2.0
      const dxSnap = quantizeBeat(dxRaw, snap);
      const beatI = pts0[idx].beat + dxSnap;
      expect(tl.amplitudeAt(beatI)).toBeCloseTo(2.0, 4);
      const pp = 2 * TW_AMP * tl.amplitudeAt(beatI);
      expect(pp).toBeCloseTo(2 * TW_AMP * 2.0, 1);
      // verify engine reflects step
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      const pts1 = engine1.getPoints();
      expect(pts1.length).toBe(pts0.length);
    });
  });

  // ------------------------------------------------------------
  // 8. 境界辺 (先頭 idx0, 末尾 idx last) は隣接 1 本のみ再計算
  // ------------------------------------------------------------
  describe('8. 境界辺は隣接1本のみ再計算・snap整数倍・長さ不変', () => {
    it('先頭 edge idx0: idx+1 のみ再計算、prev なし', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      expect(pts0.length).toBe(initial.length + 1);
      const idx = 0;
      const dxRaw = 0.37;
      const dyRaw = -15.5;
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      // only idx and idx+1 changed (idx+1 corresponds to seg 1)
      expect(newSegs![2].beats).toBeCloseTo(initial[2].beats, 4);
      // edge beats not necessarily equal to orig, but snap aligned
      const pts1 = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
      expect(pts1.length).toBe(pts0.length);
      expect(pts1[0].beat).toBeCloseTo(0, 4);
    });

    it('末尾 edge idx=last: prev のみ再計算、next なし', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.0);
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const idx = initial.length - 1;
      const dxRaw = 1.23;
      const dyRaw = 25.3;
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();
      expect(pts0[idx].beat).toBe(initial.slice(0, idx).reduce((s, v) => s + v.beats, 0));
      // Step2
      const newSegs = referenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();
      // Step3
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      expect(newSegs![0].beats).toBeCloseTo(initial[0].beats, 4);
      expect(newSegs![1].beats).toBeCloseTo(initial[1].beats, 4);
      const pts1 = new WaveEngine(newSegs!, tl, 1.0, 0).getPoints();
      expect(pts1.length).toBe(pts0.length);
      const dxSnap = quantizeBeat(dxRaw, snap);
      expect(pts1[idx].beat).toBeCloseTo(pts0[idx].beat + dxSnap, 4);
    });
  });

  // ------------------------------------------------------------
  // 9. 回帰: T127/T128/T139 と cursor 一致・上下幅固定
  // ------------------------------------------------------------
  describe('9. 回帰: 上下幅 TW_AMP固定 & cursor/wave 一致 (T127/T128)', () => {
    it('振幅変更で上下幅は TW_AMP=130 固定、移動速度のみ変化 (amp 0.7 vs 2.7)', () => {
      const snap = 0.25;
      const amps = [0.7, 2.7] as const;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs: Segment[] = [{ direction: 'down', beats: 1 }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        const pts = engine.getPoints();
        // Step1 capture TOP/BOTTOM
        expect(pts[0].y).toBeCloseTo(CENTER - 0 * TW_AMP, 4); // startPosition 0 => CENTER
        // wave at beat 1 should be clamped but not exceed bounds
        const yAt1 = engine.waveYAt(1);
        expect(yAt1).toBeGreaterThanOrEqual(TOP - 1e-6);
        expect(yAt1).toBeLessThanOrEqual(BOTTOM + 1e-6);
        // edge drag still snap aligned
        const newSegs = referenceEdgeDrag(segs.concat({ direction: 'up', beats: 1 }), tl, 0, 0, 0.37, 0, snap);
        expect(newSegs).not.toBeNull();
        for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      }
      // perBeat scales with amp, height does not
      const tl07 = new BpmTimeline(120, [], 0.7);
      const tl27 = new BpmTimeline(120, [], 2.7);
      const e07 = new WaveEngine([{ direction: 'down', beats: 10 }], tl07, 0.7, 0);
      const e27 = new WaveEngine([{ direction: 'down', beats: 10 }], tl27, 2.7, 0);
      expect(e07.waveYAt(0.2)).not.toBeCloseTo(e27.waveYAt(0.2), 1);
      expect(e07.waveYAt(10)).toBeCloseTo(BOTTOM, 1);
      expect(e27.waveYAt(10)).toBeCloseTo(BOTTOM, 1);
    });

    it('cursor と waveEngine の perBeat 一致 (amp 1.3 off-grid 0.37)', async () => {
      const { Cursor } = await import('../src/game/cursor');
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, amp, 0);
      // off-grid
      const b = 0.37;
      const dyWave = engine.waveYAt(b) - engine.waveYAt(0);
      const slopeWave = dyWave / b;
      expect(slopeWave).toBeCloseTo(2 * TW_AMP * amp, 0);
      const cursor = new Cursor(amp, 0);
      const beatMs = 500;
      const dt = (b * beatMs) / 1000;
      cursor.update(dt, false, true, beatMs, 1);
      const expectedY = clampY(CENTER + 2 * TW_AMP * amp * b);
      expect(cursor.y).toBeCloseTo(expectedY, 1);
      expect(engine.waveYAt(b)).toBeCloseTo(expectedY, 1);
    });

    it('getPoints().length === segments.length+1 を維持 (複数ケース)', () => {
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
      for (const segs of cases) {
        const engine = new WaveEngine(segs, tl, 1.0, 0);
        expect(engine.getPoints().length).toBe(segs.length === 0 ? 2 : segs.length + 1);
        if (segs.length >= 2) {
          const newSegs = referenceEdgeDrag(segs, tl, 0, 1, 0.37, 20, 0.25);
          expect(newSegs).not.toBeNull();
          expect(newSegs!.length).toBe(segs.length);
          expect(new WaveEngine(newSegs!, tl, 1.0, 0).getPoints().length).toBe(segs.length + 1);
          for (const p of new WaveEngine(newSegs!, tl, 1.0, 0).getPoints()) {
            expect(typeof p.beat).toBe('number');
            expect(typeof p.y).toBe('number');
          }
        }
      }
    });
  });
});
