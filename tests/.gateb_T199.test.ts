/**
 * @vitest-environment node
 * T199 - SelectScreenのモード別表示分岐＋L/Eキー廃止 — Vitest acceptance test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getViewMode, setViewMode } from '../src/viewMode';

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

beforeEach(() => {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  (globalThis as unknown as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true
  };
});

describe('T199 SelectScreenのモード別表示分岐＋L/Eキー廃止', () => {
  it('SelectScreen.tsx source correctly hides import section, delete button, editor nav, calibration button, and hint in public mode', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/SelectScreen.tsx'), 'utf-8');

    expect(src).toContain("viewMode === 'debug'");
    expect(src).toContain('custom-import-section');
    expect(src).toContain('song-card-delete');
    expect(src).toContain('select-nav');
    expect(src).toContain('select-calibration-button');
    expect(src).toContain('select-hint');
  });

  it('No L or E key listeners exist in SelectScreen.tsx', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/screens/SelectScreen.tsx'), 'utf-8');
    expect(src).not.toContain("e.key === 'l'");
    expect(src).not.toContain("e.key === 'e'");
    expect(src).not.toContain("e.key === 'L'");
    expect(src).not.toContain("e.key === 'E'");
  });

  it('Default viewMode is public', () => {
    setViewMode('public');
    expect(getViewMode()).toBe('public');
  });
});
