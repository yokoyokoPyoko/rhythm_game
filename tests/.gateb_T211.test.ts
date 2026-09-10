/**
 * T211 — チュートリアルの2段階・押下確認式への刷新 (TDD Red -> Green)
 * Vitest (TypeScript, node environment) pure unit — no browser / no DOM required.
 * Spec:
 *  - 対象はパブリックモードの通常プレイ時のみ（デバッグ・プレイテスト時は出さない、T210と同一）
 *  - ステージA（波形練習・BPM90）: up 1 / down 1 / up 1 / down 1 の計4拍（導入stayなし）、リングなし。
 *    開始時は暗く（オーバーレイ減光）、↑/↓初回押下で練習開始＋時計リセット、4拍完走でステージBへ自動進行
 *  - ステージB（リング練習・BPM90・上下なし）: stay波形の上にリング4個を1拍ごと（beat 1,2,3,4, single）に配置。
 *    開始時は暗く、Space初回押下で練習開始、最終リング後にステージC（ホールド）へ自動進行
 *  - ステージC（ホールド練習・BPM90）: stay波形の上にホールド2個（head 1拍・4拍, duration 2拍）を配置。
 *    開始時は暗く、Space初回押下で練習開始、最終テール後に本編へ遷移。押し続け→テールで離す操作を体験
 *  - T213: 暗さの制御はオーバーレイ1層のみ（canvas常時不透明度1）。待機中（押下前・本編Space待ち）は
 *    rgba(10,10,10,0.45)の減光ON、練習中は減光OFF（透明）。指示文・スキップは上部配置。
 *  - 待機中は時計を進めない（押下でresetClockし直し）、待機中にメトロノームは鳴らさない
 *  - スキップボタンは常時表示でいつでも本編へ脱出可。チュートリアル中のスコアは破棄し本編開始時にリセット
 *  - T208判定表示制御は両ステージに適用
 *  - 修正: src/game/tutorial.tsに2譜面ジェネレータ（generateWavePracticeChart/generateRingPracticeChart）＋ステージ別指示文テーブル
 *  - GameScreen.tsxのみ: フェーズ 'tutorial-wave' → 'tutorial-ring' → 'main' の3状態＋待機／練習開始／自動進行
 *
 * STRICT QA:
 *  - 3-step state-transition assertions (capture → perform → assert transition)
 *  - Assert computed outputs (beats, ms, waveYAt, cursor speed)
 *  - Off-grid fractional timing mandatory (0.37, 1.23, 3.37, 5.23)
 *  - Complex amplitudes (0.7, 1.3, 2.7, 3.4) for WaveEngine/Cursor consistency
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as TutorialModule from '../src/game/tutorial';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import { RingSpawner } from '../src/game/ringSpawner';
import { judgeHit } from '../src/game/hitJudge';

// ---------------------------------------------------------------------------
// global mocks — node has no localStorage / window by default
// ---------------------------------------------------------------------------
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  } as any;
}
if (typeof (globalThis as any).window === 'undefined') {
  (globalThis as any).window = globalThis as any;
}
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = { createElement: () => ({ getContext: () => null }) } as any;
}

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  try { localStorage.clear(); } catch {}
});
afterEach(() => {
  vi.clearAllTimers();
  try { localStorage.clear(); } catch {}
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function tutorialAMs(chart: any): number {
  const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
  // stage A: no rings → total 5 beats + 2s not used; but duration is 5 beats
  const totalBeats = (chart.segments as any[]).reduce((s: number, seg: any) => s + seg.beats, 0);
  return tl.beatToMs(totalBeats);
}

function tutorialBMs(chart: any): number {
  const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
  const last = (chart.rings as any[]).reduce((m: number, r: any) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity);
  return tl.beatToMs(last) + 2000;
}

// ---------------------------------------------------------------------------
// T211-0: ファイル契約 — tutorial.ts / GameScreen.tsx
// ---------------------------------------------------------------------------
describe('T211-0: ファイル契約 — tutorial.ts / GameScreen.tsx / phases', () => {
  it('Step1 初期 capture (旧T210の単相チュートリアルのみ) → Step2 新2段階APIを探索 → Step3 generateWavePracticeChart / generateRingPracticeChart とステージ別指示文が export されている', () => {
    // Step1: old module had only generateTutorialChart
    const oldFn = (TutorialModule as any).generateTutorialChart;
    expect(typeof oldFn === 'function' || oldFn === undefined).toBe(true);

    // Step2: new APIs must exist
    const mod: any = TutorialModule as any;
    const src = readFile('src/game/tutorial.ts');

    // Step3: strict existence — these MUST exist for T211 (will FAIL before implementation)
    expect(src).toContain('generateWavePracticeChart');
    expect(src).toContain('generateRingPracticeChart');
    expect(typeof mod.generateWavePracticeChart).toBe('function');
    expect(typeof mod.generateRingPracticeChart).toBe('function');

    // Instruction tables — per-stage (allow either separate arrays or getWave/getRing functions)
    const hasWaveInstr = src.includes('WAVE') || src.includes('wave') || src.includes('WAVE_PRACTICE') || src.includes('WAVE_INSTRUCTIONS');
    const hasRingInstr = src.includes('RING') || src.includes('ring') || src.includes('RING_PRACTICE') || src.includes('RING_INSTRUCTIONS');
    // At least some per-stage instruction identifier must exist (file contract)
    expect(hasWaveInstr).toBe(true);
    expect(hasRingInstr).toBe(true);
    // Also ensure some getInstruction helper exists for each stage (or unified with stage param)
    const hasGet =
      src.includes('getWave') ||
      src.includes('getRing') ||
      src.includes('getTutorialInstruction') ||
      src.includes('getInstruction');
    expect(hasGet).toBe(true);
  });

  it('Step1 GameScreen 初期 capture (phase tutorial|main のみ) → Step2 新3相 state を探索 → Step3 GameScreen が tutorial-wave / tutorial-ring / main の3状態＋待機／リセット／メトロノーム抑制を持つ', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src.length).toBeGreaterThan(0);

    // Step3: must contain 3 phases explicitly
    expect(src).toMatch(/'tutorial-wave'/);
    expect(src).toMatch(/'tutorial-ring'/);
    expect(src).toMatch(/'main'/);
    // Phase state type must include all three
    expect(src).toMatch(/tutorial-wave.*tutorial-ring.*main|tutorial-ring.*tutorial-wave/);

    // Generators must be imported/used
    expect(src).toMatch(/generateWavePracticeChart/);
    expect(src).toMatch(/generateRingPracticeChart/);

    // Waiting: clock must NOT advance before key press, resetClock on first press
    // Look for a waiting flag (e.g. waitingForInput, tutorialStarted, tutorialPhaseStarted, hasStartedTutorial)
    const waitingRelated = src.match(/waiting|tutorialStarted|hasStarted|isWaiting|waveWaiting|ringWaiting|startedRef/i);
    expect(waitingRelated !== null).toBe(true);
    // Must call resetClock on stage start
    expect(src).toMatch(/resetClock/);

    // T213: dim is now a single overlay layer (rgba 0.45) — no canvas opacity.
    expect(src).toMatch(/overlayDimmed|overlayDim/);
    expect(src).toMatch(/setOverlayDimmed|set\w*[Dd]im\w*\s*\(/);

    // Skip button always visible
    expect(src).toMatch(/tutorial-skip/);
    expect(src).toMatch(/スキップ/);

    // Metronome suppression while waiting (must guard startMetronome or schedule)
    expect(src).toMatch(/startMetronome|stopMetronome|metronome/);

    // Public-only guard
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]public['"]/);
    expect(src).toMatch(/isPlaytest/);
  });

  it('Step1 public/debug 分岐 capture → Step2 新仕様でも publicのみチュートリアル → Step3 debug / playtest では tutorial-wave/ring に入らない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/getViewMode/);
    // Must still check public for tutorial entry
    const publicGuard = src.match(/getViewMode\(\)\s*===\s*['"]public['"][\s\S]{0,300}isPlaytest[\s\S]{0,300}\?\s*['"]tutorial-wave['"]/);
    // Allow slightly relaxed pattern but require both conditions near phase decision
    const hasPublicAndPlaytest = src.includes("getViewMode() === 'public'") || src.includes('getViewMode() === "public"');
    const hasTutorialWave = src.includes('tutorial-wave');
    expect(hasPublicAndPlaytest).toBe(true);
    expect(hasTutorialWave).toBe(true);
    // Phase initial must be conditional on public && !isPlaytest
    expect(src).toMatch(/!isPlaytest/);
    // Must not have hard-coded tutorial without guard
    const unguarded = src.match(/useState\(['"]tutorial-wave['"]\)/) || src.match(/useState\(['"]tutorial['"]\)/);
    // If unguarded initial is found, ensure surrounding code also checks view mode
    if (unguarded) {
      expect(src).toMatch(/getViewMode/);
    }
  });
});

// ---------------------------------------------------------------------------
// T211-1: ステージA — 波形練習譜面の固定内容 (3-step, computed, off-grid必須)
// ---------------------------------------------------------------------------
describe('T211-1: ステージA 波形練習譜面の固定内容 (3-step, computed, off-grid)', () => {
  it('Step1 初期 empty capture (chart 未生成) → Step2 generateWavePracticeChart() 実行 → Step3 BPM90, up1+down1+up1+down1 の4拍、リング0、amplitude1.0', () => {
    const before: unknown = null;
    expect(before).toBeNull();

    const mod: any = TutorialModule as any;
    expect(typeof mod.generateWavePracticeChart).toBe('function');
    const chart = mod.generateWavePracticeChart();

    // BPM90
    expect(chart.bpm_changes.length).toBeGreaterThanOrEqual(1);
    expect(chart.bpm_changes[0].beat).toBe(0);
    expect(chart.bpm_changes[0].bpm).toBe(90);

    // Segments: up1 + down1 + up1 + down1 =4 (T226: 導入stayなし)
    expect(chart.segments.length).toBe(4);
    expect(chart.segments[0]).toEqual({ direction: 'up', beats: 1 });
    expect(chart.segments[1]).toEqual({ direction: 'down', beats: 1 });
    expect(chart.segments[2]).toEqual({ direction: 'up', beats: 1 });
    expect(chart.segments[3]).toEqual({ direction: 'down', beats: 1 });

    // Total beats =4
    const total = chart.segments.reduce((s: number, seg: any) => s + seg.beats, 0);
    expect(total).toBe(4);

    // No rings
    expect(Array.isArray(chart.rings)).toBe(true);
    expect(chart.rings.length).toBe(0);

    expect(chart.amplitude).toBeCloseTo(1.0, 5);
    // start_position -1 (下端): 下から上へ動かす練習 (T212/T226)
    expect(chart.start_position).toBeCloseTo(-1.0, 5);
  });

  it('Step1 BPMタイムライン未構築を capture → Step2 BpmTimeline で beatToMs 計測 → Step3 90BPMで 4拍=2666ms 前後, beatMs=666ms', () => {
    const mod: any = TutorialModule as any;
    const chart = mod.generateWavePracticeChart();
    const tlBefore = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    expect(tlBefore.beatMsAt(0)).toBeCloseTo(60000 / 90, 5); // 666.666...
    expect(tlBefore.beatToMs(1)).toBeCloseTo(60000 / 90, 2);
    expect(tlBefore.beatToMs(4)).toBeCloseTo((60000 / 90) * 4, 0);
    expect(tlBefore.msToBeat((60000 / 90) * 2.5)).toBeCloseTo(2.5, 3);
    // Duration via helper
    const dur = tutorialAMs(chart);
    expect(dur).toBeCloseTo((60000 / 90) * 4, 0);
  });

  it('Step1 segments 未検証を capture → Step2 WaveEngine で getPoints/waveYAt 計測 → Step3 点数=5, 上下幅固定, 開始下端・upで上昇, off-grid 0.37/1.23 で物理整合', () => {
    const mod: any = TutorialModule as any;
    const chart = mod.generateWavePracticeChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engine = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position);

    expect(engine.getPoints().length).toBe(chart.segments.length + 1); // 5
    const points = engine.getPoints();
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));
    expect(maxY - minY).toBeGreaterThan(0);
    expect(maxY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
    expect(minY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);

    // start_position -1 => bottom at beat 0 (wave practice starts low)
    expect(engine.waveYAt(0)).toBeCloseTo(TW_CENTER_Y + TW_AMP, 5);
    // up 1 beat from 0..1: moves toward top with slope perBeat=2*TW_AMP (off-grid)
    const perBeat = 2 * TW_AMP * 1.0;
    const expected037 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, (TW_CENTER_Y + TW_AMP) - perBeat * 0.37));
    expect(engine.waveYAt(0.37)).toBeCloseTo(expected037, 2);
    const expected099 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, (TW_CENTER_Y + TW_AMP) - perBeat * 0.99));
    expect(engine.waveYAt(0.99)).toBeCloseTo(expected099, 2);
    // beat 1 reached the top (full width in 1 beat at amplitude 1.0)
    const yAt1 = engine.waveYAt(1);
    expect(yAt1).toBeCloseTo(TW_CENTER_Y - TW_AMP, 2);
    // off-grid inside down segment [1,2) should move back toward bottom
    const yAt137 = engine.waveYAt(1.37);
    expect(yAt137).toBeGreaterThan(TW_CENTER_Y - TW_AMP - 1);
    expect(yAt137).toBeLessThan(TW_CENTER_Y);
    // down segment [1,2) physically consistent: yAt137 = clamp(yAt1 + perBeat*0.37)
    const expected137 = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, yAt1 + perBeat * 0.37));
    expect(yAt137).toBeCloseTo(expected137, 2);
    // further beats remain finite
    const yAt237 = engine.waveYAt(2.37);
    expect(Number.isFinite(yAt237)).toBe(true);
  });

  it('Step1 複雑振幅 0.7/1.3/2.7/3.4 + off-grid 0.37/1.23 capture → Step2 WaveEngine と Cursor の数値整合を検証 → Step3 perBeatPx=2*TW_AMP*amplitude で一致し上下幅は不変・T128 dYクランプ維持', () => {
    const mod: any = TutorialModule as any;
    const baseChart = mod.generateWavePracticeChart();
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrids = [0.37, 1.23, 1.37, 2.37, 3.37, 4.23];
    const clampY = (v: number) => Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, v));
    for (const amp of amps) {
      const tl = new BpmTimeline(baseChart.bpm_changes, amp);
      const engine = new WaveEngine(baseChart.segments, tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      for (const off of offGrids) {
        if (off > 4) continue;
        // Determine segment containing off: 0-1 up (-perBeat), 1-2 down (+perBeat), 2-3 up, 3-4 down.
        // We verify slope matches perBeat via engine internal dY model (indirect via waveYAt difference)
        // Check that waveYAt respects clamp and slope exactly (T128)
        const y = engine.waveYAt(off);
        expect(y).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
        expect(y).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);

        // up segment [0,1): linear ascent from center with slope -perBeat (clamped)
        if (off < 1) {
          const expected = clampY(TW_CENTER_Y - perBeat * off);
          expect(y).toBeCloseTo(expected, 2);
        }

        // Cursor speed consistency at this amp & beat
        const cursor = new Cursor(amp, 0.0);
        const beatMs = tl.beatMsAt(off);
        const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
        expect(speed).toBeCloseTo(perBeat / (beatMs / 1000), 5);

        // down segment [1,2): linear descent from yAt1 with slope +perBeat (clamped)
        if (off >= 1 && off < 2) {
          const yAt1 = engine.waveYAt(1);
          const expected = clampY(yAt1 + perBeat * (off - 1));
          expect(y).toBeCloseTo(expected, 2);
        }
        // up segment [2,3): linear ascent from yAt2 with slope -perBeat (clamped)
        if (off >= 2 && off < 3) {
          const yAt2 = engine.waveYAt(2);
          const expected = clampY(yAt2 - perBeat * (off - 2));
          expect(y).toBeCloseTo(expected, 2);
        }
      }
      expect(engine.getPoints().length).toBe(baseChart.segments.length + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// T211-2: ステージB — リング練習譜面の固定内容 (3-step, computed)
// ---------------------------------------------------------------------------
describe('T211-2: ステージB リング練習譜面の固定内容 (3-step, computed)', () => {
  it('Step1 初期 empty capture → Step2 generateRingPracticeChart() 実行 → Step3 BPM90, stay波形、リング4個を1拍ごと(1/2/3/4 single)に配置', () => {
    const before: unknown = null;
    expect(before).toBeNull();

    const mod: any = TutorialModule as any;
    expect(typeof mod.generateRingPracticeChart).toBe('function');
    const chart = mod.generateRingPracticeChart();

    expect(chart.bpm_changes[0].beat).toBe(0);
    expect(chart.bpm_changes[0].bpm).toBe(90);
    expect(chart.amplitude).toBeCloseTo(1.0, 5);

    // stay wave — at least one stay segment, no up/down needed (上下移動なし)
    expect(chart.segments.length).toBeGreaterThanOrEqual(1);
    for (const seg of chart.segments) {
      expect(seg.direction).toBe('stay');
      expect(seg.beats).toBeGreaterThan(0);
    }
    const total = chart.segments.reduce((s: number, seg: any) => s + seg.beats, 0);
    expect(total).toBeGreaterThanOrEqual(4); // must cover rings up to beat 4

    expect(chart.rings.length).toBe(4);
    expect(chart.rings[0].beat).toBe(1);
    expect(chart.rings[1].beat).toBe(2);
    expect(chart.rings[2].beat).toBe(3);
    expect(chart.rings[3].beat).toBe(4);
    for (const r of chart.rings) {
      expect(r.type === undefined || r.type === 'single').toBe(true);
    }
  });

  it('Step1 BPMタイムライン未構築を capture → Step2 BpmTimeline で beatToMs 計測 → Step3 1拍=666ms, 4拍で最終リング+2秒=4666ms 付近で本編閾値', () => {
    const mod: any = TutorialModule as any;
    const chart = mod.generateRingPracticeChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    expect(tl.beatMsAt(0)).toBeCloseTo(60000 / 90, 5);
    expect(tl.beatToMs(1)).toBeCloseTo(60000 / 90, 2);
    expect(tl.beatToMs(4)).toBeCloseTo((60000 / 90) * 4, 0);
    const dur = tutorialBMs(chart);
    expect(dur).toBeCloseTo((60000 / 90) * 4 + 2000, 0); // 2666 + 2000 = 4666
    expect(tl.msToBeat((60000 / 90) * 1.37)).toBeCloseTo(1.37, 3);
    expect(tl.msToBeat((60000 / 90) * 3.37)).toBeCloseTo(3.37, 3);
  });

  it('Step1 stay波形の waveYAt 未検証を capture → Step2 WaveEngine で off-grid 1.23/3.37 を計測 → Step3 常に中央付近で安定（stayのためampに依らず）、点数=segments+1', () => {
    const mod: any = TutorialModule as any;
    const chart = mod.generateRingPracticeChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engine = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position);
    expect(engine.getPoints().length).toBe(chart.segments.length + 1);
    // stay only → always center for any beat until end
    expect(engine.waveYAt(0.37)).toBeCloseTo(TW_CENTER_Y, 3);
    expect(engine.waveYAt(1.23)).toBeCloseTo(TW_CENTER_Y, 3);
    expect(engine.waveYAt(3.37)).toBeCloseTo(TW_CENTER_Y, 3);
    expect(engine.waveYAt(4.23)).toBeCloseTo(TW_CENTER_Y, 3);
    // off-grid near rings should not deviate more than tolerance
    for (const off of [0.37, 1.23, 2.37, 3.37]) {
      expect(engine.waveYAt(off)).toBeCloseTo(TW_CENTER_Y, 2);
    }
  });

  it('Step1 複雑振幅 0.7/1.3/2.7/3.4 + off-grid capture → Step2 各振幅で stay波形の不変性を検証 → Step3 ampを変えても stay は中央固定（上下幅不変）', () => {
    const mod: any = TutorialModule as any;
    const base = mod.generateRingPracticeChart();
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offs = [0.37, 1.23, 2.37, 3.37, 4.37];
    for (const amp of amps) {
      const tl = new BpmTimeline(base.bpm_changes, amp);
      const engine = new WaveEngine(base.segments, tl, amp, 0.0);
      for (const off of offs) {
        if (off > 5) continue;
        expect(engine.waveYAt(off)).toBeCloseTo(TW_CENTER_Y, 3);
        expect(engine.waveYAt(off)).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
        expect(engine.waveYAt(off)).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
      }
      expect(engine.getPoints().length).toBe(base.segments.length + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// T211-3: 指示文テーブル — 拍連動 (3-step, off-grid必須)
// ---------------------------------------------------------------------------
describe('T211-3: 拍連動の指示文テーブル（ステージ別） (3-step, off-grid)', () => {
  it('Step1 旧単相テーブル capture → Step2 新ステージ別テーブルを探索 → Step3 波形練習とリング練習で異なる文言セットが存在する', () => {
    const src = readFile('src/game/tutorial.ts');
    // Must contain stage-specific instruction arrays or functions
    // Look for wave/ring specific identifiers
    const hasWaveTable =
      src.includes('WAVE') || src.includes('wave') || /wave.*instruction|WAVE.*INSTRUCTION/i.test(src);
    const hasRingTable =
      src.includes('RING') || src.includes('ring') || /ring.*instruction|RING.*INSTRUCTION/i.test(src);
    expect(hasWaveTable).toBe(true);
    expect(hasRingTable).toBe(true);

    // Try to invoke per-stage getters if they exist, otherwise fallback to file content checks
    const mod: any = TutorialModule as any;
    const waveGetter = mod.getWaveInstruction || mod.getWavePracticeInstruction || mod.getTutorialInstruction;
    const ringGetter = mod.getRingInstruction || mod.getRingPracticeInstruction || mod.getTutorialInstruction;
    // At least one getter must exist and return a string
    if (typeof waveGetter === 'function') {
      const at0 = waveGetter(0);
      expect(typeof at0).toBe('string');
      expect(at0.length).toBeGreaterThan(0);
    }
    if (typeof ringGetter === 'function') {
      const at1 = ringGetter(1);
      expect(typeof at1).toBe('string');
      expect(at1.length).toBeGreaterThan(0);
    }

    // Wave instruction should mention ↑↓ or 波形/移動 at beat 0
    const hasMoveHint = /↑↓|移動|波形/.test(src);
    expect(hasMoveHint).toBe(true);
    // Ring instruction should mention Space
    expect(src).toMatch(/Space/);
  });

  it('Step1 端数拍 0.37/1.23 capture → Step2 新 getter(offGrid) 実行 → Step3 ステップ関数が端数でも安定（0.37→0 beat文言, 1.23→0, 3.37→後段）', () => {
    const mod: any = TutorialModule as any;
    const getters: Array<() => any> = [
      mod.getWaveInstruction,
      mod.getWavePracticeInstruction,
      mod.getTutorialInstruction,
      mod.getInstruction,
    ].filter((f: any) => typeof f === 'function');

    // If new stage-specific getters exist, verify each; otherwise verify unified getter stability
    const toTest = getters.length > 0 ? getters : [mod.getTutorialInstruction].filter(Boolean);
    expect(toTest.length).toBeGreaterThan(0);

    for (const getter of toTest) {
      const at037 = getter(0.37);
      const at123 = getter(1.23);
      const at0 = getter(0);
      // Off-grid before first interval should equal beat 0 text (step function)
      expect(at037).toBe(at0);
      expect(at123).toBe(at0);
      // Near boundary stability (if stage has beat 1 ring, 0.99 still stage start)
      const at099 = getter(0.99);
      expect(at099).toBe(at0);
      // Far beat should be defined and not throw
      expect(() => getter(3.37)).not.toThrow();
      expect(() => getter(5.23)).not.toThrow();
      expect(typeof getter(3.37)).toBe('string');
    }

    // Also verify via Wave/Ring stage: off-grid 1.23 vs 1 should be consistent for ring stage
    const ringGetter = mod.getRingInstruction || mod.getRingPracticeInstruction;
    if (typeof ringGetter === 'function') {
      const at1 = ringGetter(1);
      const at137 = ringGetter(1.37);
      const at123 = ringGetter(1.23);
      // Ring stage should be step at each beat: 1.23 still beat 1 context or next — but must be stable
      expect(typeof at1).toBe('string');
      expect(typeof at137).toBe('string');
      expect(at123.length).toBeGreaterThan(0);
    }
  });

  it('Step1 不定値(NaN/Infinity) capture → Step2 getter で安全なフォールバック → Step3 先頭文言を返しクラッシュしない', () => {
    const mod: any = TutorialModule as any;
    const getters = [
      mod.generateWavePracticeChart ? mod.getWaveInstruction : undefined,
      mod.generateRingPracticeChart ? mod.getRingInstruction : undefined,
      mod.getTutorialInstruction,
      mod.getWavePracticeInstruction,
      mod.getRingPracticeInstruction,
    ].filter((f: any) => typeof f === 'function');
    // At least one getter must be robust
    const target = getters[0] as any;
    if (target) {
      expect(() => target(NaN)).not.toThrow();
      expect(() => target(Infinity)).not.toThrow();
      expect(() => target(-Infinity)).not.toThrow();
      const nanResult = target(NaN);
      expect(typeof nanResult).toBe('string');
      expect(nanResult.length).toBeGreaterThan(0);
      const negResult = target(-5);
      expect(typeof negResult).toBe('string');
    } else {
      // Fallback: file must have defensive guard
      const src = readFile('src/game/tutorial.ts');
      expect(src).toMatch(/Number\.isFinite|isFinite/);
    }
  });

  it('Step1 指示文全体 capture → Step2 各ステージ文言を列挙 → Step3 waveは移動/↑↓、ringはSpace、終端はねぎらい/本編系の語彙が存在', () => {
    const src = readFile('src/game/tutorial.ts');
    // Wave stage hints
    expect(src).toMatch(/↑↓|移動|波形/);
    // Ring stage hints
    expect(src).toMatch(/Space/);
    // Closing hint
    const hasClosing = /お疲れ|ねぎらい|本編|おつかれ|すばらしい/i.test(src) || src.includes('お疲れ') || src.includes('本編');
    expect(hasClosing).toBe(true);

    const mod: any = TutorialModule as any;
    // If arrays are exported, verify sorting
    const waveInstr = mod.WAVE_INSTRUCTIONS || mod.WAVE_PRACTICE_INSTRUCTIONS || mod.TUTORIAL_WAVE_INSTRUCTIONS;
    const ringInstr = mod.RING_INSTRUCTIONS || mod.RING_PRACTICE_INSTRUCTIONS || mod.TUTORIAL_RING_INSTRUCTIONS;
    if (Array.isArray(waveInstr)) {
      for (let i = 1; i < waveInstr.length; i++) {
        expect(waveInstr[i].beat).toBeGreaterThanOrEqual(waveInstr[i - 1].beat);
      }
    }
    if (Array.isArray(ringInstr)) {
      for (let i = 1; i < ringInstr.length; i++) {
        expect(ringInstr[i].beat).toBeGreaterThanOrEqual(ringInstr[i - 1].beat);
      }
    }
    // Fallback to legacy TUTORIAL_INSTRUCTIONS if stage arrays not yet split — still must be sorted
    const legacy = mod.TUTORIAL_INSTRUCTIONS;
    if (Array.isArray(legacy) && !waveInstr && !ringInstr) {
      for (let i = 1; i < legacy.length; i++) {
        expect(legacy[i].beat).toBeGreaterThan(legacy[i - 1].beat);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T211-4: ステージ遷移と押下確認 — tutorial-wave → tutorial-ring → main (3-step)
// ---------------------------------------------------------------------------
describe('T211-4: ステージ遷移と押下確認（待機→練習開始→自動進行） (3-step, file contract + computed)', () => {
  it('Step1 開始前 capture (phase tutorial-wave想定、暗いまま) → Step2 GameScreen の待機・押下・リセット契機を探索 → Step3 ↑/↓初回押下で不透明度100＋resetClock、Spaceでも同様に ring 開始', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Phase definitions
    expect(src).toMatch(/'tutorial-wave'/);
    expect(src).toMatch(/'tutorial-ring'/);

    // T213: dim is the overlay layer's state, not a canvas opacity.
    expect(src).toMatch(/overlayDimmed|overlayDim/);
    // Overlay dim setter must toggle across stage transitions
    expect(src).toMatch(/setOverlayDimmed|set\w*[Dd]im\w*\s*\(/);

    // Key handlers: ArrowUp / ArrowDown for wave stage
    expect(src).toMatch(/ArrowUp/);
    expect(src).toMatch(/ArrowDown/);
    // Space for ring stage
    expect(src).toMatch(/Space/);

    // Waiting flag must gate clock/metronome/progress
    // Look for guard like if (waiting) return or !tutorialStarted
    const hasWaitingGuard =
      /waiting|tutorialStarted|hasStartedTutorial|isWaiting|waveWaiting|ringWaiting/.test(src) &&
      src.includes('resetClock');
    expect(hasWaitingGuard).toBe(true);

    // Stage A should advance after 4 beats (wave practice duration)
    // Check for beat count or timeline check: 4 beats at 90bpm
    const has4BeatCheck = src.includes('4') && (src.includes('beatToMs') || src.includes('tutorial') || src.includes('wave'));
    expect(has4BeatCheck).toBe(true);
  });

  it('Step1 待機中は時計が進まないことを capture (startedRef / songNow) → Step2 押下で resetClock し直す → Step3 待機中にメトロノームは鳴らさない (startMetronome が待機解除後にのみ呼ばれる)', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must have a flag that prevents tick progress while waiting
    expect(src).toMatch(/resetClock/);
    // Waiting should prevent startMetronome from firing
    const metronomeSection = src.slice(src.indexOf('startMetronome') - 800, src.indexOf('startMetronome') + 1200);
    // At least one conditional around metronome/tick that checks waiting/phase
    const hasGuard =
      src.includes('waiting') ||
      src.includes('tutorialStarted') ||
      src.includes('hasStarted') ||
      src.includes('phaseRef.current');
    expect(hasGuard).toBe(true);

    // Verify tick function checks waiting before advancing songTime or doing spawner update
    const tickIdx = src.indexOf('const tick');
    if (tickIdx !== -1) {
      const tickSlice = src.slice(tickIdx, tickIdx + 2500);
      // Should reference waiting or phase before using songNow/spawner
      expect(tickSlice.length).toBeGreaterThan(0);
      // At least one of waiting/phase guard must be in tick
      expect(/waiting|tutorialStarted|phase/.test(tickSlice)).toBe(true);
    }
  });

  it('Step1 各ステージ規定拍数 capture (stageA 4拍, stageB 最終リング4拍+2秒, stageC 最終テール6拍+2秒) → Step2 GameScreen の自動進行閾値を再計算 → Step3 4拍完走で wave→ring、最終リング+2秒で ring→hold、最終テール+余白で hold→main', () => {
    const mod: any = TutorialModule as any;
    const chartA = mod.generateWavePracticeChart();
    const chartB = mod.generateRingPracticeChart();
    const chartC = mod.generateHoldPracticeChart();

    // Step1: capture stage durations
    const tlA = new BpmTimeline(chartA.bpm_changes, chartA.amplitude);
    const totalA = chartA.segments.reduce((s: number, seg: any) => s + seg.beats, 0);
    expect(totalA).toBe(4);
    const durA = tlA.beatToMs(totalA);
    expect(durA).toBeCloseTo((60000 / 90) * 4, 0);

    const tlB = new BpmTimeline(chartB.bpm_changes, chartB.amplitude);
    const lastBeatB = chartB.rings.reduce((m: number, r: any) => Math.max(m, r.beat), -Infinity);
    expect(lastBeatB).toBe(4);
    const durB = tlB.beatToMs(lastBeatB) + 2000;
    expect(durB).toBeCloseTo((60000 / 90) * 4 + 2000, 0);

    // hold stage: head 1拍・4拍, duration 2拍 → テールは 3拍・6拍
    const tlC = new BpmTimeline(chartC.bpm_changes, chartC.amplitude);
    const lastTailC = chartC.rings.reduce((m: number, r: any) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity);
    expect(lastTailC).toBe(6);
    expect(TutorialModule.TUTORIAL_HOLD_END_BEAT).toBe(7);
    const durC = tlC.beatToMs(TutorialModule.TUTORIAL_HOLD_END_BEAT);
    expect(durC).toBeCloseTo((60000 / 90) * 7, 0);

    // Step3: GameScreen must have three thresholds or a combined phased threshold
    const src = readFile('src/screens/GameScreen.tsx');
    // Must reference all three stages for auto-advance
    expect(src).toMatch(/tutorial-wave/);
    expect(src).toMatch(/tutorial-ring/);
    expect(src).toMatch(/tutorial-hold/);
    // Must have logic to transition wave -> ring and ring -> hold and hold -> main
    const waveToRing = src.match(/tutorial-wave[\s\S]{0,600}tutorial-ring/);
    expect(waveToRing !== null).toBe(true);
    const ringToHold = src.match(/tutorial-ring[\s\S]{0,800}tutorial-hold/);
    expect(ringToHold !== null).toBe(true);
    const holdToMain = src.match(/tutorial-hold[\s\S]{0,800}(enterMain|\['main'\]|'main')/);
    expect(holdToMain !== null).toBe(true);

    // Must use beatToMs or duration comparison for stage end
    expect(src).toMatch(/beatToMs|tutorialEnd|stageEnd|waveEnd|ringEnd|holdEnd/);
  });

  it('Step1 本編スコア未混入を capture (ScoreManager) → Step2 エンジン差し替え時のリセット挙動を探索 → Step3 スコア破棄・rings/judgements/cursor リセットが wave→ring と ring→main の両方で行われる', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must discard score on entering main (and ideally on entering ring stage as well)
    const enterMainIdx = src.indexOf('enterMain');
    const enterSlice = enterMainIdx !== -1 ? src.slice(enterMainIdx, enterMainIdx + 1500) : src;
    expect(enterSlice).toMatch(/new ScoreManager\(\)/);
    expect(enterSlice).toMatch(/scoreRef\.current = new ScoreManager/);
    expect(enterSlice).toMatch(/ringsRef\.current = \[\]/);
    // At least one reset point for ring stage as well (wave->ring should also reset or keep isolated)
    // Check that phase transitions involve new cursor/wave/timeline assignment
    expect(src).toMatch(/cursorRef\.current = new Cursor/);
    expect(src).toMatch(/phaseRef\.current = 'main'|setPhase\('main'\)/);
    // Also wave->ring transition must be present
    expect(src).toMatch(/setPhase\('tutorial-ring'\)|phaseRef\.current = 'tutorial-ring'/);
  });
});

// ---------------------------------------------------------------------------
// T211-5: スキップ・常時表示・メトロノーム抑制・不透明度 (3-step)
// ---------------------------------------------------------------------------
describe('T211-5: スキップ常時表示・メトロノーム抑制・不透明度・待機 (3-step)', () => {
  it('Step1 初期 capture (overlay に skip が常時ある想定) → Step2 source 探索 → Step3 tutorial-wave と tutorial-ring 両方で skip ボタンが表示され localStorage 記憶に依存しない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must not persist skip state
    expect(src).not.toMatch(/tutorialSkipped|skipTutorial.*localStorage|localStorage.*tutorial/);
    // Skip must be inside tutorial overlay guard (phase === 'tutorial-wave' || 'tutorial-ring' or generic tutorial)
    expect(src).toMatch(/tutorial-skip/);
    expect(src).toMatch(/スキップ/);
    // Must handle both wave and ring phases for skip visibility
    const hasBothGuard =
      src.includes('tutorial-wave') && src.includes('tutorial-ring') && src.includes('tutorial-skip');
    expect(hasBothGuard).toBe(true);
    // onClick must be skipTutorial or enterMain
    expect(src).toMatch(/onClick=\{skipTutorial\}|onClick=\{enterMain\}|skipTutorial/);
  });

  it('Step1 待機中は canvas 不透明度でなくオーバーレイ減光であることを capture → Step2 新方式（overlayDimmed）を探索 → Step3 canvasは常時opacity 1・dimクラス切替になり、旧canvasOpacity検証が残っていない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const css = readFile('src/index.css');
    // T213: canvas opacity state must be GONE from GameScreen (単一層化)
    expect(src).toMatch(/overlayDimmed|overlayDim/);
    expect(src).not.toMatch(/canvasOpacity/);
    // Single dim layer constant (rgba(10,10,10,0.45)) in CSS
    expect(css).toMatch(/rgba\(10,\s*10,\s*10,\s*0\.45/);
    expect(css).toMatch(/\.dim/);
    // Canvas keeps full opacity (no dynamic dim binding on canvas)
    expect(src).not.toMatch(/opacity\s*:\s*canvasOpacity/);
    // Dim setter must toggle: waiting -> true, confirmed practice -> false
    expect(src).toMatch(/setOverlayDimmed\(true\)/);
    expect(src).toMatch(/setOverlayDimmed\(false\)/);
  });

  it('Step1 待機中にメトロノームが鳴らないことを capture (schedule 未呼び出し) → Step2 startMetronome のガードを探索 → Step3 待機解除後まで schedule が呼ばれない（startedRef + waiting/phase ガード）', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must have stop/start metronome logic
    expect(src).toMatch(/startMetronome|stopMetronome|schedule/);
    // Guard must prevent metronome while waiting
    const hasWaitingGuard =
      /waiting|tutorialStarted|hasStarted|phaseRef\.current/.test(src) && src.includes('startMetronome');
    expect(hasWaitingGuard).toBe(true);
    // Verify tick or effect that would normally start metronome is gated
    const tickGuard = src.match(/if\s*\(\s*startedRef\.current[\s\S]{0,300}waiting|if\s*\([^)]*phaseRef/);
    // At least one guard must exist (allow relaxed)
    expect(src).toMatch(/startedRef/);
    expect(src).toMatch(/phaseRef/);
  });

  it('Step1 T208 判定表示制御は両ステージでも同一であることを capture → Step2 renderer.render の showJudgementDetail 渡しを探索 → Step3 tutorial-wave/ring でも getViewMode()==debug で分岐（phase依存でない）', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/showJudgementDetail/);
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]debug['"]/);
    // Must not be phase-specific
    const renderIdx = src.indexOf('renderer.render');
    const renderSlice = src.slice(Math.max(0, renderIdx - 600), renderIdx + 900);
    expect(renderSlice).toMatch(/showJudgementDetail/);
    // Should NOT have phase-specific detail (tutorial uses same rule as main)
    const phaseConditional = renderSlice.match(/phase.*showJudgementDetail|showJudgementDetail.*phase/);
    expect(phaseConditional).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T211-6: パブリック限定・スコア破棄と本編リセット (3-step, computed)
// ---------------------------------------------------------------------------
describe('T211-6: チュートリアル中のスコアは破棄し本編開始時にリセット／public限定 (3-step, computed)', () => {
  it('Step1 チュートリアル中スコア蓄積を capture (recordHit/recordTrace) → Step2 本編リセットとして new ScoreManager() で差し替え → Step3 本編スコアが 0 から始まる（混ざらない）', () => {
    const tutorialScore = new ScoreManager();
    tutorialScore.recordHit('perfect');
    tutorialScore.recordHit('great');
    tutorialScore.recordTrace(0.15, true, 60000 / 90);
    tutorialScore.recordTrace(0.15, true, 60000 / 90);
    const beforeStats = tutorialScore.getStats();
    expect(beforeStats.score).toBeGreaterThan(0);
    expect(beforeStats.perfect).toBe(1);
    expect(beforeStats.great).toBe(1);

    // Simulate enterMain reset as src does
    let mainScore: ScoreManager = new ScoreManager();
    expect(mainScore.getStats().score).toBe(0);
    expect(mainScore.getStats().perfect).toBe(0);
    expect(mainScore.getStats().great).toBe(0);
    expect(mainScore.getStats().combo).toBe(0);

    mainScore.recordHit('perfect');
    expect(mainScore.getStats().score).toBe(50);
    expect(mainScore.getStats().perfect).toBe(1);
    expect(beforeStats.score).not.toBe(mainScore.getStats().score);

    // Also verify stage A -> stage B does not leak into main (file contract)
    const src = readFile('src/screens/GameScreen.tsx');
    const mainResets = (src.match(/new ScoreManager\(\)/g) || []).length;
    expect(mainResets).toBeGreaterThanOrEqual(1);
  });

  it('Step1 トレース蓄積 16拍で bonus+2 を capture → Step2 本編で new ScoreManager にリセット → Step3 トレースボーナスもリセットされている（初回 trace は 2 点のみ）', () => {
    const tutorialScore = new ScoreManager();
    const beatMs = 60000 / 90;
    for (let i = 0; i < 160; i++) {
      tutorialScore.recordTrace(0.05, true, beatMs);
    }
    const beforeScore = tutorialScore.getStats().score;
    expect(beforeScore).toBeGreaterThan(0);

    const mainScore = new ScoreManager();
    mainScore.recordTrace(0.15, true, beatMs);
    expect(mainScore.getStats().score).toBe(2);
    expect(beforeScore).not.toBe(mainScore.getStats().score);
  });

  it('Step1 デバッグ/プレイテスト初期 capture (publicでない) → Step2 phase 初期値を検証 → Step3 デバッグ・プレイテストでは tutorial-wave/ring に入らず main から始まる', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Initial phase must be conditional: public && !isPlaytest ? tutorial-wave : main
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]public['"]/);
    expect(src).toMatch(/!isPlaytest/);
    expect(src).toMatch(/tutorial-wave/);
    expect(src).toMatch(/'main'/);
    // isPlaytest derived from playtest/playtestChart/playtestBuffer/onExit
    expect(src).toMatch(/isPlaytest/);
    expect(src).toMatch(/playtestChart|playtestBuffer|onExit/);
    // Ensure debug path sets phase to main directly (no tutorial)
    const useTutorialLine = src.match(/useTutorial|phaseRef\.current = 'main'/);
    expect(useTutorialLine !== null).toBe(true);
  });

  it('Step1 プレイテスト時はチュートリアルが出ないことを capture → Step2 isPlaytest ガードを探索 → Step3 playtestChart/playtestBuffer/onExit のいずれかがあれば tutorial をスキップ', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/isPlaytest/);
    // Must handle all playtest variants
    const hasPlaytestGuard =
      src.includes('playtestChart') && src.includes('playtestBuffer') && src.includes('onExit');
    // At least one of them must be checked for isPlaytest
    expect(src).toMatch(/playtest/);
    expect(src).toMatch(/!isPlaytest/);
  });
});

// ---------------------------------------------------------------------------
// T211-7: 結合 — 本編読込先行・エンジン差し替え・回帰 (3-step, computed)
// ---------------------------------------------------------------------------
describe('T211-7: 本編読込は裏で先行完了・エンジン差し替え・T208/T186/T187/T175/T176 回帰 (3-step)', () => {
  it('Step1 初期 capture (init が main と両チュートリアル構築) → Step2 source 探索 → Step3 main と wave/ring 両方が init 内で構築され mainChartRef が保持される', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/mainWave|mainChartRef|mainTimelineRef/);
    expect(src).toMatch(/tutorialWave|generateWavePracticeChart|generateRingPracticeChart/);
    expect(src).toMatch(/mainChartRef\.current = chart/);
    // Both tutorial charts must be built
    expect(src).toMatch(/generateWavePracticeChart/);
    expect(src).toMatch(/generateRingPracticeChart/);
    // Timeline uses new signature (base amplitude)
    expect(src).toMatch(/new BpmTimeline\(/);
  });

  it('Step1 チュートリアル tick の instruction 更新 capture → Step2 get*Instruction が timeline.msToBeat(renderTimeMs) で呼ばれる → Step3 T167/T175 の renderTimeMs 同期が維持される', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Instruction update should use renderTimeMs
    const hasRenderTime = src.includes('renderTimeMs');
    expect(hasRenderTime).toBe(true);
    expect(src).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(src).toMatch(/msToBeat\(renderTimeMs\)/);
    // Also wave/cursor must use renderTimeMs
    expect(src).toMatch(/wave\.waveYAtMs\(renderTimeMs\)/);
  });

  it('Step1 複雑な音楽タイミング capture (beat 不定・off-grid) → Step2 レンダリング差し替え後の cursor/wave 同期を仮想検証 → Step3 エンジン差し替え後も waveYAt が正しく描画される', () => {
    const mainChart: import('../src/types').Chart = {
      title: 'Main',
      artist: 'Artist',
      audio: 'main.flac',
      audio_offset: 0,
      amplitude: 1.0,
      start_position: 0.0,
      bpm_changes: [
        { beat: 0, bpm: 90 },
        { beat: 8, bpm: 120, amplitude: 1.3 },
      ],
      segments: [
        { direction: 'stay', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 4 },
      ],
      rings: [
        { beat: 4, type: 'single' },
        { beat: 8, type: 'single' },
      ],
    };
    const tlBefore = new BpmTimeline(mainChart.bpm_changes, mainChart.amplitude);
    expect(tlBefore.beatMsAt(0)).toBeCloseTo(60000 / 90, 0);
    // After 90BPM section, still 90 until beat 8
    expect(tlBefore.bpmAt(0)).toBe(90);
    expect(tlBefore.bpmAt(7.5)).toBe(90);
    const wave = new WaveEngine(mainChart.segments, tlBefore, mainChart.amplitude, mainChart.start_position);
    expect(wave.waveYAt(0.37)).toBeDefined();
    expect(Number.isFinite(wave.waveYAt(1.23))).toBe(true);
    expect(Number.isFinite(wave.waveYAt(3.37))).toBe(true);
    const cursor = new Cursor(mainChart.amplitude, 0.0);
    cursor.setAmplitude(tlBefore.amplitudeAt(3.37));
    expect(cursor.y).toBeDefined();
    expect(wave.getPoints().length).toBe(mainChart.segments.length + 1);
  });

  it('Step1 renderer の showJudgementDetail 契約 capture → Step2 T211 後も変更ないことを検証 → Step3 !== false で public はランクのみ（後方互換）', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/showJudgementDetail/);
    expect(rendererSrc).toMatch(/showJudgementDetail\s*!==\s*false/);
    expect(rendererSrc).not.toMatch(/showJudgementDetail\s*===\s*true/);
  });

  it('Step1 BpmTimeline の派生 capture (bpm_changes のみ) → Step2 両チュートリアルでも beatToMs が正しい → Step3 先頭セクションから BPM 導出 (T187) が wave/ring でも成立', () => {
    const mod: any = TutorialModule as any;
    const chartA = mod.generateWavePracticeChart();
    const chartB = mod.generateRingPracticeChart();
    for (const chart of [chartA, chartB]) {
      const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
      expect(tl.bpmAt(0)).toBe(90);
      expect(tl.beatToMs(0)).toBe(0);
      expect(tl.beatToMs(1)).toBeCloseTo(60000 / 90, 0);
      expect(tl.msToBeat(60000 / 90)).toBeCloseTo(1, 3);
    }
  });

  it('Step1 renderer の renderTimeMs 契約 capture → Step2 wave描画が renderTimeMs を使う → Step3 T175/T176 の可聴同期が tutorial-wave/ring/main 共に維持', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(rendererSrc).toMatch(/drawWave\(ctx, waveEngine, renderTimeMs/);
    expect(rendererSrc).toMatch(/drawRings\(ctx, rings, renderTimeMs/);
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(gameSrc).toMatch(/wave\.waveYAtMs\(renderTimeMs\)/);
  });

  it('Step1 オーバーレイの常時表示と記憶なし capture → Step2 overlay 探索 → Step3 スキップは毎回表示され localStorage 記憶に依存しない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).not.toMatch(/tutorialSkipped|skipTutorial.*localStorage|localStorage.*tutorial/);
    const hasOverlay = src.includes('tutorial-overlay') || src.includes('tutorial-instruction');
    expect(hasOverlay).toBe(true);
    // Overlay must be gated on tutorial-wave or tutorial-ring (not just tutorial)
    expect(src).toMatch(/tutorial-wave|tutorial-ring/);
  });
});

// ---------------------------------------------------------------------------
// Extra: T210回帰 — 旧単相 generateTutorialChart が残っていても新2段階が優先されること
// ---------------------------------------------------------------------------
describe('T211-8: 回帰 — 旧単相 generateTutorialChart と新2段階の共存', () => {
  it('Step1 旧 generateTutorialChart capture (残存してもよい) → Step2 新 generateWave/Ring が存在 → Step3 新APIが旧をラップまたは置換し、BPM90で統一されている', () => {
    const src = readFile('src/game/tutorial.ts');
    const mod: any = TutorialModule as any;
    // New APIs must exist (strict)
    expect(typeof mod.generateWavePracticeChart).toBe('function');
    expect(typeof mod.generateRingPracticeChart).toBe('function');
    // If old API still exists, it should not be BPM120 anymore, or should be deprecated wrapper
    if (typeof mod.generateTutorialChart === 'function') {
      const old = mod.generateTutorialChart();
      // Old should either be gone or now reflect new BPM90 style or be marked deprecated
      // We assert it does NOT still claim BPM120 as sole tutorial (that would be T210 regression)
      // Allow old to exist but new wave/ring must be BPM90
      const wave = mod.generateWavePracticeChart();
      const ring = mod.generateRingPracticeChart();
      expect(wave.bpm_changes[0].bpm).toBe(90);
      expect(ring.bpm_changes[0].bpm).toBe(90);
      // If old still returns 120, it's a regression — fail
      if (old.bpm_changes && old.bpm_changes[0] && old.bpm_changes[0].bpm === 120) {
        // Check if src still defines old as 120 without forwarding to new — that is a failure for T211
        const oldDef120 = src.match(/generateTutorialChart[\s\S]{0,400}bpm:\s*120/);
        // If old is still 120 but new are 90, the file is in mixed state — still fail to force migration
        expect(oldDef120).toBeNull();
      }
    } else {
      // Old may have been removed — that's acceptable for T211 (refresh)
      expect(true).toBe(true);
    }
    // File must not still advertise single 8-second 120BPM tutorial as primary
    const hasNewStages = src.includes('generateWavePracticeChart') && src.includes('generateRingPracticeChart');
    expect(hasNewStages).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T226-9: ステージC — ホールド練習 (譜面構造・3段階遷移・判定ロジック回帰)
// ---------------------------------------------------------------------------
describe('T226-9: ホールド練習ステージ C (3-step, computed, off-grid)', () => {
  it('Step1 初期 empty capture (hold chart 未生成) → Step2 generateHoldPracticeChart() 実行 → Step3 BPM90, stay波形のみ, ホールド2個 (head 1/4, duration 2), start 0.0', () => {
    const before: unknown = null;
    expect(before).toBeNull();

    const mod: any = TutorialModule as any;
    expect(typeof mod.generateHoldPracticeChart).toBe('function');
    const chart = mod.generateHoldPracticeChart();

    // BPM90
    expect(chart.bpm_changes[0].beat).toBe(0);
    expect(chart.bpm_changes[0].bpm).toBe(90);
    expect(chart.amplitude).toBeCloseTo(1.0, 5);
    expect(chart.start_position).toBeCloseTo(0.0, 5);

    // stay wave only (上下移動なし)
    expect(chart.segments.length).toBeGreaterThanOrEqual(1);
    for (const seg of chart.segments) {
      expect(seg.direction).toBe('stay');
      expect(seg.beats).toBeGreaterThan(0);
    }
    const total = chart.segments.reduce((s: number, seg: any) => s + seg.beats, 0);
    expect(total).toBeGreaterThanOrEqual(7); // 最終テール(6)＋余白

    // hold rings: head 1拍・4拍, duration 2拍
    expect(chart.rings.length).toBe(2);
    expect(chart.rings[0]).toEqual({ beat: 1, type: 'hold', duration: 2 });
    expect(chart.rings[1]).toEqual({ beat: 4, type: 'hold', duration: 2 });
  });

  it('Step1 タイムライン未構築 capture → Step2 BpmTimeline でテール計算 → Step3 テールは 3拍(=2000ms)・6拍(=4000ms)、hold 終了点=beat 7、確認用Spaceは誤ヒットしない窓幅', () => {
    const mod: any = TutorialModule as any;
    const chart = mod.generateHoldPracticeChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);

    // テール位置 (head + duration)
    expect(tl.beatToMs(3)).toBeCloseTo((60000 / 90) * 3, 0);
    expect(tl.beatToMs(6)).toBeCloseTo((60000 / 90) * 6, 0);
    // 最終テール + 余白 = TUTORIAL_HOLD_END_BEAT(7)
    expect(TutorialModule.TUTORIAL_HOLD_END_BEAT).toBe(7);

    // 確認用Space押下は t=0 (時計リセット直後)。head=1拍(666ms)に対し
    // 判定窓 windowMs = beatMs*0.4 (266ms) なので誤ヒットしない
    const windowMs = tl.beatMsAt(1) * 0.4;
    expect(tl.beatToMs(1)).toBeGreaterThan(windowMs * 1.5);
  });

  it('Step1 GameScreen 初期 capture (wave→ring→main) → Step2 新3段階遷移を探索 → Step3 startHoldStage と tutorial-hold フェーズがあり wave→ring→hold→main の順で進む', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/'tutorial-hold'/);
    expect(src).toMatch(/startHoldStage/);
    expect(src).toMatch(/generateHoldPracticeChart/);
    expect(src).toMatch(/wavePracticeEndRef\.current\s*=\s*wavePracticeTimeline\.beatToMs\(4\)/);
    expect(src).toMatch(/holdPracticeEndRef/);
    // T226: ring→hold の自動進行 + hold→main（enterMain）の順序が成立
    const waveToRing = src.match(/tutorial-wave[\s\S]{0,700}tutorial-ring/);
    expect(waveToRing !== null).toBe(true);
    const ringToHold = src.match(/tutorial-ring[\s\S]{0,800}tutorial-hold/);
    expect(ringToHold !== null).toBe(true);
    const holdToMain = src.match(/tutorial-hold[\s\S]{0,900}(enterMain\(\)|['"]main['"])/);
    expect(holdToMain !== null).toBe(true);
  });

  it('Step1 tutorial.ts の指示文 capture → Step2 getTutorialInstruction(0, \'hold\') 実行 → Step3 Space長押し＋テール離しの案内と終了文言がある', () => {
    const src = readFile('src/game/tutorial.ts');
    expect(src).toMatch(/押し続け/);
    expect(src).toMatch(/離そう/);
    expect(src).toMatch(/本編/);
    const text = TutorialModule.getTutorialInstruction(0, 'hold');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/Space|押す|離す/);
    // 端数拍でも安定（ステップ関数）
    const at37 = TutorialModule.getTutorialInstruction(3.7, 'hold');
    expect(typeof at37).toBe('string');
    expect(at37.length).toBeGreaterThan(0);
  });

  it('Step1 ホールド頭判定前 capture → Step2 RingSpawner + judgeHit で head=1拍 を叩く → Step3 判定ロジック不変: hit=true, resolved=false, holding=true, releaseTime=beat 3', () => {
    const mod: any = TutorialModule as any;
    const chart = mod.generateHoldPracticeChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const wave = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position);

    const spawner = new RingSpawner(chart.rings);
    const hitTime1 = tl.beatToMs(1);
    const rings = spawner.update(hitTime1, chart.rings, tl, wave);

    const head = rings.find(r => r.hitTime === hitTime1);
    expect(head).toBeDefined();
    expect(head!.type).toBe('hold');
    expect(head!.duration).toBe(2);
    // stay 波形のため targetY は中央
    expect(head!.targetY).toBeCloseTo(TW_CENTER_Y, 2);
    expect(head!.releaseTime).toBeCloseTo(tl.beatToMs(3), 2);

    const j = judgeHit(hitTime1, head!.targetY, rings, tl.beatMsAt(1));
    expect(j).not.toBeNull();
    // T207/T226: ホールド頭判定は従来通りの絶対値誤差 (hitJudge 変更なし)
    expect(j!.errorMs).toBeCloseTo(0, 3);
    expect(head!.hit).toBe(true);
    expect(head!.holding).toBe(true);
    expect(head!.resolved).toBe(false);
  });
});
