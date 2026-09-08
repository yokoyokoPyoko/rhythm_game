/**
 * T204 — イージング行UI（全列またぎ・追加・ドラッグ並び替え） Vitest pure+DOM acceptance
 * @vitest-environment jsdom
 *
 * 要求:
 * - 表の向きは現行維持（セクション＝行、パラメータ＝列）
 * - イージングはbeat列〜横拡大率列の全列にまたがる1行として前後セクション行の間に挿入表示
 * - 「セクションを追加」の隣に「イージング追加」ボタンを新設。イージング行はドラッグで別の隙間へ移動
 *
 * 修正: BpmEditor.tsx + index.css
 * - 「イージング追加」ボタン：押下で選択中セクションの直後（無選択なら末尾隙間）のeaseToNextを設定（既定は直線）
 * - イージング行：曲線選択（直線／イーズアウト／イーズイン）＋削除ボタン＋ドラッグハンドル。両端（前後セクションが無い位置）へのドロップは無効
 * - ドラッグ（HTML5 DnD）：掴んだイージング行を別の隙間にドロップするとeaseToNextの所有セクションが付け替わる
 * - CSS：全列またぎ行のスタイル（grid-column: 1 / -1 等）
 *
 * TDD Red->Green: 実装前は全テストが失敗する（ボタン・行・ドラッグが存在しないため）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import * as fs from 'fs';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { BpmChange } from '../src/types';
// BpmEditor is the SUT — must be imported and rendered (not file-content assertion)
import BpmEditor from '../src/screens/editor/BpmEditor';

vi.useFakeTimers({ shouldAdvanceTime: true });

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helper: expected easing factor (must match spec: linear=t, ease-out=1-(1-t)^3, ease-in=t^2)
function easeFactor(kind: string, t: number): number {
  if (kind === 'linear') return t;
  if (kind === 'ease-out') return 1 - Math.pow(1 - t, 3);
  if (kind === 'ease-in') return Math.pow(t, 2);
  return t;
}

function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  return new (BpmTimeline as unknown as new (a: unknown, b: unknown) => BpmTimeline)(sections as unknown, baseAmp as unknown);
}

// Harness to capture onSectionsChange 3-step transitions
function Harness({
  initial,
  onCaptured,
}: {
  initial: BpmChange[];
  onCaptured?: (next: BpmChange[]) => void;
}) {
  const [sections, setSections] = useState<BpmChange[]>(initial);
  const handle = (next: BpmChange[]) => {
    setSections(next);
    onCaptured?.(next);
    // expose for page.evaluate style if needed
    (window as unknown as Record<string, unknown>).__t204_lastSections = next;
  };
  return React.createElement(BpmEditor, {
    bpmChanges: sections,
    onSectionsChange: handle,
    amplitude: 1.0,
    startPosition: 0,
    onStartPositionChange: () => {},
    endBeat: undefined,
    onEndBeatChange: () => {},
    onRequestAddSection: () => {},
  } as unknown as Record<string, unknown>);
}

function getEasingAddButton(container: HTMLElement): HTMLElement | null {
  // try by testid first, then by role/text
  const byTestId = container.querySelector('[data-testid="easing-add"]') as HTMLElement | null;
  if (byTestId) return byTestId;
  const byId = container.querySelector('[data-testid="easing-add-button"]') as HTMLElement | null;
  if (byId) return byId;
  // fallback: button containing イージング追加
  const allButtons = Array.from(container.querySelectorAll('button'));
  const found = allButtons.find((b) => (b.textContent ?? '').includes('イージング追加'));
  if (found) return found as HTMLElement;
  // also try screen query
  try {
    return screen.getByRole('button', { name: /イージング追加/ });
  } catch { return null; }
}

function getEasingRows(container: HTMLElement): HTMLElement[] {
  // try data-testid prefix
  let rows = Array.from(container.querySelectorAll('[data-testid^="easing-row"]')) as HTMLElement[];
  if (rows.length > 0) return rows;
  rows = Array.from(container.querySelectorAll('[data-testid^="easing"]')) as HTMLElement[];
  // filter to rows that are not the add button
  rows = rows.filter((el) => !el.textContent?.includes('イージング追加'));
  if (rows.length > 0) return rows;
  // class fallback
  rows = Array.from(container.querySelectorAll('.easing-row, .bpm-easing-row, .section-easing-row')) as HTMLElement[];
  if (rows.length > 0) return rows;
  // generic: look for select with options 直線/イーズアウト/イーズイン
  const selects = Array.from(container.querySelectorAll('select'));
  const easingSelects = selects.filter((s) => {
    const txt = s.textContent ?? '';
    return txt.includes('直線') || txt.includes('イーズ');
  });
  // parent li/row of each select is the easing row
  return easingSelects.map((s) => (s.closest('li, div') as HTMLElement) ?? (s as unknown as HTMLElement));
}

function getSectionRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.bpm-change-item')) as HTMLElement[];
}

function getGapDropTargets(container: HTMLElement): HTMLElement[] {
  let gaps = Array.from(container.querySelectorAll('[data-testid^="easing-gap"]')) as HTMLElement[];
  if (gaps.length > 0) return gaps;
  gaps = Array.from(container.querySelectorAll('[data-testid^="easing-drop"]')) as HTMLElement[];
  if (gaps.length > 0) return gaps;
  // also .easing-gap
  gaps = Array.from(container.querySelectorAll('.easing-gap')) as HTMLElement[];
  return gaps;
}

describe('T204 イージング行UI（全列またぎ・追加・ドラッグ並び替え）— TDD Red', () => {
  describe('1. イージング追加ボタン — 3-step state transition', () => {
    it('初期0行 -> イージング追加クリック -> 1行が末尾隙間(linear)で増え、コールバックにeaseToNextが伝わる (3-step)', async () => {
      // Step 1: Capture Initial State — render with 3 sections, no easing
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      let captured: BpmChange[] | null = null;
      const { container } = render(React.createElement(Harness, { initial, onCaptured: (n) => (captured = n) }));
      const beforeRows = getEasingRows(container);
      expect(beforeRows.length).toBe(0);
      const beforeGapTargets = getGapDropTargets(container);
      void beforeGapTargets;

      // also ensure at least params columns still exist (beat/BPM/速度/横拡大)
      const sectionRows = getSectionRows(container);
      expect(sectionRows.length).toBe(3);

      // Step 2: Perform User Interaction — click イージング追加
      const addBtn = getEasingAddButton(container);
      expect(addBtn).not.toBeNull();
      // Must be next to セクションを追加
      const addSectionBtn = container.querySelector('.bpm-change-add') ?? screen.queryByText(/セクションを追加/);
      expect(addSectionBtn).not.toBeNull();
      // verify they are siblings / same parent
      if (addBtn && addSectionBtn) {
        const parent1 = addBtn.parentElement;
        const parent2 = addSectionBtn.parentElement as HTMLElement | null;
        // both inside same container (spec says隣)
        // allow direct sibling or shared wrapper; at least both visible
        expect(parent1).not.toBeNull();
        expect(parent2).not.toBeNull();
      }
      await act(async () => {
        if (addBtn) fireEvent.click(addBtn);
      });
      // allow state update
      await act(async () => { vi.advanceTimersByTime(50); });

      // Step 3: Assert Resulting Transition — exactly one easing row with linear, spanning columns
      const afterRows = getEasingRows(container);
      expect(afterRows.length).toBe(1);
      // callback must have received easeToNext
      expect(captured).not.toBeNull();
      const withEase = (captured as unknown as BpmChange[]).filter((c) => c.easeToNext !== undefined);
      expect(withEase.length).toBe(1);
      expect(withEase[0].easeToNext).toBe('linear');
      // Tail gap: for 3 sections, valid gaps are after index 0 and 1; tail is after 1 (ease on section index 1)
      // implementation may put ease on last-1 or last; we accept either tail position but must be one of the interior sections
      const tailCandidates = (captured as BpmChange[]).filter((c) => c.easeToNext === 'linear');
      const tailBeat = tailCandidates[0].beat;
      // must be 0 or 4 (not 8 if invalid tail after last). For spec "末尾隙間" = gap after second-last section => beat 4. Accept 0/4 but not out-of-range
      expect([0, 4]).toContain(tailBeat);
      // ensure not on after-last (beat 8) which would be invalid end
      const lastSectionHasEase = (captured as BpmChange[]).find((c) => c.beat === 8)?.easeToNext;
      // tail gap should not be after last, so last section must NOT have easing if there are >=2 sections
      // For 3 sections, tail gap is after index1, not index2 => last should be undefined
      expect(lastSectionHasEase).toBeUndefined();
    });

    it('選択中セクション直後にイージングが追加される挙動 — tail以外でも作用 (3-step, off-grid)', async () => {
      // Step1: 4 sections with off-grid beats to ensure sorting not broken
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 2.37, bpm: 130 },
        { beat: 4.37, bpm: 140 },
        { beat: 8.25, bpm: 150 },
      ];
      let captured: BpmChange[] | null = null;
      const { container } = render(React.createElement(Harness, { initial, onCaptured: (n) => (captured = n) }));
      expect(getEasingRows(container).length).toBe(0);
      // If implementation supports selection, we would select index 0 then add. Without selection prop,
      // the button still must create at tail. We test that at least one easing appears and is linear.
      const addBtn = getEasingAddButton(container);
      expect(addBtn).not.toBeNull();
      await act(async () => { if (addBtn) fireEvent.click(addBtn); });
      await act(async () => { vi.advanceTimersByTime(50); });
      const afterRows = getEasingRows(container);
      expect(afterRows.length).toBe(1);
      expect(captured).not.toBeNull();
      expect((captured as BpmChange[]).filter((c) => c.easeToNext).length).toBe(1);
      expect((captured as BpmChange[]).find((c) => c.easeToNext)?.easeToNext).toBe('linear');
      // off-grid beats must remain sorted after addition
      const beats = (captured as BpmChange[]).map((c) => c.beat);
      const sorted = [...beats].sort((a, b) => a - b);
      expect(beats).toEqual(sorted);
    });
  });

  describe('2. イージング行の表示 — 全列またぎ・前後セクション間に挿入 (3-step)', () => {
    it('イージング行が前後セクション間に全列またがりで挿入され、grid-column: 1 / -1 を持つ (3-step)', async () => {
      // Step1: Capture Initial — no easing rows
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      const { container } = render(React.createElement(Harness, { initial }));
      expect(getEasingRows(container).length).toBe(0);
      const beforeSectionCount = getSectionRows(container).length;
      expect(beforeSectionCount).toBe(3);

      // Step2: Perform Interaction — click イージング追加
      const addBtn = getEasingAddButton(container);
      expect(addBtn).not.toBeNull();
      await act(async () => { if (addBtn) fireEvent.click(addBtn); });
      await act(async () => { vi.advanceTimersByTime(50); });

      // Step3: Assert — row exists, spans all columns, and is ordered between sections
      const rows = getEasingRows(container);
      expect(rows.length).toBe(1);
      const row = rows[0];
      // grid-column: 1 / -1 via inline style or CSS file rule
      const cssText = fs.readFileSync('src/index.css', 'utf-8');
      const hasGridRule = /grid-column\s*:\s*1\s*\/\s*-1/.test(cssText);
      expect(hasGridRule).toBe(true);
      // class should indicate full-span
      const className = row.className ?? '';
      const hasSpanClass =
        /easing/.test(className) ||
        /grid-column/.test(row.getAttribute('style') ?? '') ||
        hasGridRule;
      expect(hasSpanClass).toBeTruthy();
      // inline style check if present
      const styleAttr = row.getAttribute('style') ?? '';
      if (styleAttr) {
        expect(styleAttr).toMatch(/grid-column/);
      } else {
        // if not inline, at least the CSS file must target the easing row selector
        // look for selector containing easing and grid-column
        const easingRuleIdx = cssText.search(/easing[\s\S]{0,300}grid-column/);
        expect(easingRuleIdx).toBeGreaterThan(-1);
      }
      // ordering: easing row should be between section rows in DOM order
      // collect all children of bpm-change-list
      const list = container.querySelector('.bpm-change-list');
      expect(list).not.toBeNull();
      if (list) {
        const children = Array.from(list.children) as HTMLElement[];
        // there should be 3 section items + 1 easing row = 4 children total
        // easing row may be li or div; at least ordering must have section before and after
        const easingIdx = children.indexOf(row as unknown as HTMLElement);
        // if row is not direct child (maybe fragment), fallback to checking DOM order via compareDocumentPosition
        if (easingIdx === -1) {
          const sections = getSectionRows(container);
          // easing row should be after first section and before last section when tail gap (index1)
          const firstSec = sections[0];
          const lastSec = sections[sections.length - 1];
          expect(firstSec.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
          expect(row.compareDocumentPosition(lastSec) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        } else {
          expect(easingIdx).toBeGreaterThan(0);
          expect(easingIdx).toBeLessThan(children.length - 1);
        }
      }
      // row must contain curve select + delete + drag handle
      const selects = within(row).queryAllByRole('combobox');
      // alternative: find select element directly
      const sel = row.querySelector('select');
      const hasSelect = selects.length > 0 || sel !== null;
      expect(hasSelect).toBe(true);
      if (sel) {
        const opts = Array.from(sel.querySelectorAll('option')).map((o) => o.textContent ?? '');
        // must have 3 options: 直線 / イーズアウト / イーズイン
        expect(opts.join(' ')).toMatch(/直線/);
        expect(opts.join(' ')).toMatch(/イーズアウト/);
        expect(opts.join(' ')).toMatch(/イーズイン/);
      }
      // delete button inside row
      const delBtn = row.querySelector('button');
      expect(delBtn).not.toBeNull();
      // drag handle: draggable attribute or data-testid handle or cursor grab
      const hasHandle =
        row.getAttribute('draggable') === 'true' ||
        row.querySelector('[data-testid*="handle"]') !== null ||
        row.querySelector('[draggable]') !== null ||
        /grab/.test(row.getAttribute('style') ?? '') ||
        row.querySelector('.easing-handle') !== null;
      // implementor must make row draggable; this will fail before implementation
      expect(hasHandle).toBe(true);
    });

    it('イージング行の曲線選択で値が linear/t ease-out/t ease-in に切り替わる (3-step)', async () => {
      // Step1: start with one easing linear via initial prop
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120, easeToNext: 'linear' } as BpmChange,
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      let captured: BpmChange[] | null = null;
      const { container } = render(React.createElement(Harness, { initial, onCaptured: (n) => (captured = n) }));
      // before select shows linear
      let rows = getEasingRows(container);
      // if harness starts with ease, rows should already be 1; if not, add one
      if (rows.length === 0) {
        const addBtn = getEasingAddButton(container);
        await act(async () => { if (addBtn) fireEvent.click(addBtn); });
        await act(async () => { vi.advanceTimersByTime(50); });
        rows = getEasingRows(container);
      }
      expect(rows.length).toBe(1);
      const row = rows[0];
      const sel = row.querySelector('select') as HTMLSelectElement | null;
      expect(sel).not.toBeNull();
      const beforeVal = sel ? sel.value : '';
      expect(['linear', 'ease-out', 'ease-in', ''].includes(beforeVal) || beforeVal.includes('直線')).toBeTruthy();

      // Step2: change to ease-out
      await act(async () => {
        if (sel) {
          fireEvent.change(sel, { target: { value: 'ease-out' } });
        }
      });
      await act(async () => { vi.advanceTimersByTime(50); });

      // Step3: assert captured has ease-out
      expect(captured).not.toBeNull();
      if (captured) {
        const eased = (captured as BpmChange[]).find((c) => c.easeToNext !== undefined);
        // allow either first or tail section to carry it; just check one is ease-out
        expect(eased?.easeToNext).toBe('ease-out');
      }
      // also test change to ease-in
      await act(async () => {
        if (sel) fireEvent.change(sel, { target: { value: 'ease-in' } });
      });
      await act(async () => { vi.advanceTimersByTime(50); });
      if (captured) {
        const eased2 = (captured as BpmChange[]).find((c) => c.easeToNext === 'ease-in');
        expect(eased2).toBeDefined();
      }
    });

    it('イージング行の削除ボタンで該当easeToNextが消える (3-step)', async () => {
      // Step1: initial with one easing
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120, easeToNext: 'linear' } as BpmChange,
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      let captured: BpmChange[] | null = null;
      const { container } = render(React.createElement(Harness, { initial, onCaptured: (n) => (captured = n) }));
      let rows = getEasingRows(container);
      if (rows.length === 0) {
        const addBtn = getEasingAddButton(container);
        await act(async () => { if (addBtn) fireEvent.click(addBtn); });
        await act(async () => { vi.advanceTimersByTime(50); });
        rows = getEasingRows(container);
      }
      const beforeCount = rows.length;
      expect(beforeCount).toBe(1);

      // Step2: click delete
      const row = rows[0];
      const del = row.querySelector('button') as HTMLElement | null;
      expect(del).not.toBeNull();
      await act(async () => { if (del) fireEvent.click(del); });
      await act(async () => { vi.advanceTimersByTime(50); });

      // Step3: assert no easing rows and captured has no easeToNext
      const afterRows = getEasingRows(container);
      expect(afterRows.length).toBe(0);
      if (captured) {
        expect((captured as BpmChange[]).filter((c) => c.easeToNext !== undefined).length).toBe(0);
      }
    });
  });

  describe('3. ドラッグで別の隙間へ移動 — 3-step + 両端無効', () => {
    it('ドラッグで gap0 -> gap1 へ移動すると所有セクションのeaseToNextが付け替わる (3-step, off-grid)', async () => {
      // Step1: Capture Before — 3 sections, ease on gap0 (section0 linear)
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120, easeToNext: 'linear' } as BpmChange,
        { beat: 4.37, bpm: 130 }, // off-grid 4.37
        { beat: 8.25, bpm: 140 },
      ];
      let captured: BpmChange[] | null = null;
      const { container } = render(React.createElement(Harness, { initial, onCaptured: (n) => (captured = n) }));
      let rows = getEasingRows(container);
      if (rows.length === 0) {
        // fallback: create via add if initial not rendered (implementation may filter)
        const addBtn = getEasingAddButton(container);
        await act(async () => { if (addBtn) fireEvent.click(addBtn); });
        await act(async () => { vi.advanceTimersByTime(50); });
        rows = getEasingRows(container);
      }
      expect(rows.length).toBe(1);
      // before: section0 has ease, section1 has none
      const beforeSections = (window as unknown as Record<string, unknown>).__t204_lastSections as BpmChange[] | undefined;
      void beforeSections;
      // ensure initial is gap0
      // if captured is null, use initial
      const before = captured ?? initial;
      expect((before as BpmChange[])[0].easeToNext).toBe('linear');
      expect((before as BpmChange[])[1].easeToNext).toBeUndefined();

      // Step2: Perform Drag — draggable row -> drop target gap1
      const row = rows[0];
      const draggable = (row.querySelector('[draggable]') as HTMLElement) ?? row;
      // Ensure draggable
      expect(draggable.getAttribute('draggable') ?? row.getAttribute('draggable') ?? 'true').toBeTruthy();

      // Find valid gap targets: there should be n-1 =2 valid gaps. Find gap for index 1
      let gaps = getGapDropTargets(container);
      // If gaps are not explicit, we treat section rows as drop targets for gap after
      // Implementation may render gap divs between sections; if not found, we will use second section row as drop zone
      let target: HTMLElement | null = null;
      if (gaps.length >= 2) {
        // gaps[0] is after 0, gaps[1] after 1
        target = gaps[1];
      } else if (gaps.length === 1) {
        target = gaps[0];
      } else {
        const secs = getSectionRows(container);
        target = secs[1] ?? secs[2] ?? container;
      }
      expect(target).not.toBeNull();

      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(k: string, v: string) { this.data[k] = v; },
        getData(k: string) { return this.data[k] ?? ''; },
        effectAllowed: 'move',
        dropEffect: 'move',
      } as unknown as DataTransfer;

      await act(async () => {
        fireEvent.dragStart(draggable, { dataTransfer } as unknown as Record<string, unknown>);
        // dragover target
        if (target) fireEvent.dragOver(target, { dataTransfer } as unknown as Record<string, unknown>);
        if (target) fireEvent.drop(target, { dataTransfer } as unknown as Record<string, unknown>);
        fireEvent.dragEnd(draggable, { dataTransfer } as unknown as Record<string, unknown>);
      });
      await act(async () => { vi.advanceTimersByTime(50); });

      // Step3: Assert — ownership moved to gap1 (section1 now has linear, section0 cleared)
      expect(captured).not.toBeNull();
      const after = captured as unknown as BpmChange[];
      const after0Ease = after[0].easeToNext;
      const after1Ease = after[1].easeToNext;
      // One of them must be linear, the other undefined — and specifically moved
      const totalEased = after.filter((c) => c.easeToNext !== undefined).length;
      expect(totalEased).toBe(1);
      expect(after0Ease).toBeUndefined();
      expect(after1Ease).toBe('linear');
    });

    it('両端（前後セクションが無い位置）へのドロップは無効で所有が変わらない (3-step)', async () => {
      // Step1: Capture Before — single easing at gap0
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120, easeToNext: 'linear' } as BpmChange,
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      let captured: BpmChange[] | null = null;
      const { container } = render(React.createElement(Harness, { initial, onCaptured: (n) => (captured = n) }));
      let rows = getEasingRows(container);
      if (rows.length === 0) {
        const addBtn = getEasingAddButton(container);
        await act(async () => { if (addBtn) fireEvent.click(addBtn); });
        await act(async () => { vi.advanceTimersByTime(50); });
        rows = getEasingRows(container);
      }
      expect(rows.length).toBe(1);
      const beforeEaseBeat = (captured ?? initial)[0].beat;
      expect((captured ?? initial)[0].easeToNext).toBe('linear');

      // Step2: Attempt drop onto invalid ends — try drop on container outside valid gaps
      // Valid gaps are 0..n-2 (0,1). Invalid are before-first (-1) and after-last (n-1 =2)
      // Implementation should either not render invalid gaps or ignore drops there.
      // We'll try to drop on an invalid target (e.g., the list container itself or a fake gap with data-invalid)
      const row = rows[0];
      const draggable = (row.querySelector('[draggable]') as HTMLElement) ?? row;
      const dataTransfer = {
        data: {} as Record<string, string>,
        setData(k: string, v: string) { this.data[k] = v; },
        getData(k: string) { return this.data[k] ?? ''; },
      } as unknown as DataTransfer;

      // Find if implementation renders invalid gaps — they should not be valid drop targets
      // We'll simulate drop on the outer list element which is not a valid gap
      const list = container.querySelector('.bpm-change-list') as HTMLElement | null;
      const invalidTarget = list ?? container;

      // Record captured before invalid drop
      captured = null;
      await act(async () => {
        fireEvent.dragStart(draggable, { dataTransfer } as unknown as Record<string, unknown>);
        fireEvent.dragOver(invalidTarget, { dataTransfer } as unknown as Record<string, unknown>);
        fireEvent.drop(invalidTarget, { dataTransfer } as unknown as Record<string, unknown>);
        fireEvent.dragEnd(draggable, { dataTransfer } as unknown as Record<string, unknown>);
      });
      await act(async () => { vi.advanceTimersByTime(50); });

      // Step3: Assert — if implementation correctly guards, captured should remain null (no change) or still have ease on original section
      // Allow two correct behaviors: either no callback at all, or callback with same ownership
      if (captured === null) {
        // No change is correct for invalid drop — pass
        expect(captured).toBeNull();
      } else {
        const after = captured as unknown as BpmChange[];
        // Must still have exactly one easing on original section (beat 0)
        expect(after.filter((c) => c.easeToNext).length).toBe(1);
        const stillOnOriginal = after.find((c) => c.beat === beforeEaseBeat)?.easeToNext;
        expect(stillOnOriginal).toBe('linear');
        // and not moved to after-last (beat 8)
        expect(after.find((c) => c.beat === 8)?.easeToNext).toBeUndefined();
      }

      // Additional invalid: try data-testid easing-gap--1 or easing-gap-3 if they exist they must be disabled
      const maybeInvalidGaps = Array.from(container.querySelectorAll('[data-testid*="gap"]')) as HTMLElement[];
      const invalidIndices = maybeInvalidGaps.filter((el) => {
        const id = el.getAttribute('data-testid') ?? '';
        return id.includes('-1') || id.includes('3') || id.includes('invalid');
      });
      if (invalidIndices.length > 0) {
        const inv = invalidIndices[0];
        captured = null;
        await act(async () => {
          fireEvent.dragStart(draggable, { dataTransfer } as unknown as Record<string, unknown>);
          fireEvent.dragOver(inv, { dataTransfer } as unknown as Record<string, unknown>);
          fireEvent.drop(inv, { dataTransfer } as unknown as Record<string, unknown>);
          fireEvent.dragEnd(draggable, { dataTransfer } as unknown as Record<string, unknown>);
        });
        await act(async () => { vi.advanceTimersByTime(50); });
        // Must still be invalid (no move)
        if (captured !== null) {
          const after2 = captured as unknown as BpmChange[];
          expect(after2.find((c) => c.beat === beforeEaseBeat)?.easeToNext).toBe('linear');
        }
      }
    });
  });

  describe('4. 補間数値整合 — イージング式が 0.5/0.875/0.25 で正確 (off-grid必須)', () => {
    it('BpmTimeline amplitudeAt/zoomAt が t=0.5 で linear 0.5 / ease-out 0.875 / ease-in 0.25 を返す (3-step off-grid)', () => {
      // Step1: Capture Before — no easing => step
      const tlStep = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ]);
      const beforeMid = tlStep.amplitudeAt(2);
      expect(beforeMid).toBeCloseTo(0.7, 5);

      // Step2: Perform Action — create easing timelines
      const tlLin = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'linear' } as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ]);
      const tlOut = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-out' } as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ]);
      const tlIn = makeTimeline([
        { beat: 0, bpm: 120, amplitude: 0.7, easeToNext: 'ease-in' } as BpmChange,
        { beat: 4, bpm: 120, amplitude: 1.5 },
      ]);

      // Step3: Assert — t=0.5 values
      expect(tlLin.amplitudeAt(2)).toBeCloseTo(0.7 + 0.8 * 0.5, 4);
      expect(tlOut.amplitudeAt(2)).toBeCloseTo(0.7 + 0.8 * 0.875, 4);
      expect(tlIn.amplitudeAt(2)).toBeCloseTo(0.7 + 0.8 * 0.25, 4);
      // off-grid 0.37 and 1.23 must use exact eased t
      const t037 = 0.37 / 4;
      expect(tlLin.amplitudeAt(0.37)).toBeCloseTo(0.7 + 0.8 * easeFactor('linear', t037), 4);
      expect(tlOut.amplitudeAt(0.37)).toBeCloseTo(0.7 + 0.8 * easeFactor('ease-out', t037), 4);
      expect(tlIn.amplitudeAt(1.23)).toBeCloseTo(0.7 + 0.8 * easeFactor('ease-in', 1.23 / 4), 4);
      // zoom same logic
      const tlZoomLin = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'linear' } as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0 } as BpmChange,
      ]);
      expect(tlZoomLin.zoomAt(2)).toBeCloseTo(1.5, 4);
      const tlZoomOut = makeTimeline([
        { beat: 0, bpm: 120, zoom: 1.0, easeToNext: 'ease-out' } as BpmChange,
        { beat: 4, bpm: 120, zoom: 2.0 } as BpmChange,
      ]);
      expect(tlZoomOut.zoomAt(2)).toBeCloseTo(1.875, 4);
      // must differ from step
      expect(tlLin.amplitudeAt(2)).not.toBeCloseTo(beforeMid, 4);
    });

    it('複雑振幅 0.7/1.3/2.7 と off-grid 0.37/1.23 でBpmTimelineと補間式が一致 (3-step)', () => {
      const before = makeTimeline([
        { beat: 2, bpm: 120, amplitude: 1.3 },
        { beat: 6, bpm: 120, amplitude: 2.7 },
      ]);
      expect(before.amplitudeAt(4)).toBeCloseTo(1.3, 5);
      const tl = makeTimeline([
        { beat: 2, bpm: 120, amplitude: 1.3, easeToNext: 'ease-out' } as BpmChange,
        { beat: 6, bpm: 120, amplitude: 2.7 },
      ]);
      const mid = 2 + (6 - 2) / 2;
      expect(tl.amplitudeAt(mid)).toBeCloseTo(1.3 + 1.4 * 0.875, 4);
      const tOff = (3.37 - 2) / 4;
      expect(tl.amplitudeAt(3.37)).toBeCloseTo(1.3 + 1.4 * easeFactor('ease-out', tOff), 4);
      const tOff2 = (2.37 - 2) / 4;
      expect(tl.amplitudeAt(2.37)).toBeCloseTo(1.3 + 1.4 * easeFactor('ease-out', tOff2), 4);
      // zoom also
      const tlZ = makeTimeline([
        { beat: 0, bpm: 120, zoom: 0.7, easeToNext: 'linear' } as BpmChange,
        { beat: 4, bpm: 120, zoom: 1.3 } as BpmChange,
      ]);
      expect(tlZ.zoomAt(2)).toBeCloseTo(1.0, 4);
      expect(tlZ.zoomAt(0.37)).toBeCloseTo(0.7 + 0.6 * (0.37 / 4), 4);
    });
  });

  describe('5. 表の向き維持とCSS — 3-step', () => {
    it('セクションは行、パラメータは列のまま — ヘッダとgrid列数が維持される (3-step)', async () => {
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 130 },
      ];
      const { container } = render(React.createElement(Harness, { initial }));
      const beforeHeader = container.querySelector('.bpm-change-header');
      expect(beforeHeader).not.toBeNull();
      const beforeCols = beforeHeader ? window.getComputedStyle(beforeHeader).gridTemplateColumns : '';
      void beforeCols;
      const beforeRows = getSectionRows(container).length;
      expect(beforeRows).toBe(2);

      const addBtn = getEasingAddButton(container);
      expect(addBtn).not.toBeNull();
      await act(async () => { if (addBtn) fireEvent.click(addBtn); });
      await act(async () => { vi.advanceTimersByTime(50); });

      const afterHeader = container.querySelector('.bpm-change-header');
      expect(afterHeader).not.toBeNull();
      // header columns must still be 5 (beat/BPM/速度/横拡大率/操作)
      const headerSpans = afterHeader ? afterHeader.querySelectorAll('span').length : 0;
      expect(headerSpans).toBeGreaterThanOrEqual(4);
      const afterRows = getSectionRows(container);
      expect(afterRows.length).toBe(2); // sections unchanged, only gap row added
      const easingRows = getEasingRows(container);
      expect(easingRows.length).toBe(1);
    });

    it('index.css に全列またぎ行の grid-column: 1 / -1 が存在する (3-step file+DOM)', async () => {
      const cssBefore = fs.readFileSync('src/index.css', 'utf-8');
      void cssBefore;
      const css = fs.readFileSync('src/index.css', 'utf-8');
      expect(css).toMatch(/grid-column\s*:\s*1\s*\/\s*-1/);
      // must be associated with easing selector
      const easingBlock = css.match(/[^{]*easing[^{]*\{[^}]*grid-column[^}]*\}/);
      expect(easingBlock).not.toBeNull();
      // DOM also must have that rule effect via class
      const initial: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 130 },
      ];
      const { container } = render(React.createElement(Harness, { initial }));
      const addBtn = getEasingAddButton(container);
      if (addBtn) {
        await act(async () => { fireEvent.click(addBtn); });
        await act(async () => { vi.advanceTimersByTime(50); });
        const rows = getEasingRows(container);
        expect(rows.length).toBe(1);
        const row = rows[0];
        const hasEasingClass = /easing/.test(row.className);
        expect(hasEasingClass).toBe(true);
      } else {
        expect(addBtn).not.toBeNull(); // will fail Red before implementation
      }
    });
  });
});
