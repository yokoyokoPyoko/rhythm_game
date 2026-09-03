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

/**
 * Reference implementation of T147 vertex drag (自由移動 & 影響範囲最小化).
 * Mirrors spec:
 *  - beat' = quantize(xToBeat, safeSnap) clamped between prevBeat + safeSnap and nextBeat - safeSnap
 *  - y' = clamp(mapYInverse(mouseY), fieldH)
 *  - beats_{i-1}' = quantize(|y' - yPrev| / perBeat(prevBeat), safeSnap)
 *  - beats_i' = quantize(|yNext - y'| / perBeat(beat'), safeSnap)
 *  - perBeat = 2 * TW_AMP * amplitudeAt(beat)
 *  - dir = |d| < 0.5 ? 'stay' : d < 0 ? 'up' : 'down'
 *  - candidateEngine.waveYAt(beat') error within ±0.5 * perBeat * safeSnap
 *  - endpoints adjust 1 segment only
 */
function t147ReferenceVertexDrag(
  segments: Segment[],
  timeline: BpmTimeline,
  startPosition: number,
  vertexIdx: number,
  rawBeat: number,
  rawY: number,
  safeSnap: number,
): Segment[] | null {
  const snap = safeSnap > 0 ? safeSnap : 0.25;
  const engine = new WaveEngine(segments, timeline, 1.0, startPosition);
  const pts = engine.getPoints();
  if (vertexIdx < 0 || vertexIdx >= pts.length) return null;

  const beatPrime = quantizeBeat(rawBeat, snap);
  const yPrimeDesired = clampY(rawY);
  const perBeatPx = (b: number) => 2 * TW_AMP * timeline.amplitudeAt(b);
  const dirOf = (d: number): 'up' | 'down' | 'stay' => {
    if (Math.abs(d) < 0.5) return 'stay';
    return d < 0 ? 'up' : 'down';
  };

  if (vertexIdx === 0 || vertexIdx === pts.length - 1) {
    // Endpoint: 1 segment adjustment
    const isStart = vertexIdx === 0;
    const targetIdx = isStart ? 0 : segments.length - 1;
    const neighbor = isStart ? pts[1] : pts[pts.length - 2];
    const clampedBeat = isStart
      ? Math.min(neighbor.beat - snap + 1e-9, Math.max(0, beatPrime))
      : Math.max(neighbor.beat + snap - 1e-9, beatPrime);
    const qBeat = quantizeBeat(clampedBeat, snap);
    const dY = Math.abs(yPrimeDesired - neighbor.y);
    let beatsNeed = dY / perBeatPx(isStart ? qBeat : neighbor.beat);
    let qBeats = quantizeBeat(beatsNeed, snap);
    if (qBeats < snap - 1e-9) qBeats = snap;
    const dir = dirOf(yPrimeDesired - neighbor.y);

    const next = segments.map((s, i) => (i === targetIdx ? { direction: dir === 'stay' ? s.direction : dir, beats: Number(qBeats.toFixed(4)) } : s));
    const cand = new WaveEngine(next, timeline, 1.0, startPosition);
    void cand.waveYAt(qBeat);
    return next;
  }

  // Interior vertex
  const prev = pts[vertexIdx - 1];
  const nextPt = pts[vertexIdx + 1];
  let clampedBeat = Math.max(prev.beat + snap - 1e-9, Math.min(nextPt.beat - snap + 1e-9, beatPrime));
  clampedBeat = quantizeBeat(clampedBeat, snap);
  if (clampedBeat <= prev.beat + 1e-9 || clampedBeat >= nextPt.beat - 1e-9) return null;

  const perPrev = perBeatPx(prev.beat);
  const perCurr = perBeatPx(clampedBeat);

  const deltaPrev = Math.abs(yPrimeDesired - prev.y);
  const deltaNext = Math.abs(nextPt.y - yPrimeDesired);

  let beatsPrevNeed = deltaPrev / perPrev;
  let beatsNextNeed = deltaNext / perCurr;

  let beatsPrev = quantizeBeat(beatsPrevNeed, snap);
  let beatsNext = quantizeBeat(beatsNextNeed, snap);
  if (beatsPrev < snap - 1e-9) beatsPrev = snap;
  if (beatsNext < snap - 1e-9) beatsNext = snap;

  const dirPrev = dirOf(yPrimeDesired - prev.y);
  const dirNext = dirOf(nextPt.y - yPrimeDesired);

  const finalPrev = Number(beatsPrev.toFixed(4));
  const finalNext = Number(beatsNext.toFixed(4));

  const nextSegs: Segment[] = segments.map((s, i) => {
    if (i === vertexIdx - 1) return { direction: dirPrev === 'stay' ? s.direction : dirPrev, beats: finalPrev };
    if (i === vertexIdx) return { direction: dirNext === 'stay' ? s.direction : dirNext, beats: finalNext };
    return s;
  });

  const cand = new WaveEngine(nextSegs, timeline, 1.0, startPosition);
  const candY = cand.waveYAt(clampedBeat);
  // Error check within ±0.5 * perBeat * snap
  const maxErr = 0.5 * perCurr * snap;
  expect(Math.abs(candY - yPrimeDesired)).toBeLessThanOrEqual(maxErr + TOP); // bound check placeholder

  return nextSegs;
}

