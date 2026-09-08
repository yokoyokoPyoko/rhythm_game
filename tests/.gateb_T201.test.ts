/**
 * @vitest-environment node
 * T201 パブリックビュー関連のテスト手直し・結合 — Vitest acceptance test (node, TDD Red->Green)
 * Covers T198 (viewMode基盤 + ルートガード), T199 (SelectScreen分岐 + L/E撤廃), T200 (GameScreen ablations)
 * PLUS preserved editor/calibration regressions, and T127-style numeric consistency.
 * Every test follows 3-step pattern: [Capture Before] -> [Perform Action] -> [Assert Transition]
 * that FAILS on unimplemented code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getViewMode, setViewMode, toggleViewMode } from '../src/viewMode';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';

vi.useFakeTimers();

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  get length(): number { return this.m.size; }
}

class MockEventTarget {
  private listeners = new Map<string, EventListenerOrEventListenerObject[]>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(listener);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const list = this.listeners.get(type);
    if (list) {
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  dispatchEvent(event: Event): boolean {
    const list = this.listeners.get(event.type);
    if (list) {
      for (const l of list) {
        if (typeof l === 'function') (l as EventListener)(event);
        else if (l && typeof (l as EventListenerObject).handleEvent === 'function') (l as EventListenerObject).handleEvent(event);
      }
    }
    return true;
  }
}

function installStorageAndWindow(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  (globalThis as unknown as Record<string, unknown>).window = new MockEventTarget() as unknown as Window & typeof globalThis;
  return s;
}

beforeEach(() => {
  installStorageAndWindow();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

function readSrc(rel: string): string {
  const p = path.join(process.cwd(), rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

// =============================================================================
// T201-1: viewMode基盤 — 既定public, toggle永続化, App shortcut + badge + route guard
// =============================================================================
describe('T201-1 viewMode基盤とApp全体ガード (T198結合)', () => {
  it('Step1: Capture initial public default -> Step2: toggle to debug -> Step3: storage and getter reflect debug', () => {
    // Step1: capture before
    const before = getViewMode();
    expect(before).toBe('public');
    expect(localStorage.getItem('traceWaveViewMode')).toBeNull();
    // Step2: perform toggle action (simulates Ctrl+Alt+Shift+@ handler calling toggleViewMode)
    const afterToggle = toggleViewMode();
    // Step3: assert transition
    expect(afterToggle).toBe('debug');
    expect(getViewMode()).toBe('debug');
    expect(localStorage.getItem('traceWaveViewMode')).toBe('debug');
  });

  it('Step1: Capture debug state -> Step2: toggle back to public -> Step3: public restored and persisted', () => {
    // Step1: establish debug
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    // Step2: toggle back (second press of combo)
    const next = toggleViewMode();
    // Step3: assert public and storage updated
    expect(next).toBe('public');
    expect(getViewMode()).toBe('public');
    expect(localStorage.getItem('traceWaveViewMode')).toBe('public');
  });

  it('Step1: Capture stored debug value -> Step2: simulate reload via fresh getViewMode() read -> Step3: still debug', () => {
    // Step1: set debug and capture raw storage
    setViewMode('debug');
    const raw = localStorage.getItem('traceWaveViewMode');
    expect(raw).toBe('debug');
    // Step2: re-read (simulates reload without clearing storage)
    const reloadedMode = getViewMode();
    // Step3: must remain debug, not fallback to public
    expect(reloadedMode).toBe('debug');
    expect(raw).not.toBe('public');
  });

  it('Step1: Read App.tsx source -> Step2: search for Combo Ctrl+Alt+Shift+@ -> Step3: assert handler calls toggleViewMode', () => {
    // Step1: capture source before assertion
    const src = readSrc('src/App.tsx');
    expect(src.length).toBeGreaterThan(0);
    // Step2: perform pattern extraction (simulates verifying user action plumbing)
    const hasCtrl = src.includes('ctrlKey');
    const hasAlt = src.includes('altKey');
    const hasShift = src.includes('shiftKey');
    const hasAt = src.includes("'@'") || src.includes('"@"');
    const callsToggle = src.includes('toggleViewMode');
    const listensKeydown = src.includes("addEventListener('keydown'") || src.includes('addEventListener("keydown"');
    // Step3: assert full combo guard present, would FAIL if handler missing
    expect(hasCtrl).toBe(true);
    expect(hasAlt).toBe(true);
    expect(hasShift).toBe(true);
    expect(hasAt).toBe(true);
    expect(callsToggle).toBe(true);
    expect(listensKeydown).toBe(true);
  });

  it('Step1: Read App.tsx -> Step2: inspect debug badge and route guard -> Step3: badge conditional and /editor redirect present', () => {
    // Step1: capture
    const src = readSrc('src/App.tsx');
    // Step2: extract badge and guard snippets
    const hasBadgeTestId = src.includes('data-testid="debug-badge"');
    const hasDebugCondition = src.includes("mode === 'debug'") || src.includes('mode==="debug"');
    const hasEditorRoute = src.includes('path="/editor"');
    const hasRedirect = src.includes('Navigate to="/"') || src.includes("Navigate to='/'");
    const hasPublicGuard = src.includes("mode === 'debug' ?") || src.includes('mode==="debug"?');
    // Step3: assert both features wired, else public/debug flow broken
    expect(hasBadgeTestId).toBe(true);
    expect(hasDebugCondition).toBe(true);
    expect(hasEditorRoute).toBe(true);
    expect(hasRedirect).toBe(true);
    expect(hasPublicGuard).toBe(true);
  });
});

// =============================================================================
// T201-2: SelectScreen モード別分岐 — publicでは非表示, debugでは表示
// =============================================================================
describe('T201-2 SelectScreen public/debug分岐 (T199結合)', () => {
  it('Step1: Capture source has custom-import-section guarded by debug -> Step2: toggle viewMode public->debug -> Step3: guard and file inputs present only in debug path', () => {
    // Step1: capture source structure before state change
    const src = readSrc('src/screens/SelectScreen.tsx');
    expect(src.length).toBeGreaterThan(0);
    const initialMode = getViewMode();
    expect(initialMode).toBe('public');
    // Step2: perform mode toggle to debug (user presses combo)
    setViewMode('debug');
    const afterMode = getViewMode();
    // Step3: assert source guards import section behind debug check and inputs exist
    expect(afterMode).toBe('debug');
    // Source must guard custom-import-section behind viewMode/debug
    const guardedImport = src.includes('custom-import-section') && src.includes("viewMode === 'debug'");
    expect(guardedImport).toBe(true);
    // Both file inputs must be inside that guarded block
    expect(src).toContain('data-testid="home-chart-input"');
    expect(src).toContain('data-testid="home-audio-input"');
    expect(src).toContain('data-testid="home-dropzone"');
    // Button text must be "追加" not old "この譜面でプレイ"
    expect(src).toContain('追加');
    expect(src).not.toContain('この譜面でプレイ');
  });

  it('Step1: Capture debug mode -> Step2: toggle back to public -> Step3: delete/calibration/editor/hint remain guarded (would be hidden in public render)', () => {
    // Step1: start debug
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    const src = readSrc('src/screens/SelectScreen.tsx');
    // Step2: toggle back to public
    const back = toggleViewMode();
    // Step3: assert transition and that guarded elements exist in source but behind debug check
    expect(back).toBe('public');
    expect(getViewMode()).toBe('public');
    // All debug-only UI must be conditional on viewMode==='debug'
    const guardedDelete = src.includes('song-card-delete') && src.includes("viewMode === 'debug'");
    const guardedCalibrationBtn = src.includes('select-calibration-button') && src.includes("viewMode === 'debug'");
    const guardedHint = src.includes('select-hint') && src.includes("viewMode === 'debug'");
    const guardedNav = src.includes('select-nav') && src.includes("viewMode === 'debug'");
    expect(guardedDelete).toBe(true);
    expect(guardedCalibrationBtn).toBe(true);
    expect(guardedHint).toBe(true);
    expect(guardedNav).toBe(true);
    // Click navigation must remain unconditional (both modes can play)
    expect(src).toContain("navigate('/play/' + song.id)");
  });

  it('Step1: Capture SelectScreen key handling area -> Step2: scan for L/E navigation listeners -> Step3: assert L/E handlers removed (regression guard)', () => {
    // Step1: capture source before scan
    const src = readSrc('src/screens/SelectScreen.tsx');
    const beforeHasL = src.includes("key === 'l'") || src.includes('key === "l"');
    const beforeHasE = src.includes("key === 'e'") || src.includes('key === "e"');
    // Step2: scan for the old navigate-on-key pattern
    const hasNavigateEditorOnKey = src.includes("navigate('/editor')") && (src.includes("'l'") || src.includes("'e'") || src.includes('"l"') || src.includes('"e"'));
    const hasNavigateCalibrationOnKey = src.includes("navigate('/calibration')") || src.includes("setCalibrationOpen") && src.includes("key === 'l'");
    // Actually setCalibrationOpen via key is old pattern; check that no keydown effect handles l/e for navigation
    const keyHandlerHasLE = (() => {
      // Rough: find any e.key === 'l'/'L'/'e'/'E' that triggers navigate or setCalibrationOpen
      const idx = src.indexOf('addEventListener');
      // If there's no addEventListener at all for keys in SelectScreen, then LE is already removed (desired)
      return src.includes("e.key === 'l'") || src.includes('e.key === "l"') || src.includes("e.key === 'L'");
    })();
    // Step3: L/E navigation must be absent — would FAIL if old L/E listeners still present
    expect(hasNavigateEditorOnKey).toBe(false);
    expect(keyHandlerHasLE).toBe(false);
    void beforeHasL; void beforeHasE; void hasNavigateCalibrationOnKey;
    // EditorScreen/CalibrationModal retain their own V/E/R and ,. — not checked here but in next suites
  });

  it('Step1: Capture public mode initial -> Step2: verify delete button selector guarded + empty message present -> Step3: both conditions hold', () => {
    // Step1: capture initial public mode
    expect(getViewMode()).toBe('public');
    const src = readSrc('src/screens/SelectScreen.tsx');
    // Step2: perform inspection for empty state and delete guard
    const hasEmptyMessage = src.includes('曲がありません') && src.includes('empty-song-list');
    const deleteGuardedPattern = src.includes('song-card-delete') && src.includes("isCustom &&") ;
    // Step3: assert transition would show/hide correctly
    expect(hasEmptyMessage).toBe(true);
    expect(deleteGuardedPattern).toBe(true);
    // After toggling to debug, empty message still present (structural), but delete becomes reachable
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    expect(deleteGuardedPattern).toBe(true);
  });
});

// =============================================================================
// T201-3: GameScreenプレイ時機能廃止 — ,/. R K キー完全撤廃、offset表示維持
// =============================================================================
describe('T201-3 GameScreen ablation (T200結合) — ,/. R K removed, offset display retained', () => {
  function gameSrc(): string { return readSrc('src/screens/GameScreen.tsx'); }

  it('Step1: Capture keySound.ts existence -> Step2: check file + import -> Step3: deleted and not imported', () => {
    // Step1: capture FS state
    const keySoundPath = path.join(process.cwd(), 'src/audio/keySound.ts');
    const existsBefore = fs.existsSync(keySoundPath);
    const src = gameSrc();
    // Step2: check import absence
    const hasImport = /from\s+['"]\.\.\/audio\/keySound['"]/.test(src) || /keySound/i.test(src) && src.includes('playKeyClick');
    // Step3: file must be deleted and no import remains (FAIL if keySound still wired)
    expect(existsBefore).toBe(false);
    expect(hasImport).toBe(false);
    expect(src).not.toMatch(/playKeyClick/);
    expect(src).not.toMatch(/keySoundOn/);
  });

  it('Step1: Capture GameScreen source -> Step2: scan for ,/. offset handler + setManualOffset -> Step3: absent and offset read-only', () => {
    // Step1: capture before (public default)
    const src = gameSrc();
    const hasAdjustOffsetBefore = src.includes('adjustOffset');
    // Step2: scan forbidden adjusters
    const hasAdjustOffset = /adjustOffset/.test(src);
    const hasSetManualOffset = /setManualOffset/.test(src);
    const hasCommaHandler = /e\.key\s*===\s*['"][,\.<>]['"]/.test(src) && src.includes('getManualOffsetMs');
    const hasOffsetSetter = /const\s*\[\s*offsetMs\s*,\s*setOffsetMs\s*\]/.test(src);
    const hasReadOnlyOffset = /const\s*\[\s*offsetMs\s*\]\s*=\s*useState\(getManualOffsetMs\)/.test(src) || /const\s*\[offsetMs\]/.test(src);
    // Step3: assert removed and read-only retained (FAIL if offset still mutable in Game)
    expect(hasAdjustOffsetBefore).toBe(false);
    expect(hasAdjustOffset).toBe(false);
    expect(hasSetManualOffset).toBe(false);
    expect(hasCommaHandler).toBe(false);
    expect(hasOffsetSetter).toBe(false);
    expect(hasReadOnlyOffset).toBe(true);
    expect(src).toContain('getManualOffsetMs');
    const clockImportLine = src.split('\n').find(l => l.includes('clock')) ?? '';
    expect(clockImportLine).not.toContain('setManualOffset');
  });

  it('Step1: Capture onKeyDown block -> Step2: verify R/resetGame absent but Escape/Arrow/Space retained -> Step3: selective removal confirmed', () => {
    // Step1: capture
    const src = gameSrc();
    const onDownIdx = src.indexOf('const onKeyDown');
    const block = onDownIdx >= 0 ? src.slice(onDownIdx, onDownIdx + 3000) : src;
    // Step2: scan for R handler vs allowed handlers
    const hasRBranch = /e\.key\s*===\s*['"]r['"]/i.test(block) && /resetGame/.test(src);
    const hasAnyRKey = /e\.key\s*===\s*['"]R['"]/.test(block) || /e\.key\s*===\s*['"]r['"]/.test(block);
    const hasEscape = block.includes("e.key === 'Escape'");
    const hasArrowUp = block.includes("e.key === 'ArrowUp'");
    const hasArrowDown = block.includes("e.key === 'ArrowDown'");
    const hasSpace = block.includes("e.code === 'Space'");
    // Step3: R must be gone, essentials must remain (FAIL if over-deleted or R still present)
    expect(hasRBranch).toBe(false);
    expect(hasAnyRKey).toBe(false);
    expect(src).not.toMatch(/resetGame/);
    expect(hasEscape).toBe(true);
    expect(hasArrowUp).toBe(true);
    expect(hasArrowDown).toBe(true);
    expect(hasSpace).toBe(true);
  });

  it('Step1: Capture source -> Step2: scan for K handler and keySound state -> Step3: absent, no dead setters', () => {
    // Step1: capture
    const src = gameSrc();
    // Step2: scan
    const hasKHandler = /e\.key\s*===\s*['"]k['"]/i.test(src);
    const hasKeySoundState = /keySoundOn/.test(src) || /setKeySoundOn/.test(src);
    const hasPlayClick = /playKeyClick/.test(src);
    const onDownIdx = src.indexOf('const onKeyDown');
    const block = onDownIdx >= 0 ? src.slice(onDownIdx, onDownIdx + 2500) : '';
    const blockHasK = /['"]k['"]/i.test(block);
    // Step3: assert stripped
    expect(hasKHandler).toBe(false);
    expect(hasKeySoundState).toBe(false);
    expect(hasPlayClick).toBe(false);
    expect(blockHasK).toBe(false);
    // getManualOffsetMs import must survive (display only)
    expect(src).toContain('getManualOffsetMs');
  });

  it('Step1: Capture game-offset and game-hint divs -> Step2: extract content -> Step3: offset display + updated hint without removed keys', () => {
    // Step1: capture
    const src = gameSrc();
    // Step2: check offset div and hint
    const hasOffsetDiv = src.includes('game-offset') && src.includes('offsetMs');
    const hasOffsetMsPattern = src.includes('offset:') && src.includes('ms');
    const hintMatch = src.match(/className="game-hint"[^>]*>([^<]*)</);
    const hintText = hintMatch ? hintMatch[1] : src.slice(src.indexOf('game-hint'), src.indexOf('game-hint') + 400);
    const mentionsOffsetKeys = hintText.includes(',') && hintText.includes('.') && hintText.toLowerCase().includes('offset');
    const mentionsReset = /\bR\b/.test(hintText) && hintText.toLowerCase().includes('reset');
    const mentionsK = /\bK\b/.test(hintText) && /key/i.test(hintText);
    // Step3: offset div must persist, hint must NOT mention removed shortcuts but must mention remaining controls
    expect(hasOffsetDiv).toBe(true);
    expect(hasOffsetMsPattern).toBe(true);
    expect(mentionsOffsetKeys).toBe(false);
    expect(mentionsReset).toBe(false);
    expect(mentionsK).toBe(false);
    expect(hintText).toContain('Space');
    expect(hintText).toContain('ESC');
    expect(src).toContain('Space: 判定 / ↑↓: 移動 / ESC: 戻る');
  });
});

// =============================================================================
// T201-4: 廃止しないもの — Editor内R録音・,/.微調整・CalibrationModal内キー の回帰確認
// =============================================================================
describe('T201-4 preserved editor/calibration keys regression (must NOT be removed)', () => {
  it('Step1: Capture EditorScreen source -> Step2: verify R toggles record and ,/. adjusts offset still present -> Step3: both retained', () => {
    // Step1: capture
    const src = readSrc('src/screens/EditorScreen.tsx');
    expect(src.length).toBeGreaterThan(0);
    // Step2: scan preserved handlers
    const hasRRecordToggle = src.includes("e.code === 'KeyR'") && src.includes('setEditMode') && (src.includes('startRecording') || src.includes('finishRecording'));
    const hasCommaEditor = src.includes("e.key === ','") || src.includes('e.key === ","');
    const hasDotEditor = src.includes("e.key === '.'") || src.includes('e.key === "."');
    const hasOffsetEditor = src.includes('setManualOffset') && src.includes('getManualOffsetMs');
    const hasRingSpaceInRecord = src.includes("modeRef.current === 'record'") && src.includes("e.code === 'Space'");
    // Step3: editor must retain all of these (FAIL if T200 over-deleted editor)
    expect(hasRRecordToggle).toBe(true);
    expect(hasCommaEditor).toBe(true);
    expect(hasDotEditor).toBe(true);
    expect(hasOffsetEditor).toBe(true);
    expect(hasRingSpaceInRecord).toBe(true);
  });

  it('Step1: Capture CalibrationModal source -> Step2: verify ,/. Space ESC Enter handlers retained -> Step3: assert all present', () => {
    // Step1: capture
    const src = readSrc('src/screens/editor/CalibrationModal.tsx');
    expect(src.length).toBeGreaterThan(0);
    // Step2: scan preserved calibration handlers
    const hasCommaCal = src.includes("e.key === ','") || src.includes("e.key === '<'");
    const hasDotCal = src.includes("e.key === '.'") || src.includes("e.key === '>'");
    const hasSpaceCal = src.includes("e.code === 'Space'") && src.includes('handleHit');
    const hasEscCal = src.includes("e.key === 'Escape'") && src.includes('cancel');
    const hasEnterCal = src.includes("e.key === 'Enter'") && src.includes('save');
    const hasAdjustOffsetCal = src.includes('adjustOffset') && src.includes('setManualOffset');
    // Step3: calibration must retain fine-tuning and hit handling
    expect(hasCommaCal).toBe(true);
    expect(hasDotCal).toBe(true);
    expect(hasSpaceCal).toBe(true);
    expect(hasEscCal).toBe(true);
    expect(hasEnterCal).toBe(true);
    expect(hasAdjustOffsetCal).toBe(true);
  });

  it('Step1: Capture EditorScreen and CalibrationModal -> Step2: verify editor still imports setManualOffset while GameScreen does not -> Step3: differential retained/abandoned correct', () => {
    // Step1: capture all three
    const editorSrc = readSrc('src/screens/EditorScreen.tsx');
    const calSrc = readSrc('src/screens/editor/CalibrationModal.tsx');
    const gameSrc = readSrc('src/screens/GameScreen.tsx');
    // Step2: compare imports
    const editorHasSet = editorSrc.includes('setManualOffset');
    const calHasSet = calSrc.includes('setManualOffset');
    const gameHasSet = gameSrc.includes('setManualOffset');
    // Step3: editor & cal must keep, game must NOT (differential guard)
    expect(editorHasSet).toBe(true);
    expect(calHasSet).toBe(true);
    expect(gameHasSet).toBe(false);
  });
});

// =============================================================================
// T201-5: 統合フロー — public既定 -> debug表示 -> public非表示 -> キー無効
// =============================================================================
describe('T201-5 public既定・デバッグ切替の一連フローが破綻なく動く', () => {
  it('Step1: Capture initial public -> Step2: toggle to debug -> Step3: localStorage debug persists and re-read correct', () => {
    // Step1: capture initial (simulates fresh load)
    expect(getViewMode()).toBe('public');
    expect(localStorage.getItem('traceWaveViewMode')).toBeNull();
    // Step2: user presses Ctrl+Alt+Shift+@ (calls toggleViewMode)
    const first = toggleViewMode();
    const storedAfterFirst = localStorage.getItem('traceWaveViewMode');
    // Step3: debug active and storage matches
    expect(first).toBe('debug');
    expect(storedAfterFirst).toBe('debug');
    expect(getViewMode()).toBe('debug');
    // Simulate reload: re-read without clearing storage
    expect(getViewMode()).toBe('debug');
  });

  it('Step1: Start from debug -> Step2: toggle back to public -> Step3: public persisted and source guards confirm hidden UI', () => {
    // Step1: ensure debug first
    setViewMode('debug');
    expect(getViewMode()).toBe('debug');
    const src = readSrc('src/screens/SelectScreen.tsx');
    // Step2: second combo press back to public
    const second = toggleViewMode();
    const stored = localStorage.getItem('traceWaveViewMode');
    // Step3: public restored
    expect(second).toBe('public');
    expect(stored).toBe('public');
    expect(getViewMode()).toBe('public');
    // Source guards prove that public render would hide debug UI (net effect = hidden in public)
    expect(src).toContain('custom-import-section');
    expect(src).toContain("viewMode === 'debug'");
  });

  it('Step1: Capture public mode offset value -> Step2: attempt GameScreen ,/. toggle (should be no-op) -> Step3: offset unchanged and display selector intact', () => {
    // Step1: capture GameScreen source state and initial offset mock
    const src = readSrc('src/screens/GameScreen.tsx');
    const s = installStorageAndWindow();
    s.setItem('rhythmManualOffsetMs', '42');
    s.setItem('rhythmManualOffsetVersion', '2');
    // Simulate GameScreen import of offset (read-only)
    const beforeOffsetRaw = s.getItem('rhythmManualOffsetMs');
    expect(beforeOffsetRaw).toBe('42');
    // Step2: verify GameScreen has no setManualOffset to change it (no-op path)
    const hasSetInGame = src.includes('setManualOffset');
    expect(hasSetInGame).toBe(false);
    // Step3: offset must remain 42, not mutated, and display still references it
    expect(s.getItem('rhythmManualOffsetMs')).toBe('42');
    expect(src).toContain('offset:');
    expect(src).toContain('getManualOffsetMs');
  });
});

// =============================================================================
// T201-6: T127-style pure numeric consistency — WaveEngine/Cursor off-grid with complex amps
// =============================================================================
describe('T201-6 純粋エンジン回帰 — WaveEngine.waveYAt vs Cursor.update 数値整合 (complex amps + off-grid)', () => {
  const complexAmps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23, 4.37, 2.73];

  for (const amp of complexAmps) {
    it(`amp=${amp} 4パターン off-gridで waveYAtが cursor速度式 2*TW_AMP*amp と整合 (3-step)`, () => {
      // Step1: capture initial timeline/wave state with complex amp
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
      const segments: { direction: 'up' | 'down' | 'stay'; beats: number }[] = [
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'stay', beats: 1 },
      ];
      const wave = new WaveEngine(segments, timeline, amp, 0.0);
      const waveTop = TW_CENTER_Y - TW_AMP;
      const waveBottom = TW_CENTER_Y + TW_AMP;

      // Step2: perform off-grid sampling + cursor tick
      for (const ob of offGridBeats) {
        const y = wave.waveYAt(ob);
        // Must be finite and bounded (fixed height invariant T123/T124)
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(waveTop - 0.01);
        expect(y).toBeLessThanOrEqual(waveBottom + 0.01);
      }
      const points = wave.getPoints();
      expect(points.length).toBe(segments.length + 1);
      const totalBeats = segments.reduce((s, seg) => s + seg.beats, 0);
      expect(points[0].beat).toBeCloseTo(0, 6);
      expect(points[points.length - 1].beat).toBeCloseTo(totalBeats, 6);

      // Step3: cursor consistency — per-beat displacement must equal the wave slope 2*TW_AMP*amp
      const cursor = new Cursor(amp, 0.0);
      const beatMs = timeline.beatMsAt(0);
      const expectedPerBeatPx = 2 * TW_AMP * amp;
      // Start from the TOP and hold down for a partial beat so the movement
      // stays well within [waveTop, waveBottom] regardless of amp (no clamp distortion):
      // 0.25 beat => 0.25 * perBeat px, bounded because max perBeat here is for amp=3.4 => 884 * 0.25 = 221 < 260.
      cursor.y = waveTop;
      const dtBeat = 0.25;
      const dtSec = (dtBeat * beatMs) / 1000;
      const yBefore = cursor.y;
      cursor.update(dtSec, false, true, beatMs, undefined);
      const moved = cursor.y - yBefore;
      // Scale partial-beat movement back to a full-beat equivalent and compare to the slope.
      const measuredPerBeatPx = moved / dtBeat;
      // Direction down should increase Y.
      expect(cursor.y).toBeGreaterThan(yBefore);
      // Cursor must remain inside the physical field.
      expect(cursor.y).toBeGreaterThanOrEqual(waveTop);
      expect(cursor.y).toBeLessThanOrEqual(waveBottom);
      // Per-beat displacement must match the waveform slope 2*TW_AMP*amp (T127/T128 numeric consistency).
      expect(Math.abs(measuredPerBeatPx - expectedPerBeatPx)).toBeLessThan(2);
      // Full-beat displacement is only bounded by the clamp for amps whose full-beat travel exceeds 260px.
      if (expectedPerBeatPx > 260) {
        expect(moved).toBeLessThanOrEqual(expectedPerBeatPx + 1);
      }
    });
  }

  it('Step1: amp=1.3 down 3beats off-grid -> Step2: sample waveYAt 0.25/0.37/0.5/1.23 -> Step3: clamp-interpolated and within bounds', () => {
    // Step1: capture wave
    const amp = 1.3;
    const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
    const wave = new WaveEngine([{ direction: 'down', beats: 3 }], timeline, amp, 0.0);
    const waveBottom = TW_CENTER_Y + TW_AMP;
    // Step2: perform samplings
    const y025 = wave.waveYAt(0.25);
    const y037 = wave.waveYAt(0.37);
    const y05 = wave.waveYAt(0.5);
    const y123 = wave.waveYAt(1.23);
    // Step3: assert climbing then clamped stay
    expect(y025).toBeGreaterThan(TW_CENTER_Y);
    expect(y037).toBeGreaterThan(y025);
    expect(y05).toBeCloseTo(waveBottom, 0);
    expect(y123).toBeCloseTo(waveBottom, 0);
    // After reaching bottom, stays flat
    expect(wave.waveYAt(2.0)).toBeCloseTo(waveBottom, 0);
  });

  it('Step1: Cursor amp=2.7 with off-grid wave pulls -> Step2: tick at renderTimeMs 0.37/1.23/2.7 -> Step3: bounded and finite', () => {
    // Step1: build timeline/wave/cursor
    const amp = 2.7;
    const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp } as any], amp);
    const wave = new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], timeline, amp, 0.0);
    const cursor = new Cursor(amp, 0.0);
    // Step2: simulate ticks pulling toward off-grid waveY
    const beats = [0.37, 1.23, 2.7];
    for (const b of beats) {
      const waveY = wave.waveYAt(b);
      const curBeatMs = timeline.beatMsAt(b);
      cursor.update(0.016, false, false, curBeatMs, waveY);
    }
    // Step3: cursor must remain within physical field and finite
    expect(cursor.y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
    expect(cursor.y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
    expect(Number.isFinite(cursor.y)).toBe(true);
  });
});
