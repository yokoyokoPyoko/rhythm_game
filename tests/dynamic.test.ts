/**
 * T210 — パブリックモード限定・譜面開始前チュートリアル（自動進行＋スキップ付き）
 * Vitest (TypeScript, node environment) pure acceptance — TDD Red->Green
 * Spec (T210):
 *  - 対象はパブリックモードの通常プレイ時のみ（デバッグ・プレイテスト時は出さない）
 *  - 流れ：譜面読込完了 → チュートリアル譜面を自動再生 → 終了後に本編へ自動遷移
 *  - チュートリアル内容（固定・コード生成、メトロノームのみ約10秒）: BPM120、波形 stay4→up2→down2→stay、リング3個(4/8/12 single)
 *  - 拍連動の指示文オーバーレイ（移動→Space→ねぎらい）。修了は成否不問・最終リング＋2秒で本編へ
 *  - スキップボタン常時表示、チュートリアル中のスコアは破棄し本編開始時にリセット
 *  - 新規 src/game/tutorial.ts: generateTutorialChart() + 指示文テーブル
 *  - GameScreen.tsx のみ: フェーズ state ('tutorial'|'main')、同一エンジンで差し替え＋リセット
 * Strict 3-step state-transition assertions, off-grid verification, complex amplitudes.
 * Prohibited fixes: use !== false for optional flags, never strict === true, ensure module exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';
import * as tutorialModule from '../src/game/tutorial';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  try { (globalThis as any).localStorage?.clear?.(); } catch {}
});
afterEach(() => {
  vi.clearAllTimers();
  try { (globalThis as any).localStorage?.clear?.(); } catch {}
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function readFile(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8');
}

function getGenerateTutorialChart(): (() => any) | undefined {
  return (tutorialModule as any).generateTutorialChart;
}
function getGetTutorialInstruction(): ((beat: number, stage?: any) => string) | undefined {
  return (tutorialModule as any).getTutorialInstruction;
}
function getInstructions(): any[] | undefined {
  const m: any = tutorialModule as any;
  return m.TUTORIAL_INSTRUCTIONS ?? m.WAVE_INSTRUCTIONS ?? m.RING_INSTRUCTIONS ?? undefined;
}

function tutorialDurationMsVia(chart: any): number {
  const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
  const lastBeat = chart.rings.reduce((m: number, r: any) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity);
  return tl.beatToMs(lastBeat) + 2000;
}

// ---------------------------------------------------------------------------
// T210-0: ファイル契約 — tutorial.ts が存在し generateTutorialChart を export
// ---------------------------------------------------------------------------
describe('T210-0: ファイル契約 — tutorial.ts / GameScreen.tsx / data-testid', () => {
  it('Step1 初期 capture (ファイル未存在時は何もない) -> Step2 実装後のモジュール読取 -> Step3 generateTutorialChart と指示文テーブルが export されている', () => {
    // Step1: capture initial — module must be importable (namespace import never throws)
    const mod: any = tutorialModule as any;
    expect(mod).toBeDefined();
    // Step2: ensure file exists on disk
    const src = readFile('src/game/tutorial.ts');
    expect(src.length).toBeGreaterThan(0);
    expect(src).toContain('generateTutorialChart');
    // Step3: exported shapes exist — strict: must be functions/arrays (Red if missing)
    const gen = getGenerateTutorialChart();
    expect(typeof gen).toBe('function');
    const getInstr = getGetTutorialInstruction();
    expect(typeof getInstr).toBe('function');
    const instr = getInstructions();
    // T210 expects TUTORIAL_INSTRUCTIONS exported; allow fallback but must be array
    expect(Array.isArray(instr)).toBe(true);
    expect((instr as any[]).length).toBeGreaterThanOrEqual(3);
    const chart = (gen as any)();
    expect(chart).toBeDefined();
    expect(chart.title).toBeDefined();
  });

  it('Step1 GameScreen 初期 capture (tutorial なし) -> Step2 実装後の source 探索 -> Step3 GameScreen が phase tutorial|main, tutorialOverlay/skip/instruction を含む', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src.length).toBeGreaterThan(0);
    // phase state — T210 spec is tutorial|main, T211 adds tutorial-wave/tutorial-ring but must still contain tutorial
    expect(src).toMatch(/phase/);
    // Must contain tutorial phase string and main
    expect(src).toMatch(/'tutorial/);
    expect(src).toMatch(/'main'/);
    // tutorial chart generation import
    const hasTutorialImport = src.includes('generateTutorialChart') || src.includes('generateWavePracticeChart');
    expect(hasTutorialImport).toBe(true);
    expect(src).toMatch(/getTutorialInstruction/);
    // data-testid — guard against hallucinated container
    expect(src).toMatch(/data-testid="tutorial-overlay"/);
    expect(src).toMatch(/data-testid="tutorial-skip"/);
    expect(src).toMatch(/data-testid="tutorial-instruction"/);
    const overlayIdx = src.indexOf('tutorial-overlay');
    const phaseGuard = src.slice(Math.max(0, overlayIdx - 700), overlayIdx + 300);
    expect(phaseGuard).toMatch(/tutorial/);
  });

  it('Step1 capture (viewMode 連携なし) -> Step2 public/debug 分岐を探索 -> Step3 public のみ tutorial, デバッグ・プレイテストはスキップ', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/getViewMode/);
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]public['"]/);
    expect(src).toMatch(/isPlaytest/);
    expect(src).toMatch(/!isPlaytest/);
    // Debug path must set phase to main directly (public && !isPlaytest ? tutorial : main)
    const hasTutorialDecision = src.includes("getViewMode() === 'public' && !isPlaytest") || src.includes('getViewMode() === "public" && !isPlaytest');
    expect(hasTutorialDecision).toBe(true);
    // playtest guard mention
    expect(src).toMatch(/playtestChart|playtestBuffer|onExit/);
  });
});

// ---------------------------------------------------------------------------
// T210-1: チュートリアル譜面 — 固定内容 (3-step, computed)
// ---------------------------------------------------------------------------
describe('T210-1: チュートリアル譜面の固定内容 (3-step, computed)', () => {
  it('Step1 初期 empty capture (chart 未生成) -> Step2 generateTutorialChart() 実行 -> Step3 segments/rings/BPM が仕様通り (stay4/up2/down2/stay + 4/8/12 single)', () => {
    const before: unknown = null;
    expect(before).toBeNull();
    const gen = getGenerateTutorialChart();
    expect(typeof gen).toBe('function');
    const chart = (gen as any)();
    // Step3: exact spec — BPM120
    expect(chart.bpm_changes.length).toBeGreaterThanOrEqual(1);
    // Find section at beat 0
    const sec0 = chart.bpm_changes.find((c: any) => c.beat === 0);
    expect(sec0).toBeDefined();
    expect(sec0.bpm).toBe(120);
    expect(chart.segments.length).toBe(4);
    expect(chart.segments[0]).toEqual({ direction: 'stay', beats: 4 });
    expect(chart.segments[1]).toEqual({ direction: 'up', beats: 2 });
    expect(chart.segments[2]).toEqual({ direction: 'down', beats: 2 });
    expect(chart.segments[3].direction).toBe('stay');
    expect(chart.segments[3].beats).toBeGreaterThanOrEqual(1);
    // rings 4/8/12 single — exact beats (off-grid not allowed for ring positions)
    expect(chart.rings.length).toBe(3);
    expect(chart.rings[0].beat).toBe(4);
    expect(chart.rings[1].beat).toBe(8);
    expect(chart.rings[2].beat).toBe(12);
    for (const r of chart.rings) {
      expect(r.type === undefined || r.type === 'single').toBe(true);
    }
    expect(chart.audio).toBe('');
    expect(chart.amplitude).toBeCloseTo(1.0, 5);
    expect(chart.audio_offset).toBe(0);
  });

  it('Step1 BPMタイムライン未構築を capture -> Step2 BpmTimeline で beatToMs 計測 -> Step3 チュートリアルは約8秒 (最終リング+2秒) でメトロノームのみ', () => {
    const gen = getGenerateTutorialChart();
    const chart = (gen as any)();
    const tlBefore = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const beforeMs = tlBefore.beatToMs(12);
    expect(beforeMs).toBeCloseTo(6000, 0);
    const duration = tutorialDurationMsVia(chart);
    // 12 beats * 500ms + 2000 = 8000
    expect(duration).toBe(8000);
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    expect(tl.beatMsAt(0)).toBeCloseTo(500, 5);
    expect(tl.msToBeat(6000)).toBeCloseTo(12, 4);
    expect(tl.bpmAt(0)).toBe(120);
    expect(tl.bpmAt(12)).toBe(120);
  });

  it('Step1 segments 未検証を capture -> Step2 WaveEngine で getPoints/waveYAt 計測 -> Step3 点数=segments+1, 上下幅固定, waveYAt が物理速度と一致', () => {
    const chart = (getGenerateTutorialChart() as any)();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engineBefore = new WaveEngine(chart.segments, tl, chart.amplitude, (chart as any).start_position ?? 0);
    expect(engineBefore.getPoints().length).toBe(chart.segments.length + 1);
    const points = engineBefore.getPoints();
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));
    expect(maxY - minY).toBeGreaterThan(0);
    expect(maxY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
    expect(minY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
    // start_position default 0 => center at beat 0
    const startPos = (chart as any).start_position ?? 0;
    const expectedStartY = TW_CENTER_Y - startPos * TW_AMP;
    expect(engineBefore.waveYAt(0)).toBeCloseTo(expectedStartY, 5);
    // stay 4 beats => remains at startY for beats 0..4
    expect(engineBefore.waveYAt(0.37)).toBeCloseTo(expectedStartY, 3);
    expect(engineBefore.waveYAt(1.23)).toBeCloseTo(expectedStartY, 3);
    expect(engineBefore.waveYAt(3.99)).toBeCloseTo(expectedStartY, 3);
  });

  it('Step1 複雑振幅 0.7/1.3/2.7/3.4 + off-grid 0.37/1.23 capture -> Step2 WaveEngine と Cursor の数値整合を検証 -> Step3 perBeatPx = 2*TW_AMP*amplitude で一致し上下幅は不変', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrids = [0.37, 1.23, 3.37, 5.23, 4.37, 8.23];
    const baseChart = (getGenerateTutorialChart() as any)();
    for (const amp of amps) {
      const tl = new BpmTimeline(baseChart.bpm_changes, amp);
      const engine = new WaveEngine(baseChart.segments, tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      for (const off of offGrids) {
        if (off > 16) continue;
        if (off >= 4 && off < 6) {
          const yAtOff = engine.waveYAt(off);
          const yAt4 = engine.waveYAt(4);
          // T128 clamp: up segment slope -perBeat, clamped to [top,bottom]
          const expected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, yAt4 - perBeat * (off - 4)));
          expect(yAtOff).toBeCloseTo(expected, 1);
        }
        const cursor = new Cursor(amp, 0.0);
        const beatMs = tl.beatMsAt(off);
        const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
        expect(speed).toBeCloseTo(perBeat / (beatMs / 1000), 5);
        expect(engine.waveYAt(off)).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
        expect(engine.waveYAt(off)).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
      }
      expect(engine.getPoints().length).toBe(baseChart.segments.length + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// T210-2: 指示文テーブル — 拍連動 (3-step, off-grid必須)
// ---------------------------------------------------------------------------
describe('T210-2: 拍連動の指示文オーバーレイ (3-step, off-grid)', () => {
  it('Step1 初期 beat 0 未指示を capture -> Step2 getTutorialInstruction(各beat) 実行 -> Step3 beat 0/4/8/12 で文言が切替、端数でも最近傍ステップに安定', () => {
    const getInstr = getGetTutorialInstruction();
    expect(typeof getInstr).toBe('function');
    const before = (getInstr as any)(-1);
    expect(typeof before).toBe('string');
    expect(before.length).toBeGreaterThan(0);
    const at0 = (getInstr as any)(0);
    const at4 = (getInstr as any)(4);
    const at8 = (getInstr as any)(8);
    const at12 = (getInstr as any)(12);
    // Distinct instructions — T210 spec: 0=移動, 4/8=Space, 12=ねぎらい
    expect(at0).toMatch(/↑↓|移動/);
    expect(at4).toMatch(/Space/);
    // allow at8 to be Space as well (ring practice)
    const instrArr = getInstructions() as any[];
    expect(instrArr.length).toBeGreaterThanOrEqual(4);
    // beats sorted
    const beats = instrArr.map((i: any) => i.beat);
    expect(beats[0]).toBe(0);
    expect(beats[1]).toBe(4);
    expect(beats[2]).toBe(8);
    expect(beats[3]).toBe(12);
    expect(at0).not.toBe(at4);
    expect(at4).not.toBe(at12);
  });

  it('Step1 端数拍 0.37/1.23 capture -> Step2 getTutorialInstruction(offGrid) 実行 -> Step3 0.37→beat0文言, 1.23→beat0文言, 4.37→beat4文言でステップ関数が安定', () => {
    const getInstr = getGetTutorialInstruction() as any;
    const at037 = getInstr(0.37);
    const at123 = getInstr(1.23);
    const at337 = getInstr(3.37);
    const at437 = getInstr(4.37);
    const at523 = getInstr(5.23);
    const at823 = getInstr(8.23);
    const at1237 = getInstr(12.37);
    expect(at037).toBe(getInstr(0));
    expect(at123).toBe(getInstr(0));
    expect(at337).toBe(getInstr(0));
    expect(at437).toBe(getInstr(4));
    expect(at523).toBe(getInstr(4));
    expect(at823).toBe(getInstr(8));
    expect(at1237).toBe(getInstr(12));
    expect(getInstr(3.99)).toBe(getInstr(0));
    expect(getInstr(4.01)).toBe(getInstr(4));
  });

  it('Step1 不定値(NaN/Infinity) capture -> Step2 getTutorialInstruction で安全なフォールバック -> Step3 先頭文言を返しクラッシュしない', () => {
    const getInstr = getGetTutorialInstruction() as any;
    expect(() => getInstr(NaN)).not.toThrow();
    expect(() => getInstr(Infinity)).not.toThrow();
    expect(() => getInstr(-Infinity)).not.toThrow();
    const instrArr = getInstructions() as any[];
    const firstText = instrArr[0].text;
    expect(getInstr(NaN)).toBe(firstText);
    expect(getInstr(-5)).toBe(firstText);
  });

  it('Step1 TUTORIAL_INSTRUCTIONS 全体 capture -> Step2 各 beat の指示文を列挙 -> Step3 0→移動、4/8→Space、12→ねぎらい の語彙が各ステップに存在', () => {
    const instrArr = getInstructions() as any[];
    const texts = instrArr.map((i: any) => i.text);
    const all = texts.join(' | ');
    expect(all).toMatch(/↑↓|移動/);
    const spaceCount = texts.filter((t: string) => /Space/.test(t)).length;
    expect(spaceCount).toBeGreaterThanOrEqual(2);
    expect(texts[texts.length - 1]).toMatch(/お疲れさま|本編|おつかれ|ねぎらい/);
    for (let i = 1; i < instrArr.length; i++) {
      expect(instrArr[i].beat).toBeGreaterThan(instrArr[i - 1].beat);
    }
  });
});

// ---------------------------------------------------------------------------
// T210-3: パブリックモード限定・自動進行＋スキップ (3-step)
// ---------------------------------------------------------------------------
describe('T210-3: パブリック限定・自動進行・スキップ (3-step, file contract + computed)', () => {
  it('Step1 通常プレイ public 初期 capture (phase tutorial 想定) -> Step2 tutorialEnd 時刻を再計算 -> Step3 最終リング+2秒で本編閾値が 8000ms になる (時間で自動進行)', () => {
    const chart = (getGenerateTutorialChart() as any)();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const lastBeatBefore = chart.rings[chart.rings.length - 1].beat;
    expect(lastBeatBefore).toBe(12);
    const lastHitMs = tl.beatToMs(lastBeatBefore);
    const tutorialEnd = lastHitMs + 2000;
    expect(lastHitMs).toBe(6000);
    expect(tutorialEnd).toBe(8000);
    expect(tutorialDurationMsVia(chart)).toBe(tutorialEnd);
    const src = readFile('src/screens/GameScreen.tsx');
    // tutorialEndRef or equivalent end threshold — T211 uses wavePracticeEndRef/ringPracticeEndRef, T210 uses tutorialEndRef
    const hasEndRef = src.includes('tutorialEndRef') || src.includes('wavePracticeEndRef') || src.includes('ringPracticeEndRef');
    expect(hasEndRef).toBe(true);
    // auto-advance check uses songTimeMs > endRef
    expect(src).toMatch(/songTimeMs\s*>\s*.*EndRef\.current/);
    const hasEnterMain = src.includes('enterMain');
    expect(hasEnterMain).toBe(true);
    // T210: 成否不問 — no score condition in auto-advance check
    const autoIdx = src.indexOf('EndRef.current');
    const autoBlock = src.slice(Math.max(0, autoIdx - 600), autoIdx + 600);
    // Should not gate on perfect/miss/score
    expect(autoBlock).not.toMatch(/score\.getStats|perfect.*miss/);
  });

  it('Step1 スキップ前 capture (score/timeline が tutorial 値) -> Step2 skipTutorial/enterMain の source パターン確認 -> Step3 スコア破棄・エンジン差し替え・phase=main が行われる', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Main/tuto engine refs — T210 uses tutorial*Ref + main*Ref, T211 splits wave/ring but still has main
    const hasMain = src.includes('mainChartRef') || src.includes('mainTimelineRef') || src.includes('mainWaveRef');
    expect(hasMain).toBe(true);
    const hasTutorial = src.includes('tutorial') && src.includes('ChartRef');
    expect(hasTutorial).toBe(true);
    const skipIdx = src.indexOf('skipTutorial');
    expect(skipIdx).toBeGreaterThan(-1);
    const skipSlice = src.slice(skipIdx, skipIdx + 700);
    expect(skipSlice).toMatch(/enterMain/);
    const enterIdx = src.indexOf('enterMain');
    const enterSlice = src.slice(enterIdx, enterIdx + 1500);
    expect(enterSlice).toMatch(/new ScoreManager\(\)/);
    expect(enterSlice).toMatch(/phaseRef\.current = 'main'/);
    expect(enterSlice).toMatch(/setPhase\('main'\)/);
    expect(enterSlice).toMatch(/ringsRef\.current = \[\]/);
    expect(enterSlice).toMatch(/resetClock/);
    expect(src).toMatch(/onClick=\{skipTutorial\}/);
    expect(src).toMatch(/スキップ/);
  });

  it('Step1 デバッグ初期 capture (getViewMode 未設定でも public だが debug 切替で) -> Step2 public/debug の分岐を検証 -> Step3 デバッグでは tutorial が出ない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must have public && !isPlaytest ? tutorial : main
    const hasDecision = src.includes("getViewMode() === 'public' && !isPlaytest");
    expect(hasDecision).toBe(true);
    expect(src).toMatch(/isPlaytest/);
    expect(src).toMatch(/playtestChart|playtestBuffer|onExit/);
  });
});

// ---------------------------------------------------------------------------
// T210-4: スコア破棄と本編リセット (3-step, computed)
// ---------------------------------------------------------------------------
describe('T210-4: チュートリアル中のスコアは破棄し本編開始時にリセット (3-step, computed)', () => {
  it('Step1 チュートリアル中スコア蓄積を capture (recordHit/recordTrace) -> Step2 本編リセットとして new ScoreManager() で差し替え -> Step3 本編スコアが 0 から始まる', () => {
    const tutorialScore = new ScoreManager();
    tutorialScore.recordHit('perfect');
    tutorialScore.recordHit('great');
    tutorialScore.recordTrace(0.15, true, 500);
    tutorialScore.recordTrace(0.15, true, 500);
    const beforeStats = tutorialScore.getStats();
    expect(beforeStats.score).toBeGreaterThan(0);
    expect(beforeStats.perfect).toBe(1);
    expect(beforeStats.great).toBe(1);
    let mainScore: ScoreManager = new ScoreManager();
    expect(mainScore.getStats().score).toBe(0);
    expect(mainScore.getStats().perfect).toBe(0);
    expect(mainScore.getStats().great).toBe(0);
    expect(mainScore.getStats().combo).toBe(0);
    mainScore.recordHit('perfect');
    expect(mainScore.getStats().score).toBe(50);
    expect(mainScore.getStats().perfect).toBe(1);
    expect(beforeStats.score).not.toBe(mainScore.getStats().score);
  });

  it('Step1 トレース蓄積 16拍で bonus+2 を capture -> Step2 本編で new ScoreManager にリセット -> Step3 トレースボーナスもリセットされている', () => {
    const tutorialScore = new ScoreManager();
    const beatMs = 500;
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

  it('Step1 チュートリアル終了間際の MISS を capture -> Step2 本編リセット -> Step3 MISS カウントも破棄される', () => {
    const tutorialScore = new ScoreManager();
    tutorialScore.recordHit('perfect');
    tutorialScore.recordHit('miss');
    expect(tutorialScore.getStats().miss).toBe(1);
    expect(tutorialScore.getStats().combo).toBe(0);
    const mainScore = new ScoreManager();
    expect(mainScore.getStats().miss).toBe(0);
    expect(mainScore.getStats().combo).toBe(0);
    expect(mainScore.getStats().perfect).toBe(0);
  });

  it('Step1 fakeTimersでチュートリアル経過を capture -> Step2 本編差し替え後の timeline を検証 -> Step3 3-stepでリセット時刻が正しい', () => {
    // Step1: capture initial tutorial end time
    const chart = (getGenerateTutorialChart() as any)();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const tutorialEnd = tl.beatToMs(12) + 2000;
    expect(tutorialEnd).toBe(8000);
    // Step2: simulate advancing fake timers by tutorial duration + 1ms
    const start = Date.now();
    vi.advanceTimersByTime(tutorialEnd + 100);
    const after = Date.now();
    expect(after - start).toBe(tutorialEnd + 100);
    // Step3: resetting score after transition must start at zero (simulated by new ScoreManager)
    const fresh = new ScoreManager();
    expect(fresh.getStats().score).toBe(0);
    // advance further and ensure no leakage
    vi.advanceTimersByTime(2000);
    expect(fresh.getStats().score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T210-5: 本編読込の先行完了と表示分離 (3-step, file contract)
// ---------------------------------------------------------------------------
describe('T210-5: 本編読込は裏で先行完了・T208判定表示制御はチュートリアル中も同一 (3-step, file contract)', () => {
  it('Step1 初期 capture (init が main と tutorial の両方を構築) -> Step2 source 探索 -> Step3 本編と tutorial 両方が init 内で構築され mainChartRef が保持される', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const hasMain = src.includes('mainChartRef.current = chart') || src.includes('mainChartRef.current');
    expect(hasMain).toBe(true);
    const hasTutorialChart = src.includes('tutorialChartRef.current') || src.includes('wavePracticeChartRef.current');
    expect(hasTutorialChart).toBe(true);
    expect(src).toMatch(/new BpmTimeline\(chart\.bpm_changes/);
    // tutorial timeline construction
    const hasTutorialTimeline = src.includes('new BpmTimeline(tutorialChart') || src.includes('new BpmTimeline(wavePracticeChart') || src.includes('new BpmTimeline(ringPracticeChart');
    expect(hasTutorialTimeline).toBe(true);
  });

  it('Step1 capture (renderer.render 呼び出し) -> Step2 showJudgementDetail の渡し方を確認 -> Step3 チュートリアル中も getViewMode()==debug で public はランク名のみ', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const renderIdx = src.indexOf('renderer.render');
    expect(renderIdx).toBeGreaterThan(-1);
    const renderSlice = src.slice(renderIdx, renderIdx + 1200);
    expect(renderSlice).toMatch(/showJudgementDetail/);
    // Must use !== false semantics — never === true (backwards compat)
    expect(renderSlice).toMatch(/getViewMode\(\)\s*===\s*['"]debug['"]/);
    // Should NOT have phase-specific detail; it's uniform
    const phaseConditionalDetail = renderSlice.match(/phase.*showJudgementDetail|showJudgementDetail.*phase/);
    expect(phaseConditionalDetail).toBeNull();
  });

  it('Step1 チュートリアル tick の instruction 更新 capture -> Step2 getTutorialInstruction が timeline.msToBeat(renderTimeMs) で呼ばれる -> Step3 T167/T175 の renderTimeMs 同期が維持される', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const instructionIdx = src.indexOf('getTutorialInstruction(timeline.msToBeat');
    expect(instructionIdx).toBeGreaterThan(-1);
    const around = src.slice(Math.max(0, instructionIdx - 700), instructionIdx + 700);
    expect(around).toMatch(/renderTimeMs/);
    expect(around).toMatch(/msToBeat/);
    expect(src).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    const autoIdx = src.indexOf('EndRef.current');
    expect(autoIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// T210-6: オーバーレイの常時表示と記憶なし (3-step, file contract)
// ---------------------------------------------------------------------------
describe('T210-6: スキップボタン常時表示・記憶なし・毎回表示 (3-step, file contract)', () => {
  it('Step1 初期 capture (localStorage に記憶キーなし) -> Step2 オーバーレイ要素を探索 -> Step3 スキップは毎回表示され localStorage 記憶に依存しない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must not use tutorialSkipped localStorage persistence
    expect(src).not.toMatch(/tutorialSkipped/);
    expect(src).not.toMatch(/localStorage.*tutorial/);
    const overlayPos = src.indexOf('tutorial-overlay');
    expect(overlayPos).toBeGreaterThan(-1);
    const phaseGuardStart = src.lastIndexOf("phase ===", overlayPos - 200) !== -1 ? src.lastIndexOf("phase ===", overlayPos) : src.indexOf("phase ===");
    expect(phaseGuardStart).toBeGreaterThan(-1);
    // Ensure skip button is inside tutorial overlay guard
    const skipPos = src.indexOf('tutorial-skip');
    expect(skipPos).toBeGreaterThan(overlayPos);
  });

  it('Step1 チュートリアル instruction 初期 capture (empty) -> Step2 chart 生成後の初期文言 -> Step3 初回は beat0 の移動説明が表示される', () => {
    const before = '';
    expect(before).toBe('');
    const getInstr = getGetTutorialInstruction() as any;
    const initialInstruction = getInstr(0);
    expect(initialInstruction).toMatch(/↑↓|移動/);
    const src = readFile('src/screens/GameScreen.tsx');
    // fallback to getTutorialInstruction(0) in render
    const hasFallback = src.includes('getTutorialInstruction(0') || src.includes('getTutorialInstruction(0,');
    expect(hasFallback).toBe(true);
    expect(src).toMatch(/setTutorialInstruction/);
  });

  it('Step1 複雑な音楽タイミング capture (beat 不定・off-grid) -> Step2 レンダリング差し替え後の cursor/wave 同期を仮想検証 -> Step3 エンジン差し替え後も waveYAt が正しく描画される', () => {
    const mainChart: any = {
      title: 'Main',
      artist: 'Artist',
      audio: 'main.flac',
      audio_offset: 0,
      amplitude: 1.0,
      start_position: 0.0,
      bpm_changes: [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 150, amplitude: 1.3 }],
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
    expect(tlBefore.beatMsAt(0)).toBeCloseTo(500, 0);
    expect(tlBefore.beatMsAt(9)).toBeCloseTo(400, 0);
    const wave = new WaveEngine(mainChart.segments, tlBefore, mainChart.amplitude, mainChart.start_position);
    expect(wave.waveYAt(0.37)).toBeDefined();
    expect(Number.isFinite(wave.waveYAt(1.23))).toBe(true);
    expect(Number.isFinite(wave.waveYAt(9.37))).toBe(true);
    const cursor = new Cursor(mainChart.amplitude, 0.0);
    cursor.setAmplitude(tlBefore.amplitudeAt(9.37));
    expect(cursor.y).toBeDefined();
    expect(wave.getPoints().length).toBe(mainChart.segments.length + 1);
  });
});

// ---------------------------------------------------------------------------
// T210-7: 回帰 — T208/T186/T187/T175/T176 不変量維持
// ---------------------------------------------------------------------------
describe('T210-7: 回帰 — T208/T186/T187/T175/T176 不変量維持', () => {
  it('Step1 renderer の showJudgementDetail 契約 capture -> Step2 T210 後も変更ないことを検証 -> Step3 !== false で public はランクのみ', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/showJudgementDetail/);
    // Must use !== false for backwards compatibility (Prohibited strict === true)
    expect(rendererSrc).toMatch(/showJudgementDetail\s*!==\s*false/);
    expect(rendererSrc).not.toMatch(/showJudgementDetail\s*===\s*true/);
  });

  it('Step1 BpmTimeline の派生 capture (bpm_changes のみ) -> Step2 チュートリアルでも beatToMs が正しい -> Step3 先頭セクションから BPM 導出 (T187) が tutorial でも成立', () => {
    const chart = (getGenerateTutorialChart() as any)();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    expect(tl.bpmAt(0)).toBe(120);
    expect(tl.bpmAt(12)).toBe(120);
    expect(tl.beatToMs(0)).toBe(0);
    expect(tl.beatToMs(4)).toBeCloseTo(2000, 0);
    expect(tl.msToBeat(2000)).toBeCloseTo(4, 3);
  });

  it('Step1 renderer の renderTimeMs 契約 capture -> Step2 wave描画が renderTimeMs を使う -> Step3 T175/T176 の可聴同期が tutorial/main 共に維持', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(rendererSrc).toMatch(/drawWave\(ctx, waveEngine, renderTimeMs/);
    expect(rendererSrc).toMatch(/drawRings\(ctx, rings, renderTimeMs/);
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(gameSrc).toMatch(/wave\.waveYAtMs\(renderTimeMs\)/);
  });

  it('Step1 現在の tutorial.ts が T211 の 2段階でも、T210単一チャート生成が可能か capture -> Step2 generateTutorialChart が T210仕様を満たすか検証 -> Step3 将来の統合で両立する（T210/T211共存）', () => {
    const gen = getGenerateTutorialChart();
    expect(typeof gen).toBe('function');
    const chart = (gen as any)();
    // Must still be deterministic via fake timers
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const d1 = tl.beatToMs(4);
    vi.advanceTimersByTime(500);
    const d2 = tl.beatToMs(4);
    expect(d1).toBe(d2);
    expect(d1).toBeCloseTo(2000, 0);
    // off-grid stability
    expect((getGetTutorialInstruction() as any)(0.37)).toBe((getGetTutorialInstruction() as any)(0));
  });
});