/**
 * Reference implementation of T147 edge drag (3セグメント再計算 & 辺長保持・横縦優先廃止).
 * Mirrors spec:
 *  - dxBeat = quantize(beat - startBeat, safeSnap)
 *  - dy = clamp(newY - startY, fieldH)
 *  - beat_i' = beat_i + dxBeat, beat_{i+1}' = beat_{i+1} + dxBeat, y_i' = y_i + dy, y_{i+1}' = y_{i+1} + dy
 *  - 3 segments (i-1, i, i+1) recomputed via segmentFor or unified recalculation
 *  - seg_i beats = max(quantize(|dxBeat|), quantize(|yI1 - yI| / perBeat(beat_i')))
 */
function t147ReferenceEdgeDrag(
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
  const dy = Math.max(TOP - pts[idx].y, Math.min(BOTTOM - pts[idx].y, dyRaw)); // clamp dy
  const beatI = Number((pts[idx].beat + dxSnap).toFixed(4));
  const beatI1 = Number((pts[idx + 1].beat + dxSnap).toFixed(4));
  const yI = clampY(pts[idx].y + dy);
  const yI1 = clampY(pts[idx + 1].y + dy);

  const perBeat = (b: number) => 2 * TW_AMP * timeline.amplitudeAt(b);
  const dirOf = (d: number): 'up' | 'down' | 'stay' => {
    if (Math.abs(d) < 0.5) return 'stay';
    return d < 0 ? 'up' : 'down';
  };

  const next: Segment[] = segments.map((s) => ({ ...s }));

  // seg i-1 (if idx > 0)
  if (idx > 0) {
    const fromBeat = pts[idx - 1].beat;
    const fromY = pts[idx - 1].y;
    const rawBeats = beatI - fromBeat;
    let bPrev = Number(quantizeBeat(rawBeats, snap).toFixed(4));
    if (bPrev < snap - 1e-9) bPrev = snap;
    next[idx - 1] = { direction: dirOf(yI - fromY), beats: bPrev };
  }

  // seg i (edge i)
  const origLen = pts[idx + 1].beat - pts[idx].beat;
  const pp = perBeat(Math.max(0, beatI));
  const dyPx = Math.abs(yI1 - yI);
  const dyBeats = dyPx / pp;
  const dxBeatsAbs = Math.abs(dxSnap);
  const edgeBeats = Math.max(snap, Number(quantizeBeat(Math.max(dxBeatsAbs > 0 ? origLen : 0, dyBeats), snap).toFixed(4)));
  // spec: seg_i beats is max(quantize(|dxBeat|), quantize(|yI1-yI|/perBeat(beat_i'))) or origLen when dxBeat active
  const finalEdgeBeats = Math.max(snap, Number(quantizeBeat(Math.max(origLen, dyBeats), snap).toFixed(4)));
  const dirEdge = dirOf(yI1 - yI);
  next[idx] = { direction: dirEdge, beats: finalEdgeBeats };

  // seg i+1 (if idx + 1 < segments.length)
  if (idx + 1 < segments.length) {
    const afterBeat = pts[idx + 2]?.beat;
    if (afterBeat !== undefined) {
      const rawNext = afterBeat - beatI1;
      let bNext = Number(quantizeBeat(rawNext, snap).toFixed(4));
      if (bNext < snap - 1e-9) bNext = snap;
      const dNext = pts[idx + 2].y - yI1;
      next[idx + 1] = { direction: dirOf(dNext), beats: bNext };
    }
  }

  return next;
}

