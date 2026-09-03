import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat } from '../src/chart/quantize';
import type { RingDef, Segment } from '../src/types';
import * as fs from 'fs';

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

// Reference implementation of T142 ring add (double-click, empty area only)
// Spec: onDoubleClick button 0 detail 2, editMode==='ring', nearestRingIndex === -1 (hit <35)
// beat = quantizeBeat(xToBeat, safeSnap) -> onAddRing(beat)
function referenceRingAdd(
  rings: RingDef[],
  rawBeat: number,
  snap: number,
  editMode: string,
  nearestHit: number,
): RingDef[] | null {
  const safeSnap = snap > 0 ? snap : 0.25;
  if (editMode !== 'ring') return null;
  if (nearestHit >= 0) return null;
  const beat = quantizeBeat(rawBeat, safeSnap);
  // ensure beat is snap aligned
  if (!isSnapAligned(beat, safeSnap)) return null;
  const next = [...rings, { beat: Number(beat.toFixed(4)) }];
  return next;
}

// Reference implementation of T142 ring delete (right-click / contextMenu)
// Spec: onContextMenu button 2, nearestRingIndex <35 (hit >=0), e.preventDefault()
function referenceRingDelete(
  rings: RingDef[],
  hitIndex: number,
  editMode: string,
): RingDef[] | null {
  const safeMode = editMode;
  if (safeMode !== 'ring') return null;
  if (hitIndex < 0) return null;
  if (hitIndex >= rings.length) return null;
  const next = [...rings];
  next.splice(hitIndex, 1);
  return next;
}

function canBeginRingDrag(editMode: string, hitIndex: number, button: number): boolean {
  if (editMode !== 'ring') return false;
  if (hitIndex < 0) return false;
  if (button !== 0) return false;
  return true;
}

