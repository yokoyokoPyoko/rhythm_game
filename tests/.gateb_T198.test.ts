/**
 * @vitest-environment node
 * T198 パブリックビュー／デバッグモード基盤＋切替＋ルートガード — Vitest acceptance test
 * Verifies behavior/internal state, 3-step state-transition pattern, storage persistence, keyboard shortcut, and route guard logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getViewMode, setViewMode, toggleViewMode, ViewMode } from '../src/viewMode';

vi.useFakeTimers();

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  get length(): number { return this.m.size; }
  keys(): string[] { return [...this.m.keys()]; }
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
        if (typeof l === 'function') {
          l(event);
        } else if (l && typeof l.handleEvent === 'function') {
          l.handleEvent(event);
        }
      }
    }
    return true;
  }
}

function installStorageAndWindow(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  const mockWin = new MockEventTarget();
  (globalThis as unknown as Record<string, unknown>).window = mockWin;
  return s;
}

beforeEach(() => {
  installStorageAndWindow();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('T198 パブリックビュー／デバッグモード基盤＋切替＋ルートガード', () => {
  describe('1. src/viewMode.ts storage and toggle behavior (3-Step State-Transition)', () => {
    it('Step1: Initial state defaults to public when storage is empty', () => {
      // Step 1
      const initialMode = getViewMode();
      expect(initialMode).toBe('public');
      expect(localStorage.getItem('traceWaveViewMode')).toBeNull();

      // Step 2: Set mode to debug
      setViewMode('debug');

      // Step 3: Assert transition
      expect(getViewMode()).toBe('debug');
      expect(localStorage.getItem('traceWaveViewMode')).toBe('debug');
    });

    it('Step1: Toggle from public to debug and back, persisting in localStorage', () => {
      // Step 1: Initial public
      expect(getViewMode()).toBe('public');

      // Step 2: Toggle 1 (public -> debug)
      const afterFirstToggle = toggleViewMode();
      expect(afterFirstToggle).toBe('debug');
      expect(getViewMode()).toBe('debug');
      expect(localStorage.getItem('traceWaveViewMode')).toBe('debug');

      // Step 2b: Toggle 2 (debug -> public)
      const afterSecondToggle = toggleViewMode();
      expect(afterSecondToggle).toBe('public');
      expect(getViewMode()).toBe('public');
      expect(localStorage.getItem('traceWaveViewMode')).toBe('public');
    });

    it('Step1: Reload persistence (simulated via new storage instance / reading key)', () => {
      // Step 1: Set debug mode
      setViewMode('debug');
      const stored = localStorage.getItem('traceWaveViewMode');
      expect(stored).toBe('debug');

      // Step 2: Simulate page reload by creating a fresh getViewMode check with existing storage value
      const reloadedMode = getViewMode();
      // Step 3: Assert mode remains debug
      expect(reloadedMode).toBe('debug');
    });
  });

  describe('2. App.tsx keyboard shortcut and route guard structure (Static & Behavioral Analysis)', () => {
    it('Step1: App.tsx source contains Ctrl+Alt+Shift+@ keydown shortcut handling', () => {
      const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
      
      // Step 2 & 3: Assert App.tsx handles ctrlKey, altKey, shiftKey, and key === '@'
      expect(appSrc).toContain('ctrlKey');
      expect(appSrc).toContain('altKey');
      expect(appSrc).toContain('shiftKey');
      expect(appSrc).toContain("@");
      expect(appSrc).toContain('toggleViewMode');
    });

    it('Step1: App.tsx source contains debug badge with data-testid="debug-badge"', () => {
      const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
      
      // Step 3: Assert debug badge testid exists and condition checks debug mode
      expect(appSrc).toContain('data-testid="debug-badge"');
      expect(appSrc).toContain("mode === 'debug'");
    });

    it('Step1: App.tsx source contains route guard for /editor redirecting to / when not in debug mode', () => {
      const appSrc = fs.readFileSync(path.join(process.cwd(), 'src/App.tsx'), 'utf-8');
      
      // Step 3: Assert /editor route uses Navigate to="/" or similar guard
      expect(appSrc).toContain('path="/editor"');
      expect(appSrc).toContain('Navigate to="/"');
    });
  });
});
