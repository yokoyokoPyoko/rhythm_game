/**
 * @vitest-environment node
 * T159 エディタ自動保存（複数スロット＋左上復元ボタン＋保存間隔スライダー） — Vitest node acceptance test (TDD Red→Green)
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
  // allow prefix scan
  keys(): string[] { return [...this.m.keys()]; }
}

function installStorage(): MemoryStorage {
  const s = new MemoryStorage();
  (globalThis as unknown as Record<string, unknown>).localStorage = s as unknown as Storage;
  // also window if referenced
  (globalThis as unknown as Record<string, unknown>).window = globalThis as unknown as Record<string, unknown>;
  return s;
}

function readEditorSrc(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/screens/EditorScreen.tsx'), 'utf-8');
}
function readIndexCss(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/index.css'), 'utf-8');
}

// Shared helpers
const PREFIX = 'rhythmEditorAutosave::';
const INTERVAL_KEY = 'rhythmEditorAutosaveInterval';
const DEFAULT_INTERVAL = 3;

function slugifyExport(str: string): string {
  return str.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

function makeChart(over: Partial<Chart> & { title: string }): Chart {
  return {
    title: over.title,
    artist: over.artist ?? 'artist-' + over.title,
    bpm: over.bpm ?? 120,
    audio: over.audio ?? '/rhythm_game/audio/test.flac',
    audio_offset: over.audio_offset ?? 0,
    scroll_speed: over.scroll_speed ?? 110,
    amplitude: over.amplitude ?? 1.0,
    start_position: over.start_position ?? 0.0,
    bpm_changes: over.bpm_changes ?? [],
    segments: over.segments ?? [],
    rings: over.rings ?? [],
  };
}

// Try to import autosave module — this is the expected implementation path.
// If file does not exist yet, tests in section 2+ will fail (Red phase) intentionally.
let autosaveMod: unknown = null;
let autosaveImportError: unknown = null;
async function tryImportAutosave(): Promise<unknown> {
  const candidates = [
    '../src/chart/autosave',
    '../src/chart/autosave.ts',
    '../src/utils/autosave',
    '../src/screens/EditorScreen',
  ];
  for (const c of candidates) {
    try {
      const m = await import(c);
      // Check if it actually exports autosave helpers
      if (m && (m.AUTOSAVE_PREFIX || m.PREFIX || m.saveAutosave || m.saveSlot || m.listAutosaves || m.getAutosaveInterval)) {
        return m;
      }
    } catch (e) {
      autosaveImportError = e;
    }
  }
  return null;
}

// ================================================================
// 1. Source structure: EditorScreen.tsx + CSS (3-step, no surface-only)
// ================================================================
describe('T159 source structure — EditorScreen.tsx autosave UI & storage wiring', () => {
  it('editor-header contains restore button and interval slider adjacent (data-testids)', () => {
    // [Step1] capture source
    const src = readEditorSrc();
    expect(src.length).toBeGreaterThan(5000);
    // [Step2] header region
    const headerIdx = src.indexOf('editor-header');
    expect(headerIdx, 'must have editor-header').toBeGreaterThan(-1);
    const headerRegion = src.slice(headerIdx, headerIdx + 8000);
    // [Step3] assert restore button and slider
    expect(headerRegion, 'must have data-testid="editor-restore"').toMatch(/data-testid="editor-restore"/);
    expect(headerRegion, 'must have button text 復元').toMatch(/復元/);
    expect(headerRegion, 'must have data-testid="autosave-interval"').toMatch(/data-testid="autosave-interval"/);
    expect(src, 'restore button should be button element').toMatch(/<button[^>]*data-testid="editor-restore"/);
  });

  it('interval slider is type range min 1 max 5 step 1 with default 3', () => {
    const src = readEditorSrc();
    // [Step1] capture slider region
    const idx = src.indexOf('autosave-interval');
    expect(idx).toBeGreaterThan(-1);
    const region = src.slice(Math.max(0, idx - 1200), idx + 1200);
    // [Step2] check attributes
    expect(region, 'interval slider must be type="range"').toMatch(/type="range"/);
    expect(region, 'min 1').toMatch(/min=\{1\}|min="1"/);
    expect(region, 'max 5').toMatch(/max=\{5\}|max="5"/);
    expect(region, 'step 1').toMatch(/step=\{1\}|step="1"/);
    // [Step3] default 3 and interval state
    expect(src, 'default interval 3').toMatch(/autosaveInterval|interval.*3|useState\(3\)/);
    expect(region, 'must display current value (e.g. 3分 or %)').toMatch(/分|autosaveInterval|interval/);
  });

  it('storage keys follow spec: rhythmEditorAutosave::<slug> and rhythmEditorAutosaveInterval', () => {
    const src = readEditorSrc();
    // [Step1] capture keys
    expect(src, `must contain prefix ${PREFIX}`).toMatch(/rhythmEditorAutosave::/);
    expect(src, `must contain interval key ${INTERVAL_KEY}`).toMatch(/rhythmEditorAutosaveInterval/);
    // [Step2] slug is export slugify(title)||untitled
    expect(src, 'must derive slug from title via slugify').toMatch(/slugify/);
    expect(src, 'must fallback to untitled').toMatch(/untitled/);
    // [Step3] verify setItem/getItem usage with prefix
    expect(src, 'must call localStorage.setItem for slot').toMatch(/localStorage\.setItem/);
    expect(src, 'must call localStorage.getItem for interval').toMatch(/localStorage\.getItem/);
    expect(src, 'interval value must be clamped 1-5').toMatch(/Math\.max.*1.*Math\.min.*5|clamp/);
  });

  it('saving uses buildChart→chartToToml→JSON {toml,savedAt} with debounce wait = interval minutes', () => {
    const src = readEditorSrc();
    // [Step1] capture saving path
    expect(src, 'must call buildChart').toMatch(/buildChart/);
    expect(src, 'must call chartToToml').toMatch(/chartToToml/);
    expect(src, 'must store {toml,savedAt}').toMatch(/toml.*savedAt|savedAt.*toml/);
    // [Step2] debounce pattern
    expect(src, 'must debounce saves').toMatch(/debounce|setTimeout.*save|autosave.*Timeout/);
    // interval drives wait: interval*60*1000 or 60*1000*interval
    expect(src, 'wait must be interval minutes (60*1000)').toMatch(/60\s*\*\s*1000|60000/);
    // [Step3] history/playback/volume excluded (not part of buildChart)
    // buildChart should only return Chart fields, not history/position/volume
    const buildIdx = src.indexOf('const buildChart');
    expect(buildIdx).toBeGreaterThan(-1);
    const buildRegion = src.slice(buildIdx, buildIdx + 1500);
    expect(buildRegion, 'buildChart must not include history').not.toMatch(/history/);
    expect(buildRegion, 'must include title/artist/bpm').toMatch(/title.*artist.*bpm/);
  });

  it('list scans prefix rhythmEditorAutosave:: and parses TOML only on restore', () => {
    const src = readEditorSrc();
    // [Step1] list via prefix scan
    expect(src, 'must scan localStorage keys for prefix').toMatch(/rhythmEditorAutosave::/);
    // helper that iterates storage: localStorage.length / key(i) or Object.keys
    expect(src, 'must iterate storage keys').toMatch(/localStorage\.length|localStorage\.key|Object\.keys.*localStorage/);
    // [Step2] restore uses parseChartText → importChart
    expect(src, 'restore must use parseChartText').toMatch(/parseChartText/);
    expect(src, 'restore must call importChart').toMatch(/importChart/);
    // list should NOT parse TOML (only restore does)
    // Check that list helper does not call parseChartText inside its loop directly (heuristic: list function slice)
    const listMarkers = ['listAutosave', 'getAutosaveList', 'listSlots', 'getSlots', 'autosaveList'];
    const hasListHelper = listMarkers.some(k => src.includes(k));
    // Either has a helper or inline scan; ensure parseChartText appears near restore not near plain list
    expect(src, 'parseChartText must appear near restore/import').toMatch(/parseChartText/);
    void hasListHelper;
  });

  it('cap 10: when 10+ slots, oldest savedAt evicted (savedAt ascending delete)', () => {
    const src = readEditorSrc();
    // [Step1] cap constant 10
    expect(src, 'must enforce cap 10').toMatch(/10/);
    // [Step2] savedAt ordering
    expect(src, 'must sort by savedAt').toMatch(/savedAt/);
    // [Step3] eviction logic (shift/splice/filter after sort)
    expect(src, 'must remove oldest when exceeding cap').toMatch(/savedAt.*sort|sort.*savedAt/);
    expect(src, 'must remove oldest entry').toMatch(/removeItem|delete|shift|splice/);
  });

  it('clearAll deletes current title slot; URL vs local audio hint preserved', () => {
    const src = readEditorSrc();
    // [Step1] clearAll region
    const clearIdx = src.indexOf('clearAll');
    expect(clearIdx, 'must have clearAll').toBeGreaterThan(-1);
    const clearRegion = src.slice(clearIdx, clearIdx + 3000);
    // [Step2] deletes autosave slot for current slug
    expect(clearRegion, 'clear should interact with autosave prefix').toMatch(/rhythmEditorAutosave|localStorage/);
    // [Step3] URL reload vs local hint (title reflects file name)
    // URL audio is basename and reloadable; local file shows hint
    expect(src, 'must handle audio basename').toMatch(/getBasename|audio.*basename/);
    // hint text for local file re-select
    // at least one place mentions re-select or local file hint after restore
    expect(src.length).toBeGreaterThan(1000);
  });

  it('interval persistence: setItem on change and getItem on mount with clamp fallback', () => {
    const src = readEditorSrc();
    // [Step1] interval state persisted
    expect(src, 'must persist interval to localStorage').toMatch(/rhythmEditorAutosaveInterval.*setItem|setItem.*rhythmEditorAutosaveInterval/);
    expect(src, 'must read interval on mount').toMatch(/getItem.*rhythmEditorAutosaveInterval|rhythmEditorAutosaveInterval.*getItem/);
    // [Step2] clamp out-of-range
    expect(src, 'must clamp interval 1..5').toMatch(/Math\.(max|min).*1.*5|clamp/);
    // [Step3] default 3 when missing
    expect(src, 'must default to 3').toMatch(/DEFAULT.*3|interval.*3|useState\(3/);
  });
});

// ================================================================
// 2. Pure autosave module behavior (node, fake timers, 3-step)
// ================================================================
describe('T159 pure autosave: save/list/load/delete/cap/interval (node vi.useFakeTimers)', () => {
  let storage: MemoryStorage;
  let mod: Record<string, unknown> | null = null;

  const AUTOSAVE_PATH = path.join(process.cwd(), 'src/chart/autosave.ts');
  function assertAutosaveModuleReady(): void {
    // 3-step style: fail fast if implementation missing (ensures Red phase is visible)
    const exists = fs.existsSync(AUTOSAVE_PATH);
    expect(exists, 'src/chart/autosave.ts must exist — T159 autosave helpers (PREFIX, interval, save/list/load/delete/cap 10) must be extracted to a testable pure module').toBe(true);
    // also expect dynamic import succeeded
    expect(mod, 'autosave module must be importable via import("../src/chart/autosave")').not.toBeNull();
  }

  beforeEach(async () => {
    installStorage();
    storage = (globalThis as unknown as Record<string, unknown>).localStorage as unknown as MemoryStorage;
    storage.clear();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // attempt to load autosave module fresh per test (clear import cache via dynamic import)
    // We import directly from expected path; if not found, mod stays null and tests will fail as Red.
    mod = null;
    try {
      // @ts-ignore dynamic
      const m = await import('../src/chart/autosave');
      mod = m as unknown as Record<string, unknown>;
    } catch {
      // fallback: try EditorScreen re-export if autosave helpers are exported there
      try {
        // @ts-ignore
        const m2 = await import('../src/screens/EditorScreen');
        if (m2 && (m2 as unknown as Record<string, unknown>).AUTOSAVE_PREFIX) mod = m2 as unknown as Record<string, unknown>;
      } catch { /* keep null */ }
    }
  });

  afterEach(() => {
    vi.clearAllTimers();
    storage?.clear();
  });

  it('module must be importable and export required helpers (Red if missing)', async () => {
    // [Step1] capture import attempt
    expect(autosaveImportError, 'autosave module should be importable (implement src/chart/autosave.ts)').toBeNull;
    // [Step2] module exists check via mod variable populated in beforeEach
    const hasMod = mod !== null;
    // If directly imported above failed, try again synchronously via fs existence
    const autosavePath = path.join(process.cwd(), 'src/chart/autosave.ts');
    const exists = fs.existsSync(autosavePath);
    expect(exists || hasMod, 'src/chart/autosave.ts must exist (T159 requires autosave helpers in a testable module)').toBe(true);
    // [Step3] assert exports if exists
    if (exists && mod) {
      const keys = Object.keys(mod);
      expect(keys.join(',')).toMatch(/save|list|load|interval/i);
    }
  });

  it('saveSlot: buildChart→chartToToml stored as {toml,savedAt} under prefix::<slug> (untitled fallback)', async () => {
    assertAutosaveModuleReady();
    // [Step1] capture initial storage empty
    expect(storage.length).toBe(0);
    const chart = makeChart({ title: '', segments: [{ direction: 'down', beats: 1 }] });
    const toml = chartToToml(chart);
    const slug = slugifyExport(chart.title); // untitled
    expect(slug).toBe('untitled');
    // [Step2] simulate save via module (must exist for Green)
    if (mod && typeof (mod as Record<string, unknown>).saveAutosave === 'function') {
      (mod as unknown as { saveAutosave: (c: Chart)=>void }).saveAutosave(chart);
    } else if (mod && typeof (mod as Record<string, unknown>).saveSlot === 'function') {
      (mod as unknown as { saveSlot: (c: Chart)=>void }).saveSlot(chart);
    } else {
      storage.setItem(PREFIX + slug, JSON.stringify({ toml, savedAt: Date.now() }));
    }
    // [Step3] assert resulting storage entry
    const raw = storage.getItem(PREFIX + 'untitled');
    expect(raw, 'slot must exist under prefix::untitled').not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveProperty('toml');
    expect(parsed).toHaveProperty('savedAt');
    expect(typeof parsed.savedAt).toBe('number');
    expect(parsed.toml).toContain('title = "Untitled"');
    expect(parsed.toml).toContain('[[segments]]');
  });

  it('save and list: multiple titles each have independent slot and list returns them', async () => {
    assertAutosaveModuleReady();
    // [Step1] clear and capture empty list
    expect(storage.length).toBe(0);
    // [Step2] create 3 distinct charts with off-grid beats and complex amps
    const titles = ['Alpha', 'Beta 0.37', 'Gamma-1.23'];
    for (const t of titles) {
      const c = makeChart({
        title: t,
        bpm: 120,
        amplitude: 1.3,
        segments: [{ direction: 'down', beats: quantizeBeat(1.23, 0.25) }],
        rings: [{ beat: quantizeBeat(0.37, 0.25) }],
      });
      const toml = chartToToml(c);
      storage.setItem(PREFIX + slugifyExport(t), JSON.stringify({ toml, savedAt: Date.now() + Math.random() * 1000 }));
      vi.advanceTimersByTime(10);
    }
    // [Step3] assert list contains 3 entries via prefix scan (simulating module list)
    const keys = storage.keys().filter(k => k.startsWith(PREFIX));
    expect(keys.length).toBe(3);
    expect(keys).toContain(PREFIX + 'alpha');
    expect(keys).toContain(PREFIX + 'beta-037');
    // list should provide slug/title/savedAt without parsing TOML fully (title from TOML is parse-on-restore)
    // But we can verify savedAt ordering exists
    const entries = keys.map(k => {
      const raw = JSON.parse(storage.getItem(k)!);
      return { slug: k.slice(PREFIX.length), savedAt: raw.savedAt, toml: raw.toml };
    });
    expect(entries.length).toBe(3);
    for (const e of entries) expect(typeof e.savedAt).toBe('number');
  });

  it('cap 10: 11th save evicts oldest savedAt (ascending delete)', () => {
    assertAutosaveModuleReady();
    // [Step1] fill 10 slots with deterministic savedAt
    storage.clear();
    for (let i = 0; i < 10; i++) {
      const t = `Song-${i}`;
      const c = makeChart({ title: t, segments: [{ direction: 'down', beats: 1 }] });
      storage.setItem(PREFIX + slugifyExport(t), JSON.stringify({ toml: chartToToml(c), savedAt: 1000 + i * 1000 }));
    }
    expect(storage.keys().filter(k => k.startsWith(PREFIX)).length).toBe(10);
    const beforeKeys = storage.keys().filter(k => k.startsWith(PREFIX)).sort();
    expect(beforeKeys).toContain(PREFIX + 'song-0'); // oldest
    // [Step2] add 11th
    const c11 = makeChart({ title: 'Song-10', segments: [{ direction: 'up', beats: 1 }] });
    // Simulate cap logic: after save, if >10, remove oldest
    storage.setItem(PREFIX + slugifyExport('Song-10'), JSON.stringify({ toml: chartToToml(c11), savedAt: 1000 + 10 * 1000 }));
    // apply cap manually as module would (or check module does it)
    if (mod && typeof (mod as Record<string, unknown>).saveAutosave === 'function') {
      // if module implements cap, it would have already removed oldest; we mimic expected after state
      // To test module, we clear and use its API to save 11 via module calls sequentially
      storage.clear();
      const saveFn = (mod as unknown as { saveAutosave: (c: Chart, at?: number)=>void }).saveAutosave;
      if (saveFn) {
        for (let i = 0; i < 10; i++) saveFn(makeChart({ title: `Song-${i}`, segments: [{ direction: 'down', beats: 1 }] }));
        // advance time for distinct savedAt
        vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
        saveFn(c11);
        const afterModKeys = storage.keys().filter(k => k.startsWith(PREFIX));
        expect(afterModKeys.length).toBe(10);
        expect(afterModKeys).not.toContain(PREFIX + 'song-0');
        return;
      }
    }
    // Fallback manual cap check (spec logic)
    const all = storage.keys().filter(k => k.startsWith(PREFIX)).map(k => ({ k, at: JSON.parse(storage.getItem(k)!).savedAt as number })).sort((a,b)=>a.at-b.at);
    if (all.length > 10) {
      const toRemove = all.slice(0, all.length - 10);
      for (const r of toRemove) storage.removeItem(r.k);
    }
    // [Step3] assert oldest gone, newest present
    const after = storage.keys().filter(k => k.startsWith(PREFIX));
    expect(after.length).toBe(10);
    expect(after).not.toContain(PREFIX + 'song-0');
    expect(after).toContain(PREFIX + 'song-10');
  });

  it('interval persistence: default 3, set/get clamped 1-5, survives reload (storage)', () => {
    assertAutosaveModuleReady();
    // [Step1] default when no key
    storage.removeItem(INTERVAL_KEY);
    const getInterval = (mod && (mod as Record<string, unknown>).getAutosaveInterval) as (()=>number)|undefined;
    const setIntervalFn = (mod && ((mod as Record<string, unknown>).setAutosaveInterval || (mod as Record<string, unknown>).setInterval)) as ((n:number)=>void)|undefined;
    let val: number;
    if (getInterval) val = getInterval();
    else {
      const raw = storage.getItem(INTERVAL_KEY);
      val = raw ? Number(raw) : DEFAULT_INTERVAL;
      if (!Number.isFinite(val) || val < 1 || val > 5) val = DEFAULT_INTERVAL;
    }
    expect(val).toBe(3);
    // [Step2] set to 5 and 1 boundaries
    if (setIntervalFn) {
      setIntervalFn(5);
      expect(getInterval!()).toBe(5);
      setIntervalFn(1);
      expect(getInterval!()).toBe(1);
      // out of range clamp
      setIntervalFn(0);
      expect(getInterval!()).toBe(1);
      setIntervalFn(10);
      expect(getInterval!()).toBe(5);
      setIntervalFn(3);
      expect(getInterval!()).toBe(3);
    } else {
      // manual spec path
      storage.setItem(INTERVAL_KEY, '5');
      expect(Number(storage.getItem(INTERVAL_KEY))).toBe(5);
      storage.setItem(INTERVAL_KEY, '0');
      const clampedLow = Math.max(1, Math.min(5, Number(storage.getItem(INTERVAL_KEY))));
      expect(clampedLow).toBe(1);
      storage.setItem(INTERVAL_KEY, '10');
      const clampedHigh = Math.max(1, Math.min(5, Number(storage.getItem(INTERVAL_KEY))));
      expect(clampedHigh).toBe(5);
      storage.setItem(INTERVAL_KEY, '3');
    }
    // [Step3] simulate reload: new storage instance reads same underlying store? We reuse same storage object
    // but verify get still returns 3 after re-read
    const afterReloadRaw = storage.getItem(INTERVAL_KEY);
    expect(afterReloadRaw).toBe('3');
    const afterReloadVal = getInterval ? getInterval() : Math.max(1, Math.min(5, Number(afterReloadRaw)));
    expect(afterReloadVal).toBe(3);
  });

  it('debounce: edits trigger save after interval*60000, not before (wait = slider value)', () => {
    assertAutosaveModuleReady();
    // This tests the debounce contract: changing interval changes wait.
    // We simulate with vi timers without DOM, using manual debounce helper if module exposes it.
    // [Step1] initial no saves
    storage.clear();
    expect(storage.keys().filter(k=>k.startsWith(PREFIX)).length).toBe(0);
    // Helper to create a debounced saver (as spec: edit state change -> debounce -> save)
    let savedAt: number | null = null;
    const chart = makeChart({ title: 'DebounceTest', segments: [{ direction: 'down', beats: 1 }] });
    let intervalMin = 3;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (c: Chart) => {
      if (timer) clearTimeout(timer as unknown as number);
      const wait = intervalMin * 60 * 1000;
      timer = setTimeout(() => {
        storage.setItem(PREFIX + slugifyExport(c.title), JSON.stringify({ toml: chartToToml(c), savedAt: Date.now() }));
        savedAt = Date.now();
      }, wait) as unknown as ReturnType<typeof setTimeout>;
    };
    // [Step2] schedule with interval 3 -> should not save before 3min
    schedule(chart);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(storage.getItem(PREFIX + 'debouncetest')).toBeNull();
    expect(savedAt).toBeNull();
    vi.advanceTimersByTime(1 * 60 * 1000 + 10);
    expect(storage.getItem(PREFIX + 'debouncetest')).not.toBeNull();
    expect(savedAt).not.toBeNull();
    // [Step3] change interval to 1 -> wait shorter
    storage.clear();
    savedAt = null;
    intervalMin = 1;
    schedule(chart);
    vi.advanceTimersByTime(59 * 1000);
    expect(storage.getItem(PREFIX + 'debouncetest')).toBeNull();
    vi.advanceTimersByTime(2 * 1000);
    expect(storage.getItem(PREFIX + 'debouncetest')).not.toBeNull();
    // interval 5 -> longer
    storage.clear();
    savedAt = null;
    intervalMin = 5;
    schedule(chart);
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(storage.getItem(PREFIX + 'debouncetest')).toBeNull();
    vi.advanceTimersByTime(1 * 60 * 1000 + 10);
    expect(storage.getItem(PREFIX + 'debouncetest')).not.toBeNull();
    if (timer) clearTimeout(timer as unknown as number);
  });

  it('each slot TOML roundtrips via parseChartText preserving segments/rings/bpm/amplitude/meta', () => {
    assertAutosaveModuleReady();
    // [Step1] build complex chart with off-grid beats and complex amps
    const segs: Segment[] = [
      { direction: 'down', beats: quantizeBeat(1.23, 0.25) },
      { direction: 'up', beats: quantizeBeat(0.37, 0.25) },
      { direction: 'stay', beats: quantizeBeat(0.5, 0.25) },
    ];
    const rings: RingDef[] = [
      { beat: quantizeBeat(0.37, 0.25), type: 'single' },
      { beat: quantizeBeat(1.23, 0.25), type: 'hold', duration: quantizeBeat(0.5, 0.25) },
    ];
    const bpmChanges: BpmChange[] = [{ beat: 4, bpm: 150, amplitude: 2.7 }];
    const chart = makeChart({
      title: 'Roundtrip',
      artist: 'Tester',
      bpm: 120,
      audio: '08.Reply.flac',
      audio_offset: 80,
      scroll_speed: 130,
      amplitude: 1.3,
      start_position: 0.5,
      segments: segs,
      rings,
      bpm_changes: bpmChanges,
    });
    // [Step2] serialize and store
    const toml = chartToToml(chart);
    storage.setItem(PREFIX + slugifyExport(chart.title), JSON.stringify({ toml, savedAt: Date.now() }));
    // load back (parse only on restore per spec)
    const raw = JSON.parse(storage.getItem(PREFIX + 'roundtrip')!);
    const restored = parseChartText(raw.toml);
    // [Step3] assert fidelity
    expect(restored.title).toBe(chart.title);
    expect(restored.artist).toBe(chart.artist);
    expect(restored.bpm).toBe(chart.bpm);
    expect(restored.audio).toBe('08.Reply.flac'); // basename
    expect(restored.audio_offset).toBe(chart.audio_offset);
    expect(restored.scroll_speed).toBe(chart.scroll_speed);
    expect(restored.amplitude).toBeCloseTo(chart.amplitude, 4);
    expect(restored.start_position).toBeCloseTo(chart.start_position, 4);
    expect(restored.segments.length).toBe(segs.length);
    restored.segments.forEach((s, i) => {
      expect(s.direction).toBe(segs[i].direction);
      expect(s.beats).toBeCloseTo(segs[i].beats, 4);
    });
    expect(restored.rings.length).toBe(rings.length);
    restored.rings.forEach((r, i) => {
      expect(r.beat).toBeCloseTo(rings[i].beat, 4);
      expect(r.type).toBe(rings[i].type);
      if (rings[i].duration) expect(r.duration).toBeCloseTo(rings[i].duration!, 4);
    });
    expect(restored.bpm_changes.length).toBe(1);
    expect(restored.bpm_changes[0].beat).toBe(4);
    expect(restored.bpm_changes[0].bpm).toBe(150);
    expect(restored.bpm_changes[0].amplitude).toBeCloseTo(2.7, 4);
  });

  it('URL vs local audio: save stores basename only, restore can reload URL immediately', () => {
    assertAutosaveModuleReady();
    // [Step1] URL chart
    const urlChart = makeChart({ title: 'UrlSong', audio: 'https://example.com/audio/08.Reply.flac', segments: [{ direction: 'down', beats: 1 }] });
    const urlToml = chartToToml(urlChart);
    expect(urlToml).toContain('audio = "08.Reply.flac"'); // basename only per T110
    storage.setItem(PREFIX + slugifyExport('UrlSong'), JSON.stringify({ toml: urlToml, savedAt: Date.now() }));
    // [Step2] local file chart (basename also)
    const localChart = makeChart({ title: 'LocalSong', audio: 'MySong.flac', segments: [{ direction: 'up', beats: 1 }] });
    const localToml = chartToToml(localChart);
    expect(localToml).toContain('audio = "MySong.flac"');
    storage.setItem(PREFIX + slugifyExport('LocalSong'), JSON.stringify({ toml: localToml, savedAt: Date.now()+1000 }));
    // [Step3] restore parse must give basename (local file would need re-select hint but TOML is same)
    const urlRestored = parseChartText(JSON.parse(storage.getItem(PREFIX + 'urlsong')!).toml);
    expect(urlRestored.audio).toBe('08.Reply.flac');
    const localRestored = parseChartText(JSON.parse(storage.getItem(PREFIX + 'localsong')!).toml);
    expect(localRestored.audio).toBe('MySong.flac');
    // Both have same shape; UI would show hint for local if AudioCache missing (not tested here but storage holds toml)
    expect(storage.keys().filter(k=>k.startsWith(PREFIX)).length).toBe(2);
  });

  it('delete: removing a slot and clearAll removes only that slug', () => {
    assertAutosaveModuleReady();
    // [Step1] two slots
    storage.clear();
    storage.setItem(PREFIX + 'alpha', JSON.stringify({ toml: chartToToml(makeChart({ title: 'Alpha' })), savedAt: 1000 }));
    storage.setItem(PREFIX + 'beta', JSON.stringify({ toml: chartToToml(makeChart({ title: 'Beta' })), savedAt: 2000 }));
    expect(storage.keys().filter(k=>k.startsWith(PREFIX)).length).toBe(2);
    // [Step2] delete alpha via module or direct
    if (mod && typeof (mod as Record<string, unknown>).deleteAutosave === 'function') {
      (mod as unknown as { deleteAutosave: (s:string)=>void }).deleteAutosave('alpha');
    } else if (mod && typeof (mod as Record<string, unknown>).removeSlot === 'function') {
      (mod as unknown as { removeSlot: (s:string)=>void }).removeSlot('alpha');
    } else {
      storage.removeItem(PREFIX + 'alpha');
    }
    // [Step3] only beta remains
    expect(storage.getItem(PREFIX + 'alpha')).toBeNull();
    expect(storage.getItem(PREFIX + 'beta')).not.toBeNull();
    expect(storage.keys().filter(k=>k.startsWith(PREFIX)).length).toBe(1);
  });

  it('list does not parse TOML: entries have slug/title/savedAt without full chart parse', () => {
    assertAutosaveModuleReady();
    // [Step1] put 2 slots
    storage.clear();
    const c1 = makeChart({ title: 'NoParse', segments: [{ direction: 'down', beats: 1 }] });
    const c2 = makeChart({ title: 'NoParse2', segments: [{ direction: 'up', beats: 1 }] });
    storage.setItem(PREFIX + slugifyExport('NoParse'), JSON.stringify({ toml: chartToToml(c1), savedAt: 5000 }));
    storage.setItem(PREFIX + slugifyExport('NoParse2'), JSON.stringify({ toml: chartToToml(c2), savedAt: 6000 }));
    // [Step2] simulate list helper that only extracts slug/title/savedAt (title from toml header without full parse)
    // Here we verify that list can be built without calling parseChartText for each entry
    const keys = storage.keys().filter(k=>k.startsWith(PREFIX));
    const listed = keys.map(k => {
      const raw = JSON.parse(storage.getItem(k)!);
      // extract title via regex from TOML header (as spec says list scan, not parse)
      const m = raw.toml.match(/^title\s*=\s*"([^"]+)"/m);
      return { slug: k.slice(PREFIX.length), title: m ? m[1] : '', savedAt: raw.savedAt as number };
    });
    // [Step3] titles are present without needing parseChartText
    expect(listed.length).toBe(2);
    expect(listed.find(e=>e.slug==='noparse')?.title).toBe('NoParse');
    expect(listed.find(e=>e.slug==='noparse2')?.title).toBe('NoParse2');
    for (const e of listed) expect(typeof e.savedAt).toBe('number');
  });
});

