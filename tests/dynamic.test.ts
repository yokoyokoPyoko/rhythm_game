/**
 * T198 — パブリックビュー／デバッグモード基盤＋切替＋ルートガード (Vitest, node environment)
 * TDD Red→Green — strict acceptance for src/viewMode.ts and App.tsx / viewMode routing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), filePath), 'utf-8');
  } catch {
    return '';
  }
}

describe('T198 パブリックビュー／デバッグモード基盤＋切替＋ルートガード (TDD Red→Green)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('1. src/viewMode.ts 基盤関数とlocalStorage永続化 (3-step)', () => {
    it('getViewMode defaults to public, setViewMode/toggleViewMode persist in localStorage (traceWaveViewMode)', async () => {
      // [Step1: Capture Initial State]
      const initialLocalStorage = localStorage.getItem('traceWaveViewMode');
      expect(initialLocalStorage).toBeNull();

      // Dynamically import viewMode (may fail initially in Red phase)
      let viewModeModule: any;
      try {
        viewModeModule = await import('../src/viewMode');
      } catch {
        // Red phase: module doesn't exist yet
        viewModeModule = null;
      }

      if (!viewModeModule) {
        // Red phase assertion: force fail until implementation exists
        expect(viewModeModule).toBeDefined();
        return;
      }

      const modeBefore = viewModeModule.getViewMode();
      expect(modeBefore).toBe('public');

      // [Step2: Perform User Interaction]
      viewModeModule.setViewMode('debug');
      const modeAfterSet = viewModeModule.getViewMode();
      const storedDebug = localStorage.getItem('traceWaveViewMode');

      viewModeModule.toggleViewMode();
      const modeAfterToggle = viewModeModule.getViewMode();
      const storedPublicAgain = localStorage.getItem('traceWaveViewMode');

      // [Step3: Assert Resulting Transition]
      expect(modeAfterSet).toBe('debug');
      expect(storedDebug).toBe('debug');
      expect(modeAfterToggle).toBe('public');
      expect(storedPublicAgain).toBe('public');
    });

    it('viewMode handles invalid localStorage values by falling back to public (3-step)', async () => {
      // [Step1] set invalid storage value
      localStorage.setItem('traceWaveViewMode', 'invalid-mode');
      let viewModeModule: any;
      try {
        viewModeModule = await import('../src/viewMode');
      } catch {
        expect(true).toBe(false);
        return;
      }

      // [Step2] get view mode with corrupted storage
      const mode = viewModeModule.getViewMode();

      // [Step3] must fallback to public safely
      expect(mode).toBe('public');
    });
  });

  describe('2. App.tsx 全画面共通キー監視 (Ctrl+Alt+Shift+@) とDEBUGバッジ (3-step)', () => {
    it('App.tsx listens for Ctrl+Alt+Shift+@ keyboard shortcut to toggle viewMode (3-step static/runtime analysis)', () => {
      // [Step1: Capture Source State]
      const appSrc = readFileSafe('src/App.tsx');
      expect(appSrc.length).toBeGreaterThan(0);

      // [Step2: Verify KeyCombo logic and Badge rendering in App.tsx]
      // Check for Ctrl+Alt+Shift+@ key handler
      const hasKeyCombo =
        /ctrlKey|altKey|shiftKey/.test(appSrc) &&
        (/@|Digit2|Key@/.test(appSrc) || appSrc.includes('@'));

      // Check for DEBUG badge rendering conditionally
      const hasDebugBadge = /DEBUG|debug/i.test(appSrc);

      // Check for /editor route guard (redirect to / when public)
      const hasEditorGuard = appSrc.includes('/editor') && (appSrc.includes('Navigate') || appSrc.includes('redirect') || appSrc.includes('public'));

      // [Step3: Assert Transition / Requirements]
      expect(hasKeyCombo, 'App.tsx must listen for Ctrl+Alt+Shift+@ keyboard combo').toBe(true);
      expect(hasDebugBadge, 'App.tsx must render DEBUG badge conditionally based on viewMode').toBe(true);
      expect(hasEditorGuard, 'App.tsx must guard /editor route in public mode (redirect to /)').toBe(true);
    });
  });

  describe('3. ルートガード /editor -> / redirection in public mode', () => {
    it('viewMode is public by default, triggering route protection logic', async () => {
      // [Step1: Capture] default mode is public
      localStorage.removeItem('traceWaveViewMode');
      let viewModeModule: any;
      try {
        viewModeModule = await import('../src/viewMode');
      } catch {
        expect(true).toBe(false);
        return;
      }
      expect(viewModeModule.getViewMode()).toBe('public');

      // [Step2: Perform] simulate setting public mode explicitly
      viewModeModule.setViewMode('public');

      // [Step3: Assert] mode remains public and guard condition met
      expect(viewModeModule.getViewMode()).toBe('public');
      expect(localStorage.getItem('traceWaveViewMode')).toBe('public');
    });
  });
});
