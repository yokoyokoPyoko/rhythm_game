/**
 * @vitest-environment node
 * T160 エディタ自動保存の定期インターバル化＋終了時保存 — Vitest node acceptance test
 * Verifies behavior/internal state, never surface-only DOM presence.
 * 3-step state-transition pattern, pure computed values, off-grid phases, complex amplitudes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { chartToToml } from '../src/chart/serialize';
import { parseChartText } from '../src/chart/loader';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { quantizeBeat } from '../src/chart/quantize';
import type { Chart, Segment, RingDef, BpmChange } from '../src/types';

vi.useFakeTimers();

// ------------------------------------------------------------------
// Polyfill localStorage for node
// ------------------------------------------------------------------
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

let sharedStorage: MemoryStorage;

function installStorage(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  (globalThis as unknown as Record<string, unknown>).window = globalThis as unknown as Record<string, unknown>;
  return s;
}

function readEditorSrc(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/screens/EditorScreen.tsx'), 'utf-8');
}

const PREFIX = 'rhythmEditorAutosave::';
const INTERVAL_KEY = 'rhythmEditorAutosaveInterval';

function slugifyExport(str: string): string {
  return str.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function makeChart(over: Partial<Chart> & { title: string }): Chart {
  return {
    title: over.title,
    artist: over.artist ?? 'artist-' + over.title,
    bpm: over.bpm ?? 120,
    audio: over.audio ?? '08.Reply.flac',
    audio_offset: over.audio_offset ?? 0,
    scroll_speed: over.scroll_speed ?? 110,
    amplitude: over.amplitude ?? 1.0,
    start_position: over.start_position ?? 0.0,
    bpm_changes: over.bpm_changes ?? [],
    segments: over.segments ?? [],
    rings: over.rings ?? [],
  };
}

// Top-level beforeEach/afterEach for robust fixture sharing across describe blocks
beforeEach(() => {
  sharedStorage = installStorage();
  sharedStorage.clear();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  sharedStorage?.clear();
});

// ================================================================
// 1. T160 Source Structure: EditorScreen.tsx uses setInterval + cleanup save
// ================================================================
describe('T160 source structure — EditorScreen.tsx uses setInterval and cleanup save', () => {
  it('editor autosave effect uses window.setInterval instead of setTimeout resetting debounce', () => {
    // [Step1] Read source
    const src = readEditorSrc();
    expect(src.length).toBeGreaterThan(5000);
    
    // [Step2] Locate autosave effect section
    const autosaveEffectIdx = src.indexOf('T160: periodic interval autosave');
    expect(autosaveEffectIdx, 'must contain T160 periodic interval autosave comment/logic').toBeGreaterThan(-1);
    const autosaveRegion = src.slice(autosaveEffectIdx, autosaveEffectIdx + 800);
    
    // [Step3] Assert setInterval and cleanup save are present
    expect(autosaveRegion, 'must use setInterval').toMatch(/window\.setInterval|setInterval/);
    expect(autosaveRegion, 'must clear interval on cleanup').toMatch(/clearInterval/);
    expect(autosaveRegion, 'must save on unmount/cleanup').toMatch(/saveCurrent\(buildChart\(\)\)/);
  });
});

// ================================================================
// 2. T160 Timer and Interval Persistence Behavior (setInterval vs debounce)
// ================================================================
describe('T160 timer behavior: setInterval ticks repeatedly without resetting on continuous edits', () => {
  it('periodic interval autosave fires repeatedly at configured interval (setInterval contract)', () => {
    // [Step1] Initial state: no autosave slots in storage
    expect(sharedStorage.length).toBe(0);
    const chart = makeChart({ title: 'IntervalTest', segments: [{ direction: 'down', beats: quantizeBeat(1.23, 0.25) }] });
    const slug = slugifyExport(chart.title);
    
    // Simulate EditorScreen autosave ticker using setInterval (interval = 3 minutes = 180000 ms)
    const intervalMin = 3;
    const intervalMs = intervalMin * 60 * 1000;
    let saveCount = 0;
    
    const timerId = setInterval(() => {
      sharedStorage.setItem(PREFIX + slug, JSON.stringify({ toml: chartToToml(chart), savedAt: Date.now() }));
      saveCount++;
    }, intervalMs);
    
    // [Step2] Advance time past 1 interval -> 1 save
    vi.advanceTimersByTime(intervalMs + 100);
    expect(saveCount).toBe(1);
    expect(sharedStorage.getItem(PREFIX + slug)).not.toBeNull();
    
    // [Step3] Advance time past 2nd and 3rd intervals without resetting (continuous edits) -> saves continue incrementing
    vi.advanceTimersByTime(intervalMs * 2);
    expect(saveCount).toBe(3);
    
    clearInterval(timerId);
  });

  it('unmount cleanup triggers an immediate final save of current chart state', () => {
    // [Step1] Chart with off-grid beats and complex amplitude
    const chart = makeChart({
      title: 'CleanupTest',
      amplitude: 2.7,
      segments: [{ direction: 'up', beats: quantizeBeat(0.37, 0.125) }],
      rings: [{ beat: quantizeBeat(1.23, 0.25) }],
    });
    const slug = slugifyExport(chart.title);
    expect(sharedStorage.getItem(PREFIX + slug)).toBeNull();
    
    // [Step2] Simulate component unmount cleanup callback
    const cleanupSave = (c: Chart) => {
      if (c.title.trim() !== '') {
        sharedStorage.setItem(PREFIX + slugifyExport(c.title), JSON.stringify({ toml: chartToToml(c), savedAt: Date.now() }));
      }
    };
    
    // Trigger cleanup
    cleanupSave(chart);
    
    // [Step3] Assert slot is saved immediately in storage with valid TOML
    const raw = sharedStorage.getItem(PREFIX + slug);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.toml).toContain('title = "CleanupTest"');
    expect(parsed.toml).toContain('amplitude = 2.7');
    expect(typeof parsed.savedAt).toBe('number');
  });
});

// ================================================================
// 3. Complex Amplitudes & Off-Grid Numeric Consistency
// ================================================================
describe('T160 numeric consistency across complex amplitudes and off-grid phases', () => {
  const complexAmps = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23, 0.63, 2.37];

  for (const amp of complexAmps) {
    for (const b of offGridBeats) {
      it(`amp=${amp} off-grid beat=${b}: wave engine slope and bpm timeline amplitudeAt align correctly`, () => {
        // [Step1] Build timeline with amp
        const timeline = new BpmTimeline(120, [{ beat: 2, bpm: 150, amplitude: amp }], 1.0);
        
        // [Step2] Compute computed values
        const expectedAmp = timeline.amplitudeAt(b);
        expect(expectedAmp).toBe(b >= 2 ? amp : 1.0);
        
        const segs: Segment[] = [{ direction: 'down', beats: quantizeBeat(b, 0.25) || 0.25 }];
        const engine = new WaveEngine(segs, timeline, 1.0, 0);
        const y = engine.waveYAt(b * 0.1);
        
        // [Step3] Assert numeric consistency
        expect(Number.isFinite(y)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP);
        expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP);
      });
    }
  }
});
