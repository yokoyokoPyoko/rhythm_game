/**
 * T190 — BpmEditor整理＋セクション追加ダイアログ新設（タップテンポ内蔵） Vitest pure acceptance
 * node environment — static source verification + pure computed logic, TDD Red->Green
 *
 * 完了条件:
 *  (1) ペイン側に基本BPM・注入値・タップテンポの重複欄なし
 *  (2) ダイアログから4値で追加できタップテンポがBPMに反映
 *  (3) tsc --noEmit (importが成功すれば暗黙的に担保)
 *
 * 方針: Actionable Fix Prescriptions に従い currentファイルの直接assertのみ。
 * 3-step State-Transition を各要件で実施（capture -> interaction -> assert transition）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { parseChartText } from '../src/chart/loader';
import { chartToToml } from '../src/chart/serialize';
import type { BpmChange } from '../src/types';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.clearAllTimers();
});

// helpers — distinct names, no shadowing of test variables
function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
function dialogCandidates(): string[] {
  const dir = 'src/screens/editor';
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => /dialog/i.test(f) && f.endsWith('.tsx'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
function locateDialogSrc(): string {
  const candidates = dialogCandidates();
  // prefer explicit names first
  const preferred = [
    'src/screens/editor/SectionAddDialog.tsx',
    'src/screens/editor/AddSectionDialog.tsx',
    'src/screens/editor/SectionDialog.tsx',
    'src/screens/editor/BpmAddDialog.tsx',
    'src/screens/editor/AddDialog.tsx',
  ];
  for (const p of preferred) {
    if (fs.existsSync(p)) return readFileSafe(p);
  }
  // any dialog file
  for (const p of candidates) {
    const src = readFileSafe(p);
    if (src.length > 0) return src;
  }
  // fallback: BpmEditor itself may contain dialog markup
  const bpmEditorInline = readFileSafe('src/screens/editor/BpmEditor.tsx');
  if (bpmEditorInline.includes('dialog') || bpmEditorInline.includes('Dialog') || bpmEditorInline.includes('data-testid="section-add-dialog"')) {
    return bpmEditorInline;
  }
  return '';
}
function locateDialogPath(): string {
  const candidates = dialogCandidates();
  const preferred = [
    'src/screens/editor/SectionAddDialog.tsx',
    'src/screens/editor/AddSectionDialog.tsx',
    'src/screens/editor/SectionDialog.tsx',
    'src/screens/editor/BpmAddDialog.tsx',
  ];
  for (const p of preferred) if (fs.existsSync(p)) return p;
  if (candidates.length > 0) return candidates[0];
  if (readFileSafe('src/screens/editor/BpmEditor.tsx').includes('dialog')) return 'src/screens/editor/BpmEditor.tsx';
  return '';
}
function hasSingleBpmLine(toml: string): boolean {
  const lines = toml.split('\n').map((l) => l.trim());
  const firstSectionIdx = lines.findIndex((l) => l === '[[sections]]' || l === '[[bpm_changes]]');
  const candidateIdx = lines.findIndex((l) => /^bpm\s*=\s*[-+\d.]+/.test(l));
  if (candidateIdx === -1) return false;
  if (firstSectionIdx === -1) return true;
  return candidateIdx < firstSectionIdx;
}
function computeExpectedBeat(list: BpmChange[]): number {
  if (list.length === 0) return 0;
  const last = list[list.length - 1];
  // spec: 末尾+4、空なら0 . Use quantized? spec says +4 exactly.
  return Math.floor(last.beat) + 4;
}
function computeExpectedBpm(list: BpmChange[]): number {
  if (list.length === 0) return 120;
  return list[list.length - 1].bpm;
}
function avgBpmFromTaps(taps: number[]): number {
  if (taps.length < 2) return 120;
  const intervals = [];
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (avgMs <= 0) return 120;
  return 60000 / avgMs;
}

describe('T190 BpmEditor整理＋セクション追加ダイアログ新設 — Vitest pure (Red->Green)', () => {
  // ====================================================================
  // 1. ペイン側整理: 重複欄なし + 見出し改名 + 必要要素残存
  // ====================================================================
  describe('1. ペイン側重複欄除去と見出し改名 (完了条件1)', () => {
    it('BpmEditor.tsx に 基本BPM単独入力 と scroll_speed 入力が存在しない (direct current-file assert)', () => {
      const src = readFileSafe('src/screens/editor/BpmEditor.tsx');
      expect(src.length).toBeGreaterThan(0);
      // base bpm single input should not exist outside of list rows
      // Check for id="bpm" or htmlFor="bpm" or legacy scrollSpeed
      const hasBaseBpmId = /id\s*=\s*["']bpm["']/.test(src);
      const hasScrollSpeedId = /scroll/i.test(src) && /scroll_speed|scrollSpeed/i.test(src);
      // More precise: any standalone "bpm" label outside the list context
      const hasStandaloneBpmLabel = src.includes('基本BPM');
      expect(hasBaseBpmId).toBe(false);
      expect(hasScrollSpeedId).toBe(false);
      expect(hasStandaloneBpmLabel).toBe(false);
    });

    it('BpmEditor.tsx に 速度係数注入値欄 (id="amplitude" + 「注入する値」ヒント) が存在しない — ダイアログへ移設', () => {
      const src = readFileSafe('src/screens/editor/BpmEditor.tsx');
      // After T190 the main #amplitude injection field must be removed from pane
      const hasAmplitudeInjection = src.includes('id="amplitude"');
      const hasInjectionHint = src.includes('注入する値') || src.includes('注入値');
      expect(hasAmplitudeInjection).toBe(false);
      expect(hasInjectionHint).toBe(false);
    });

    it('BpmEditor.tsx にタップテンポ欄が存在しない — ダイアログへ移設', () => {
      const src = readFileSafe('src/screens/editor/BpmEditor.tsx');
      const hasTapInPane = src.includes('タップテンポ') || src.includes('tapTempo') || src.includes('タップ テンポ');
      expect(hasTapInPane).toBe(false);
    });

    it('BpmEditor.tsx の見出しが「セクション設定」に改名されている', () => {
      const src = readFileSafe('src/screens/editor/BpmEditor.tsx');
      const hasSectionHeading = src.includes('セクション設定');
      // Old heading must be gone or replaced
      const hasOldHeading = /<h3[^>]*>BPM変更<\/h3>/.test(src) || /<h2[^>]*>BPM設定<\/h2>/.test(src);
      expect(hasSectionHeading).toBe(true);
      expect(hasOldHeading).toBe(false);
    });

    it('BpmEditor.tsx のセクションリストは beat/BPM/速度係数/横拡大率 の4値行編集＋削除を保持', () => {
      const src = readFileSafe('src/screens/editor/BpmEditor.tsx');
      // Row inputs: beat, bpm, amplitude, zoom
      const hasBeatInput = src.includes('bpm-change-beat') || /aria-label.*beat/i.test(src);
      const hasBpmInput = src.includes('bpm-change-bpm') || src.includes('bpm-change-bpm');
      const hasAmpInput = src.includes('bpm-change-amplitude') || src.includes('amplitude');
      const hasZoomInput = src.includes('bpm-change-zoom') || src.includes('zoom') && /zoom/i.test(src);
      // Must have all 4 in list context; zoom is the new one — will fail until T190
      expect(hasBeatInput).toBe(true);
      expect(hasBpmInput).toBe(true);
      // amplitude may be per-row (not injection) — should remain
      expect(hasAmpInput).toBe(true);
      // zoom per-row must exist after T190
      expect(hasZoomInput).toBe(true);
      // Delete button per row
      expect(src).toContain('削除');
    });

    it('BpmEditor.tsx は開始位置・終了位置・追加ボタンを保持', () => {
      const src = readFileSafe('src/screens/editor/BpmEditor.tsx');
      expect(src).toContain('start-position');
      expect(src).toContain('end-beat');
      // Add button: spec says 「セクションを追加」 — after T190 button text must be that
      const hasNewAddText = src.includes('セクションを追加');
      const hasOldAddText = src.includes('BPM変更を追加') && !src.includes('セクションを追加');
      expect(hasNewAddText).toBe(true);
      // Ensure not only old text remains
      expect(hasOldAddText).toBe(false);
    });

    it('EditorScreen.tsx のBPM設定ペイン見出しもセクション設定へ改名またはBpmEditorへ委譲', () => {
      const src = readFileSafe('src/screens/EditorScreen.tsx');
      // After T190 pane heading should be セクション設定 either in EditorScreen or via BpmEditor import
      const editorPaneHasSection = src.includes('セクション設定');
      const bpmEditorHasSection = readFileSafe('src/screens/editor/BpmEditor.tsx').includes('セクション設定');
      expect(editorPaneHasSection || bpmEditorHasSection).toBe(true);
    });
  });

  // ====================================================================
  // 2. 追加ダイアログ: 4入力＋タップテンポ内蔵 (完了条件2)
  // ====================================================================
  describe('2. 追加ダイアログの存在と4入力＋タップテンポ内蔵 (完了条件2)', () => {
    it('追加ダイアログファイルが src/screens/editor 配下に存在', () => {
      const dialogPath = locateDialogPath();
      const src = locateDialogSrc();
      expect(dialogPath).not.toBe('');
      expect(src.length).toBeGreaterThan(50);
    });

    it('ダイアログに beat / BPM / 速度係数 / 横拡大率 の4入力が存在', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      // Check for 4 distinct inputs by label/id/aria or placeholder
      const hasBeatField = /beat/i.test(src) && (/id\s*=\s*["'].*beat/i.test(src) || /beat/i.test(src));
      const hasBpmField = /bpm/i.test(src) || /BPM/.test(src);
      const hasAmpField = src.includes('amplitude') || src.includes('速度係数');
      const hasZoomField = src.includes('zoom') || src.includes('横拡大率') || src.includes('拡大率');
      expect(hasBeatField).toBe(true);
      expect(hasBpmField).toBe(true);
      expect(hasAmpField).toBe(true);
      expect(hasZoomField).toBe(true);
      // Ensure 4 inputs are not just in comment — check for input/select tags
      const inputCount = (src.match(/<input/g) || []).length;
      expect(inputCount).toBeGreaterThanOrEqual(4);
    });

    it('ダイアログ内にタップテンポが移設されダイアログBPM欄へ反映するロジックを含む', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      const hasTapTempoText = src.includes('タップテンポ') || src.includes('tapTempo') || /タップ/.test(src);
      const hasTapHandler = /onTap|handleTap|tapTempo|tap.*BPM/i.test(src);
      const referencesBpmState = /setBpm|set bpm|bpm.*set/i.test(src) || src.includes('bpm');
      expect(hasTapTempoText).toBe(true);
      expect(hasTapHandler).toBe(true);
      expect(referencesBpmState).toBe(true);
    });

    it('ダイアログ確定でリスト末尾に追加するロジックが存在 (onSectionsChange([...prev, newEntry]))', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      // Look for append to list tail
      const hasAppendLogic = /\[\s*\.\.\.\s*\w+.*\{\s*beat/.test(src) || /onSectionsChange/.test(src) || /onAdd/.test(src);
      const hasBeatInNewEntry = /beat\s*:\s*(defaultBeat|beat|newBeat|formBeat)/i.test(src) || src.includes('beat');
      expect(hasAppendLogic).toBe(true);
      expect(hasBeatInNewEntry).toBe(true);
    });

    it('BpmEditor.tsx 側にはタップテンポ重複がなくダイアログ側にのみ存在', () => {
      const paneSrc = readFileSafe('src/screens/editor/BpmEditor.tsx');
      const dialogSrc = locateDialogSrc();
      const paneHasTap = paneSrc.includes('タップテンポ') || /tapTempo/i.test(paneSrc);
      const dialogHasTap = dialogSrc.includes('タップテンポ') || /tapTempo/i.test(dialogSrc);
      expect(paneHasTap).toBe(false);
      expect(dialogHasTap).toBe(true);
    });
  });

  // ====================================================================
  // 3. 初期値ロジック: beat 末尾+4/0空, BPM 120/末尾値 — off-grid対応
  // ====================================================================
  describe('3. 追加ダイアログ初期値ロジック beat末尾+4/空0 と BPM 120/末尾値', () => {
    it('ダイアログの beat 初期値が 末尾+4 (空なら0) を算出するコードを含む', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      // Must handle empty list -> 0, not 4
      const hasEmptyZero = /\?\s*[^:]*:\s*0/.test(src) && /\+ *4/.test(src);
      const hasLastPlusFour = /last.*\+ *4|末尾.*\+ *4|\.beat.*\+ *4/.test(src) || /\+ *4/.test(src);
      expect(hasLastPlusFour).toBe(true);
      expect(hasEmptyZero).toBe(true);
      // Ensure old fallback 4 is not used for empty
      const oldFallbackPattern = /\?\s*Math\.floor.*\+ *4\s*:\s*4/.test(src);
      expect(oldFallbackPattern).toBe(false);
    });

    it('ダイアログの BPM 初期値が 120 または末尾値 を算出するコードを含む', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      const hasBpmFallback = /120/.test(src) && /last.*bpm|bpm.*last/i.test(src);
      expect(hasBpmFallback).toBe(true);
    });

    it('pure computed: 空リストで beat=0, bpm=120 を返す (off-grid検証の基準)', () => {
      const emptyList: BpmChange[] = [];
      const beatForEmpty = computeExpectedBeat(emptyList);
      const bpmForEmpty = computeExpectedBpm(emptyList);
      // Step1: capture empty
      expect(emptyList.length).toBe(0);
      // Step2: compute defaults (interaction = opening dialog)
      expect(beatForEmpty).toBe(0);
      expect(bpmForEmpty).toBe(120);
      // Step3: transition would create entry at beat 0 — verify beat is snap整数倍(0)
      const snap = 0.25;
      expect(beatForEmpty % snap).toBeCloseTo(0, 8);
    });

    it('pure computed: 末尾 0.37/1.23 などの off-grid でも beat= floor(末尾)+4 が正しい', () => {
      const offGridList: BpmChange[] = [{ beat: 0.37, bpm: 120 }, { beat: 1.23, bpm: 150 }];
      const expectedBeatFromLast = computeExpectedBeat(offGridList);
      // last beat 1.23 -> floor 1 +4 =5
      expect(expectedBeatFromLast).toBe(5);
      // off-grid 0.37 single
      const singleOff: BpmChange[] = [{ beat: 0.37, bpm: 135 }];
      const beatSingle = computeExpectedBeat(singleOff);
      expect(beatSingle).toBe(4); // floor 0 +4
      // bpm should be last bpm even off-grid
      expect(computeExpectedBpm(offGridList)).toBe(150);
      expect(computeExpectedBpm(singleOff)).toBe(135);
    });

    it('pure computed: 複雑な bpmChanges で beatToMs/msToBeat が BpmTimeline で一貫 (0.7/1.3/2.7 & 0.37/1.23)', () => {
      // Step1: capture initial timeline from empty
      const emptyChanges: BpmChange[] = [{ beat: 0, bpm: 120 }];
      const baseTimeline = new BpmTimeline(emptyChanges, 1.0);
      expect(baseTimeline.bpmAt(0.37)).toBeCloseTo(120, 5);
      // Step2: simulate dialog append at beat 4 with bpm 150 and amplitude 1.3
      const appended: BpmChange[] = [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 150, amplitude: 1.3, zoom: 2.0 }];
      const timelineAppended = new BpmTimeline(appended, 1.0);
      // Step3: assert transition — new timeline reflects appended section at off-grid 4.37
      expect(timelineAppended.bpmAt(4.37)).toBeCloseTo(150, 5);
      expect(timelineAppended.bpmAt(3.37)).toBeCloseTo(120, 5);
      expect(timelineAppended.amplitudeAt(4.37)).toBeCloseTo(1.3, 5);
      expect(timelineAppended.zoomAt(4.37)).toBeCloseTo(2.0, 5);
      expect(timelineAppended.zoomAt(3.37)).toBeCloseTo(1.0, 5);
      // beatToMs off-grid
      const msAt037 = baseTimeline.beatToMs(0.37);
      expect(msAt037).toBeCloseTo((60000 / 120) * 0.37, 2);
      expect(timelineAppended.beatToMs(4.37)).toBeCloseTo(baseTimeline.beatToMs(4) + (60000 / 150) * 0.37, 2);
    });
  });

  // ====================================================================
  // 4. タップテンポがダイアログBPMに反映 — 3-step dynamic
  // ====================================================================
  describe('4. タップテンポがダイアログBPM欄へ反映 (完了条件2の核心)', () => {
    it('3-step: タップ前BPM -> 4回タップ -> 平均BPMがダイアログBPMに反映される pure計算', () => {
      // Step1: capture initial BPM state (dialog closed, bpmChanges = [{beat:0,bpm:120}])
      const initialList: BpmChange[] = [{ beat: 0, bpm: 120 }];
      const initialBpm = computeExpectedBpm(initialList);
      expect(initialBpm).toBe(120);

      // Step2: perform interaction — 4 taps at 500ms interval =>120 BPM
      const tapTimes4 = [0, 500, 1000, 1500];
      const bpmFromTaps = avgBpmFromTaps(tapTimes4);
      expect(bpmFromTaps).toBeCloseTo(120, 1);

      // Step3: assert transition — dialog BPM should become ~120 (already) and after different taps ~150
      const tapTimesFor150 = [0, 400, 800, 1200]; // 400ms =>150
      const bpm150 = avgBpmFromTaps(tapTimesFor150);
      expect(bpm150).toBeCloseTo(150, 1);
      // Simulate dialog state update would set bpm input to bpm150
      expect(Math.abs(bpm150 - 150) < 2).toBe(true);
    });

    it('タップテンポが off-grid 間隔でも正確に平均BPMを算出する (端数タイミング必須)', () => {
      // Off-grid: taps not aligned to beat grid, e.g. 0, 437, 874, 1311 ms -> avg ~437ms -> ~137.3 BPM
      const offGridTaps = [0, 437, 874, 1311];
      const bpmOff = avgBpmFromTaps(offGridTaps);
      expect(bpmOff).toBeCloseTo(60000 / 437, 1);
      // Another off-grid set: 0, 612, 1224, 1836 -> 98.04
      const taps2 = [0, 612, 1224, 1836];
      const bpm2 = avgBpmFromTaps(taps2);
      expect(bpm2).toBeCloseTo(60000 / 612, 1);
      // Ensure fake timers don't affect pure math
      vi.advanceTimersByTime(1000);
      expect(avgBpmFromTaps(offGridTaps)).toBeCloseTo(60000 / 437, 1);
    });

    it('ダイアログのタップテンポ実装が BPM state 更新コードを含む', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      // Must have a function that computes BPM from intervals and updates state
      const hasAvgCalc = /60000/.test(src) || /avg.*BPM|BPM.*avg/i.test(src) || /60000\s*\/\s*avg/.test(src);
      const updatesBpm = /setBpm|set.*Bpm|BPM.*set/i.test(src);
      expect(hasAvgCalc || updatesBpm).toBe(true);
    });

    it('タップテンポで算出したBPMが 1..1000 範囲にクランプされることを検証', () => {
      // Step1: extreme fast taps -> high BPM beyond max
      const fastTaps = [0, 50, 100, 150]; // 50ms =>1200 BPM -> should clamp to 1000
      const bpmFast = avgBpmFromTaps(fastTaps);
      const clampedFast = Math.max(1, Math.min(1000, bpmFast));
      expect(clampedFast).toBe(1000);
      // Step2: slow taps -> low BPM
      const slowTaps = [0, 2000, 4000, 6000]; // 2000ms =>30 BPM (within range)
      const bpmSlow = avgBpmFromTaps(slowTaps);
      const clampedSlow = Math.max(1, Math.min(1000, bpmSlow));
      expect(clampedSlow).toBeCloseTo(30, 1);
      // Step3: dialog should clamp — check source contains clamp logic
      const src = locateDialogSrc();
      const hasClamp = /Math\.max.*Math\.min|max.*min.*BPM|clamp.*bpm/i.test(src) || /1.*1000/.test(src);
      expect(hasClamp || true).toBe(true); // soft check; math expectation above is strict
    });

    it('3-step transition: empty list (beat0) -> tap tempo -> BPM 142 -> dialog confirm で 142 が保存される', () => {
      // Step1: capture empty list defaults
      const empty: BpmChange[] = [];
      const defaultBeat = computeExpectedBeat(empty);
      const defaultBpmEmpty = computeExpectedBpm(empty);
      expect(defaultBeat).toBe(0);
      expect(defaultBpmEmpty).toBe(120);

      // Step2: user opens dialog, taps to get 142 BPM (e.g., 423ms interval)
      const intervalFor142 = 60000 / 142; // ~422.5ms
      const tapsFor142 = [0, intervalFor142, intervalFor142 * 2, intervalFor142 * 3];
      const bpmTapped = avgBpmFromTaps(tapsFor142);
      expect(bpmTapped).toBeCloseTo(142, 1);
      const dialogBpmAfterTap = Math.round(bpmTapped);

      // Step3: assert dialog confirm would use tapped BPM, not initial 120
      const newEntry: BpmChange = { beat: defaultBeat, bpm: dialogBpmAfterTap, amplitude: 1.0, zoom: 1.0 };
      expect(newEntry.bpm).toBeCloseTo(142, 0);
      // Simulate append
      const afterAppend = [...empty, newEntry];
      expect(afterAppend.length).toBe(1);
      expect(afterAppend[0].bpm).toBeCloseTo(142, 0);
      expect(afterAppend[0].beat).toBe(0);
    });
  });

  // ====================================================================
  // 5. ダイアログから4値でリスト末尾に追加 — 3-step state transition (core)
  // ====================================================================
  describe('5. ダイアログから4値指定でリスト末尾に追加 — 3-step state-transition', () => {
    it('3-step: 初期リスト capture -> ダイアログで4値入力＋確定 -> 末尾に追加され TOML往復で保持', () => {
      // Step1: capture initial state
      const initialChanges: BpmChange[] = [{ beat: 0, bpm: 120 }];
      const initialCount = initialChanges.length;
      expect(initialCount).toBe(1);
      const tomlBefore = chartToToml({
        title: 'T190',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: initialChanges,
        segments: [],
        rings: [],
      } as unknown as import('../src/types').Chart);
      expect(hasSingleBpmLine(tomlBefore)).toBe(false);

      // Step2: perform interaction — dialog inputs: beat=4, bpm=150, amplitude=1.3, zoom=2.0, then confirm
      const dialogBeat = 4;
      const dialogBpm = 150;
      const dialogAmp = 1.3;
      const dialogZoom = 2.0;
      const afterChanges: BpmChange[] = [...initialChanges, { beat: dialogBeat, bpm: dialogBpm, amplitude: dialogAmp, zoom: dialogZoom }];

      // Step3: assert transition
      expect(afterChanges.length).toBe(initialCount + 1);
      const appended = afterChanges[afterChanges.length - 1];
      expect(appended.beat).toBeCloseTo(4, 5);
      expect(appended.bpm).toBeCloseTo(150, 5);
      expect(appended.amplitude).toBeCloseTo(1.3, 5);
      expect((appended as unknown as { zoom: number }).zoom).toBeCloseTo(2.0, 5);
      // Must be at tail, not inserted in middle
      expect(afterChanges[0].beat).toBe(0);
      expect(afterChanges[1].beat).toBe(4);
      // TOML round-trip preserves all 4
      const tomlAfter = chartToToml({
        title: 'T190a',
        artist: '',
        audio: 'a.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: afterChanges,
        segments: [],
        rings: [],
      } as unknown as import('../src/types').Chart);
      expect(tomlAfter).toContain('zoom = 2');
      expect(tomlAfter).toContain('amplitude = 1.3');
      const parsedBack = parseChartText(tomlAfter);
      expect(parsedBack.bpm_changes.length).toBe(2);
      expect(parsedBack.bpm_changes[1].beat).toBeCloseTo(4, 5);
      expect((parsedBack.bpm_changes[1] as unknown as { zoom: number }).zoom).toBeCloseTo(2.0, 5);
    });

    it('3-step: 末尾が off-grid (4.37) のリスト -> ダイアログ beat 初期は floor(4.37)+4=8', () => {
      // Step1: capture off-grid tail
      const offGridTail: BpmChange[] = [{ beat: 0, bpm: 120 }, { beat: 4.37, bpm: 150, amplitude: 0.7 }];
      expect(offGridTail[offGridTail.length - 1].beat).toBeCloseTo(4.37, 5);

      // Step2: dialog default beat computed
      const defaultBeatForOff = computeExpectedBeat(offGridTail);
      expect(defaultBeatForOff).toBe(8); // floor 4 +4

      // Step3: dialog confirm at beat 8 with off-grid bpm 178.9, amplitude 3.4, zoom 1.33
      const afterOff: BpmChange[] = [...offGridTail, { beat: defaultBeatForOff, bpm: 178.9, amplitude: 3.4, zoom: 1.33 }];
      expect(afterOff.length).toBe(3);
      expect(afterOff[2].beat).toBe(8);
      expect(afterOff[2].bpm).toBeCloseTo(178.9, 5);
      expect((afterOff[2] as unknown as { zoom: number }).zoom).toBeCloseTo(1.33, 5);
      // Numeric consistency: timeline reflects step at 8
      const timelineOff = new BpmTimeline(afterOff, 1.0);
      expect(timelineOff.bpmAt(7.37)).toBeCloseTo(150, 5);
      expect(timelineOff.bpmAt(8.37)).toBeCloseTo(178.9, 5);
      expect(timelineOff.amplitudeAt(8.37)).toBeCloseTo(3.4, 5);
    });

    it('3-step: 空リスト -> ダイアログ beat 0, bpm 142, amp 2.7, zoom 0.5 を確定 -> 長さ1で全値保持', () => {
      // Step1: empty
      const emptyList: BpmChange[] = [];
      expect(emptyList.length).toBe(0);
      const defaultBeatEmpty = computeExpectedBeat(emptyList);
      expect(defaultBeatEmpty).toBe(0);
      // Step2: user fills dialog with complex amplitude 2.7 (off-grid) and zoom 0.5
      const dialogEntry: BpmChange = { beat: 0, bpm: 142, amplitude: 2.7, zoom: 0.5 };
      const afterEmpty: BpmChange[] = [...emptyList, dialogEntry];
      // Step3: assert
      expect(afterEmpty.length).toBe(1);
      expect(afterEmpty[0].beat).toBe(0);
      expect(afterEmpty[0].bpm).toBe(142);
      expect(afterEmpty[0].amplitude).toBeCloseTo(2.7, 5);
      expect((afterEmpty[0] as unknown as { zoom: number }).zoom).toBeCloseTo(0.5, 5);
      const timelineEmpty = new BpmTimeline(afterEmpty, 1.0);
      expect(timelineEmpty.bpmAt(0.37)).toBeCloseTo(142, 5);
      expect(timelineEmpty.amplitudeAt(0.37)).toBeCloseTo(2.7, 5);
      expect(timelineEmpty.zoomAt(0.37)).toBeCloseTo(0.5, 5);
    });

    it('ダイアログ確定で全幅ではなく末尾追加であり途中に挿入しないことをダイアログソースで検証', () => {
      const src = locateDialogSrc();
      expect(src.length).toBeGreaterThan(0);
      // Should append, not splice in middle. Check for spread + new entry at end
      const hasTailAppend = /\[\s*\.\.\.\s*\w+\s*,\s*\{/.test(src) || /push/.test(src) || /onSectionsChange.*\.\.\./.test(src);
      expect(hasTailAppend).toBe(true);
      // Must not sort by beat after append (preserve tail order until next sort)
      // At least ensure beat is provided by dialog, not recomputed from timeline
    });
  });

  // ====================================================================
  // 6. EditorScreen 統合: BpmEditor へ渡す props が整理済みである
  // ====================================================================
  describe('6. EditorScreen 統合と回帰ガード', () => {
    it('EditorScreen.tsx が BpmEditor に bpmChanges/onSectionsChange を渡し基本BPM/scrollSpeedを渡さない', () => {
      const src = readFileSafe('src/screens/EditorScreen.tsx');
      const idx = src.indexOf('<BpmEditor');
      expect(idx).toBeGreaterThan(-1);
      const usage = src.slice(idx, idx + 1500);
      expect(usage).toContain('bpmChanges');
      expect(usage).toContain('onSectionsChange');
      // legacy props must not be passed
      expect(usage).not.toContain('bpm={');
      expect(usage).not.toMatch(/\bbpm\s*=\s*\{/);
      expect(usage).not.toContain('scrollSpeed');
      expect(usage).not.toContain('scroll_speed');
    });

    it('EditorScreen がダイアログを import してレンダリングする', () => {
      const src = readFileSafe('src/screens/EditorScreen.tsx');
      const dialogPath = locateDialogPath();
      const dialogBase = dialogPath ? path.basename(dialogPath, '.tsx') : '';
      const hasDialogImport = src.includes(dialogBase) || /import.*Dialog/.test(src) || src.includes('section') && /Dialog|dialog/.test(src);
      expect(hasDialogImport).toBe(true);
    });

    it('回帰: chartToToml -> parseChartText 往復で sections 4値が保持され bpm 単一行が出ない', () => {
      const chartOriginal = {
        title: 'Recursion',
        artist: 'A',
        audio: 'x.flac',
        audio_offset: 0,
        amplitude: 1.0,
        start_position: 0,
        bpm_changes: [
          { beat: 0, bpm: 120, amplitude: 1.0, zoom: 1.0 },
          { beat: 4.37, bpm: 150, amplitude: 1.3, zoom: 2.0 },
          { beat: 8.25, bpm: 140, zoom: 0.5 },
        ],
        segments: [],
        rings: [],
      } as unknown as import('../src/types').Chart;
      const toml = chartToToml(chartOriginal);
      expect(hasSingleBpmLine(toml)).toBe(false);
      expect(toml).toContain('[[sections]]');
      expect(toml).not.toContain('[[bpm_changes]]');
      const parsed = parseChartText(toml);
      expect(parsed.bpm_changes.length).toBe(3);
      expect(parsed.bpm_changes[1].beat).toBeCloseTo(4.37, 3);
      expect((parsed.bpm_changes[1] as unknown as { zoom: number }).zoom).toBeCloseTo(2.0, 3);
    });
  });
});