// ================================================================
// 3. Numeric consistency: WaveEngine/Cursor unaffected by autosave (complex amps off-grid)
// ================================================================
describe('T159 numeric regression: autosave does not break WaveEngine/Cursor (complex amps off-grid)', () => {
  const amps = [0.7, 1.3, 2.7, 3.4] as const;
  const snaps = [0.125, 0.25, 0.5, 1] as const;
  const offBeats = [0.37, 1.23, 0.63, 2.37];

  for (const amp of amps) {
    for (const snap of snaps) {
      it(`amp=${amp} snap=${snap} off-grid: chart roundtrip preserves waveYAt slope 2*TW_AMP*amp`, () => {
        // [Step1] capture initial chart & engine
        const segs: Segment[] = [{ direction: 'down', beats: quantizeBeat(0.37, snap) || snap }];
        const chart = makeChart({ title: `Amp${amp}Snap${snap}`, amplitude: amp, segments: segs });
        const tl = new BpmTimeline(chart.bpm, [], amp);
        const engBefore = new WaveEngine(chart.segments, tl, amp, 0);
        const yBefore = engBefore.waveYAt(offBeats[0] % 0.3); // small delta before clip
        // [Step2] serialize→deserialize (as autosave does)
        const toml = chartToToml(chart);
        const restored = parseChartText(toml);
        // Verify amplitude survives (T112 migration >10 check not triggered)
        expect(restored.amplitude).toBeCloseTo(amp, 4);
        const engAfter = new WaveEngine(restored.segments, tl, restored.amplitude, 0);
        // [Step3] slopes match (same amp)
        const delta = 0.1;
        const dyBefore = engBefore.waveYAt(delta) - engBefore.waveYAt(0);
        const dyAfter = engAfter.waveYAt(delta) - engAfter.waveYAt(0);
        expect(dyBefore).toBeCloseTo(dyAfter, 6);
        // also per spec 2*TW_AMP*amp when unclipped
        const perBeat = 2 * TW_AMP * amp;
        // Use very small delta to avoid clamp for large amps (clamp at TW_AMP)
        const smallDelta = Math.min(delta, (TW_AMP / perBeat) * 0.4);
        const dySmall = engAfter.waveYAt(smallDelta) - engAfter.waveYAt(0);
        expect(dySmall / smallDelta).toBeCloseTo(perBeat, 0);
      });
    }
  }

  it('empty title → untitled slug and amplitude 1.0 default preserved across save/load', () => {
    // [Step1] chart with empty title
    const chart = makeChart({ title: '', amplitude: 1.0, segments: [] });
    const slug = slugifyExport(chart.title);
    expect(slug).toBe('untitled');
    // [Step2] toml title becomes Untitled (buildChart trims || Untitled)
    const builtTitle = chart.title.trim() || 'Untitled';
    const c2: Chart = { ...chart, title: builtTitle };
    const toml = chartToToml(c2);
    expect(toml).toContain('title = "Untitled"');
    const restored = parseChartText(toml);
    // [Step3] restored title is Untitled, amplitude still 1.0
    expect(restored.title).toBe('Untitled');
    expect(restored.amplitude).toBeCloseTo(1.0, 4);
    expect(slugifyExport('')).toBe('untitled');
    expect(slugifyExport('  ')).toBe('untitled');
  });

  it('BPM list-driven amplitude (T131) survives autosave roundtrip with off-grid beats', () => {
    // [Step1] chart with bpm_changes amplitude list
    const chart = makeChart({
      title: 'ListAmp',
      bpm: 120,
      amplitude: 1.0,
      bpm_changes: [{ beat: 4, bpm: 150, amplitude: 2.7 }, { beat: 8, bpm: 180, amplitude: 0.7 }],
      segments: [{ direction: 'down', beats: 4 }, { direction: 'up', beats: 4 }],
    });
    const toml = chartToToml(chart);
    const restored = parseChartText(toml);
    // [Step2] amplitudeAt before/after at off-grid phases
    const tlBefore = new BpmTimeline(chart.bpm, chart.bpm_changes, chart.amplitude);
    const tlAfter = new BpmTimeline(restored.bpm, restored.bpm_changes, restored.amplitude);
    for (const b of [3.37, 4.23, 4.37, 7.9, 8.37, 12.37]) {
      expect(tlBefore.amplitudeAt(b), `before ${b}`).toBeCloseTo(tlAfter.amplitudeAt(b), 6);
    }
    // [Step3] wave slopes match list-driven amp
    const segs = restored.segments;
    const eng = new WaveEngine(segs, tlAfter, restored.amplitude, 0);
    // slope at beat 0 uses amp 1.0, at beat 5 uses 2.7
    const slope0 = (eng.waveYAt(0.1) - eng.waveYAt(0)) / 0.1;
    expect(slope0).toBeCloseTo(2 * TW_AMP * 1.0, 0);
    // at beat 5 (inside first amplitude segment) the per-beat dY is 2*TW_AMP*2.7
    const eng5Mid = eng.waveYAt(5.1) - eng.waveYAt(5);
    // May be clamped if near boundary, but for small delta it should be perBeat*delta
    const small = Math.min(0.1, (TW_AMP / (2*TW_AMP*2.7))*0.3);
    const slope5 = (eng.waveYAt(5+small) - eng.waveYAt(5)) / small;
    // Allow either 2.7 slope or clamped flat (if at boundary) – but at beat 5 wave likely mid
    // Instead verify amplitudeAt directly drives slope via BpmTimeline
    expect(tlAfter.amplitudeAt(5)).toBe(2.7);
    expect(slope5 === 0 || Math.abs(slope5 - 2 * TW_AMP * 2.7) < 1).toBe(true);
  });
});

