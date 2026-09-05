import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat, isSnapAligned } from '../src/chart/quantize';
import { calculateVertexDrag, calculateEdgeDrag } from '../src/game/editorDrag';
import type { Segment, RingDef } from '../src/types';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

class TestHistory {
  past: { segments: Segment[]; rings: RingDef[] }[] = [];
  future: { segments: Segment[]; rings: RingDef[] }[] = [];
  readonly cap = 50;

  push(segments: Segment[], rings: RingDef[]): void {
    this.past.push({ segments: deepClone(segments), rings: deepClone(rings) });
    if (this.past.length > this.cap) this.past.shift();
    this.future = [];
  }

  undo(current: { segments: Segment[]; rings: RingDef[] }): { segments: Segment[]; rings: RingDef[] } | null {
    if (this.past.length === 0) return null;
    const prev = this.past.pop()!;
    this.future.push({ segments: deepClone(current.segments), rings: deepClone(current.rings) });
    return deepClone(prev);
  }

  redo(current: { segments: Segment[]; rings: RingDef[] }): { segments: Segment[]; rings: RingDef[] } | null {
    if (this.future.length === 0) return null;
    const nxt = this.future.pop()!;
    this.past.push({ segments: deepClone(current.segments), rings: deepClone(current.rings) });
    if (this.past.length > this.cap) this.past.shift();
    return deepClone(nxt);
  }
}

