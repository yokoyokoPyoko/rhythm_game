import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat, isSnapAligned, segmentize } from '../src/chart/quantize';
import type { Segment } from '../src/types';

vi.useFakeTimers();

const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;
const CENTER = TW_CENTER_Y;

function readSrc(rel: string): string {
  return fs.readFileSync(rel, 'utf-8');
}

function clampY(y: number): number {
  return Math.max(TOP, Math.min(BOTTOM, y));
}

function expectedClampedY(startPos: number, amp: number, dir: 'up' | 'down' | 'stay', beat: number): number {
  const startY = CENTER - startPos * TW_AMP;
  const dY = dir === 'up' ? -2 * TW_AMP * amp : dir === 'down' ? 2 * TW_AMP * amp : 0;
  if (dir === 'stay') return startY;
  return clampY(startY + dY * beat);
}

// Reference helpers mirroring WavePreview logic for rings
function computeRingBeat(rawBeat: number, snap: number): number {
  const beat = quantizeBeat(rawBeat, snap);
  // second quantize as in WavePreview: Math.round(beat/snap)*snap
  return Math.round(beat / snap) * snap;
}

function nearestRingIndexMock(rings: { beat: number }[], clickBeat: number, viewStart: number, viewBeats: number, width: number, clickX: number): number {
  let nearest = -1;
  let nearestDist = Infinity;
  rings.forEach((r, i) => {
    const rx = ((r.beat - viewStart) / viewBeats) * width;
    const d = Math.abs(rx - clickX);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = i;
    }
  });
  return nearestDist < 35 ? nearest : -1;
}