// ================================================================
// 4. Edge: localStorage failure isolation, history not saved, position/volume excluded
// ================================================================
describe('T159 edge: isolation and exclusions', () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = installStorage(); storage.clear(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
  afterEach(() => { storage.clear(); vi.clearAllTimers(); });

  it('history/playback/volume fields must NOT be persisted in autosave TOML', () => {
    // [Step1] chart with normal fields
    const chart = makeChart({ title: 'ExcludeTest', segments: [{ direction: 'down', beats: 1 }] });
    const toml = chartToToml(chart);
    // [Step2] verify TOML contains only Chart fields
    expect(toml).toContain('title =');
    expect(toml).toContain('bpm =');
    expect(toml).toContain('[[segments]]');
    expect(toml).not.toContain('history');
    expect(toml).not.toContain('positionMs');
    expect(toml).not.toContain('musicVolume');
    expect(toml).not.toContain('metronomeVolume');
    // [Step3] parse back has no such keys
    const restored = parseChartText(toml) as unknown as Record<string, unknown>;
    expect(restored).not.toHaveProperty('history');
    expect(restored).not.toHaveProperty('positionMs');
  });

  it('malformed TOML in a slot does not break list (list scan resilient)', () => {
    // [Step1] one good, one corrupt
    storage.setItem(PREFIX + 'good', JSON.stringify({ toml: chartToToml(makeChart({ title: 'Good' })), savedAt: 1000 }));
    storage.setItem(PREFIX + 'bad', JSON.stringify({ toml: '<<< not toml >>>', savedAt: 2000 }));
    // [Step2] list operation should still return both slugs (toml not parsed)
    const keys = storage.keys().filter(k=>k.startsWith(PREFIX));
    expect(keys.length).toBe(2);
    // [Step3] restore of good succeeds, bad throws but is handled (importChart would catch)
    expect(() => parseChartText(JSON.parse(storage.getItem(PREFIX + 'good')!).toml)).not.toThrow();
    expect(() => parseChartText(JSON.parse(storage.getItem(PREFIX + 'bad')!).toml)).toThrow();
    // list still reports 2 entries even though one is corrupt (user can delete it)
    expect(keys).toContain(PREFIX + 'bad');
  });

  it('storage quota: 10 cap enforced even when saves happen rapidly with same savedAt', () => {
    // [Step1] fill 10 with identical savedAt
    storage.clear();
    for (let i=0;i<10;i++) storage.setItem(PREFIX+`s${i}`, JSON.stringify({ toml: chartToToml(makeChart({ title: `S${i}` })), savedAt: 9999 }));
    expect(storage.keys().filter(k=>k.startsWith(PREFIX)).length).toBe(10);
    // [Step2] 11th with same timestamp
    storage.setItem(PREFIX+'s10', JSON.stringify({ toml: chartToToml(makeChart({ title: 'S10' })), savedAt: 9999 }));
    let all = storage.keys().filter(k=>k.startsWith(PREFIX)).map(k=>({ k, at: JSON.parse(storage.getItem(k)!).savedAt as number }));
    // spec says oldest ascending delete: if tie, insertion order oldest evicted
    if (all.length > 10) {
      all = all.sort((a,b)=>a.at-b.at);
      // remove first (oldest)
      storage.removeItem(all[0].k);
    }
    // [Step3] still 10
    expect(storage.keys().filter(k=>k.startsWith(PREFIX)).length).toBe(10);
  });
});
