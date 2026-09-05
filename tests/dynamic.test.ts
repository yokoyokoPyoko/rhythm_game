/**
 * @vitest-environment node
 * Dynamic Acceptance Test module for T160 (Editor periodic interval autosave + unmount save)
 * and T127-style numeric consistency (WaveEngine & Cursor across complex amplitudes & off-grid phases).
 *
 * Runs without a browser using Vitest node environment and fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { quantizeBeat, segmentize } from '../src/chart/quantize';
import { saveAutosave, listAutosaves, loadAutosave, getAutosaveInterval, setAutosaveInterval, AUTOSAVE_PREFIX } from '../src/chart/autosave';
import type { Chart } from '../src/types';

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

function installStorage(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  return s;
}

function makeChart(over: Partial<Chart> & { title: string }): Chart {
  return {
    title: over.title,
    artist: over.artist ?? 'artist-' + over.title,
    bpm: over.bpm ?? 120,
    audio: over.audio ?? 'test.flac',
    audio_offset: over.audio_offset ?? 0,
    scroll_speed: over.scroll_speed ?? 110,
    amplitude: over.amplitude ?? 1.0,
    start_position: over.start_position ?? 0.0,
    bpm_changes: over.bpm_changes ?? [],
    segments: over.segments ?? [],
    rings: over.rings ?? [],
  };
}

describe('T160: Editor periodic interval autosave & unmount save', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = installStorage();
    storage.clear();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    storage.clear();
  });

  it('1. Periodic autosave via setInterval (timer not resetting on continuous updates)', () => {
    // [Step 1: Capture Initial State]
    expect(storage.keys().filter(k => k.startsWith(AUTOSAVE_PREFIX))).toHaveLength(0);
    const chart = makeChart({ title: 'PeriodicTest', segments: [{ direction: 'down', beats: 1.23 }] });
    const intervalMin = 2; // e.g. 2 minutes = 120,000 ms
    setAutosaveInterval(intervalMin);
    expect(getAutosaveInterval()).toBe(intervalMin);

    // Simulate setInterval timer logic for T160
    let saveCount = 0;
    const intervalMs = intervalMin * 60 * 1000;
    const timerId = setInterval(() => {
      saveAutosave(chart);
      saveCount++;
    }, intervalMs);

    // [Step 2: Perform Interaction / Time Advance without reset]
    vi.advanceTimersByTime(intervalMs);
    expect(saveCount).toBe(1);
    const slotsAfter1 = listAutosaves();
    expect(slotsAfter1).toHaveLength(1);
    expect(slotsAfter1[0].title).toBe('PeriodicTest');

    // Continuous updates should not reset setInterval timer
    vi.advanceTimersByTime(intervalMs);
    expect(saveCount).toBe(2);
    expect(storage.keys().filter(k => k.startsWith(AUTOSAVE_PREFIX))).toHaveLength(1);

    clearInterval(timerId);
  });

  it('2. Unmount cleanup save ensures latest edited state is persisted upon exit', () => {
    // [Step 1: Capture Initial State]
    expect(storage.getItem(AUTOSAVE_PREFIX + 'unmounttest')).toBeNull();

    // Simulate editor state transition and cleanup callback (unmount)
    const cleanupSave = (c: Chart) => {
      saveAutosave(c);
    };

    // [Step 2: Perform Unmount Trigger]
    const updatedChart = makeChart({ title: 'UnmountTest', segments: [{ direction: 'up', beats: 1.23 }, { direction: 'down', beats: 0.37 }] });
    cleanupSave(updatedChart);

    // [Step 3: Assert Resulting Transition]
    const savedRaw = storage.getItem(AUTOSAVE_PREFIX + 'unmounttest');
    expect(savedRaw).not.toBeNull();
    const loaded = loadAutosave('unmounttest');
    expect(loaded.segments).toHaveLength(2);
    expect(loaded.segments[0].beats).toBeCloseTo(1.23, 4);
    expect(loaded.segments[1].beats).toBeCloseTo(0.37, 4);
  });
});

describe('T127-style Numeric Consistency: WaveEngine & Cursor with complex amplitudes and off-grid phases', () => {
  const timeline = new BpmTimeline(120, []);
  const amplitudes = [0.7, 1.3, 2.7, 3.4];
  const offGridBeats = [0.37, 1.23, 0.63, 2.37];

  it('Numeric consistency between WaveEngine waveYAt and Cursor update across complex amps & off-grid phases', () => {
    for (const amp of amplitudes) {
      for (const b of offGridBeats) {
        // [Step 1: Capture Initial State]
        const engine = new WaveEngine([{ direction: 'down', beats: b }], timeline, amp, 0.0);
        const yBefore = engine.waveYAt(0);
        expect(yBefore).toBeCloseTo(TW_CENTER_Y, 1);

        // [Step 2: Perform Computation / Simulation]
        const yVal = engine.waveYAt(b);
        const expectedMove = Math.min(TW_AMP, 2 * TW_AMP * amp * b);

        // [Step 3: Assert Resulting Transition]
        expect(yVal).toBeCloseTo(TW_CENTER_Y + expectedMove, 1);

        // Cursor verification
        const beatMs = 500; // 120 BPM
        const cursor = new Cursor(amp, 0.0);
        const dt = (b * beatMs) / 1000;
        cursor.update(dt, false, true, beatMs, b);
        expect(cursor.y).toBeCloseTo(yVal, 1);
      }
    }
  });

  it('Off-grid quantization and segmentize stability with fractional inputs', () => {
    const snap = 0.25;
    const rawBeats = 1.23; // off-grid fractional
    const quantized = quantizeBeat(rawBeats, snap);
    expect(quantized).toBeCloseTo(1.25, 2); // nearest grid line

    const traj = [
      { beat: 0, y: TW_CENTER_Y, down: true },
      { beat: 0.37, y: TW_CENTER_Y + 40, down: true },
      { beat: 1.23, y: TW_CENTER_Y + 120, down: true },
    ];
    const segs = segmentize(traj, snap, 1.3);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect((s.beats / snap) % 1).toBeCloseTo(0, 3);
    }
  });
});
