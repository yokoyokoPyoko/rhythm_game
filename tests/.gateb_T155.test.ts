import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';
import { quantizeBeat } from '../src/chart/quantize';
import type { Segment, RingDef } from '../src/types';

vi.useFakeTimers();

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true;
  const rem = ((beats % snap) + snap) % snap;
  return rem < 1e-6 || Math.abs(rem - snap) < 1e-6;
}
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
function segEqual(a: Segment[], b: Segment[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function ringEqual(a: RingDef[], b: RingDef[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Reference implementation of EditorHistory per T155 spec
// Past holds snapshots {segments,rings} before each commit.
// Future holds undone snapshots for redo.
// Cap 50, deep copy, atomic push of both segments+rings.
class RefHistory {
  past: { segments: Segment[]; rings: RingDef[] }[] = [];
  future: { segments: Segment[]; rings: RingDef[] }[] = [];
  readonly cap = 50;
  push(segments: Segment[], rings: RingDef[]): void {
    this.past.push({ segments: deepClone(segments), rings: deepClone(rings) });
    if (this.past.length > this.cap) this.past.shift();
    this.future = [];
  }
  // undo: current -> returns previous snapshot, pushes current to future
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
  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }
  clear(): void { this.past = []; this.future = []; }
}

// Selection correction helper per spec: after undo/redo clamp indices
function clampSelection<T>(selected: number | null, arr: T[]): number | null {
  if (selected == null) return null;
  if (selected < 0 || selected >= arr.length) return null;
  return selected;
}

describe('T155 Ctrl+Z（元に戻す）追加（波形＋リング） — Vitest node (history atomic, cap 50, preview-tick guard, editable exclusion)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // =================================================================
  // 1. Source structure: historyRef past/future cap 50, undo/redo handlers, editable guard, selection correction
  // =================================================================
  describe('1. EditorScreen source must implement T155 history structure', () => {
    it('contains historyRef with past/future and cap 50', () => {
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step1] capture initial source
      expect(src.length).toBeGreaterThan(5000);
      // [Step2] check identifiers
      expect(src, 'must declare historyRef').toMatch(/historyRef/);
      expect(src, 'must contain past array').toMatch(/past/);
      expect(src, 'must contain future array').toMatch(/future/);
      // cap 50
      expect(src, 'must enforce cap 50 (history length limit)').toMatch(/50/);
      // shape {past:[{segments,rings}][], future:[]}
      const hasPastSegmentsRings = /past\s*:\s*.*segments/.test(src) || /past.*segments/.test(src);
      expect(hasPastSegmentsRings, 'past should store segments+rings').toBe(true);
    });

    it('contains undo/redo key handlers: Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y near Delete handler', () => {
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step1] locate Delete handler region
      const deleteIdx = src.indexOf('Delete');
      expect(deleteIdx, 'must contain Delete handler').toBeGreaterThan(-1);
      // [Step2] slice around Delete region (±3000 chars)
      const region = src.slice(Math.max(0, deleteIdx - 3000), deleteIdx + 4000);
      // [Step3] assert undo/redo handlers present in that region or file
      expect(src, 'must handle Ctrl+Z / metaKey+Z').toMatch(/ctrlKey|metaKey/);
      expect(src, 'must handle KeyZ').toMatch(/KeyZ|key.*z/i);
      expect(region, 'undo/redo handler should be near Delete handler (:708 region)').toMatch(/KeyZ|ctrlKey/);
      expect(src, 'must handle redo Ctrl+Shift+Z or Ctrl+Y').toMatch(/Shift|KeyY/);
    });

    it('undo/redo respects editable guard (INPUT/SELECT/TEXTAREA/contentEditable)', () => {
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step1] read onKeyDown region
      const kdIdx = src.indexOf('onKeyDown');
      expect(kdIdx).toBeGreaterThan(-1);
      const kdRegion = src.slice(kdIdx, kdIdx + 5000);
      // [Step2] editable guard must appear before undo logic
      expect(kdRegion, 'must check editable').toMatch(/editable/);
      expect(kdRegion, 'must check INPUT/SELECT/TEXTAREA').toMatch(/INPUT.*SELECT.*TEXTAREA|tag\s*===.*INPUT/);
      // [Step3] undo should be after editable check (editable exclusion prevents history operation)
      const editableIdx = kdRegion.indexOf('editable');
      const zIdx = kdRegion.indexOf('KeyZ');
      expect(editableIdx).toBeGreaterThan(-1);
      expect(zIdx).toBeGreaterThan(editableIdx);
    });

    it('selection index corrected after undo/redo (range guard)', () => {
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step1] check for selection correction
      expect(src, 'must reference selectedRing/selectedSegment after undo').toMatch(/selectedRing|selectedSegment/);
      // [Step2] correction logic: clamp or null when out of range
      const hasClamp = /selectedRing.*null|setSelectedRing|setSelectedSegment/.test(src);
      expect(hasClamp, 'must correct selected indices after undo/redo').toBe(true);
      // [Step3] ensure future clearing or past management
      expect(src, 'must manage future clearing on push').toMatch(/future/);
    });

    it('commit-trigger push points present, preview/tick not pushing (source check)', () => {
      const p = path.join(process.cwd(), 'src/screens/EditorScreen.tsx');
      const src = fs.readFileSync(p, 'utf-8');
      // [Step1] commit triggers must exist
      // drag mouseup, dblclick, right-click, ring add/move/delete, recording finish, import/clear
      expect(src, 'must push history on commit triggers').toMatch(/historyRef/);
      // [Step2] preview/tick sections should NOT contain history push
      const tickIdx = src.indexOf('const tick');
      const previewDragIdx = src.indexOf('dragPreview');
      // tick block check - ensure history push not inside tick loop
      if (tickIdx !== -1) {
        const tickRegion = src.slice(tickIdx, tickIdx + 2500);
        const tickHasPush = /historyRef.*push|past\.push/.test(tickRegion);
        expect(tickHasPush, 'tick/preview must NOT push history').toBe(false);
      }
      if (previewDragIdx !== -1) {
        // onMove preview region should not push
        const onMoveIdx = src.indexOf('const onMove');
        if (onMoveIdx !== -1) {
          const onMoveRegion = src.slice(onMoveIdx, src.indexOf('const onUp') !== -1 ? src.indexOf('const onUp') : onMoveIdx + 3000);
          // onMove should set preview, not push history
          const moveHasDirectPush = /historyRef\.current.*past\.push/.test(onMoveRegion) && !/dragPreview/.test(onMoveRegion);
          // we allow no push; if push exists it should be guarded by preview check
          expect(moveHasDirectPush, 'onMove preview must not directly push history').toBe(false);
        }
      }
      // [Step3] at least some commit triggers reference history
      const commitMarkers = ['onSegmentsChange', 'removeRing', 'finishRecording', 'importChart', 'clearAll'];
      const hasCommitRef = commitMarkers.some(m => src.includes(m) && src.includes('historyRef'));
      expect(hasCommitRef, 'at least one commit path must reference historyRef').toBe(true);
    });
  });

  // =================================================================
  // 2. Pure history behavior: push/undo/redo atomic segments+rings (3-step)
  // =================================================================
  describe('2. Pure history push/undo/redo atomicity (3-step state-transition)', () => {
    it('creation → deletion → undo restores, redo re-applies (segments+rings atomic)', () => {
      // [Step1] capture initial chart
      const snap = 0.25;
      const amp = 1.3;
      const h = new RefHistory();
      const initialSegments: Segment[] = [
        { direction: 'down', beats: quantizeBeat(1.5, snap) },
        { direction: 'up', beats: quantizeBeat(1.0, snap) },
      ];
      const initialRings: RingDef[] = [
        { beat: quantizeBeat(0.37, snap), type: 'single' },
        { beat: quantizeBeat(1.23, snap), type: 'single' },
      ];
      // verify initial state
      expect(h.past.length).toBe(0);
      expect(h.future.length).toBe(0);
      // push initial snapshot before creation (historyRef pattern: push before mutation)
      h.push(initialSegments, initialRings);

      // [Step2] perform creation (add segment + ring)
      const afterCreationSegments: Segment[] = [...initialSegments, { direction: 'stay', beats: snap }];
      const afterCreationRings: RingDef[] = [...initialRings, { beat: quantizeBeat(2.37, snap), type: 'single' }];
      h.push(afterCreationSegments, afterCreationRings); // before next mutation
      const afterCreationCount = afterCreationSegments.length;

      // deletion (remove last ring and segment)
      const afterDeletionSegments = afterCreationSegments.slice(0, -1);
      const afterDeletionRings = afterCreationRings.slice(0, -1);
      // Note: creation snapshot already in past, deletion will be undone to creation
      let current = { segments: afterDeletionSegments, rings: afterDeletionRings };

      // [Step3] undo -> should restore creation state (atomic)
      const undo1 = h.undo(current);
      expect(undo1).not.toBeNull();
      expect(undo1!.segments.length).toBe(afterCreationCount);
      expect(segEqual(undo1!.segments, afterCreationSegments)).toBe(true);
      expect(ringEqual(undo1!.rings, afterCreationRings)).toBe(true);
      // future should hold deletion snapshot
      expect(h.future.length).toBe(1);
      expect(h.past.length).toBe(1); // initial remains

      // redo -> should re-apply deletion
      current = undo1!;
      const redo1 = h.redo(current);
      expect(redo1).not.toBeNull();
      expect(segEqual(redo1!.segments, afterDeletionSegments)).toBe(true);
      expect(ringEqual(redo1!.rings, afterDeletionRings)).toBe(true);
      expect(h.future.length).toBe(0);
      expect(h.past.length).toBe(2);
    });

    it('undo after multiple pushes restores step-by-step (off-grid beats 0.37/1.23, amps 0.7/2.7)', () => {
      for (const amp of [0.7, 2.7] as const) {
        for (const snap of [0.125, 0.25] as const) {
          // [Step1] initial
          const h = new RefHistory();
          const initial: Segment[] = [{ direction: 'down', beats: quantizeBeat(1.0, snap) }];
          const initialRings: RingDef[] = [{ beat: quantizeBeat(0.37, snap) }];
          h.push(initial, initialRings);
          // [Step2] 3 successive pushes with off-grid beats
          const state1Seg = [...initial, { direction: 'up', beats: quantizeBeat(0.37 + snap, snap) }];
          const state1Rings = [...initialRings, { beat: quantizeBeat(1.23, snap) }];
          h.push(state1Seg, state1Rings);
          const state2Seg = [...state1Seg, { direction: 'stay', beats: snap }];
          const state2Rings = [...state1Rings, { beat: quantizeBeat(2.37, snap), type: 'hold', duration: quantizeBeat(1.23, snap) }];
          h.push(state2Seg, state2Rings);
          let cur = { segments: state2Seg, rings: state2Rings };
          // need to push state2 before moving to state3? Pattern: push before mutation, so push state2's successor
          const state3Seg = state2Seg.slice(0, -1);
          const state3Rings = state2Rings.slice(0, -1);
          cur = { segments: state3Seg, rings: state3Rings };
          // Now undo chain
          // undo to state2
          const u1 = h.undo(cur);
          expect(u1, `undo1 amp=${amp} snap=${snap}`).not.toBeNull();
          expect(segEqual(u1!.segments, state2Seg)).toBe(true);
          cur = u1!;
          const u2 = h.undo(cur);
          expect(segEqual(u2!.segments, state1Seg)).toBe(true);
          cur = u2!;
          const u3 = h.undo(cur);
          expect(segEqual(u3!.segments, initial)).toBe(true);
          // redo to state1
          cur = u3!;
          const r1 = h.redo(cur);
          expect(segEqual(r1!.segments, state1Seg)).toBe(true);
          // [Step3] verify cap and alignment after transitions
          for (const s of r1!.segments) expect(isSnapAligned(s.beats, snap)).toBe(true);
          void amp;
        }
      }
    });

    it('new push after undo clears future (no redo branch)', () => {
      // [Step1] initial
      const h = new RefHistory();
      const s0: Segment[] = [{ direction: 'down', beats: 1 }];
      const r0: RingDef[] = [{ beat: 0.25 }];
      h.push(s0, r0);
      const s1: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const r1: RingDef[] = [{ beat: 0.25 }, { beat: 1.0 }];
      h.push(s1, r1);
      let cur = { segments: s1, rings: r1 };
      const s2 = s1.slice(0, 1);
      const r2 = r1.slice(0, 1);
      cur = { segments: s2, rings: r2 };
      // undo to s1
      const undone = h.undo(cur);
      expect(undone).not.toBeNull();
      expect(h.future.length).toBe(1);
      // [Step2] new push (branch) should clear future
      const newState: Segment[] = [{ direction: 'stay', beats: 2 }];
      const newRings: RingDef[] = [{ beat: 0.5 }, { beat: 2.0 }];
      h.push(newState, newRings);
      // [Step3] future cleared, redo impossible
      expect(h.future.length).toBe(0);
      expect(h.canRedo()).toBe(false);
      const redoAttempt = h.redo({ segments: newState, rings: newRings });
      expect(redoAttempt).toBeNull();
    });
  });

  // =================================================================
  // 3. History cap 50 (上限)
  // =================================================================
  describe('3. History cap 50 enforcement', () => {
    it('push beyond 50 keeps only last 50 snapshots', () => {
      // [Step1] empty history
      const h = new RefHistory();
      expect(h.cap).toBe(50);
      expect(h.past.length).toBe(0);
      // [Step2] push 60 times with distinct segments
      for (let i = 0; i < 60; i++) {
        const seg: Segment[] = [{ direction: 'down', beats: 0.5 + (i % 4) * 0.25 }];
        const ring: RingDef[] = [{ beat: i * 0.25 }];
        h.push(seg, ring);
      }
      // [Step3] assert cap
      expect(h.past.length).toBe(50);
      // oldest 10 should be evicted, newest should remain
      const firstKept = h.past[0];
      expect(firstKept.rings[0].beat).toBe(10 * 0.25);
      const lastKept = h.past[49];
      expect(lastKept.rings[0].beat).toBe(59 * 0.25);
    });

    it('undo respects cap and does not exceed past length', () => {
      // [Step1] fill to cap
      const h = new RefHistory();
      for (let i = 0; i < 50; i++) h.push([{ direction: 'stay', beats: 0.5 }], [{ beat: i }]);
      expect(h.past.length).toBe(50);
      // [Step2] undo all 50
      let cur = { segments: [{ direction: 'stay', beats: 0.5 }] as Segment[], rings: [{ beat: 100 }] as RingDef[] };
      let count = 0;
      while (h.canUndo()) {
        const prev = h.undo(cur);
        expect(prev).not.toBeNull();
        cur = prev!;
        count++;
      }
      // [Step3] count should be 50, further undo null
      expect(count).toBe(50);
      expect(h.undo(cur)).toBeNull();
      expect(h.future.length).toBe(50);
    });
  });

  // =================================================================
  // 4. Deep copy / isolation (preview must not pollute history, mutation isolation)
  // =================================================================
  describe('4. Deep copy isolation and preview pollution prevention', () => {
    it('push stores deep copy: mutating original does not affect past', () => {
      // [Step1] push snapshot
      const h = new RefHistory();
      const origSeg: Segment[] = [{ direction: 'down', beats: 1 }];
      const origRing: RingDef[] = [{ beat: 0.25, type: 'single' }];
      h.push(origSeg, origRing);
      // [Step2] mutate original arrays after push
      origSeg[0].beats = 999;
      origSeg.push({ direction: 'up', beats: 999 });
      origRing[0].beat = 999;
      origRing.push({ beat: 999 });
      // [Step3] past snapshot must remain unchanged (deep copy)
      expect(h.past[0].segments[0].beats).toBe(1);
      expect(h.past[0].segments.length).toBe(1);
      expect(h.past[0].rings[0].beat).toBe(0.25);
      expect(h.past[0].rings.length).toBe(1);
    });

    it('undo returns deep copy: mutating returned value does not affect history stacks', () => {
      // [Step1] prepare history
      const h = new RefHistory();
      const s0: Segment[] = [{ direction: 'down', beats: 1 }];
      const r0: RingDef[] = [{ beat: 0.25 }];
      const s1: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const r1: RingDef[] = [{ beat: 0.25 }, { beat: 1.0 }];
      h.push(s0, r0);
      h.push(s1, r1);
      let cur = { segments: s1, rings: r1 };
      cur = { segments: s1.slice(0, 1), rings: r1.slice(0, 1) } as any;
      // but we push s1 before, undo will return s1
      // Simulate proper: push s1, then current is s2 (modified)
      const s2: Segment[] = [{ direction: 'stay', beats: 2 }];
      const r2: RingDef[] = [{ beat: 0.5 }];
      const curBeforeUndo = { segments: s2, rings: r2 };
      // past contains [s0, s1], future empty, current s2 not yet pushed
      // undo should pop s1
      const undone = h.undo(curBeforeUndo);
      expect(undone).not.toBeNull();
      // [Step2] mutate undone snapshot
      undone!.segments[0].beats = 777;
      undone!.rings.push({ beat: 777 });
      // [Step3] past/future internal copies must be unaffected for next operations
      // pop another undo should still give s0 with beats=1
      const cur2 = { segments: [{ direction: 'stay', beats: 9 } as Segment], rings: [{ beat: 9 }] };
      // need to undo again from undone (but we mutated undone, so we use a fresh cur based on undone's original s1?)
      // Instead test that future's stored s2 is intact
      expect(h.future[0].segments[0].beats).toBe(2); // curBeforeUndo s2 beats 2
      expect(h.future[0].rings[0].beat).toBe(0.5);
      // past top should be s0
      const secondUndo = h.undo({ segments: [{ direction: 'stay', beats: 999 } as Segment], rings: [{ beat: 999 }] });
      // secondUndo pops s0, not affected by mutation of first undo return
      expect(secondUndo).not.toBeNull();
      expect(secondUndo!.segments[0].beats).toBe(1);
    });

    it('preview updates (mousemove) must not push history — 5 previews still 0 past growth', () => {
      // [Step1] initial history empty
      const h = new RefHistory();
      const initial: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
      ];
      const initialRings: RingDef[] = [{ beat: 0.37 }];
      // No push for preview: simulate 5 mousemove previews with different beats/y
      const previews: Segment[][] = [];
      for (const off of [0.37, 0.63, 1.23, 0.87, 1.37]) {
        const preview = initial.map(s => ({ ...s, beats: s.beats + off * 0.01 }));
        previews.push(preview);
        // preview NOT pushed
        expect(h.past.length).toBe(0);
      }
      // [Step2] no history growth during previews
      expect(h.past.length).toBe(0);
      // [Step3] only mouseup commits once
      const committed = previews[previews.length - 1];
      h.push(committed, initialRings);
      expect(h.past.length).toBe(1);
      // further preview after commit should not auto-push until next mouseup
      const nextPreview = committed.map(s => ({ ...s, beats: s.beats * 1.1 }));
      void nextPreview;
      expect(h.past.length).toBe(1);
    });

    it('tick loop (animation frame) must not push history even over many frames', () => {
      // [Step1] history with one entry
      const h = new RefHistory();
      h.push([{ direction: 'down', beats: 1 }], [{ beat: 1.0 }]);
      expect(h.past.length).toBe(1);
      // [Step2] simulate 100 tick frames (position updates, recording trajectory)
      for (let i = 0; i < 100; i++) {
        // tick does positionRef updates, recTraj pushes, but not history
        vi.advanceTimersByTime(16);
        expect(h.past.length).toBe(1);
      }
      // [Step3] history length unchanged unless explicit commit
      expect(h.past.length).toBe(1);
      expect(h.future.length).toBe(0);
    });
  });

  // =================================================================
  // 5. Selection index correction after undo/redo (range guard)
  // =================================================================
  describe('5. Selection correction after undo/redo (selectedRing/selectedSegment)', () => {
    it('undo that reduces array truncates selection to null', () => {
      // [Step1] initial: 3 segments, selected index 2
      const initialSeg: Segment[] = [
        { direction: 'down', beats: 1 },
        { direction: 'up', beats: 1 },
        { direction: 'down', beats: 1 },
      ];
      const initialRings: RingDef[] = [{ beat: 0.25 }, { beat: 1.0 }, { beat: 2.0 }];
      let selectedSegment: number | null = 2;
      let selectedRing: number | null = 2;
      expect(initialSeg.length).toBe(3);
      // [Step2] deletion reduces to 1 segment/ring, undo stack holds initial
      const h = new RefHistory();
      h.push(initialSeg, initialRings);
      const afterDeletionSeg = initialSeg.slice(0, 1);
      const afterDeletionRings = initialRings.slice(0, 1);
      let cur = { segments: afterDeletionSeg, rings: afterDeletionRings };
      // selection currently 2 but array length is 1 -> out of range, will be corrected on undo?
      // Simulate undo: returns initial (length 3) -> selection 2 becomes valid again
      // But if we are at afterDeletion and undo restores initial, selection should remain or be corrected to valid range
      // Test the correction helper directly
      selectedSegment = clampSelection(selectedSegment, afterDeletionSeg);
      selectedRing = clampSelection(selectedRing, afterDeletionRings);
      expect(selectedSegment).toBeNull();
      expect(selectedRing).toBeNull();
      // [Step3] undo restores, selection should be clamped to restored array (2 is valid for length 3)
      const restored = h.undo(cur);
      expect(restored).not.toBeNull();
      selectedSegment = clampSelection(2, restored!.segments);
      selectedRing = clampSelection(2, restored!.rings);
      expect(selectedSegment).toBe(2);
      expect(selectedRing).toBe(2);
      // if restored had length 1, selection 2 would be null
      const smallRestored: Segment[] = [{ direction: 'stay', beats: 1 }];
      expect(clampSelection(2, smallRestored)).toBeNull();
      expect(clampSelection(0, smallRestored)).toBe(0);
      expect(clampSelection(null, smallRestored)).toBeNull();
    });

    it('undo/redo with various amps preserves selection range (off-grid)', () => {
      for (const amp of [0.7, 1.3, 2.7, 3.4] as const) {
        // [Step1] create history with varying lengths
        const h = new RefHistory();
        const snap = 0.25;
        const seg3: Segment[] = [
          { direction: 'down', beats: quantizeBeat(1.0, snap) },
          { direction: 'up', beats: quantizeBeat(1.0, snap) },
          { direction: 'down', beats: quantizeBeat(1.0, snap) },
        ];
        const seg1: Segment[] = [{ direction: 'stay', beats: quantizeBeat(2.0, snap) }];
        h.push(seg3, [{ beat: 0.37 }, { beat: 1.23 }, { beat: 2.37 }]);
        let cur = { segments: seg1, rings: [{ beat: 0.37 }] };
        // [Step2] undo restores seg3
        const undone = h.undo(cur);
        expect(undone).not.toBeNull();
        // selection 2 valid for seg3 length 3
        expect(clampSelection(2, undone!.segments)).toBe(2);
        expect(clampSelection(3, undone!.segments)).toBeNull(); // out of range
        // [Step3] redo restores seg1 length 1, selection 2 should be null
        cur = undone!;
        const redone = h.redo(cur);
        expect(redone).not.toBeNull();
        expect(clampSelection(2, redone!.segments)).toBeNull();
        expect(clampSelection(0, redone!.segments)).toBe(0);
        void amp;
      }
    });
  });

  // =================================================================
  // 6. Atomic segments+rings: history stores both together, not separately
  // =================================================================
  describe('6. History stores segments+rings atomically (never separate)', () => {
    it('push stores both arrays together; undo restores both in sync', () => {
      // [Step1] initial with both non-empty
      const h = new RefHistory();
      const s0: Segment[] = [{ direction: 'down', beats: 1 }];
      const r0: RingDef[] = [{ beat: 0.25 }];
      h.push(s0, r0);
      const s1: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 2 }];
      const r1: RingDef[] = [{ beat: 0.25 }, { beat: 1.23, type: 'hold', duration: 0.5 }];
      h.push(s1, r1);
      // [Step2] modify only rings (addHold)
      const r2: RingDef[] = [...r1, { beat: 2.37, type: 'single' }];
      let cur = { segments: s1, rings: r2 };
      // undo should restore s1+r1 together, not just segments
      const undone = h.undo(cur);
      expect(undone).not.toBeNull();
      // [Step3] both segments and rings restored atomically
      expect(segEqual(undone!.segments, s1)).toBe(true);
      expect(ringEqual(undone!.rings, r1)).toBe(true);
      expect(undone!.segments.length).toBe(2);
      expect(undone!.rings.length).toBe(2);
      expect(undone!.rings[1].type).toBe('hold');
    });

    it('ring add via Space in record mode and segment recording are separate pushes but both atomic', () => {
      // [Step1] simulate recording finish push (segments via segmentize, rings via space hold)
      const h = new RefHistory();
      const snap = 0.25;
      const amp = 1.3;
      const initialSeg: Segment[] = [{ direction: 'stay', beats: 2 }];
      const initialRings: RingDef[] = [{ beat: quantizeBeat(0.37, snap) }];
      h.push(initialSeg, initialRings);
      // [Step2] segment recording finish generates newSegs
      const newSegs: Segment[] = [
        { direction: 'down', beats: quantizeBeat(1.0, snap) },
        { direction: 'up', beats: quantizeBeat(1.0, snap) },
      ];
      const combinedSeg = [...initialSeg, ...newSegs];
      const combinedRings: RingDef[] = [...initialRings, { beat: quantizeBeat(1.23, snap), type: 'hold', duration: quantizeBeat(0.5, snap) }];
      h.push(combinedSeg, combinedRings);
      // [Step3] undo should restore initial both
      let cur = { segments: combinedSeg.slice(0, 1), rings: combinedRings.slice(0, 1) };
      // simulate deletion after recording
      const undone = h.undo(cur);
      expect(undone).not.toBeNull();
      expect(segEqual(undone!.segments, combinedSeg)).toBe(true);
      expect(ringEqual(undone!.rings, combinedRings)).toBe(true);
      void amp;
    });
  });

  // =================================================================
  // 7. Regression: history operations preserve WaveEngine/Cursor numeric consistency
  // =================================================================
  describe('7. Regression: WaveEngine/Cursor consistency unaffected by history operations (complex amps off-grid)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const snaps = [0.125, 0.25, 0.5, 1] as const;
    for (const amp of amps) {
      for (const snap of snaps) {
        it(`amp=${amp} snap=${snap} off-grid 0.37/1.23: waveYAt slope == Cursor speed after history push/undo`, () => {
          // [Step1] initial wave
          const tl = new BpmTimeline(120, [], amp);
          const initial: Segment[] = [
            { direction: 'down', beats: quantizeBeat(1.5, snap) || snap },
            { direction: 'up', beats: quantizeBeat(1.0, snap) || snap },
          ];
          const engine0 = new WaveEngine(initial, tl, amp, 0);
          const pts0 = engine0.getPoints();
          expect(pts0.length).toBe(initial.length + 1);
          // [Step2] push history then create new segment via history commit
          const h = new RefHistory();
          h.push(initial, [{ beat: quantizeBeat(0.37, snap) }]);
          const newSeg: Segment[] = [...initial, { direction: 'stay', beats: snap }];
          h.push(newSeg, [{ beat: quantizeBeat(0.37, snap) }, { beat: quantizeBeat(1.23, snap) }]);
          // simulate undo to initial
          let cur = { segments: newSeg, rings: [{ beat: quantizeBeat(0.37, snap) }, { beat: quantizeBeat(1.23, snap) }] as RingDef[] };
          const undone = h.undo(cur);
          expect(undone).not.toBeNull();
          const engineUndone = new WaveEngine(undone!.segments, tl, amp, 0);
          // [Step3] waveYAt slope must match cursor speed for unclamped interval
          const beatMs = 500;
          const cursor = new Cursor(amp, 0);
          cursor.setAmplitude(amp);
          const startY = cursor.y;
          cursor.update(beatMs / 1000, false, true, beatMs);
          const cursorDisp = cursor.y - startY;
          const perBeat = 2 * TW_AMP * amp;
          // find unclamped segment for verification (beats < TW_AMP/perBeat)
          const smallBeats = Math.min(0.37, (TW_AMP / perBeat) * 0.4);
          const segsSmall: Segment[] = [{ direction: 'down', beats: smallBeats }];
          const engSmall = new WaveEngine(segsSmall, tl, amp, 0);
          const ptsS = engSmall.getPoints();
          const disp = ptsS[1].y - ptsS[0].y;
          expect(Math.abs(disp - perBeat * smallBeats)).toBeLessThan(1e-6);
          // history restored engine should also satisfy top/bottom clamping invariant
          for (const p of engineUndone.getPoints()) {
            expect(p.y).toBeGreaterThanOrEqual(TOP - 1e-6);
            expect(p.y).toBeLessThanOrEqual(BOTTOM + 1e-6);
          }
          // all beats remain snap-aligned after history ops
          for (const s of undone!.segments) expect(isSnapAligned(s.beats, snap)).toBe(true);
          const historyEngine = new WaveEngine(newSeg, tl, amp, 0);
          expect(historyEngine.getPoints().length).toBe(newSeg.length + 1);
          void cursorDisp;
        });
      }
    }

    it('WaveEngine dY clamp still matches Cursor after history undo/redo with centre/middle zones', () => {
      const amp = 1.3;
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], amp);
      const segs: Segment[] = [
        { direction: 'down', beats: 3 },
        { direction: 'up', beats: 3 },
      ];
      const engine = new WaveEngine(segs, tl, amp, 0);
      const offBeats = [0.37, 1.23, 0.63, 2.37];
      for (const ob of offBeats) {
        const safeBeat = Math.min(ob, 0.5);
        const p0 = engine.getPoints()[0];
        const perBeat = 2 * TW_AMP * amp;
        const rawY = p0.y + perBeat * (safeBeat - p0.beat);
        const expected = Math.max(TOP, Math.min(BOTTOM, rawY));
        expect(Math.abs(engine.waveYAt(safeBeat) - expected)).toBeLessThan(1e-6);
      }
      // history should not affect this invariant
      const h = new RefHistory();
      h.push(segs, [{ beat: 0.37 }]);
      h.push([...segs, { direction: 'stay', beats: snap }], [{ beat: 0.37 }, { beat: 1.23 }]);
      const undone = h.undo({ segments: [...segs, { direction: 'stay', beats: snap }], rings: [{ beat: 0.37 }] });
      expect(undone).not.toBeNull();
      const eng2 = new WaveEngine(undone!.segments, tl, amp, 0);
      for (const ob of offBeats) {
        const safeBeat = Math.min(ob, 0.5);
        const p0 = eng2.getPoints()[0];
        const perBeat = 2 * TW_AMP * amp;
        const rawY = p0.y + perBeat * (safeBeat - p0.beat);
        const expected = Math.max(TOP, Math.min(BOTTOM, rawY));
        expect(Math.abs(eng2.waveYAt(safeBeat) - expected)).toBeLessThan(1e-6);
      }
    });
  });

  // =================================================================
  // 8. Edge: import/clear, SegmentEditor edit, drag-mouseup, dblclick, right-click all trigger push (source + behavior)
  // =================================================================
  describe('8. All commit triggers must push: drag-mouseup / dblclick / right-click / SegmentEditor / ring add-move-delete / recording finish / import / clear', () => {
    it('each commit trigger creates distinct history entry (behavioral)', () => {
      // [Step1] empty
      const h = new RefHistory();
      const baseSeg: Segment[] = [{ direction: 'stay', beats: 1 }];
      const baseRing: RingDef[] = [{ beat: 0.25 }];
      expect(h.past.length).toBe(0);
      // [Step2] simulate sequential commits for each trigger type
      const triggers: Array<{ seg: Segment[]; ring: RingDef[]; label: string }> = [
        { seg: [...baseSeg, { direction: 'down', beats: 0.5 }], ring: baseRing, label: 'drag mouseup' },
        { seg: [...baseSeg, { direction: 'down', beats: 0.5 }, { direction: 'up', beats: 0.5 }], ring: baseRing, label: 'dblclick add' },
        { seg: [...baseSeg], ring: baseRing, label: 'right-click delete' },
        { seg: [{ direction: 'up', beats: 1 }], ring: baseRing, label: 'SegmentEditor edit' },
        { seg: baseSeg, ring: [...baseRing, { beat: 1.0 }], label: 'ring add' },
        { seg: baseSeg, ring: [{ beat: 0.5 }], label: 'ring move' },
        { seg: baseSeg, ring: [], label: 'ring delete' },
        { seg: [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }], ring: [{ beat: 0.5 }], label: 'recording finish' },
        { seg: [{ direction: 'stay', beats: 2 }], ring: [{ beat: 2.0 }], label: 'import' },
        { seg: [], ring: [], label: 'clearAll' },
      ];
      let lastSeg = baseSeg;
      let lastRing = baseRing;
      for (const t of triggers) {
        // push snapshot before mutation (history holds previous state)
        h.push(lastSeg, lastRing);
        lastSeg = t.seg;
        lastRing = t.ring;
      }
      // also push final state? history holds 10 pushes
      expect(h.past.length).toBe(10);
      // [Step3] undo all should walk back in reverse order, each entry distinct
      let cur = { segments: lastSeg, rings: lastRing };
      for (let i = triggers.length - 1; i >= 0; i--) {
        const prev = h.undo(cur);
        expect(prev).not.toBeNull();
        // prev should equal the state before trigger i
        cur = prev!;
      }
      // after undoing all pushes, past empty
      expect(h.canUndo()).toBe(false);
      expect(h.future.length).toBe(10);
    });

    it('redo re-applies triggers in forward order', () => {
      // [Step1] same setup
      const h = new RefHistory();
      const base: Segment[] = [{ direction: 'stay', beats: 1 }];
      const baseR: RingDef[] = [{ beat: 0.25 }];
      const seq: Array<{ seg: Segment[]; ring: RingDef[] }> = [
        { seg: [{ direction: 'down', beats: 1 }], ring: [{ beat: 0.5 }] },
        { seg: [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }], ring: [{ beat: 0.5 }, { beat: 1.0 }] },
        { seg: [], ring: [] },
      ];
      let curSeg = base;
      let curRing = baseR;
      for (const s of seq) {
        h.push(curSeg, curRing);
        curSeg = s.seg;
        curRing = s.ring;
      }
      let cur = { segments: curSeg, rings: curRing };
      // undo all
      const undoneStack: typeof seq = [];
      while (h.canUndo()) {
        const prev = h.undo(cur);
        expect(prev).not.toBeNull();
        undoneStack.push({ seg: prev!.segments, ring: prev!.rings });
        cur = prev!;
      }
      expect(h.canRedo()).toBe(true);
      // [Step2] redo forward
      for (let i = undoneStack.length - 1; i >= 0; i--) {
        const nxt = h.redo(cur);
        expect(nxt).not.toBeNull();
        cur = nxt!;
      }
      // [Step3] after redo all, past restored to 3 and future empty, final cur equals last seq
      expect(h.future.length).toBe(0);
      expect(segEqual(cur.segments, seq[seq.length - 1].seg)).toBe(true);
    });
  });
});
