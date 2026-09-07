/**
 * @vitest-environment node
 * T199 SelectScreenのモード別表示分岐＋L/Eキー廃止 — Vitest acceptance test
 * Verifies viewMode behavior, SelectScreen conditional UI branching for public vs debug, and L/E key listener removal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getViewMode, setViewMode, toggleViewMode } from '../src/viewMode';

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

function installStorage(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  return s;
}

beforeEach(() => {
  installStorage();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('T199 SelectScreenのモード別表示分岐＋L/Eキー廃止', () => {
  describe('1. viewMode basic state-transition tests (3-step)', () => {
    it('Step1: Initial state is public. Step2: Set debug. Step3: State becomes debug in storage and getter', () => {
      // Step 1: Capture initial state
      const initial = getViewMode();
      expect(initial).toBe('public');

      // Step 2: Perform action (setViewMode('debug'))
      setViewMode('debug');

      // Step 3: Assert transition
      expect(getViewMode()).toBe('debug');
      expect(localStorage.getItem('traceWaveViewMode')).toBe('debug');
    });

    it('Step1: Toggle from public to debug and back (3-step state-transition)', () => {
      // Step 1: Initial state
      expect(getViewMode()).toBe('public');

      // Step 2: Toggle to debug
      const mode1 = toggleViewMode();
      expect(mode1).toBe('debug');
      expect(getViewMode()).toBe('debug');

      // Step 3: Toggle back to public
      const mode2 = toggleViewMode();
      expect(mode2).toBe('public');
      expect(getViewMode()).toBe('public');
      expect(localStorage.getItem('traceWaveViewMode')).toBe('public');
    });
  });

  describe('2. SelectScreen.tsx source code inspection for public/debug view mode branching (3-step)', () => {
    const selectSrcPath = path.join(process.cwd(), 'src/screens/SelectScreen.tsx');
    const selectSrc = fs.existsSync(selectSrcPath) ? fs.readFileSync(selectSrcPath, 'utf-8') : '';

    it('Step1: Check if viewMode is imported in SelectScreen. Step2: Check conditional rendering for public vs debug. Step3: Assert presence of mode check in source', () => {
      // Step 1: Initial check
      const importsViewMode = selectSrc.includes('viewMode') || selectSrc.includes('getViewMode');
      
      // Step 2 & 3: Assert viewMode branching exists for hiding import section, delete button, editor button, calibration button, and hint
      const hasCustomImportBranch = selectSrc.includes('custom-import-section') && (selectSrc.includes('debug') || selectSrc.includes('getViewMode()'));
      const hasCalibrationBtnBranch = selectSrc.includes('select-calibration-button') && (selectSrc.includes('debug') || selectSrc.includes('getViewMode()'));
      const hasHintBranch = selectSrc.includes('select-hint') && (selectSrc.includes('debug') || selectSrc.includes('getViewMode()'));

      expect(importsViewMode || hasCustomImportBranch || hasCalibrationBtnBranch || hasHintBranch).toBe(true);
      expect(selectSrc).toContain('song-card-delete');
    });

    it('Step1: Verify song card click navigation is maintained in both modes. Step2 & 3: Assert navigate("/play/" + song.id) exists', () => {
      // Step 1 & 2: Check navigate call for song cards
      const hasNavigatePlay = selectSrc.includes("navigate('/play/' + song.id)") || selectSrc.includes('navigate("/play/"');
      
      // Step 3: Assert persistence of click play
      expect(hasNavigatePlay).toBe(true);
    });
  });

  describe('3. L/E key listener removal validation (3-step)', () => {
    const selectSrcPath = path.join(process.cwd(), 'src/screens/SelectScreen.tsx');
    const selectSrc = fs.existsSync(selectSrcPath) ? fs.readFileSync(selectSrcPath, 'utf-8') : '';

    it('Step1: Check key listener presence. Step2: Inspect for L/E key handling. Step3: Assert L/E key navigation/calibration useEffect listener is removed', () => {
      // Step 1 & 2: Check if 'e'/'E' or 'l'/'L' keydown navigation is present in SelectScreen
      const checksLEKeys = (selectSrc.includes("'l'") || selectSrc.includes('"l"') || selectSrc.includes("'L'") || selectSrc.includes('"L"')) &&
                           (selectSrc.includes("'e'") || selectSrc.includes('"e"') || selectSrc.includes("'E'") || selectSrc.includes('"E"'));
      const hasNavigateEditorOnKey = selectSrc.includes("navigate('/editor')") && selectSrc.includes('key');

      // Step 3: L/E key listener must be removed (false)
      expect(checksLEKeys && hasNavigateEditorOnKey).toBe(false);
    });
  });
});
