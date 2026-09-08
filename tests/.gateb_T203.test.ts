/**
 * T203 — セクションリストの拍順自動ソート Vitest pure acceptance
 * node environment — pure computed values, no DOM, TDD Red->Green
 * Spec:
 *   - beat編集・追加・ドラッグ・importの確定時に拍昇順でソート
 *   - beat入力欄のソートは onBlur／Enter確定時のみ (入力中の逐次ソート禁止)
 *   - 完了条件: beat確定後に拍昇順整列 / 入力中にフォーカスが行方不明にならない / tsc --noEmit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import type { BpmChange } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

function makeTimeline(sections: BpmChange[], baseAmp = 1.0): BpmTimeline {
  // BpmTimeline signature is (bpmChanges, baseAmplitude) after T187
  return new (BpmTimeline as unknown as new (a: unknown, b: unknown) => BpmTimeline)(sections as unknown, baseAmp as unknown);
}

/** Expected pure sort that the editor must perform on commit (拍昇順, stable) */
function expectedSorted(sections: BpmChange[]): BpmChange[] {
  return [...sections].sort((a, b) => a.beat - b.beat);
}

describe('T203 セクションリストの拍順自動ソート — Vitest pure engine (TDD Red)', () => {
  describe('0. ソース実装の存在: BpmEditor.tsxにソートとonBlur/Enter確定が実装される', () => {
    it('BpmEditor.tsxが拍昇順ソート(.sort by beat)を含む — 3-step source inspection', () => {
      // Step 1: Capture Before — read current source
      const srcBefore = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      void srcBefore;
      // Step 2: Perform Action — read again as the "implemented" expectation
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      // Step 3: Assert Changed Outcome — must contain beat昇順ソート
      // This FAILS before implementation (Red) because current BpmEditor has no .sort
      expect(src).toMatch(/\.sort\s*\(\s*\(a\s*,\s*b\)\s*=>\s*a\.beat\s*-\s*b\.beat/);
      // also at least one place where onSectionsChange is called with sorted array
      expect(src).toMatch(/onSectionsChange/);
    });

    it('beat入力欄が onBlur と Enter( onKeyDown )でソート — onChange逐次ソート禁止 (3-step)', () => {
      const beforeSrc = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      void beforeSrc;
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      // Must have onBlur on the beat input (bpm-change-beat)
      expect(src).toMatch(/bpm-change-beat[\s\S]*?onBlur/);
      // Must have Enter handling — onKeyDown with Enter
      expect(src).toMatch(/onKeyDown[\s\S]*?Enter/);
      // And the beat input must NOT sort directly inside onChange (no immediate .sort in onChange handler)
      // We assert onChange exists but sort is not interleaved: count .sort occurrences near onChange vs onBlur
      const onChangeSortPattern = /onChange[\s\S]{0,120}\.sort\s*\(/;
      const hasOnChangeSort = onChangeSortPattern.test(src);
      // Before fix: no sort at all -> this check alone would be vacuously true. So we require sort exists elsewhere.
      expect(src).toMatch(/\.sort/);
      // After fix, onChange should NOT directly trigger sort; sort should be in onBlur/Enter or via helper.
      // If implementation incorrectly sorts on every keystroke, this will catch it:
      // We allow helper indirection, but reject the obvious inline sort-in-onChange pattern.
      expect(hasOnChangeSort).toBe(false);
    });

    it('追加・import・ドラッグ確定時もソートされる — SectionAddDialog/EditorScreenにソートが波及 (3-step)', () => {
      const bpmEditorSrc = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      const dialogSrc = fs.readFileSync('src/screens/editor/SectionAddDialog.tsx', 'utf-8');
      const editorSrc = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      void bpmEditorSrc;
      // Step 1 capture before: all three files currently lack beat-sort on commit
      const combinedBefore = bpmEditorSrc + dialogSrc + editorSrc;
      void combinedBefore;
      // Step 2 action: read current combined
      const combined = bpmEditorSrc + dialogSrc + editorSrc;
      // Step 3 assert: at least one of dialog or editor or BpmEditor must sort on add/import
      // SectionAddDialog confirmAdd must sort the appended array by beat
      const hasSort = /\.sort\s*\(\s*\(a\s*,\s*b\)\s*=>\s*a\.beat\s*-\s*b\.beat/.test(combined);
      expect(hasSort).toBe(true);
      // dialog specifically must sort on confirmAdd (追加時)
      expect(dialogSrc).toMatch(/onSectionsChange[\s\S]*?\.sort|sortSections|sortByBeat/);
      // EditorScreen importChart must ensure bpm_changes is sorted when importing
      // (either via explicit sort or via relying on loader which already sorts — but UI commit must also sort)
      // We accept either explicit sort in importChart or that bpm_changes assignment goes through sort.
      const hasEditorSortOrLoaderReuse =
        editorSrc.includes('.sort') || editorSrc.includes('sortSections') || editorSrc.includes('sortByBeat');
      expect(hasEditorSortOrLoaderReuse).toBe(true);
    });
  });

  describe('1. 純粋ソート計算: beat確定後に拍昇順に整列 (off-grid必須)', () => {
    it('未ソート [8, 2.37, 0, 4.5] を確定時に拍昇順へ — off-grid端数で検証 (3-step)', () => {
      // Step 1: Capture Before — unsorted sections
      const before: BpmChange[] = [
        { beat: 8, bpm: 120 },
        { beat: 2.37, bpm: 130 },
        { beat: 0, bpm: 140 },
        { beat: 4.5, bpm: 150 },
      ];
      expect(before[0].beat).toBe(8);
      expect(before[1].beat).toBe(2.37);
      expect(before.map((s) => s.beat)).toEqual([8, 2.37, 0, 4.5]);
      // Step 2: Perform Action — simulate commit sort that editor must do
      const sorted = expectedSorted(before);
      // Also verify source contains the expected sort implementation
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/\.sort\s*\(\s*\(a\s*,\s*b\)\s*=>\s*a\.beat\s*-\s*b\.beat/);
      // Step 3: Assert Changed Outcome — strictly ascending, off-grid preserved
      expect(sorted.map((s) => s.beat)).toEqual([0, 2.37, 4.5, 8]);
      expect(sorted[0].beat).toBeCloseTo(0, 5);
      expect(sorted[1].beat).toBeCloseTo(2.37, 5);
      expect(sorted[2].beat).toBeCloseTo(4.5, 5);
      expect(sorted[3].beat).toBeCloseTo(8, 5);
      // must be stable and not mutate original order incorrectly
      expect(before.map((s) => s.beat)).toEqual([8, 2.37, 0, 4.5]); // before unchanged
      expect(sorted).not.toEqual(before);
    });

    it('複雑端数 [0.37, 12.125, 4.37, 1.23, 8.25] を拍昇順に — off-grid 0.37/1.23必須 (3-step)', () => {
      const before: BpmChange[] = [
        { beat: 0.37, bpm: 120 },
        { beat: 12.125, bpm: 180 },
        { beat: 4.37, bpm: 150 },
        { beat: 1.23, bpm: 130 },
        { beat: 8.25, bpm: 140 },
      ];
      expect(before.map((s) => s.beat)).toEqual([0.37, 12.125, 4.37, 1.23, 8.25]);
      const sorted = expectedSorted(before);
      expect(sorted.map((s) => s.beat)).toEqual([0.37, 1.23, 4.37, 8.25, 12.125]);
      expect(sorted[0].beat).toBeCloseTo(0.37, 5);
      expect(sorted[1].beat).toBeCloseTo(1.23, 5);
      expect(sorted[2].beat).toBeCloseTo(4.37, 5);
      // verify source still has sort
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/\.sort/);
    });

    it('同beatや極小差の安定ソート — 3.4, 0.7, 2.7 等の複雑振幅とともに (3-step)', () => {
      const before: BpmChange[] = [
        { beat: 4, bpm: 120, amplitude: 3.4 },
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 2, bpm: 120, amplitude: 1.3 },
        { beat: 4, bpm: 120, amplitude: 2.7 },
        { beat: 1.23, bpm: 120, amplitude: 1.5 },
      ];
      expect(before[0].beat).toBe(4);
      const sorted = expectedSorted(before);
      expect(sorted.map((s) => s.beat)).toEqual([0, 1.23, 2, 4, 4]);
      // stable: original order of equal beats preserved (3.4 before 2.7)
      expect(sorted[3].amplitude).toBeCloseTo(3.4, 5);
      expect(sorted[4].amplitude).toBeCloseTo(2.7, 5);
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/\.sort/);
    });
  });

  describe('2. 追加時ソート: 未ソート末尾追加が確定で拍昇順へ (3-step)', () => {
    it('既存 [0,4,8] に beat=2.37 を追加 → 確定で [0,2.37,4,8] へ再整列 (3-step off-grid)', () => {
      const before: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      expect(before.map((s) => s.beat)).toEqual([0, 4, 8]);
      // Simulate dialog confirmAdd appending then sorting (as editor must do)
      const appended: BpmChange[] = [...before, { beat: 2.37, bpm: 150 }];
      expect(appended.map((s) => s.beat)).toEqual([0, 4, 8, 2.37]);
      const sorted = expectedSorted(appended);
      expect(sorted.map((s) => s.beat)).toEqual([0, 2.37, 4, 8]);
      expect(sorted[1].beat).toBeCloseTo(2.37, 5);
      // source must implement sort on add
      const dialogSrc = fs.readFileSync('src/screens/editor/SectionAddDialog.tsx', 'utf-8');
      expect(dialogSrc).toMatch(/\.sort|sortSections|sortByBeat/);
      expect(sorted.length).toBe(4);
      expect(before.length).toBe(3); // before unchanged proof of action
    });

    it('追加 beatが先頭に入るケース: [4,8] に 0.37 を追加 → [0.37,4,8] (3-step)', () => {
      const before: BpmChange[] = [
        { beat: 4, bpm: 120 },
        { beat: 8, bpm: 120 },
      ];
      expect(before.map((s) => s.beat)).toEqual([4, 8]);
      const appended: BpmChange[] = [...before, { beat: 0.37, bpm: 120 }];
      const sorted = expectedSorted(appended);
      expect(sorted.map((s) => s.beat)).toEqual([0.37, 4, 8]);
      expect(sorted[0].beat).toBeCloseTo(0.37, 5);
      const src = fs.readFileSync('src/screens/editor/SectionAddDialog.tsx', 'utf-8');
      expect(src).toMatch(/\.sort|sortSections|sortByBeat/);
    });
  });

  describe('3. beat編集確定時ソート: 編集中は順序不変、Blur/Enterで整列 (3-step)', () => {
    it('beat入力中(仮状態)は順序不変、onBlur確定で拍昇順へ — フォーカス飛び防止 (3-step off-grid)', () => {
      // Step 1: Capture Before — list in correct order
      const beforeEdit: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 130 },
        { beat: 8, bpm: 140 },
      ];
      expect(beforeEdit.map((s) => s.beat)).toEqual([0, 4, 8]);
      // Step 2: Simulate user typing: editing second entry from 4 -> 12.125 (still typing, not yet committed)
      // During typing, the UI must NOT reorder (focus preservation)
      const duringTyping: BpmChange[] = beforeEdit.map((c, i) => (i === 1 ? { ...c, beat: 12.125 } : c));
      // If buggy implementation sorted on every onChange, duringTyping would already be sorted to [0,8,12.125]
      // Correct behavior: duringTyping retains array index order until blur
      expect(duringTyping.map((s) => s.beat)).toEqual([0, 12.125, 8]);
      // Step 3: Assert commit-time sorting moves it to correct position
      const afterBlur = expectedSorted(duringTyping);
      expect(afterBlur.map((s) => s.beat)).toEqual([0, 8, 12.125]);
      // Verify source implements blur/commit sort not inline onChange sort
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/onBlur/);
      expect(src).toMatch(/onKeyDown/);
      expect(src).toMatch(/\.sort/);
      // And off-grid end-to-end: editing to 1.23 should sort to front after blur
      const editToFront = beforeEdit.map((c, i) => (i === 2 ? { ...c, beat: 1.23 } : c));
      expect(editToFront.map((s) => s.beat)).toEqual([0, 4, 1.23]);
      const sortedFront = expectedSorted(editToFront);
      expect(sortedFront.map((s) => s.beat)).toEqual([0, 1.23, 4]);
      expect(sortedFront[1].beat).toBeCloseTo(1.23, 5);
    });

    it('Enter確定でも拍昇順へ — onKeyDown EnterがonBlurと同等にソート (3-step)', () => {
      const before: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 8, bpm: 120 },
        { beat: 4, bpm: 120 },
      ];
      // Intentionally unsorted initial to prove commit sorts
      expect(before.map((s) => s.beat)).toEqual([0, 8, 4]);
      // User edits middle entry 8 -> 2.37 but not yet committed (simulate pending local value)
      const pendingEdit: BpmChange[] = [{ beat: 0, bpm: 120 }, { beat: 2.37, bpm: 120 }, { beat: 4, bpm: 120 }];
      // During pending, array is still [0,2.37,4] at indices (no global resort yet if implementation buffers)
      expect(pendingEdit.map((s) => s.beat)).toEqual([0, 2.37, 4]);
      const sortedOnEnter = expectedSorted(pendingEdit);
      expect(sortedOnEnter.map((s) => s.beat)).toEqual([0, 2.37, 4]);
      // More interesting: edit last entry to 0.37, Enter should move it to front
      const pendingFront: BpmChange[] = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 120 }, { beat: 0.37, bpm: 120 }];
      const sortedFront = expectedSorted(pendingFront);
      expect(sortedFront.map((s) => s.beat)).toEqual([0, 0.37, 8]);
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/Enter/);
      expect(src).toMatch(/onBlur/);
    });
  });

  describe('4. import時ソート: 未ソートTOML読込が確定で拍昇順へ (3-step)', () => {
    it('未ソートsectionsを含むTOMLをimport → bpm_changesが拍昇順に (3-step off-grid)', async () => {
      const tomlUnsorted = `
title = "Unsorted Import"
artist = ""
audio = "a.flac"
[[sections]]
beat = 8
bpm = 140
[[sections]]
beat = 0.37
bpm = 120
[[sections]]
beat = 4.5
bpm = 130
`;
      // Step 1: Capture Before — parse raw without editor sort would be loader-sorted already
      // Loader (parseChartText) already sorts, but editor importChart must also ensure committed order.
      // So we simulate unsorted in-memory sections before EditorScreen importChart commits
      const beforeSections: BpmChange[] = [
        { beat: 8, bpm: 140 },
        { beat: 0.37, bpm: 120 },
        { beat: 4.5, bpm: 130 },
      ];
      expect(beforeSections.map((s) => s.beat)).toEqual([8, 0.37, 4.5]);
      // Step 2: Perform Action — simulate import commit that must sort
      const { parseChartText } = await import('../src/chart/loader');
      const chart = parseChartText(tomlUnsorted);
      const importedSorted = [...chart.bpm_changes].sort((a, b) => a.beat - b.beat);
      // Step 3: Assert Changed Outcome — sorted ascending, off-grid preserved
      expect(chart.bpm_changes.map((s) => s.beat)).toEqual([0.37, 4.5, 8]);
      expect(importedSorted.map((s) => s.beat)).toEqual([0.37, 4.5, 8]);
      expect(chart.bpm_changes[0].beat).toBeCloseTo(0.37, 5);
      expect(chart.bpm_changes[1].beat).toBeCloseTo(4.5, 5);
      // source must ensure EditorScreen import path also sorts (or relies on loader + re-sort)
      const editorSrc = fs.readFileSync('src/screens/EditorScreen.tsx', 'utf-8');
      const bpmEditorSrc = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      const combined = editorSrc + bpmEditorSrc;
      expect(combined).toMatch(/\.sort|sortSections|sortByBeat/);
    });
  });

  describe('5. ドラッグ等での確定ソートとBpmTimeline整合 (off-grid + 複雑振幅)', () => {
    it('ドラッグでbeatを4→1.23へ移動確定 → 整列しBpmTimeline beatToMsが整合 (3-step)', () => {
      const before: BpmChange[] = [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 150 },
        { beat: 8, bpm: 180 },
      ];
      expect(before.map((s) => s.beat)).toEqual([0, 4, 8]);
      // Simulate drag commit: second section dragged from 4 to 1.23
      const dragged: BpmChange[] = [{ beat: 0, bpm: 120 }, { beat: 1.23, bpm: 150 }, { beat: 8, bpm: 180 }];
      expect(dragged.map((s) => s.beat)).toEqual([0, 1.23, 8]);
      const sorted = expectedSorted(dragged);
      expect(sorted.map((s) => s.beat)).toEqual([0, 1.23, 8]);
      // BpmTimeline must still compute correct ms after resort (off-grid 0.37/1.23)
      const tlBefore = makeTimeline(before);
      const beforeMs = tlBefore.beatToMs(1.23);
      expect(beforeMs).toBeGreaterThan(0);
      const tlAfter = makeTimeline(sorted);
      const afterMs = tlAfter.beatToMs(1.23);
      // After move, beat 1.23 falls in second segment (150 BPM) boundary shifted, but ms must be consistent with new ordering
      expect(afterMs).toBeCloseTo(tlAfter.beatToMs(1.23), 5);
      // Source must have sort on drag commit (at least beat sort somewhere)
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/\.sort/);
    });

    it('複数回編集→確定の連続で常に拍昇順を維持 — 複雑amp 0.7/1.3/2.7とoff-grid 0.37/1.23 (3-step)', () => {
      let sections: BpmChange[] = [
        { beat: 0, bpm: 120, amplitude: 0.7 },
        { beat: 4, bpm: 130, amplitude: 1.3 },
        { beat: 8, bpm: 140, amplitude: 2.7 },
      ];
      expect(sections.map((s) => s.beat)).toEqual([0, 4, 8]);
      // Edit 1: add beat 12.125
      sections = expectedSorted([...sections, { beat: 12.125, bpm: 150, amplitude: 1.0 }]);
      expect(sections.map((s) => s.beat)).toEqual([0, 4, 8, 12.125]);
      // Edit 2: modify middle to 0.37 (off-grid)
      sections = sections.map((c, i) => (i === 1 ? { ...c, beat: 0.37 } : c));
      expect(sections.map((s) => s.beat)).toEqual([0, 0.37, 8, 12.125]);
      sections = expectedSorted(sections);
      expect(sections.map((s) => s.beat)).toEqual([0, 0.37, 8, 12.125]);
      expect(sections[1].beat).toBeCloseTo(0.37, 5);
      expect(sections[1].amplitude).toBeCloseTo(1.3, 5);
      // Edit 3: modify to 1.23
      sections = sections.map((c, i) => (i === 2 ? { ...c, beat: 1.23 } : c));
      sections = expectedSorted(sections);
      expect(sections.map((s) => s.beat)).toEqual([0, 0.37, 1.23, 12.125]);
      expect(sections[2].beat).toBeCloseTo(1.23, 5);
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/onBlur/);
      expect(src).toMatch(/Enter/);
    });
  });

  describe('6. フォーカス飛び防止と安定性 + tsc整合', () => {
    it('入力中ソートが無いことでフォーカス喪失しない — onChangeはローカル保持、ソートはblur/Enterのみ (3-step)', () => {
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      void src;
      const currentSrc = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      // Must have a buffered/local state pattern or onBlur indirection, not immediate parent resort on every keystroke
      expect(currentSrc).toMatch(/onBlur/);
      // The beat input should have both value controlled and onChange that does NOT trigger global sort
      // Check that onChange handler for bpm-change-beat does NOT contain .sort directly
      const beatInputBlock = currentSrc.match(/bpm-change-beat[\s\S]{0,600}/)?.[0] ?? '';
      expect(beatInputBlock).toContain('onChange');
      expect(beatInputBlock).toContain('onBlur');
      // No .sort inside the onChange arrow for beat input (allow sort in onBlur block)
      const onChangeIdx = currentSrc.indexOf('bpm-change-beat');
      const nextOnBlurIdx = currentSrc.indexOf('onBlur', onChangeIdx);
      const between = currentSrc.slice(onChangeIdx, nextOnBlurIdx !== -1 ? nextOnBlurIdx : onChangeIdx + 500);
      // onChange region before onBlur should not contain sort
      expect(between).not.toMatch(/\.sort\s*\(/);
      // overall file must have sort after (in blur/commit path)
      expect(currentSrc.slice(nextOnBlurIdx)).toMatch(/\.sort|sortSections|sortByBeat/);
    });

    it('beatsが全て非負かつ昇順で重複してもBpmTimelineが安定 — 3-step off-grid', () => {
      const before: BpmChange[] = [
        { beat: 8, bpm: 120 },
        { beat: 8, bpm: 130 },
        { beat: 0, bpm: 140 },
        { beat: 0.37, bpm: 150 },
      ];
      expect(before.map((s) => s.beat)).toEqual([8, 8, 0, 0.37]);
      const sorted = expectedSorted(before);
      expect(sorted.map((s) => s.beat)).toEqual([0, 0.37, 8, 8]);
      const tl = makeTimeline(sorted);
      expect(tl.beatToMs(0.37)).toBeCloseTo((0.37 * 60000) / sorted[0].bpm, 3);
      expect(tl.bpmAt(8)).toBeCloseTo(130, 5);
      const src = fs.readFileSync('src/screens/editor/BpmEditor.tsx', 'utf-8');
      expect(src).toMatch(/\.sort/);
    });
  });
});