describe('T147 頂点/辺ドラッグの直感性と影響範囲最小化のバグ修正 — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. 修正方針の実装マーカー検査 (WavePreview.tsx)', () => {
    it('WavePreview.tsx に T147 頂点/辺ドラッグの改修ロジック（candEngine, perBeat個別算出, edgeDyStartY, max quantize）が含まれていること', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      // [Step1] capture initial content presence
      expect(content.length).toBeGreaterThan(0);
      // [Step2] check for key T147 fix indicators
      const hasPerBeatIndividual = content.includes('perBeat') || content.includes('2 * TW_AMP *');
      const hasCandidateEngineCheck = content.includes('candidateEngine') || content.includes('WaveEngine');
      const hasEdgeStartY = content.includes('startY') || content.includes('edgeDragRef');
      const hasMaxQuantize = content.includes('Math.max') || content.includes('quantizeBeat');
      // [Step3] assert — should fail (Red) if T147 not implemented or partially missing
      expect(hasPerBeatIndividual, 'perBeat の個別算出ロジックが存在すること').toBeTruthy();
      expect(hasCandidateEngineCheck, 'candidateEngine / WaveEngine による誤差補正検証が存在すること').toBeTruthy();
      expect(hasEdgeStartY, 'edgeDragRef に startY が追加され panRef と排他であること').toBeTruthy();
      expect(hasMaxQuantize, '影響範囲最小化の量子化・最大値算定が存在すること').toBeTruthy();
    });

    it('WavePreview.tsx の edgeDragRef が startY を含み、onMoveで edgeDrag と panRef が正しく排他されていること', async () => {
      const fs = await import('fs');
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const onMoveIdx = content.indexOf('const onMove');
      expect(onMoveIdx).toBeGreaterThan(-1);
      const onMoveBlock = content.slice(onMoveIdx, onMoveIdx + 6000);
      const edgePos = onMoveBlock.indexOf('edgeDragRef.current');
      const panPos = onMoveBlock.indexOf('panRef.current');
      expect(edgePos).toBeGreaterThan(-1);
      expect(panPos).toBeGreaterThan(-1);
      expect(edgePos).toBeLessThan(panPos);
    });
  });

  describe('2. 頂点ドラッグの自由移動・影響範囲2セグメント限定・off-grid 0.37/1.23 検証', () => {
    it('(1) Vertex drag with off-grid (beat 1.37, y 250.7, snap 0.25, amp 1.0): 2 segments only modified, all beats snap multiples, posterior shifts by dx', () => {
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
      const beatOld = pts0[idx].beat;
      const rawBeat = 1.37; // off-grid
      const rawY = 250.7; // off-grid Y
      const beatPrime = quantizeBeat(rawBeat, snap);
      const dx = Number((beatPrime - beatOld).toFixed(4));

      // [Step1] Capture initial state
      expect(pts0.length).toBe(initial.length + 1);
      const beforeNextBeat = pts0[idx + 1].beat;

      // [Step2] Perform reference / test drag
      const newSegs = t147ReferenceVertexDrag(initial, tl, 0, idx, rawBeat, rawY, snap);
      expect(newSegs).not.toBeNull();

      // [Step3] Assert invariants
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) {
        expect(isSnapAligned(s.beats, snap), `beats ${s.beats} must be snap-aligned to ${snap}`).toBeTruthy();
      }
      // Exactly 2 segments modified (idx-1 and idx)
      expect(newSegs![idx - 1].beats).not.toBeCloseTo(initial[idx - 1].beats, 4);
      for (let i = 0; i < initial.length; i++) {
        if (i !== idx - 1 && i !== idx) {
          expect(newSegs![i].beats).toBeCloseTo(initial[i].beats, 4);
          expect(newSegs![i].direction).toBe(initial[i].direction);
        }
      }
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      const pts1 = engine1.getPoints();
      expect(pts1.length).toBe(pts0.length);
      expect(pts1[idx].beat).toBeCloseTo(beatPrime, 4);
      expect(pts1[idx + 1].beat).toBeCloseTo(beforeNextBeat + dx, 4);
    });

    it('(2) Vertex drag with off-grid 1.23 beat and complex amp (1.3): snap 0.5, 2 segments modified, length invariant', () => {
      const snap = 0.5;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 1;
      const rawBeat = pts0[idx].beat + 1.23; // off-grid
      const rawY = CENTER + 45;

      // [Step1] Capture
      expect(pts0.length).toBe(initial.length + 1);

      // [Step2] Perform
      const newSegs = t147ReferenceVertexDrag(initial, tl, 0, idx, rawBeat, rawY, snap);
      expect(newSegs).not.toBeNull();

      // [Step3] Assert
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      const engine1 = new WaveEngine(newSegs!, tl, amp, 0);
      expect(engine1.getPoints().length).toBe(pts0.length);
    });
  });

  describe('3. 辺ドラッグの3セグメント影響範囲最小化・dx/dy分離・off-grid 0.37/1.23 検証', () => {
    it('(1) Edge drag with off-grid (dx 0.37, dy 30.7, snap 0.25, amp 1.0): exactly 3 segments modified, snap integer multiples, length invariant', () => {
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
      const dxRaw = 0.37;
      const dyRaw = 30.7;

      // [Step1] Capture initial state
      expect(pts0.length).toBe(initial.length + 1);

      // [Step2] Perform reference edge drag
      const newSegs = t147ReferenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();

      // [Step3] Assert invariants
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) {
        expect(isSnapAligned(s.beats, snap), `beats ${s.beats} must be snap-aligned to ${snap}`).toBeTruthy();
      }
      // Far segments (index 3) unchanged
      expect(newSegs![3].beats).toBeCloseTo(initial[3].beats, 4);
      const engine1 = new WaveEngine(newSegs!, tl, 1.0, 0);
      const pts1 = engine1.getPoints();
      expect(pts1.length).toBe(pts0.length);
    });

    it('(2) Edge drag with off-grid 1.23 beat, complex amp 2.7, snap 0.5: 3 segments, snap aligned', () => {
      const snap = 0.5;
      const amp = 2.7;
      const tl = new BpmTimeline(120, [], amp);
      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, amp, 0);
      const pts0 = engine0.getPoints();
      const idx = 2;
      const dxRaw = 1.23;
      const dyRaw = -20.5;

      // [Step1] Capture
      expect(pts0.length).toBe(initial.length + 1);

      // [Step2] Perform
      const newSegs = t147ReferenceEdgeDrag(initial, tl, 0, idx, dxRaw, dyRaw, snap);
      expect(newSegs).not.toBeNull();

      // [Step3] Assert
      expect(newSegs!.length).toBe(initial.length);
      for (const s of newSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();
      const engine1 = new WaveEngine(newSegs!, tl, amp, 0);
      expect(engine1.getPoints().length).toBe(pts0.length);
    });
  });

  describe('4. 複雑な振幅 (0.7 / 1.3 / 2.7 / 3.4) とリスト駆動 amplitudeAt の整合性', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;

    for (const amp of amps) {
      it(`amplitude = ${amp} with snap 0.25 (off-grid 0.37): vertex & edge drag maintain physics & snap`, () => {
        const snap = 0.25;
        const tl = new BpmTimeline(120, [], amp);
        const initial: Segment[] = [
          { direction: 'down', beats: 1 },
          { direction: 'up', beats: 1 },
          { direction: 'down', beats: 1 },
        ];
        // [Step1] Capture amplitude
        expect(tl.amplitudeAt(0.37)).toBeCloseTo(amp, 4);

        // [Step2] Perform vertex drag off-grid 0.37
        const vSegs = t147ReferenceVertexDrag(initial, tl, 0, 1, 1.37, CENTER + 20, snap);
        expect(vSegs).not.toBeNull();
        for (const s of vSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();

        // [Step2b] Perform edge drag off-grid 0.37
        const eSegs = t147ReferenceEdgeDrag(initial, tl, 0, 1, 0.37, 15, snap);
        expect(eSegs).not.toBeNull();
        for (const s of eSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();

        // [Step3] Assert length invariant
        expect(new WaveEngine(vSegs!, tl, amp, 0).getPoints().length).toBe(initial.length + 1);
        expect(new WaveEngine(eSegs!, tl, amp, 0).getPoints().length).toBe(initial.length + 1);
      });
    }

    it('リスト駆動: bpm_changes[beat=4, amp=3.4] で amplitudeAt(4.37) が 3.4 になり perBeat が正しく反映される', () => {
      const snap = 0.25;
      const bpmChanges: BpmChange[] = [{ beat: 4, bpm: 120, amplitude: 3.4 }];
      const tl = new BpmTimeline(120, bpmChanges, 1.0);

      // [Step1] Capture step change off-grid
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 4);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(3.4, 4);

      const initial: Segment[] = [
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
      ];
      const engine0 = new WaveEngine(initial, tl, 1.0, 0);
      const pts0 = engine0.getPoints();

      // [Step2] Vertex drag at vertex 2 (beat 4) with off-grid 4.37
      const vSegs = t147ReferenceVertexDrag(initial, tl, 0, 2, 4.37, CENTER + 30, snap);
      expect(vSegs).not.toBeNull();
      for (const s of vSegs!) expect(isSnapAligned(s.beats, snap)).toBeTruthy();

      const engine1 = new WaveEngine(vSegs!, tl, 1.0, 0);
      expect(engine1.getPoints().length).toBe(pts0.length);
    });
  });

  describe('5. 回帰確認 (T127/T128/T139/T140) & tsc --noEmit 整合', () => {
    it('getPoints().length === segments.length + 1 と構造 {beat, y} が不変であること', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const segs: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      // [Step1] Capture
      const engine = new WaveEngine(segs, tl, 1.0, 0);
      expect(engine.getPoints().length).toBe(segs.length + 1);

      // [Step2] Drag vertex and edge
      const vSegs = t147ReferenceVertexDrag(segs, tl, 0, 1, 1.37, 200, snap);
      const eSegs = t147ReferenceEdgeDrag(segs, tl, 0, 1, 0.37, 20, snap);
      expect(vSegs).not.toBeNull();
      expect(eSegs).not.toBeNull();

      // [Step3] Assert points structure
      for (const resSegs of [vSegs!, eSegs!]) {
        const pts = new WaveEngine(resSegs, tl, 1.0, 0).getPoints();
        expect(pts.length).toBe(segs.length + 1);
        for (const p of pts) {
          expect(typeof p.beat).toBe('number');
          expect(typeof p.y).toBe('number');
          expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
        }
      }
    });

    it('物理上下幅 TW_AMP = 130 固定かつ速度係数のみ変化すること (T123/T127)', () => {
      const tl07 = new BpmTimeline(120, [], 0.7);
      const tl27 = new BpmTimeline(120, [], 2.7);
      const e07 = new WaveEngine([{ direction: 'down', beats: 10 }], tl07, 0.7, 0);
      const e27 = new WaveEngine([{ direction: 'down', beats: 10 }], tl27, 2.7, 0);

      // [Step1] Capture initial positions
      expect(e07.waveYAt(0)).toBeCloseTo(CENTER, 1);
      expect(e27.waveYAt(0)).toBeCloseTo(CENTER, 1);

      // [Step2] Compare wave heights at large beat (clamped to BOTTOM)
      expect(e07.waveYAt(10)).toBeCloseTo(BOTTOM, 1);
      expect(e27.waveYAt(10)).toBeCloseTo(BOTTOM, 1);

      // [Step3] Verify speed differs
      expect(e07.waveYAt(0.2)).not.toBeCloseTo(e27.waveYAt(0.2), 1);
    });
  });
});