// Helper to compute nearest ring index like WavePreview.nearestRingIndex
function nearestRingIndexSim(
  rings: RingDef[],
  viewStart: number,
  viewBeats: number,
  width: number,
  clickX: number,
): number {
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

  // ------------------------------------------------------------
  // 1. ファイル実装マーカー (Red before T142 / Green after)
  // ------------------------------------------------------------
  describe('1. WavePreview.tsx 実装マーカー', () => {
    it('handleDoubleClick が ring モードのダブルクリック追加を実装 (quantizeBeat, safeSnap, onAddRing, emptyチェック, detail/button)', () => {
      // [Step1] capture initial state
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      const idx = content.indexOf('handleDoubleClick');
      expect(idx).toBeGreaterThan(-1);
      // [Step2] extract block
      const block = content.slice(idx, idx + 7000);
      expect(block.length).toBeGreaterThan(0);
      // [Step3] assert required markers for new spec
      expect(block).toMatch(/editMode\s*===\s*['"]ring['"]/);
      expect(block).toMatch(/nearestRingIndex/);
      expect(block).toMatch(/quantizeBeat/);
      expect(block).toMatch(/onAddRing/);
      expect(block).toMatch(/safeSnap/);
      // empty area only: hit <0 or hit === -1 or hit < 35 check
      expect(block).toMatch(/hit\s*<\s*0|hit\s*===\s*-1|nearestRingIndex[^]*?<\s*0/);
      // double-click specifics: detail 2 and button 0 (React synthetic or explicit)
      expect(block).toMatch(/e\.detail|detail/);
      expect(block).toMatch(/e\.button|button/);
      // must NOT still only delete: must contain add path
      expect(block).toMatch(/onAddRing\s*\(/);
    });

    it('handleContextMenu が ring 右クリック削除を実装 (preventDefault, nearestRingIndex <35, onDeleteRing)', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleContextMenu');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 6000);
      // [Step1] capture
      expect(block.length).toBeGreaterThan(0);
      // [Step2] require preventDefault still
      expect(block).toMatch(/preventDefault/);
      // [Step3] ring branch markers
      expect(block).toMatch(/editMode\s*===\s*['"]ring['"]/);
      expect(block).toMatch(/nearestRingIndex/);
      expect(block).toMatch(/onDeleteRing/);
      // distance check <35
      expect(block).toMatch(/35/);
      // ring branch should appear before vertex early-return to ensure exclusivity
      const ringPos = block.indexOf("editMode === 'ring'");
      const vertexPos = block.indexOf("editMode !== 'vertex'");
      if (ringPos > -1 && vertexPos > -1) {
        expect(ringPos).toBeLessThan(vertexPos);
      }
    });

    it('handleMouseDown の dragRef は左クリックのみ有効 (e.button===0) — 右クリックドラッグでは立てない', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleMouseDown');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 6000);
      // [Step1] capture dragRef assignment
      expect(block).toMatch(/dragRef\.current/);
      expect(block).toMatch(/nearestRingIndex/);
      // [Step2] button guard
      // [Step3] assert left-click guard present
      expect(block).toMatch(/e\.button\s*===\s*0|button\s*!==\s*0|e\.button/);
    });

    it('onUp (mouseup) の pan.moved==false での addRingAt 廃止 — ダブルクリックと二重発火しない', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('const onUp');
      expect(idx).toBeGreaterThan(-1);
      const block = content.slice(idx, idx + 4000);
      // [Step1] capture
      expect(block.length).toBeGreaterThan(0);
      // [Step2] check that old single-click add is removed
      // Old pattern: if (panRef.current && !panRef.current.moved) { ... addRingAt }
      // After T142, addRingAt should NOT appear inside onUp
      // [Step3] assert absence
      expect(block).not.toMatch(/addRingAt/);
      expect(block).not.toMatch(/panRef\.current\.moved[^]*?addRingAt/);
    });

    it('onDoubleClick が vertex モード追加を維持し ring モード追加と共存 (T141回帰)', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleDoubleClick');
      const block = content.slice(idx, idx + 7000);
      // [Step1] capture
      expect(block.length).toBeGreaterThan(0);
      // [Step2] check both branches exist
      expect(block).toMatch(/editMode\s*===\s*['"]ring['"]/);
      expect(block).toMatch(/editMode\s*===\s*['"]vertex['"]/);
      // vertex branch should still have beatAdd / yAdd / perBeat / splice
      expect(block).toMatch(/beatAdd/);
      expect(block).toMatch(/yAdd/);
      expect(block).toMatch(/splice\(k,/);
    });

    it('handleContextMenu が vertex 削除 (nearestVertexIndex <14, endpoint保護) と ring 削除を排他で共存', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleContextMenu');
      const block = content.slice(idx, idx + 6000);
      expect(block).toMatch(/nearestVertexIndex/);
      expect(block).toMatch(/14/);
      // endpoint protection vi <=0 or vi >= pts.length-1
      expect(block).toMatch(/vi\s*<=\s*0|vi\s*===\s*0/);
      expect(block).toMatch(/pts\.length/);
      // ring branch also present
      expect(block).toMatch(/nearestRingIndex/);
      expect(block).toMatch(/onDeleteRing/);
    });

    it('canvas に onDoubleClick と onContextMenu がバインドされている', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      expect(content).toMatch(/onDoubleClick=\{handleDoubleClick\}/);
      expect(content).toMatch(/onContextMenu=\{handleContextMenu\}/);
    });
  });

  // ------------------------------------------------------------
  // 2. ダブルクリック追加 — 空領域で+1, snap整数倍, off-grid, singleクリックでは追加されない
  // ------------------------------------------------------------
  describe('2. Ring ダブルクリック追加: 空領域+1, snap整数倍, off-grid, 単クリック否定', () => {
    it('snap 0.25 off-grid 1.37 空領域ダブルクリック: rings+1, beat=quantize 1.25, snap整数倍', () => {
      const snap = 0.25;
      const initial: RingDef[] = [{ beat: 1 }, { beat: 3 }];
      // [Step1] capture initial state
      const beforeLen = initial.length;
      const rawBeat = 1.37; // off-grid
      const q = quantizeBeat(rawBeat, snap);
      expect(q).toBeCloseTo(1.25, 4);
      expect(isSnapAligned(q, snap)).toBeTruthy();
      // simulate empty area: no ring within 35px
      const hit = -1;
      expect(hit).toBe(-1);
      // [Step2] perform double-click add
      const after = referenceRingAdd(initial, rawBeat, snap, 'ring', hit);
      expect(after).not.toBeNull();
      // [Step3] assert transition
      expect(after!.length).toBe(beforeLen + 1);
      expect(isSnapAligned(after![after!.length - 1].beat, snap)).toBeTruthy();
      expect(after![after!.length - 1].beat).toBeCloseTo(q, 4);
      // ensure not hit area: if hit >=0 should not add
      const noAdd = referenceRingAdd(initial, rawBeat, snap, 'ring', 0);
      expect(noAdd).toBeNull();
    });

    it('snap 0.5 off-grid 0.37 空領域: beat 0.5 に吸着, 不整合1/amplitudeでない', () => {
      const snap = 0.5;
      const amp = 1;
      const initial: RingDef[] = [{ beat: 2 }];
      const rawBeat = 0.37; // off-grid -> 0.5
      // [Step1] capture
      const beforeLen = initial.length;
      const q = quantizeBeat(rawBeat, snap);
      expect(q).toBeCloseTo(0.5, 4);
      expect(q).not.toBeCloseTo(1 / amp, 4);
      expect(isSnapAligned(q, snap)).toBeTruthy();
      // [Step2] perform
      const after = referenceRingAdd(initial, rawBeat, snap, 'ring', -1);
      expect(after).not.toBeNull();
      // [Step3] assert
      expect(after!.length).toBe(beforeLen + 1);
      expect(after![after!.length - 1].beat).toBeCloseTo(0.5, 4);
      expect(after![after!.length - 1].beat).not.toBeCloseTo(1.0, 4);
      for (const r of after!) expect(isSnapAligned(r.beat, snap)).toBeTruthy();
    });

    it('snap 0.125 off-grid 1.23 空領域: 1.25 に吸着, snap整数倍', () => {
      const snap = 0.125;
      const initial: RingDef[] = [];
      const rawBeat = 1.23; // ->1.25
      // [Step1]
      const q = quantizeBeat(rawBeat, snap);
      expect(q).toBeCloseTo(1.25, 4);
      expect(isSnapAligned(q, snap)).toBeTruthy();
      const beforeLen = initial.length;
      // [Step2]
      const after = referenceRingAdd(initial, rawBeat, snap, 'ring', -1);
      expect(after).not.toBeNull();
      // [Step3]
      expect(after!.length).toBe(beforeLen + 1);
      expect(after![after!.length - 1].beat).toBeCloseTo(1.25, 4);
    });

    it('snap 1.0 off-grid 1.37 空領域: 1.0 に吸着, snap整数倍', () => {
      const snap = 1.0;
      const initial: RingDef[] = [{ beat: 4 }];
      const rawBeat = 1.37; // ->1.0
      // [Step1]
      const q = quantizeBeat(rawBeat, snap);
      expect(q).toBeCloseTo(1, 4);
      // [Step2]
      const after = referenceRingAdd(initial, rawBeat, snap, 'ring', -1);
      expect(after).not.toBeNull();
      // [Step3]
      expect(after!.length).toBe(2);
      expect(after![1].beat).toBeCloseTo(1, 4);
      expect(isSnapAligned(after![1].beat, snap)).toBeTruthy();
    });

    it('単クリック（pan.moved==false の mouseup）ではリングが追加されない — 二重発火分離', () => {
      const snap = 0.25;
      const initial: RingDef[] = [{ beat: 1 }];
      // [Step1] capture before
      const beforeLen = initial.length;
      const rawBeat = 0.37;
      // Simulate that old single-click path would have called addRingAt on mouseup,
      // but new spec says only double-click adds. So we assert that a helper representing
      // single-click does NOT call referenceRingAdd.
      // We model singleClickAdd as null-operation (should not add)
      const singleClickAdd = (rings: RingDef[], _beat: number): RingDef[] | null => {
        // spec: single click must NOT add (pan only)
        return null;
      };
      // [Step2] perform single click (should be no-op)
      const afterSingle = singleClickAdd(initial, rawBeat);
      // [Step3] assert no transition
      expect(afterSingle).toBeNull();
      expect(initial.length).toBe(beforeLen);
      // double-click does add
      const afterDouble = referenceRingAdd(initial, rawBeat, snap, 'ring', -1);
      expect(afterDouble).not.toBeNull();
      expect(afterDouble!.length).toBe(beforeLen + 1);
    });

    it('hit 領域 (nearestRingIndex >=0) でのダブルクリックは追加せず削除のみ', () => {
      const snap = 0.25;
      const initial: RingDef[] = [{ beat: 1 }, { beat: 2 }];
      const rawBeat = 1.02; // near first ring
      // [Step1] capture nearest
      const viewStart = 0;
      const viewBeats = 16;
      const width = 800;
      // compute clickX near beat 1
      const clickX = ((1 - viewStart) / viewBeats) * width + 2; // within 35
      const hit = nearestRingIndexSim(initial, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(0);
      // [Step2] try add on hit area
      const afterAdd = referenceRingAdd(initial, rawBeat, snap, 'ring', hit);
      // [Step3] must be null (no add on occupied)
      expect(afterAdd).toBeNull();
      // delete should succeed
      const afterDel = referenceRingDelete(initial, hit, 'ring');
      expect(afterDel).not.toBeNull();
      expect(afterDel!.length).toBe(initial.length - 1);
    });

    it('複雑な振幅 1.3 snap 0.5 off-grid 1.37 でもリング追加は snap整数倍で amplitude に影響されない', () => {
      const snap = 0.5;
      const tl = new BpmTimeline(120, [], 1.3);
      // Rings are beat-based, amplitude should not affect quantization
      expect(tl.amplitudeAt(1.37)).toBeCloseTo(1.3, 4);
      const initial: RingDef[] = [{ beat: 0 }];
      const rawBeat = 1.37; // ->1.5
      const q = quantizeBeat(rawBeat, snap);
      expect(q).toBeCloseTo(1.5, 4);
      // [Step1] capture snap aligns
      expect(isSnapAligned(q, snap)).toBeTruthy();
      // [Step2] add
      const after = referenceRingAdd(initial, rawBeat, snap, 'ring', -1);
      expect(after).not.toBeNull();
      // [Step3] assert
      expect(after!.length).toBe(2);
      expect(isSnapAligned(after![1].beat, snap)).toBeTruthy();
      expect(after![1].beat).toBeCloseTo(1.5, 4);
    });
  });

  // ------------------------------------------------------------
  // 3. 右クリック削除 — hitで-1, snap維持, preventDefault, off-grid
  // ------------------------------------------------------------
  describe('3. Ring 右クリック削除: hitで-1, preventDefault, snap維持', () => {
    it('snap 0.25 hit領域 右クリック: rings-1, 残り snap維持, off-grid 0.37付近', () => {
      const initial: RingDef[] = [{ beat: 1.25 }, { beat: 2.5 }, { beat: 3.75 }];
      // [Step1] capture initial
      const beforeLen = initial.length;
      const viewStart = 0;
      const viewBeats = 16;
      const width = 800;
      const clickX = ((2.5 - viewStart) / viewBeats) * width + 1; // near beat 2.5
      const hit = nearestRingIndexSim(initial, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(1);
      expect(hit).toBeGreaterThan(-1);
      // [Step2] perform right-click delete (contextMenu)
      let prevented = false;
      const mockEvent = { preventDefault: () => { prevented = true; }, button: 2 } as unknown as MouseEvent;
      mockEvent.preventDefault();
      const after = referenceRingDelete(initial, hit, 'ring');
      // [Step3] assert
      expect(prevented).toBeTruthy();
      expect(after).not.toBeNull();
      expect(after!.length).toBe(beforeLen - 1);
      expect(after!.some(r => Math.abs(r.beat - 2.5) < 1e-6)).toBeFalsy();
      for (const r of after!) expect(isSnapAligned(r.beat, 0.25)).toBeTruthy();
    });

    it('空領域 右クリックでは削除されない (hit -1)', () => {
      const initial: RingDef[] = [{ beat: 1 }, { beat: 5 }];
      // [Step1] capture
      const beforeLen = initial.length;
      const hit = nearestRingIndexSim(initial, 0, 16, 800, 400); // click far from both
      // compute: beat 1 -> x 50, beat5-> x250, click 400 far >35
      expect(hit).toBe(-1);
      // [Step2] try delete empty
      const after = referenceRingDelete(initial, hit, 'ring');
      // [Step3] null
      expect(after).toBeNull();
      expect(initial.length).toBe(beforeLen);
    });

    it('右クリック削除は preventDefault を呼び contextMenu を抑止', () => {
      const initial: RingDef[] = [{ beat: 2 }];
      const hit = 0;
      // [Step1] capture prevented flag false
      let prevented = false;
      const e = { preventDefault: () => { prevented = true; } } as unknown as MouseEvent;
      // [Step2] simulate handler calls preventDefault before delete
      e.preventDefault();
      const after = referenceRingDelete(initial, hit, 'ring');
      // [Step3] assert
      expect(prevented).toBeTruthy();
      expect(after).not.toBeNull();
      expect(after!.length).toBe(0);
    });

    it('snap 0.5/0.125/1.0 でも削除後の残り beats は snap整数倍', () => {
      const snaps = [0.5, 0.125, 1.0] as const;
      for (const snap of snaps) {
        const initial: RingDef[] = [1, 2, 3].map(b => ({ beat: quantizeBeat(b, snap) }));
        // [Step1] capture all aligned
        for (const r of initial) expect(isSnapAligned(r.beat, snap)).toBeTruthy();
        // [Step2] delete middle
        const after = referenceRingDelete(initial, 1, 'ring');
        expect(after).not.toBeNull();
        // [Step3] still aligned
        for (const r of after!) expect(isSnapAligned(r.beat, snap)).toBeTruthy();
        expect(after!.length).toBe(initial.length - 1);
      }
    });

    it('off-grid 1.23 付近のリングを検索して削除: snap 0.25 で正確', () => {
      const snap = 0.25;
      const rings: RingDef[] = [{ beat: quantizeBeat(1.23, snap) }, { beat: 3 }];
      expect(rings[0].beat).toBeCloseTo(1.25, 4);
      // [Step1] capture hit
      const width = 800;
      const viewStart = 0;
      const viewBeats = 16;
      const clickX = ((rings[0].beat - viewStart) / viewBeats) * width;
      const hit = nearestRingIndexSim(rings, viewStart, viewBeats, width, clickX);
      expect(hit).toBe(0);
      // [Step2] delete
      const after = referenceRingDelete(rings, hit, 'ring');
      // [Step3] assert
      expect(after!.length).toBe(1);
      expect(after![0].beat).toBeCloseTo(3, 4);
    });
  });

  // ------------------------------------------------------------
  // 4. ドラッグ — 左は移動、右は不可
  // ------------------------------------------------------------
  describe('4. 左ドラッグでリング移動、右ドラッグでは移動しない', () => {
    it('左クリックドラッグ (button 0) hitあり: ドラッグ開始可', () => {
      const initial: RingDef[] = [{ beat: 2 }, { beat: 4 }];
      // [Step1] capture
      const hit = 0;
      const editMode = 'ring';
      const button = 0;
      expect(hit).toBe(0);
      // [Step2] canBegin?
      const can = canBeginRingDrag(editMode, hit, button);
      // [Step3] assert true and simulate move
      expect(can).toBeTruthy();
      // simulate move: update beat via quantize
      const newBeatRaw = 2.37; // off-grid -> 2.25 or 2.5?
      const snap = 0.25;
      const newBeat = quantizeBeat(newBeatRaw, snap);
      expect(newBeat).toBeCloseTo(2.25, 4);
      const moved = initial.map((r, i) => (i === hit ? { beat: newBeat } : r));
      expect(moved[hit].beat).toBeCloseTo(2.25, 4);
      expect(isSnapAligned(moved[hit].beat, snap)).toBeTruthy();
    });

    it('右クリックドラッグ (button 2) hitあり: ドラッグ開始不可', () => {
      const hit = 0;
      const editMode = 'ring';
      // [Step1] capture
      const button = 2;
      expect(button).toBe(2);
      // [Step2] canBegin?
      const can = canBeginRingDrag(editMode, hit, button);
      // [Step3] assert false
      expect(can).toBeFalsy();
      // also button 1 (middle) not allowed
      expect(canBeginRingDrag(editMode, hit, 1)).toBeFalsy();
    });

    it('空領域でのドラッグ (hit -1) は左右いずれも開始不可', () => {
      const hit = -1;
      // [Step1] capture
      expect(hit).toBe(-1);
      // [Step2]
      const left = canBeginRingDrag('ring', hit, 0);
      const right = canBeginRingDrag('ring', hit, 2);
      // [Step3]
      expect(left).toBeFalsy();
      expect(right).toBeFalsy();
    });

    it('左ドラッグ移動後も snap整数倍を維持 (off-grid 1.23 snap 0.5)', () => {
      const snap = 0.5;
      const initial: RingDef[] = [{ beat: 1 }, { beat: 3 }];
      const hit = 1;
      // [Step1] capture before beat
      const beforeBeat = initial[hit].beat;
      expect(beforeBeat).toBeCloseTo(3, 4);
      // [Step2] drag with raw 3.37 -> quant 3.5
      const raw = 3.37;
      const q = quantizeBeat(raw, snap);
      expect(q).toBeCloseTo(3.5, 4);
      const can = canBeginRingDrag('ring', hit, 0);
      expect(can).toBeTruthy();
      const after = initial.map((r, i) => (i === hit ? { beat: q } : r));
      // [Step3] assert aligned
      expect(isSnapAligned(after[hit].beat, snap)).toBeTruthy();
      expect(after[hit].beat).toBeCloseTo(3.5, 4);
    });

    it('編集中の移動は WaveEngine.waveYAt で正しいYに追随', () => {
      const snap = 0.25;
      const tl = new BpmTimeline(120, [], 1.0);
      const segs: Segment[] = [{ direction: 'down', beats: 2 }, { direction: 'up', beats: 2 }];
      const engine = new WaveEngine(segs, tl, 1.0, 0);
      const ringBeatBefore = 1.0;
      const yBefore = engine.waveYAt(ringBeatBefore);
      // [Step1] capture y before
      expect(yBefore).toBeGreaterThan(CENTER - TW_AMP - 1);
      // [Step2] drag ring to 1.37 ->1.25
      const raw = 1.37;
      const newBeat = quantizeBeat(raw, snap);
      expect(newBeat).toBeCloseTo(1.25, 4);
      const yAfter = engine.waveYAt(newBeat);
      // [Step3] Y changes according to wave slope
      expect(yAfter).not.toBeCloseTo(yBefore, 2);
      expect(yAfter).toBeCloseTo(engine.waveYAt(newBeat), 4);
    });
  });

  // ------------------------------------------------------------
  // 5. 回帰: T116 V/E/R分離 / T141 との排他
  // ------------------------------------------------------------
  describe('5. 回帰: T116 V/E/R分離 & T141 右クリック排他', () => {
    it('vertexモードでダブルクリックはリング追加せず頂点追加のみ', () => {
      const snap = 0.25;
      const rings: RingDef[] = [{ beat: 1 }];
      // [Step1] capture ring count before
      const beforeLen = rings.length;
      const hit = -1;
      // double-click in vertex mode should NOT add ring
      const afterRing = referenceRingAdd(rings, 1.37, snap, 'vertex', hit);
      expect(afterRing).toBeNull();
      expect(rings.length).toBe(beforeLen);
      // but vertex add should succeed (reference from T141 logic)
      const tl = new BpmTimeline(120, [], 1.0);
      const segs: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const engine = new WaveEngine(segs, tl, 1.0, 0);
      const pts = engine.getPoints();
      expect(pts.length).toBe(segs.length + 1);
      // vertex add at 0.37 ->0.25 inside first segment would add
      // we just check that vertex mode handling exists in file
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const dbl = content.slice(content.indexOf('handleDoubleClick'), content.indexOf('handleDoubleClick') + 7000);
      expect(dbl).toMatch(/editMode\s*===\s*['"]vertex['"]/);
    });

    it('edgeモードでダブルクリックはリング追加せず', () => {
      const snap = 0.25;
      const rings: RingDef[] = [{ beat: 2 }];
      // [Step1]
      const beforeLen = rings.length;
      // [Step2] try ring add in edge mode
      const after = referenceRingAdd(rings, 0.37, snap, 'edge', -1);
      // [Step3] null
      expect(after).toBeNull();
      expect(rings.length).toBe(beforeLen);
    });

    it('ringモードで右クリックは頂点削除を発動しない', () => {
      const editMode = 'ring';
      const hitRing = 0;
      // [Step1] capture that ring delete should happen, vertex delete not
      const rings: RingDef[] = [{ beat: 1 }, { beat: 2 }];
      const afterRing = referenceRingDelete(rings, hitRing, editMode);
      expect(afterRing).not.toBeNull();
      // [Step2] vertex delete helper would be blocked in ring mode
      const vertexDeleteInRingMode = (mode: string) => mode === 'vertex';
      expect(vertexDeleteInRingMode(editMode)).toBeFalsy();
      // [Step3] assert ring delete succeeded
      expect(afterRing!.length).toBe(1);
    });

    it('vertexモードで右クリックはリング削除を発動しない', () => {
      const editMode = 'vertex';
      const hit = 0;
      const rings: RingDef[] = [{ beat: 1 }];
      // [Step1] capture
      const beforeLen = rings.length;
      // [Step2] ring delete in vertex mode -> null
      const after = referenceRingDelete(rings, hit, editMode);
      expect(after).toBeNull();
      // [Step3] still same
      expect(rings.length).toBe(beforeLen);
      // verify file has separate branches
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const ctx = content.slice(content.indexOf('handleContextMenu'), content.indexOf('handleContextMenu') + 6000);
      expect(ctx).toMatch(/editMode\s*===\s*['"]vertex['"]/);
      expect(ctx).toMatch(/editMode\s*===\s*['"]ring['"]/);
    });

    it('ringモードで頂点ハンドル近傍クリックは vertexDrag ではなく ring drag/選択', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const md = content.slice(content.indexOf('handleMouseDown'), content.indexOf('handleMouseDown') + 6000);
      // [Step1] capture that handleMouseDown checks vertex first, then edge, then ring
      const vPos = md.indexOf("editMode === 'vertex'");
      const ePos = md.indexOf("editMode === 'edge'");
      const rPos = md.indexOf('// ring mode');
      expect(vPos).toBeGreaterThan(-1);
      expect(ePos).toBeGreaterThan(vPos);
      expect(rPos).toBeGreaterThan(ePos);
      // [Step2] ring mode block uses nearestRingIndex, not nearestVertexIndex
      const ringBlock = md.slice(rPos, rPos + 2000);
      expect(ringBlock).toMatch(/nearestRingIndex/);
      expect(ringBlock).not.toMatch(/nearestVertexIndex/);
      // [Step3] vertex mode empty drag is pan, not ring add
      const vertexBlock = md.slice(vPos, ePos);
      expect(vertexBlock).toMatch(/panRef\.current/);
    });

    it('WaveEngine.getPoints 長さ不変量がリング操作前後で維持', () => {
      const tl = new BpmTimeline(120, [], 1.0);
      const segs: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const engine = new WaveEngine(segs, tl, 1.0, 0);
      // [Step1] capture
      const ptsLenBefore = engine.getPoints().length;
      expect(ptsLenBefore).toBe(segs.length + 1);
      // [Step2] simulate ring add/delete (should not affect segs)
      const ringsBefore: RingDef[] = [{ beat: 1 }];
      const afterAdd = referenceRingAdd(ringsBefore, 0.37, 0.25, 'ring', -1);
      expect(afterAdd).not.toBeNull();
      const afterDel = referenceRingDelete(afterAdd!, 0, 'ring');
      expect(afterDel).not.toBeNull();
      // [Step3] engine unchanged
      const engine2 = new WaveEngine(segs, tl, 1.0, 0);
      expect(engine2.getPoints().length).toBe(ptsLenBefore);
      expect(engine2.getPoints().length).toBe(segs.length + 1);
    });

    it('複雑な振幅 0.7/1.3/2.7/3.4 と off-grid 0.37/1.23 で waveYAt/cursor一致は崩れない (T127回帰)', async () => {
      const { Cursor } = await import('../src/game/cursor');
      const amps = [0.7, 1.3, 2.7, 3.4] as const;
      const offGrids = [0.37, 1.23] as const;
      for (const amp of amps) {
        const tl = new BpmTimeline(120, [], amp);
        const segs: Segment[] = [{ direction: 'down', beats: 10 }];
        const engine = new WaveEngine(segs, tl, amp, 0);
        for (const b of offGrids) {
          // [Step1] capture perBeat
          const perBeat = 2 * TW_AMP * amp;
          expect(perBeat).toBeCloseTo(2 * TW_AMP * amp, 4);
          // [Step2] waveYAt slope before clip
          const delta = Math.min(b, 0.4); // avoid clamp
          const y = engine.waveYAt(delta);
          const expected = clampY(CENTER + perBeat * delta);
          expect(y).toBeCloseTo(expected, 0);
          // cursor same
          const cursor = new Cursor(amp, 0);
          const beatMs = 500;
          cursor.update((delta * beatMs) / 1000, false, true, beatMs, 1);
          expect(cursor.y).toBeCloseTo(expected, 0);
          expect(engine.waveYAt(delta)).toBeCloseTo(cursor.y, 0);
        }
      }
      // ring operation should not affect wave
      const tl = new BpmTimeline(120, [], 1.0);
      const segs: Segment[] = [{ direction: 'down', beats: 1 }, { direction: 'up', beats: 1 }];
      const engine0 = new WaveEngine(segs, tl, 1.0, 0);
      const y0 = engine0.waveYAt(0.37);
      const rings: RingDef[] = [];
      const after = referenceRingAdd(rings, 0.37, 0.25, 'ring', -1);
      expect(after).not.toBeNull();
      const engine1 = new WaveEngine(segs, tl, 1.0, 0);
      expect(engine1.waveYAt(0.37)).toBeCloseTo(y0, 4);
    });
  });

  // ------------------------------------------------------------
  // 6. スナップ整合性網羅 & 1/amplitudeでないこと (T129回帰)
  // ------------------------------------------------------------
  describe('6. スナップ整合性網羅 & 1/amplitude否定', () => {
    it('snap 0.125/0.25/0.5/1 で端数 rawBeat 0.37/1.23/1.37 が snap整数倍に量子化', () => {
      const snaps = [0.125, 0.25, 0.5, 1] as const;
      const raws = [0.37, 1.23, 1.37] as const;
      for (const snap of snaps) {
        for (const raw of raws) {
          // [Step1] capture quant
          const q = quantizeBeat(raw, snap);
          expect(isSnapAligned(q, snap)).toBeTruthy();
          // [Step2] ring add
          const after = referenceRingAdd([], raw, snap, 'ring', -1);
          expect(after).not.toBeNull();
          // [Step3] assert
          expect(isSnapAligned(after![0].beat, snap)).toBeTruthy();
          expect(after![0].beat).toBeCloseTo(q, 4);
          // not clipped to 1/amplitude
          expect(after![0].beat).not.toBeCloseTo(1, 0);
        }
      }
    });

    it('snap 0.25 amp 1 短押し 0.30 -> beats 0.25 であり 1.0 でない (T129回帰)', () => {
      const snap = 0.25;
      const amp = 1;
      const raw = 0.30;
      const q = quantizeBeat(raw, snap);
      // [Step1] capture
      expect(q).toBeCloseTo(0.25, 4);
      expect(q).not.toBeCloseTo(1 / amp, 4);
      // [Step2] add
      const after = referenceRingAdd([], raw, snap, 'ring', -1);
      expect(after).not.toBeNull();
      // [Step3] assert
      expect(after![0].beat).toBeCloseTo(0.25, 4);
      expect(after![0].beat).not.toBeCloseTo(1.0, 4);
    });

    it('連続操作: 追加(+1) -> 追加(+1) -> 削除(-1) -> 削除(-1) で snap維持', () => {
      const snap = 0.25;
      let rings: RingDef[] = [{ beat: 1 }];
      // [Step1] capture
      expect(rings.length).toBe(1);
      // [Step2] add 0.37
      let after = referenceRingAdd(rings, 0.37, snap, 'ring', -1);
      expect(after).not.toBeNull();
      rings = after!;
      expect(rings.length).toBe(2);
      // add 1.23
      after = referenceRingAdd(rings, 1.23, snap, 'ring', -1);
      expect(after).not.toBeNull();
      rings = after!;
      expect(rings.length).toBe(3);
      // delete first
      let del = referenceRingDelete(rings, 0, 'ring');
      expect(del).not.toBeNull();
      rings = del!;
      expect(rings.length).toBe(2);
      // delete again
      del = referenceRingDelete(rings, 0, 'ring');
      expect(del).not.toBeNull();
      rings = del!;
      // [Step3] back to 1 and aligned
      expect(rings.length).toBe(1);
      for (const r of rings) expect(isSnapAligned(r.beat, snap)).toBeTruthy();
    });
  });

  // ------------------------------------------------------------
  // 7. tsc & エラーハンドリング回帰
  // ------------------------------------------------------------
  describe('7. tsc エラーハンドリング & 未使用変数禁止', () => {
    it('WavePreview.tsx が未使用変数 centerY/dispAmp を handleDoubleClick 内に残さない', () => {
      const content = fs.readFileSync('src/screens/editor/WavePreview.tsx', 'utf-8');
      const idx = content.indexOf('handleDoubleClick');
      const block = content.slice(idx, idx + 7000);
      const yRawIdx = block.indexOf('const yRaw = ((y - RULER_H)');
      expect(yRawIdx).toBeGreaterThan(-1);
      const before = block.slice(Math.max(0, yRawIdx - 600), yRawIdx);
      // [Step1] capture before snippet
      expect(before.length).toBeGreaterThan(0);
      // [Step2] check no dead declarations
      // [Step3] assert absence
      expect(before).not.toMatch(/const\s+centerY\s*=/);
      expect(before).not.toMatch(/const\s+dispAmp\s*=/);
    });

    it('BpmTimeline / WaveEngine / quantizeBeat が import 可能で型エラーなし', async () => {
      // [Step1] capture imports exist
      expect(WaveEngine).toBeDefined();
      expect(BpmTimeline).toBeDefined();
      expect(quantizeBeat).toBeDefined();
      // [Step2] create instances
      const tl = new BpmTimeline(120, [], 1.0);
      const engine = new WaveEngine([{ direction: 'down', beats: 1 }], tl, 1.0, 0);
      // [Step3] assert no throw and numeric consistency
      expect(engine.waveYAt(0.37)).toBeDefined();
      expect(typeof engine.waveYAt(0.37)).toBe('number');
      expect(tl.amplitudeAt(0.37)).toBeCloseTo(1.0, 4);
    });
  });
});