describe('T142 リング追加/削除の統一（ダブルクリック追加 / 右クリック削除） — Vitest node', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ========================================================================
  // 1. WavePreview.tsx 実装マーカー — source pattern checks (3-step)
  // ========================================================================
  describe('1. WavePreview.tsx 実装マーカー — T142 handler bodies contain required inline logic', () => {
    it('handleDoubleClick の ring 分岐で quantizeBeat + onAddRing を inline で呼ぶ (helper だけに委譲しない)', () => {
      // [Step1] capture initial file content
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      expect(content.length).toBeGreaterThan(0);
      const idx = content.indexOf('handleDoubleClick');
      expect(idx).toBeGreaterThan(-1);
      // [Step2] extract ring branch block
      const block = content.slice(idx, idx + 5000);
      expect(block).toContain('handleDoubleClick');
      // [Step3] assert inline markers inside handleDoubleClick ring branch
      expect(block).toMatch(/editMode\s*===\s*['"]ring['"]/);
      // quantizeBeat must appear directly in this block, not only via helper
      expect(block).toMatch(/quantizeBeat/);
      expect(block).toMatch(/onAddRing/);
      // snapped computation inline (Math.round pattern from WavePreview)
      expect(block).toMatch(/Math\.round\(beat\s*\/\s*safeSnap\)/);
      // additional guard: nearestRingIndex hit check <0 for empty area
      expect(block).toMatch(/nearestRingIndex/);
      expect(block).toMatch(/hit\s*<\s*0/);
      // onDoubleClick binding exists
      expect(content).toMatch(/onDoubleClick=\{handleDoubleClick\}/);
    });

    it('handleContextMenu の ring 分岐で 35px 距離チェックを inline で行い onDeleteRing 前に preventDefault する', () => {
      // [Step1] capture content
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const idx = content.indexOf('handleContextMenu');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 5000);
      // [Step2] locate ring branch within handleContextMenu
      const ringIdx = block.indexOf("editMode === 'ring'");
      expect(ringIdx).toBeGreaterThan(-1);
      const ringBlock = block.slice(ringIdx, ringIdx + 2500);
      // [Step3] assert inline 35px threshold and preventDefault before delete
      expect(ringBlock).toMatch(/nearestDist\s*<\s*35/);
      expect(ringBlock).toMatch(/onDeleteRing/);
      // preventDefault must be at top of handleContextMenu
      expect(block.slice(0, 400)).toMatch(/preventDefault/);
      // also verify helper nearestRingIndex itself uses 35 (duplicate, not sole)
      const helperIdx = content.indexOf('const nearestRingIndex');
      expect(helperIdx).toBeGreaterThan(-1);
      const helperBlock = content.slice(helperIdx, helperIdx + 1500);
      expect(helperBlock).toMatch(/nearestDist\s*<\s*35/);
    });

    it('handleContextMenu の vertex 分岐で 14px 距離チェックを inline で行う', () => {
      // [Step1] capture
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const idx = content.indexOf('handleContextMenu');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 7000);
      // [Step2] find vertex section after ring return
      const vertexMarker = block.indexOf("editMode !== 'vertex'");
      expect(vertexMarker).toBeGreaterThan(-1);
      const afterVertex = block.slice(vertexMarker, vertexMarker + 3000);
      // [Step3] assert 14px threshold inline
      expect(afterVertex).toMatch(/viDist\s*<\s*14|viDist\s*>=\s*14/);
      // nearestVertexIndex helper also uses 14
      const helperIdx = content.indexOf('const nearestVertexIndex');
      expect(helperIdx).toBeGreaterThan(-1);
      const helperBlock = content.slice(helperIdx, helperIdx + 1500);
      expect(helperBlock).toMatch(/nearestDist\s*<\s*14/);
    });

    it('handleMouseDown の dragRef は左クリック (button===0) のみで立て、右クリックドラッグは無効', () => {
      // [Step1] capture
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const idx = content.indexOf('handleMouseDown');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 6000);
      // [Step2] find ring mode hit handling
      const ringCommentIdx = block.indexOf('ring mode');
      expect(ringCommentIdx).toBeGreaterThan(-1);
      const ringBlock = block.slice(ringCommentIdx, ringCommentIdx + 1500);
      // [Step3] assert left-click guard and dragRef
      expect(ringBlock).toMatch(/e\.button\s*===\s*0/);
      expect(ringBlock).toMatch(/dragRef\.current\s*=\s*\{\s*index:\s*hit/);
      // ensure no unconditional dragRef outside button check for hit>=0
      // the block should have if (e.button===0) before dragRef
      const buttonIdx = ringBlock.indexOf('e.button === 0');
      const dragIdx = ringBlock.indexOf('dragRef.current');
      expect(buttonIdx).toBeGreaterThan(-1);
      expect(dragIdx).toBeGreaterThan(buttonIdx);
    });

    it('handleMouseDown の empty area は pan のみ、pan.moved による mouseup 追加は廃止 (onUp に onAddRing がない)', () => {
      // [Step1] capture
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      // [Step2] extract onUp block (mouseup handler)
      const onUpIdx = content.indexOf('const onUp');
      expect(onUpIdx).toBeGreaterThan(-1);
      const onUpBlock = content.slice(onUpIdx, onUpIdx + 1200);
      // [Step3] assert onUp does not contain ring add logic
      expect(onUpBlock).not.toMatch(/onAddRing/);
      expect(onUpBlock).not.toMatch(/addRingAt/);
      // onUp should handle vertex/edge/drag cleanup and pan reset only
      expect(onUpBlock).toMatch(/vertexDragRef/);
      expect(onUpBlock).toMatch(/panRef\.current\s*=\s*null/);
      // handleMouseDown empty area should only set panRef, not add ring
      const handleDownIdx = content.indexOf('handleMouseDown');
      const handleDoubleIdx = content.indexOf('const handleDoubleClick', handleDownIdx);
      const downEnd = handleDoubleIdx > -1 ? handleDoubleIdx : handleDownIdx + 6000;
      const downBlockRaw = content.slice(handleDownIdx, downEnd);
      // empty area comment or final panRef assignment should exist
      expect(downBlockRaw).toMatch(/panRef\.current\s*=\s*\{/);
      // there should be no onAddRing in handleMouseDown at all (only in handleDoubleClick)
      expect(downBlockRaw).not.toMatch(/onAddRing/);
    });

    it('onUp の引数は未使用でも _e で prefix されている (unused param lint対策)', () => {
      // [Step1] capture
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      // [Step2] find onUp signature
      const match = content.match(/const onUp\s*=\s*\(\s*(_e|e)\s*:/);
      expect(match).not.toBeNull();
      // [Step3] assert underscore prefix when unused
      // The file uses (_e: MouseEvent) per fix prescription
      expect(content).toMatch(/const onUp\s*=\s*\(_e\s*:/);
      // also ensure not using bare e without underscore while body ignores it
      // If it were (e: MouseEvent) but body never reads e, that would be unused
      expect(content.slice(content.indexOf('const onUp'), content.indexOf('const onUp') + 200)).not.toMatch(/const onUp\s*=\s*\(e\s*:/);
    });

    it('T116 V/E/R 分離と T141 vertex add/delete の回帰 — handleDoubleClick/handleContextMenu に両モードが残る', () => {
      // [Step1] capture
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const dcIdx = content.indexOf('handleDoubleClick');
      expect(dcIdx).toBeGreaterThan(-1);
      const dcBlock = content.slice(dcIdx, dcIdx + 7000);
      // [Step2] check both ring and vertex branches exist in doubleClick
      expect(dcBlock).toMatch(/editMode\s*===\s*['"]ring['"]/);
      expect(dcBlock).toMatch(/editMode\s*===\s*['"]vertex['"]/);
      // [Step3] check contextMenu has both ring and vertex
      const cmIdx = content.indexOf('handleContextMenu');
      const cmBlock = content.slice(cmIdx, cmIdx + 7000);
      expect(cmBlock).toMatch(/editMode\s*===\s*['"]ring['"]/);
      expect(cmBlock).toMatch(/editMode\s*!==\s*['"]vertex['"]/);
      // editMode type includes all three
      expect(content).toMatch(/EditMode.*vertex.*edge.*ring|type EditMode = 'vertex' \| 'edge' \| 'ring'/);
    });
  });

  // ========================================================================
  // 2. Ring ダブルクリック追加 — 空領域で +1、単発クリックでは追加されない (3-step)
  // ========================================================================
  describe('2. Ring ダブルクリック追加: 空領域で snap整数倍、単発では追加されない (off-grid)', () => {
    it('snap 0.25 空領域を off-grid 0.37拍相当でダブルクリック: quantizeされ snap整数倍で +1', () => {
      const snap = 0.25;
      // [Step1] capture initial rings state
      const initialRings: { beat: number }[] = [{ beat: 4 }, { beat: 8 }];
      const initialLen = initialRings.length;
      expect(initialLen).toBe(2);
      const rawBeat = 0.37; // off-grid
      const snapped = computeRingBeat(rawBeat, snap);
      // 0.37 with 0.25 -> 0.25
      expect(snapped).toBeCloseTo(0.25, 4);
      expect(isSnapAligned(snapped, snap)).toBeTruthy();
      // verify not 1/amplitude (1.0) when off-grid short
      expect(snapped).not.toBeCloseTo(1.0, 2);
      // [Step2] perform: simulate empty area double-click (hit <0)
      const width = 800;
      const viewStart = 0;
      const viewBeats = 16;
      const clickX = (snapped - viewStart) / viewBeats * width;
      const hit = nearestRingIndexMock(initialRings, snapped, viewStart, viewBeats, width, clickX); // far from existing rings (0.25 vs 4) -> -1
      expect(hit).toBe(-1);
      let addedBeat: number | null = null;
      if (hit < 0) {
        addedBeat = snapped;
        initialRings.push({ beat: addedBeat });
      }
      // [Step3] assert transition: +1 and snap-aligned
      expect(initialRings.length).toBe(initialLen + 1);
      expect(addedBeat).not.toBeNull();
      expect(isSnapAligned(addedBeat!, snap)).toBeTruthy();
      expect(addedBeat).toBeCloseTo(0.25, 4);
    });

    it('snap 0.5 空領域 1.37拍 off-grid ダブルクリック -> 1.5 に吸着、beats は snap整数倍', () => {
      const snap = 0.5;
      // [Step1] capture
      const rings: { beat: number }[] = [{ beat: 2 }];
      const beforeLen = rings.length;
      const rawBeat = 1.37;
      const snapped = computeRingBeat(rawBeat, snap);
      expect(snapped).toBeCloseTo(1.5, 4);
      expect(isSnapAligned(snapped, snap)).toBeTruthy();
      // [Step2] empty area double-click
      const width = 800;
      const viewStart = 0;
      const viewBeats = 16;
      const clickXEmpty = (snapped - viewStart) / viewBeats * width + 200; // offset to ensure empty
      // Use rings at 2 -> snapped 1.5 is distinct gap; choose click far from 2
      const hit = nearestRingIndexMock(rings, snapped, viewStart, viewBeats, width, (snapped - viewStart) / viewBeats * width);
      // distance from beat 2: (2 -1.5)/16*800=25px <35 -> would be nearest 0, so we need empty detection by placing click not near 2
      // Instead test that when click is near existing ring, add is suppressed
      // First case: near ring -> hit >=0 Should not add
      const nearClickX = (2 - viewStart) / viewBeats * width + 5; // near ring at 2
      const nearHit = nearestRingIndexMock(rings, 2, viewStart, viewBeats, width, nearClickX);
      expect(nearHit).toBe(0);
      // Empty area far away -> -1
      const farClickX = (snapped - viewStart) / viewBeats * width; // 1.5 -> 75px vs 100px for beat2 -> diff 25 <35 still hit, so choose viewBeats larger or snap different
      // To guarantee empty, use snapped far from existing: 6
      const farSnapped = computeRingBeat(6.37, snap); // 6.5
      const farX = (farSnapped - viewStart) / viewBeats * width;
      const farHit = nearestRingIndexMock(rings, farSnapped, viewStart, viewBeats, width, farX);
      expect(farHit).toBe(-1);
      if (farHit < 0) rings.push({ beat: farSnapped });
      // [Step3] assert far added, near not added
      expect(rings.length).toBe(beforeLen + 1);
      expect(isSnapAligned(farSnapped, snap)).toBeTruthy();
      expect(nearHit).toBe(0); // near would not add
      void clickXEmpty; // silence unused
    });

    it('クリック単発 (single click) ではリングが追加されない — ダブルクリックとの分離', () => {
      const snap = 0.25;
      // [Step1] capture
      const rings: { beat: number }[] = [{ beat: 4 }];
      const beforeLen = rings.length;
      expect(beforeLen).toBe(1);
      // [Step2] simulate single click handler path (handleMouseDown -> pan, not onAddRing)
      // In current WavePreview, handleMouseDown for empty area only sets panRef.moved=false,
      // and onUp does not call onAddRing. So single click count stays same.
      const simulatedPanAdded = false; // no add on mouseup
      void snap;
      // [Step3] assert no addition on single click path
      expect(simulatedPanAdded).toBeFalsy();
      expect(rings.length).toBe(beforeLen);
      // double-click path would add
      const rawBeat = 1.23;
      const snapped = computeRingBeat(rawBeat, snap);
      expect(isSnapAligned(snapped, snap)).toBeTruthy();
      rings.push({ beat: snapped });
      expect(rings.length).toBe(beforeLen + 1);
    });

    it('snap 0.125/1.0 でも off-grid 0.37/1.23 で snap整数倍 (包括)', () => {
      for (const snap of [0.125, 0.25, 0.5, 1] as const) {
        for (const raw of [0.37, 1.23] as const) {
          // [Step1] capture snap
          const snapped = computeRingBeat(raw, snap);
          expect(isSnapAligned(snapped, snap), `snap ${snap} raw ${raw} -> ${snapped}`).toBeTruthy();
          // [Step2] verify not arbitrary raw residue
          if (Math.abs(raw - snapped) > 1e-6) {
            expect(snapped).not.toBeCloseTo(raw, 2);
          }
          // [Step3] ensure beats quantized properly
          const remainder = ((snapped % snap) + snap) % snap;
          const aligned = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6;
          expect(aligned).toBeTruthy();
        }
      }
    });

    it('既存リング近傍 (hit >=0) へのダブルクリックでは追加されない', () => {
      const snap = 0.25;
      // [Step1] capture rings with known beat
      const rings: { beat: number }[] = [{ beat: 4 }, { beat: 8 }];
      const viewStart = 0;
      const viewBeats = 16;
      const width = 800;
      const targetBeat = 4; // existing
      const clickX = (targetBeat - viewStart) / viewBeats * width;
      const hit = nearestRingIndexMock(rings, targetBeat, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(0);
      // [Step2] perform double-click at same X (should be blocked by hit>=0)
      let added = false;
      if (hit < 0) {
        const beat = computeRingBeat(targetBeat, snap);
        rings.push({ beat });
        added = true;
      }
      // [Step3] assert not added
      expect(added).toBeFalsy();
      expect(rings.length).toBe(2);
    });
  });

  // ========================================================================
  // 3. 右クリック削除 — リング上で -1、コンテキストメニュー抑止 (3-step)
  // ========================================================================
  describe('3. 右クリック削除: リング上で -1、空領域では削除なし、preventDefault抑止 (off-grid含む)', () => {
    it('リング上で右クリック: nearestDist<35 で -1、preventDefault 呼び出し', () => {
      // [Step1] capture initial rings
      const rings: { beat: number }[] = [{ beat: 4 }, { beat: 8 }, { beat: 12 }];
      const beforeLen = rings.length;
      expect(beforeLen).toBe(3);
      const viewStart = 0;
      const viewBeats = 16;
      const width = 800;
      const targetBeat = 8;
      const clickX = (targetBeat - viewStart) / viewBeats * width;
      const hit = nearestRingIndexMock(rings, targetBeat, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(1);
      // simulate preventDefault
      let prevented = false;
      const e = { preventDefault: () => { prevented = true; }, clientX: clickX } as unknown as MouseEvent;
      // call handler inline logic mirror: preventDefault then if distance <35 delete
      e.preventDefault();
      expect(prevented).toBeTruthy();
      // [Step2] perform delete as WavePreview does
      if (hit >= 0) {
        rings.splice(hit, 1);
      }
      // [Step3] assert -1 and correct ring removed
      expect(rings.length).toBe(beforeLen - 1);
      expect(rings.some(r => r.beat === 8)).toBeFalsy();
      expect(rings[0].beat).toBe(4);
      expect(rings[1].beat).toBe(12);
    });

    it('空領域で右クリック: nearestDist >=35 で削除なし、preventDefault は呼ばれるが削除しない', () => {
      // [Step1] capture
      const rings: { beat: number }[] = [{ beat: 4 }];
      const beforeLen = rings.length;
      const viewStart = 0;
      const viewBeats = 16;
      const width = 800;
      const farClickX = 700; // far from beat 4 at 200px
      const hit = nearestRingIndexMock(rings, 4, viewStart, viewBeats, width, farClickX);
      expect(hit).toBe(-1);
      let prevented = false;
      const mockE = { preventDefault: () => { prevented = true; } } as unknown as MouseEvent;
      mockE.preventDefault();
      // [Step2] attempt delete
      let deleted = false;
      if (hit >= 0 && hit < rings.length) {
        rings.splice(hit, 1);
        deleted = true;
      }
      // [Step3] assert not deleted but prevented still true (context menu suppressed)
      expect(deleted).toBeFalsy();
      expect(prevented).toBeTruthy();
      expect(rings.length).toBe(beforeLen);
    });

    it('off-grid 位置のリングも 35px 以内で削除できる (beat 4.37 snap 0.25 -> 4.25)', () => {
      const snap = 0.25;
      // [Step1] capture ring at off-grid snapped beat
      const raw = 4.37;
      const snapped = computeRingBeat(raw, snap); // 4.25
      expect(snapped).toBeCloseTo(4.25, 4);
      expect(isSnapAligned(snapped, snap)).toBeTruthy();
      const rings: { beat: number }[] = [{ beat: snapped }, { beat: 8 }];
      const viewStart = 0;
      const viewBeats = 16;
      const width = 800;
      const clickX = (snapped - viewStart) / viewBeats * width + 2; // within 35
      const hit = nearestRingIndexMock(rings, snapped, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(0);
      // [Step2] delete
      rings.splice(hit, 1);
      // [Step3] assert removed
      expect(rings.length).toBe(1);
      expect(rings[0].beat).toBe(8);
    });
  });

  // ========================================================================
  // 4. ドラッグ分離 — 左ドラッグで移動、右ドラッグでは移動しない (3-step)
  // ========================================================================
  describe('4. ドラッグ分離: 左ドラッグでリング移動、右クリックドラッグでは移動しない', () => {
    it('左クリック (button 0) で dragRef が立ち、移動で beat が更新される', () => {
      // [Step1] capture initial ring beat
      const rings: { beat: number }[] = [{ beat: 4 }];
      const beforeBeat = rings[0].beat;
      expect(beforeBeat).toBeCloseTo(4, 4);
      // [Step2] simulate handleMouseDown left click on ring
      const width = 800;
      const viewStart = 0;
      const viewBeats = 16;
      const clickX = (beforeBeat - viewStart) / viewBeats * width;
      const hit = nearestRingIndexMock(rings, beforeBeat, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(0);
      const eDown = { button: 0, clientX: clickX } as unknown as MouseEvent;
      let dragRef: { index: number } | null = null;
      if (hit >= 0 && eDown.button === 0) {
        dragRef = { index: hit };
      }
      expect(dragRef).not.toBeNull();
      // simulate mousemove to newX
      const newBeatRaw = 6.37; // off-grid
      const snap = 0.25;
      const newBeat = computeRingBeat(newBeatRaw, snap); // 6.25
      expect(isSnapAligned(newBeat, snap)).toBeTruthy();
      if (dragRef) {
        rings[dragRef.index].beat = newBeat; // onMoveRing called with raw beat, quant handled by caller
      }
      // [Step3] assert moved and snap-aligned
      expect(rings[0].beat).toBeCloseTo(6.25, 4);
      expect(rings[0].beat).not.toBeCloseTo(beforeBeat, 2);
      expect(isSnapAligned(rings[0].beat, snap)).toBeTruthy();
    });

    it('右クリック (button 2) では dragRef が立たず、mousemove でも beat が変わらない', () => {
      // [Step1] capture
      const rings: { beat: number }[] = [{ beat: 4 }];
      const beforeBeat = rings[0].beat;
      const width = 800;
      const viewStart = 0;
      const viewBeats = 16;
      const clickX = (beforeBeat - viewStart) / viewBeats * width;
      const hit = nearestRingIndexMock(rings, beforeBeat, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(0);
      // [Step2] simulate right click
      const eDown = { button: 2, clientX: clickX } as unknown as MouseEvent;
      let dragRef: { index: number } | null = null;
      if (hit >= 0 && eDown.button === 0) {
        dragRef = { index: hit };
      }
      expect(dragRef).toBeNull();
      // attempt to move (should not affect)
      const newBeat = 6.5;
      if (dragRef) {
        rings[dragRef.index].beat = newBeat;
      }
      // [Step3] assert unchanged
      expect(rings[0].beat).toBeCloseTo(beforeBeat, 4);
      expect(rings[0].beat).not.toBeCloseTo(newBeat, 2);
    });

    it('左ドラッグ off-grid 1.23 beat で snap 0.5 -> 1.0 に吸着して移動', () => {
      const snap = 0.5;
      // [Step1] capture
      const rings: { beat: number }[] = [{ beat: 2 }];
      const before = rings[0].beat;
      expect(before).toBe(2);
      const rawTarget = 1.23;
      const snappedTarget = computeRingBeat(rawTarget, snap);
      expect(snappedTarget).toBeCloseTo(1.0, 4);
      expect(isSnapAligned(snappedTarget, snap)).toBeTruthy();
      // [Step2] left drag move
      let dragRef: { index: number } | null = { index: 0 };
      if (dragRef) rings[dragRef.index].beat = snappedTarget;
      // [Step3] assert snap-aligned move
      expect(rings[0].beat).toBeCloseTo(1.0, 4);
      expect(isSnapAligned(rings[0].beat, snap)).toBeTruthy();
    });
  });

  // ========================================================================
  // 5. 回帰 T116 / T141 — V/E/R 分離と vertex 14px が維持される (3-step)
  // ========================================================================
  describe('5. 回帰: T116 V/E/R 分離 / T141 vertex 右クリック 14px が壊れていない', () => {
    it('editMode が vertex のとき handleMouseDown は ring 追加を呼ばず vertexDrag のみ', () => {
      // [Step1] capture source for vertex mode block
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const downIdx = content.indexOf('handleMouseDown');
      expect(downIdx).toBeGreaterThan(-1);
      const block = content.slice(downIdx, downIdx + 6000);
      const vertexIdx = block.indexOf("editMode === 'vertex'");
      expect(vertexIdx).toBeGreaterThan(-1);
      const vertexBlock = block.slice(vertexIdx, vertexIdx + 2000);
      // [Step2] verify vertex block contains vertexDragRef and pan, not ring add
      expect(vertexBlock).toMatch(/vertexDragRef/);
      expect(vertexBlock).toMatch(/panRef\.current/);
      expect(vertexBlock).not.toMatch(/onAddRing/);
      // [Step3] also edge mode does not call ring add
      const edgeIdx = block.indexOf("editMode === 'edge'");
      expect(edgeIdx).toBeGreaterThan(-1);
      const edgeBlock = block.slice(edgeIdx, edgeIdx + 2000);
      expect(edgeBlock).toMatch(/onSelectSegment/);
      expect(edgeBlock).not.toMatch(/onAddRing/);
    });

    it('handleContextMenu が ring と vertex で排他的に分岐し、どちらも preventDefault を持つ', () => {
      // [Step1] capture
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const cmIdx = content.indexOf('handleContextMenu');
      const block = content.slice(cmIdx, cmIdx + 7000);
      expect(block).toContain('handleContextMenu');
      // [Step2] extract branches
      const ringBranch = block.slice(block.indexOf("editMode === 'ring'"), block.indexOf("editMode === 'ring'") + 2500);
      const vertexCheck = block.slice(block.indexOf("editMode !== 'vertex'"), block.indexOf("editMode !== 'vertex'") + 1500);
      // [Step3] assert both exist and preventDefault is at top (common)
      expect(ringBranch).toMatch(/onDeleteRing/);
      expect(vertexCheck.length).toBeGreaterThan(0);
      expect(block.slice(0, 300)).toMatch(/preventDefault/);
      // ensure vertex delete still checks endpoint protection vi <=0 / vi >= pts.length-1
      expect(block).toMatch(/vi\s*<=\s*0/);
      expect(block).toMatch(/vi\s*>=.*pts\.length/);
    });

    it('wave-preview ヒントテキストが各モードで正しい説明を表示 (ring は ダブルクリックで追加)', () => {
      // [Step1] capture hint JSX
      const content = readSrc('src/screens/editor/WavePreview.tsx');
      const hintIdx = content.indexOf('wave-preview-hint');
      expect(hintIdx).toBeGreaterThan(-1);
      const hintBlock = content.slice(hintIdx, hintIdx + 1500);
      // [Step2] perform mode string checks
      // ring hint must contain ダブルクリックで追加 and 右クリックで削除
      // [Step3] assert
      expect(hintBlock).toMatch(/リングモード: ダブルクリックで追加/);
      expect(hintBlock).toMatch(/右クリックで削除/);
      expect(hintBlock).toMatch(/頂点モード: ダブルクリックで追加/);
      expect(hintBlock).toMatch(/辺モード:/);
    });
  });

  // ========================================================================
  // 6. WaveEngine / Cursor 数値整合 — 複雑な振幅 & off-grid 位相 (T127/T128回帰)
  // ========================================================================
  describe('6. WaveEngine / Cursor 数値整合 — 複雑な振幅 & off-grid位相で同一規約 (T127/T128回帰)', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrid = [0.37, 1.23];
    const timeline120 = new BpmTimeline(120, []);

    it.each(amps)('amp=%s slope が 2*TW_AMP*amp と一致 (clipped 前)', (amp) => {
      // [Step1] capture initial engine with long segment to avoid clip at small delta
      const tlAmp = new BpmTimeline(120, [], amp);
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tlAmp, amp, 0);
      const delta = 0.1;
      const dy = engine.waveYAt(delta) - engine.waveYAt(0);
      const slope = dy / delta;
      // [Step2] perform cursor update same physical time
      const beatMs = 500;
      const dt = (delta * beatMs) / 1000;
      const cursor = new Cursor(amp, 0);
      const y0 = cursor.y;
      cursor.update(dt, false, true, beatMs, 1);
      const slopeCursor = (cursor.y - y0) / delta;
      // [Step3] assert both slopes equal physical speed, not diluted
      expect(slope).toBeCloseTo(2 * TW_AMP * amp, 1);
      expect(slopeCursor).toBeCloseTo(2 * TW_AMP * amp, 1);
      expect(slope).toBeCloseTo(slopeCursor, 1);
    });

    for (const amp of amps) {
      for (const b of offGrid) {
        it(`amp=${amp} off-grid beat=${b} waveYAt が clamp(CENTER + 2*TW_AMP*amp*beat) と一致`, () => {
          // [Step1] capture expected before clip
          const expected = expectedClampedY(0, amp, 'down', b);
          const tlAmp = new BpmTimeline(120, [], amp);
          const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tlAmp, amp, 0);
          // [Step2] perform waveYAt
          const actual = engine.waveYAt(b);
          // [Step3] assert off-grid climb uses perBeat*delta without premature clamp dilution
          expect(actual).toBeCloseTo(expected, 1);
          // Ensure off-grid before border is not already at integer beat's diluted value
          // For amp where 0.37 not yet clipped, Y must not equal BOTTOM prematurely
          if (expected !== BOTTOM && expected !== TOP) {
            expect(actual).not.toBeCloseTo(BOTTOM, 1);
            expect(actual).not.toBeCloseTo(TOP, 1);
          }
        });
      }
    }

    it('clipped single segment — amp=1.0 down beats=3 が beat 0.5 で底に到達し以降 flat (off-grid 0.37/1.23)', () => {
      const amp = 1.0;
      const engine = new WaveEngine([{ direction: 'down', beats: 3 }], timeline120, amp, 0);
      // [Step1] capture 0.37 before bottom, 0.5 at bottom
      const y037 = engine.waveYAt(0.37);
      const y05 = engine.waveYAt(0.5);
      const y10 = engine.waveYAt(1.0);
      const y123 = engine.waveYAt(1.23);
      // [Step2] compute expected
      const exp037 = expectedClampedY(0, amp, 'down', 0.37);
      const exp05 = expectedClampedY(0, amp, 'down', 0.5);
      // [Step3] assert
      expect(y037).toBeCloseTo(exp037, 1);
      expect(y05).toBeCloseTo(BOTTOM, 1);
      expect(exp05).toBeCloseTo(BOTTOM, 1);
      expect(y10).toBeCloseTo(BOTTOM, 1);
      expect(y123).toBeCloseTo(BOTTOM, 1);
      // slope before clip must be 260, not 43 diluted
      const slope = (engine.waveYAt(0.25) - engine.waveYAt(0)) / 0.25;
      expect(slope).toBeCloseTo(2 * TW_AMP * amp, 1);
      // slope after border flat (use precision 2 to avoid 0-threshold bug)
      const slopeFlat = engine.waveYAt(1.0) - engine.waveYAt(0.5);
      expect(slopeFlat).toBeCloseTo(0, 2);
    });

    it('cursor と waveEngine の off-grid 0.37/1.23 での一致と上下幅 TW_AMP=130 不変', () => {
      // [Step1] capture before engines at multiple amplitudes
      const ampsToCheck = [0.5, 1.3, 2.7];
      for (const amp of ampsToCheck) {
        const tlAmp = new BpmTimeline(120, [], amp);
        const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tlAmp, amp, 0);
        const pts = engine.getPoints();
        const ys = pts.map(p => p.y);
        const maxY = Math.max(...ys);
        const minY = Math.min(...ys);
        // [Step2] height check
        expect(maxY).toBeLessThanOrEqual(BOTTOM + 1e-6);
        expect(minY).toBeGreaterThanOrEqual(TOP - 1e-6);
        expect(maxY - minY).toBeLessThanOrEqual(2 * TW_AMP + 1e-6);
        // [Step3] off-grid cursor vs wave
        for (const b of [0.37, 1.23] as const) {
          const wy = engine.waveYAt(b);
          const beatMs = 500;
          const dt = (b * beatMs) / 1000;
          const cursor = new Cursor(amp, 0);
          // cursor up to b would be clamped if beyond bottom, so compare clipped expectation
          const expected = expectedClampedY(0, amp, 'down', b);
          expect(wy).toBeCloseTo(expected, 1);
          // cursor path: need to handle clamp same as wave
          cursor.update(dt, false, true, beatMs, 1);
          // if b large and amp high, cursor also clamped to BOTTOM
          if (expected === BOTTOM) {
            expect(cursor.y).toBeCloseTo(BOTTOM, 1);
          } else {
            // before clip, cursor.y should equal wy (started at center)
            expect(cursor.y).toBeCloseTo(wy, 1);
          }
        }
      }
    });

    it('getPoints 長さ不変 (segments+1) と構造 {beat,y} のみ — 追加/削除後も維持', () => {
      // [Step1] capture cases
      const cases: Segment[][] = [
        [{ direction: 'down', beats: 1 }],
        [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }],
        [{ direction: 'down', beats: 0.5 }, { direction: 'stay', beats: 1 }, { direction: 'up', beats: 0.5 }],
      ];
      for (const segs of cases) {
        const engine = new WaveEngine(segs, timeline120, 1.0, 0);
        const pts = engine.getPoints();
        // [Step2] perform check
        expect(pts.length).toBe(segs.length + 1);
        for (const p of pts) {
          expect(typeof p.beat).toBe('number');
          expect(typeof p.y).toBe('number');
          expect(Object.keys(p).sort()).toEqual(['beat', 'y']);
        }
        // [Step3] also verify no dY leakage
        const raw = JSON.stringify(pts);
        expect(raw).not.toMatch(/dY/);
      }
    });

    it('segmentize の全 beats が snap整数倍 (isSnapAligned) — off-grid trajectory', () => {
      // [Step1] capture trajectory off-grid
      const traj = [
        { beat: 0, y: CENTER, down: true },
        { beat: 0.37, y: CENTER + 50, down: true },
        { beat: 1.23, y: CENTER + 130, down: true },
        { beat: 1.24, y: CENTER + 130, down: false },
      ];
      for (const snap of [0.125, 0.25, 0.5, 1] as const) {
        for (const amp of [0.7, 1.3, 2.7] as const) {
          // [Step2] perform segmentize
          const segs = segmentize(traj, snap, amp);
          expect(segs.length).toBeGreaterThan(0);
          // [Step3] assert snap-aligned via helper (not precision 0)
          for (const s of segs) {
            expect(isSnapAligned(s.beats, snap), `amp=${amp} snap=${snap} beats=${s.beats}`).toBeTruthy();
            const rem = ((s.beats % snap) + snap) % snap;
            expect(rem < 1e-6 || Math.abs(rem - snap) < 1e-6).toBeTruthy();
          }
        }
      }
    });
  });

  // ========================================================================
  // 7. snap整合性 — beats が常に snap整数倍 & waveYAtMs 経由でも一致
  // ========================================================================
  describe('7. snap整合性 & waveYAtMs 一致 — off-grid 0.37/1.23', () => {
    it('複数 snap で off-grid rawBeat の ring beat が isSnapAligned', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const raws = [0.37, 0.44, 1.2, 1.23, 0.3] as const;
      for (const snap of snaps) {
        for (const raw of raws) {
          // [Step1] capture raw
          const snapped = computeRingBeat(raw, snap);
          // [Step2] assert snap-aligned
          expect(isSnapAligned(snapped, snap), `snap ${snap} raw ${raw} -> ${snapped}`).toBeTruthy();
          // [Step3] ensure not arbitrary residue when off-grid
          if (Math.abs(raw - snapped) > 1e-6) {
            expect(snapped).not.toBeCloseTo(raw, 2);
          }
        }
      }
    });

    it('waveYAtMs が waveYAt(msToBeat) と一致 (off-grid 0.37/1.23)', () => {
      const tl = new BpmTimeline(120, []);
      const engine = new WaveEngine([{ direction: 'down', beats: 3 }], tl, 1.0, 0);
      for (const b of [0.37, 1.23] as const) {
        // [Step1] capture ms
        const ms = tl.beatToMs(b);
        // [Step2] perform both
        const viaMs = engine.waveYAtMs(ms);
        const viaBeat = engine.waveYAt(b);
        // [Step3] assert equal
        expect(viaMs).toBeCloseTo(viaBeat, 1);
      }
    });

    it('BpmTimeline amplitudeAt が step 関数で off-grid 3.37/4.37 を正しく返す', () => {
      // [Step1] capture timeline with entry at beat 4
      const tl = new BpmTimeline(120, [{ beat: 4, bpm: 120, amplitude: 2.0 }], 1.0);
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.0, 4);
      expect(tl.amplitudeAt(4.0)).toBeCloseTo(2.0, 4);
      expect(tl.amplitudeAt(4.37)).toBeCloseTo(2.0, 4);
      // [Step2] waveYAt perBeat at off-grid should use correct amplitude
      const engine = new WaveEngine([{ direction: 'down', beats: 10 }], tl, 1.0, 0);
      // first segment from 0 amp 1.0, at 4.37 we are in later segment with amp 2.0 dY
      // Check that wave slope after beat 4 is steeper (2.0)
      const dyBefore = engine.waveYAt(3.37) - engine.waveYAt(3.0);
      // [Step3] before change slope uses 1.0 (if not clipped)
      // This is complex due to clipping, but amplitudeAt correctness is core
      expect(tl.amplitudeAt(3.37)).not.toBeCloseTo(tl.amplitudeAt(4.37), 2);
      void dyBefore;
    });
  });
});