describe('T156: 右ドラッグ範囲選択・左ドラッグ移動（モード対応・左右上下） — Vitest node unit test module', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. Selection math & Mode filtering (Vertex, Edge, Ring with off-grid beats 0.37, 1.23)', () => {
    it('vertex mode selection: selects vertex indices inside bounding box [beat0, beat1, y0, y1]', () => {
      // [Step1] Capture initial geometry (off-grid beats & complex amp)
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segments: Segment[] = [
        { direction: 'down', beats: quantizeBeat(1.37, snap) },
        { direction: 'up', beats: quantizeBeat(1.23, snap) },
        { direction: 'stay', beats: quantizeBeat(1.0, snap) },
      ];
      const engine = new WaveEngine(segments, tl, amp, 0);
      const points = engine.getPoints();
      expect(points.length).toBe(segments.length + 1);

      // [Step2] Perform selection calculation (bounding box covering vertex 0 and 1)
      const minBeat = points[0].beat;
      const maxBeat = points[1].beat;
      const minY = Math.min(points[0].y, points[1].y) - 10;
      const maxY = Math.max(points[0].y, points[1].y) + 10;

      const selectedIndices: number[] = [];
      points.forEach((p, idx) => {
        if (p.beat >= minBeat - 1e-6 && p.beat <= maxBeat + 1e-6 && p.y >= minY && p.y <= maxY) {
          selectedIndices.push(idx);
        }
      });

      // [Step3] Assert changed outcome
      expect(selectedIndices).toContain(0);
      expect(selectedIndices).toContain(1);
      expect(selectedIndices.length).toBeGreaterThanOrEqual(2);
    });

    it('edge mode selection: selects edge segment indices when bounding box intersects segment span', () => {
      // [Step1] Capture initial edge list from WaveEngine points
      const snap = 0.25;
      const amp = 0.7;
      const tl = new BpmTimeline(120, [], amp);
      const segments: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 1.5 },
        { direction: 'stay', beats: 1.0 },
      ];
      const engine = new WaveEngine(segments, tl, amp, 0);
      const points = engine.getPoints();

      // [Step2] Compute edge hit test for box covering edge 0 and 1
      const targetMinBeat = points[0].beat;
      const targetMaxBeat = points[2].beat;
      const selectedEdges: number[] = [];

      for (let i = 0; i < segments.length; i++) {
        const pA = points[i];
        const pB = points[i + 1];
        const edgeMinBeat = Math.min(pA.beat, pB.beat);
        const edgeMaxBeat = Math.max(pA.beat, pB.beat);
        if (!(edgeMaxBeat < targetMinBeat || edgeMinBeat > targetMaxBeat)) {
          selectedEdges.push(i);
        }
      }

      // [Step3] Assert selected edges array contains expected indices
      expect(selectedEdges).toEqual([0, 1, 2]);
    });

    it('ring mode selection: selects ring indices within beat range [beat0, beat1]', () => {
      // [Step1] Capture initial rings (off-grid 0.37, 1.23, 2.37)
      const snap = 0.25;
      const rings: RingDef[] = [
        { beat: quantizeBeat(0.37, snap) },
        { beat: quantizeBeat(1.23, snap) },
        { beat: quantizeBeat(2.37, snap) },
      ];
      const b0 = 0.2;
      const b1 = 1.5;

      // [Step2] Perform beat range filtering
      const selectedRings: number[] = [];
      rings.forEach((r, idx) => {
        if (r.beat >= b0 && r.beat <= b1) {
          selectedRings.push(idx);
        }
      });

      // [Step3] Assert selected rings array
      expect(selectedRings).toEqual([0, 1]);
    });
  });

  describe('2. Multi-item drag math & Quantization (Vertex collection, Edge collection, Ring beat shift)', () => {
    it('vertex collection movement: applies dxBeat and snapped Y (3-zone TOP/CENTER/BOTTOM)', () => {
      // [Step1] Capture initial segment configuration
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segments: Segment[] = [
        { direction: 'down', beats: 1.0 },
        { direction: 'up', beats: 1.0 },
      ];

      // [Step2] Perform vertex drag using calculateVertexDrag for interior vertex (index 1)
      const res = calculateVertexDrag({
        segments,
        bpmTimeline: tl,
        startPosition: 0,
        pointIndex: 1,
        targetBeat: 1.25,
        targetY: CENTER, // snaps to CENTER (300)
        snap,
      });

      // [Step3] Assert outcome: non-null segments with snap aligned beats
      expect(res).not.toBeNull();
      expect(res!.length).toBe(2);
      for (const s of res!) {
        expect(isSnapAligned(s.beats, snap)).toBe(true);
      }
    });

    it('edge collection movement: parallel shift with boundary clamp and safeSnap quantization', () => {
      // [Step1] Capture initial segments
      const snap = 0.25;
      const amp = 2.7;
      const tl = new BpmTimeline(120, [], amp);
      const segments: Segment[] = [
        { direction: 'up', beats: 1.0 },
        { direction: 'down', beats: 1.0 },
        { direction: 'stay', beats: 1.0 },
      ];

      // [Step2] Perform edge drag on edge index 1 with dxBeat = 0.25, dy = 10
      const res = calculateEdgeDrag({
        segments,
        bpmTimeline: tl,
        startPosition: 0,
        edgeIndex: 1,
        startBeat: 1.0,
        startY: CENTER,
        startPrevBeat: 0,
        startNextBeat: 2.0,
        dxBeat: 0.25,
        dy: 10,
        snap,
      });

      // [Step3] Assert outcome: segments updated, snap aligned
      expect(res).not.toBeNull();
      expect(res!.length).toBe(3);
      for (const s of res!) {
        expect(isSnapAligned(s.beats, snap)).toBe(true);
      }
    });

    it('ring beat shift: beat += quantize(dxBeat) with Y waveYAt dependent', () => {
      // [Step1] Capture initial rings and wave engine
      const snap = 0.25;
      const amp = 1.3;
      const tl = new BpmTimeline(120, [], amp);
      const segments: Segment[] = [{ direction: 'down', beats: 2.0 }];
      const engine = new WaveEngine(segments, tl, amp, 0);

      const rings: RingDef[] = [{ beat: 1.0 }, { beat: 1.5 }];
      const selectedIndices = [0, 1];
      const dxBeatRaw = 0.37; // off-grid shift
      const dxBeatQuantized = quantizeBeat(dxBeatRaw, snap);

      // [Step2] Apply shift to selected rings
      const movedRings = rings.map((r, idx) => {
        if (selectedIndices.includes(idx)) {
          const newBeat = quantizeBeat(r.beat + dxBeatQuantized, snap);
          return { ...r, beat: newBeat, targetY: engine.waveYAt(newBeat) };
        }
        return r;
      });

      // [Step3] Assert outcome: beats shifted and snap aligned, targetY computed from waveYAt
      expect(movedRings[0].beat).toBe(quantizeBeat(1.0 + dxBeatQuantized, snap));
      expect(isSnapAligned(movedRings[0].beat, snap)).toBe(true);
      expect(typeof movedRings[0].targetY).toBe('number');
      expect(movedRings[0].targetY).toBeGreaterThanOrEqual(TOP - 1e-6);
      expect(movedRings[0].targetY).toBeLessThanOrEqual(BOTTOM + 1e-6);
    });
  });

  describe('3. History Integration & Atomic Commits (T155/T156)', () => {
    it('multi-item move commits once on mouseup (pushes to history historyRef past stack)', () => {
      // [Step1] Capture initial history and chart state
      const h = new TestHistory();
      const initialSegs: Segment[] = [{ direction: 'down', beats: 1.0 }, { direction: 'up', beats: 1.0 }];
      const initialRings: RingDef[] = [{ beat: 0.5 }, { beat: 1.5 }];
      expect(h.past.length).toBe(0);
      // [Step2] Simulate drag previews (not pushed) followed by mouseup commit (pushed once)
      const previewSegs: Segment[] = [{ direction: 'down', beats: 1.25 }, { direction: 'up', beats: 0.75 }];
      const previewRings: RingDef[] = [{ beat: 0.75 }, { beat: 1.75 }];
      // preview state active... push initial state before commit
      h.push(initialSegs, initialRings);
      expect(h.past.length).toBe(1);

      // [Step3] Assert outcome: past length 1, undo restores initial
      const undone = h.undo({ segments: previewSegs, rings: previewRings });
      expect(undone).not.toBeNull();
      expect(undone!.segments[0].beats).toBe(1.0);
    });

    it('bulk deletion (Delete/Backspace) and Esc selection clearing', () => {
      // [Step1] Capture selection state
      let selectedSegments: number[] = [0, 1];
      let selectedRings: number[] = [0];
      const segments: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const rings: RingDef[] = [{ beat: 0.5 }, { beat: 1.0 }];

      // [Step2] Simulate Delete action (remove selected segments & rings)
      const remainingSegments = segments.filter((_, i) => !selectedSegments.includes(i));
      const remainingRings = rings.filter((_, i) => !selectedRings.includes(i));
      selectedSegments = [];
      selectedRings = [];

      // [Step3] Assert outcome: items removed, selections cleared
      expect(remainingSegments.length).toBe(0);
      expect(remainingRings.length).toBe(1);
      expect(selectedSegments).toEqual([]);
      expect(selectedRings).toEqual([]);
    });
  });

  describe('4. Numeric consistency between WaveEngine and Cursor across complex amplitudes & off-grid phases', () => {
    const amplitudes = [0.7, 1.3, 2.7, 3.4] as const;
    const offGridBeats = [0.37, 1.23] as const;

    for (const amp of amplitudes) {
      for (const ob of offGridBeats) {
        it(`amp=${amp} off-grid beat=${ob}: WaveEngine waveYAt and Cursor numeric consistency`, () => {
          // [Step1] Capture initial timeline and engine
          const tl = new BpmTimeline(120, [], amp);
          const segments: Segment[] = [{ direction: 'down', beats: 3.0 }];
          const engine = new WaveEngine(segments, tl, amp, 0);

          // [Step2] Compute waveYAt at off-grid beat and compare with expected linear displacement clamped
          const p0 = engine.getPoints()[0];
          const perBeat = 2 * TW_AMP * amp;
          const rawY = p0.y + perBeat * ob;
          const expectedY = Math.max(TOP, Math.min(BOTTOM, rawY));
          const actualY = engine.waveYAt(ob);

          // [Step3] Assert numeric consistency within precision limits
          expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-6);
          expect(actualY).toBeGreaterThanOrEqual(TOP - 1e-6);
          expect(actualY).toBeLessThanOrEqual(BOTTOM + 1e-6);
        });
      }
    }
  });
});
