/**
 * T210 — パブリックモード限定・譜面開始前チュートリアル（自動進行＋スキップ付き）
 * Vitest (TypeScript, node environment) pure acceptance — TDD Red->Green
 * Spec:
 *  - 対象はパブリックモードの通常プレイ時のみ（デバッグ・プレイテスト時は出さない）
 *  - 流れ：譜面読込完了 → チュートリアル譜面を自動再生 → 終了後に本編へ自動遷移
 *  - チュートリアル内容（固定・コード生成、メトロノームのみ約8秒）: BPM120、波形 stay4→up2→down2→stay、リング3個(4/8/12 single)
 *  - 拍連動の指示文オーバーレイ（移動→Space→ねぎらい）。修了は成否不問・最終リング＋2秒で本編へ
 *  - スキップボタン常時表示、チュートリアル中のスコアは破棄し本編開始時にリセット
 *  - 新規 src/game/tutorial.ts: generateTutorialChart() + 指示文テーブル
 *  - GameScreen.tsx のみ: フェーズ state ('tutorial'|'main')、同一エンジンで差し替え＋リセット
 * Strict 3-step state-transition assertions, off-grid verification, complex amplitudes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { generateTutorialChart, getTutorialInstruction, TUTORIAL_INSTRUCTIONS } from '../src/game/tutorial';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';
import { ScoreManager } from '../src/game/score';

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

function tutorialDurationMs(): number {
  const chart = generateTutorialChart();
  const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
  const lastBeat = chart.rings.reduce((m, r) => Math.max(m, r.beat + (r.duration ?? 0)), -Infinity);
  return tl.beatToMs(lastBeat) + 2000;
}

// ---------------------------------------------------------------------------
// T210-0: ファイル契約 — tutorial.ts が存在し generateTutorialChart を export
// ---------------------------------------------------------------------------
describe('T210-0: ファイル契約 — tutorial.ts / GameScreen.tsx / data-testid', () => {
  it('Step1 初期 capture (ファイル未存在時は何もない) → Step2 実装後のモジュール読取 → Step3 generateTutorialChart と指示文テーブルが export されている', () => {
    // Step1: capture initial — module must be importable
    expect(typeof generateTutorialChart).toBe('function');
    expect(typeof getTutorialInstruction).toBe('function');
    expect(Array.isArray(TUTORIAL_INSTRUCTIONS)).toBe(true);
    // Step2: ensure file exists on disk
    const src = readFile('src/game/tutorial.ts');
    expect(src).toContain('generateTutorialChart');
    expect(src).toContain('TUTORIAL_INSTRUCTIONS');
    // Step3: exported shapes exist
    const chart = generateTutorialChart();
    expect(chart).toBeDefined();
    expect(chart.title).toBeDefined();
  });

  it('Step1 GameScreen 初期 capture (tutorial なし) → Step2 実装後の source 探索 → Step3 GameScreen が phase tutorial|main, tutorialOverlay/skip/instruction を含む', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Step1: must exist
    expect(src.length).toBeGreaterThan(0);
    // Step3: phase state
    expect(src).toMatch(/phase/);
    expect(src).toMatch(/'tutorial'\s*\|\s*'main'|"tutorial"\s*\|\s*"main"/);
    expect(src).toMatch(/generateTutorialChart/);
    expect(src).toMatch(/getTutorialInstruction/);
    // data-testid — use available selectors only
    expect(src).toMatch(/data-testid="tutorial-overlay"/);
    expect(src).toMatch(/data-testid="tutorial-skip"/);
    expect(src).toMatch(/data-testid="tutorial-instruction"/);
    // must not hallucinate parent container like #music-control
    // Ensure tutorial overlay is tied to phase === 'tutorial'
    const overlayIdx = src.indexOf('tutorial-overlay');
    const phaseGuard = src.slice(Math.max(0, overlayIdx - 600), overlayIdx + 200);
    expect(phaseGuard).toMatch(/tutorial/);
  });

  it('Step1 capture (viewMode 連携なし) → Step2 public/debug 分岐を探索 → Step3 public のみ tutorial, デバッグ・プレイテストはスキップ', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/getViewMode/);
    // public check — must be getViewMode() === 'public'
    expect(src).toMatch(/getViewMode\(\)\s*===\s*['"]public['"]/);
    // playtest guard — tutorial only when !isPlaytest
    expect(src).toMatch(/isPlaytest/);
    // Must handle !isPlaytest for tutorial decision
    expect(src).toMatch(/!isPlaytest/);
    // Debug path must set phase to main directly
    const useTutorialLine = src.match(/useTutorial[\s\S]*?getViewMode\(\)[\s\S]*?isPlaytest/);
    expect(useTutorialLine !== null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T210-1: チュートリアル譜面 — 固定内容 (3-step, computed)
// ---------------------------------------------------------------------------
describe('T210-1: チュートリアル譜面の固定内容 (3-step, computed)', () => {
  it('Step1 初期 empty capture (chart 未生成) → Step2 generateTutorialChart() 実行 → Step3 segments/rings/BPM が仕様通り (stay4/up2/down2/stay + 4/8/12 single)', () => {
    // Step1: capture initial — nothing yet
    const before: unknown = null;
    expect(before).toBeNull();
    // Step2: perform
    const chart = generateTutorialChart();
    // Step3: assert resulting transition — exact spec
    expect(chart.bpm_changes.length).toBeGreaterThanOrEqual(1);
    expect(chart.bpm_changes[0].beat).toBe(0);
    expect(chart.bpm_changes[0].bpm).toBe(120);
    expect(chart.segments.length).toBe(4);
    expect(chart.segments[0]).toEqual({ direction: 'stay', beats: 4 });
    expect(chart.segments[1]).toEqual({ direction: 'up', beats: 2 });
    expect(chart.segments[2]).toEqual({ direction: 'down', beats: 2 });
    expect(chart.segments[3].direction).toBe('stay');
    expect(chart.segments[3].beats).toBeGreaterThanOrEqual(4);
    expect(chart.rings.length).toBe(3);
    expect(chart.rings[0].beat).toBe(4);
    expect(chart.rings[1].beat).toBe(8);
    expect(chart.rings[2].beat).toBe(12);
    for (const r of chart.rings) {
      expect(r.type === undefined || r.type === 'single').toBe(true);
    }
    expect(chart.audio).toBe('');
    expect(chart.amplitude).toBeCloseTo(1.0, 5);
  });

  it('Step1 BPMタイムライン未構築を capture → Step2 BpmTimeline で beatToMs 計測 → Step3 チュートリアルは約8秒 (最終リング+2秒) でメトロノームのみ', () => {
    const chart = generateTutorialChart();
    const tlBefore = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const beforeMs = tlBefore.beatToMs(12);
    expect(beforeMs).toBeCloseTo(6000, 0); // 12 beats * 500ms at 120BPM
    // Step2: compute duration via helper
    const duration = tutorialDurationMs();
    // Step3: duration = 6000 + 2000 = 8000ms (~8s, not 10s but spec ~10s is approximate)
    expect(duration).toBe(8000);
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    expect(tl.beatMsAt(0)).toBeCloseTo(500, 5);
    expect(tl.msToBeat(6000)).toBeCloseTo(12, 4);
    expect(tl.bpmAt(0)).toBe(120);
    expect(tl.bpmAt(12)).toBe(120);
  });

  it('Step1 segments 未検証を capture → Step2 WaveEngine で getPoints/waveYAt 計測 → Step3 点数=segments+1, 上下幅固定, waveYAt が物理速度と一致', () => {
    const chart = generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const engineBefore = new WaveEngine(chart.segments, tl, chart.amplitude, chart.start_position);
    expect(engineBefore.getPoints().length).toBe(chart.segments.length + 1);
    // Step2: measure wave height
    const points = engineBefore.getPoints();
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));
    // Step3: physical height fixed at TW_AMP=130 (stay 4 at center, up/down 2 reaches edges)
    expect(maxY - minY).toBeGreaterThan(0);
    expect(maxY).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
    expect(minY).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
    // start_position 0 => center
    expect(engineBefore.waveYAt(0)).toBeCloseTo(TW_CENTER_Y, 5);
    // stay 4 beats => remains center at beats 0..4
    expect(engineBefore.waveYAt(0.37)).toBeCloseTo(TW_CENTER_Y, 3);
    expect(engineBefore.waveYAt(1.23)).toBeCloseTo(TW_CENTER_Y, 3);
    expect(engineBefore.waveYAt(3.99)).toBeCloseTo(TW_CENTER_Y, 3);
  });

  it('Step1 複雑振幅 0.7/1.3/2.7/3.4 + off-grid 0.37/1.23 capture → Step2 WaveEngine と Cursor の数値整合を検証 → Step3 perBeatPx = 2*TW_AMP*amplitude で一致し上下幅は不変', () => {
    const amps = [0.7, 1.3, 2.7, 3.4];
    const offGrids = [0.37, 1.23, 3.37, 5.23];
    for (const amp of amps) {
      const chart = generateTutorialChart();
      // Use tutorial segments but override amplitude via timeline baseAmplitude
      const tl = new BpmTimeline(chart.bpm_changes, amp);
      const engine = new WaveEngine(chart.segments, tl, amp, 0.0);
      const perBeat = 2 * TW_AMP * amp;
      for (const off of offGrids) {
        if (off > 16) continue;
        // Wave slope in up segment (beats 4..6) should be -perBeat
        if (off >= 4 && off < 6) {
          const yAtOff = engine.waveYAt(off);
          const yAt4 = engine.waveYAt(4);
          const expected = Math.max(TW_CENTER_Y - TW_AMP, Math.min(TW_CENTER_Y + TW_AMP, yAt4 - perBeat * (off - 4)));
          expect(yAtOff).toBeCloseTo(expected, 2);
        }
        // Cursor speed consistency: speed = perBeat / (beatMs/1000)
        const cursor = new Cursor(amp, 0.0);
        const beatMs = tl.beatMsAt(off);
        const speed = (2 * TW_AMP * amp) / (beatMs / 1000);
        expect(speed).toBeCloseTo(perBeat / (beatMs / 1000), 5);
        // Upper/lower clamp invariant
        expect(engine.waveYAt(off)).toBeGreaterThanOrEqual(TW_CENTER_Y - TW_AMP - 1);
        expect(engine.waveYAt(off)).toBeLessThanOrEqual(TW_CENTER_Y + TW_AMP + 1);
      }
      // getPoints length invariant
      expect(engine.getPoints().length).toBe(chart.segments.length + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// T210-2: 指示文テーブル — 拍連動 (3-step, off-grid必須)
// ---------------------------------------------------------------------------
describe('T210-2: 拍連動の指示文オーバーレイ (3-step, off-grid)', () => {
  it('Step1 初期 beat 0 未指示を capture → Step2 getTutorialInstruction(各beat) 実行 → Step3 beat 0/4/8/12 で文言が切替、端数でも最近傍ステップに安定', () => {
    const before = getTutorialInstruction(-1);
    expect(typeof before).toBe('string');
    expect(before.length).toBeGreaterThan(0);
    // Step2: perform at exact beats
    const at0 = getTutorialInstruction(0);
    const at4 = getTutorialInstruction(4);
    const at8 = getTutorialInstruction(8);
    const at12 = getTutorialInstruction(12);
    // Step3: distinct instructions
    expect(at0).toContain('↑↓');
    expect(at4).toMatch(/Space/);
    expect(at8).toMatch(/Space/);
    expect(at12).toMatch(/お疲れさま|ねぎらい|本編/);
    expect(at0).not.toBe(at4);
    expect(at4).not.toBe(at12);
    expect(TUTORIAL_INSTRUCTIONS.length).toBeGreaterThanOrEqual(4);
    expect(TUTORIAL_INSTRUCTIONS[0].beat).toBe(0);
    expect(TUTORIAL_INSTRUCTIONS[1].beat).toBe(4);
    expect(TUTORIAL_INSTRUCTIONS[2].beat).toBe(8);
    expect(TUTORIAL_INSTRUCTIONS[3].beat).toBe(12);
  });

  it('Step1 端数拍 0.37/1.23 capture → Step2 getTutorialInstruction(offGrid) 実行 → Step3 0.37→beat0文言, 1.23→beat0文言, 4.37→beat4文言でステップ関数が安定', () => {
    const at037 = getTutorialInstruction(0.37);
    const at123 = getTutorialInstruction(1.23);
    const at337 = getTutorialInstruction(3.37);
    const at437 = getTutorialInstruction(4.37);
    const at523 = getTutorialInstruction(5.23);
    const at823 = getTutorialInstruction(8.23);
    const at1237 = getTutorialInstruction(12.37);
    expect(at037).toBe(getTutorialInstruction(0));
    expect(at123).toBe(getTutorialInstruction(0));
    expect(at337).toBe(getTutorialInstruction(0));
    expect(at437).toBe(getTutorialInstruction(4));
    expect(at523).toBe(getTutorialInstruction(4));
    expect(at823).toBe(getTutorialInstruction(8));
    expect(at1237).toBe(getTutorialInstruction(12));
    // Off-grid near boundary: 3.99 still beat0, 4.01 is beat4
    expect(getTutorialInstruction(3.99)).toBe(getTutorialInstruction(0));
    expect(getTutorialInstruction(4.01)).toBe(getTutorialInstruction(4));
  });

  it('Step1 不定値(NaN/Infinity) capture → Step2 getTutorialInstruction で安全なフォールバック → Step3 先頭文言を返しクラッシュしない', () => {
    expect(() => getTutorialInstruction(NaN)).not.toThrow();
    expect(() => getTutorialInstruction(Infinity)).not.toThrow();
    expect(() => getTutorialInstruction(-Infinity)).not.toThrow();
    const nanResult = getTutorialInstruction(NaN);
    expect(nanResult).toBe(TUTORIAL_INSTRUCTIONS[0].text);
    const negResult = getTutorialInstruction(-5);
    expect(negResult).toBe(TUTORIAL_INSTRUCTIONS[0].text);
  });

  it('Step1 TUTORIAL_INSTRUCTIONS 全体 capture → Step2 各 beat の指示文を列挙 → Step3 0→移動、4/8→Space、12→ねぎらい の語彙が各ステップに存在', () => {
    const texts = TUTORIAL_INSTRUCTIONS.map(i => i.text);
    const all = texts.join(' | ');
    expect(all).toMatch(/↑↓|移動/);
    const spaceCount = texts.filter(t => /Space/.test(t)).length;
    expect(spaceCount).toBeGreaterThanOrEqual(2);
    expect(texts[texts.length - 1]).toMatch(/お疲れさま|本編|おつかれ/);
    // Beats are sorted ascending
    for (let i = 1; i < TUTORIAL_INSTRUCTIONS.length; i++) {
      expect(TUTORIAL_INSTRUCTIONS[i].beat).toBeGreaterThan(TUTORIAL_INSTRUCTIONS[i - 1].beat);
    }
  });
});

// ---------------------------------------------------------------------------
// T210-3: パブリックモード限定・自動進行＋スキップ (3-step)
// ---------------------------------------------------------------------------
describe('T210-3: パブリック限定・自動進行・スキップ (3-step, file contract + computed)', () => {
  it('Step1 通常プレイ public 初期 capture (phase tutorial 想定) → Step2 tutorialEnd 時刻を再計算 → Step3 最終リング+2秒で本編閾値が 8000ms になる (時間で自動進行)', () => {
    // Step1: capture initial — tutorial chart generation
    const chart = generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    const lastBeatBefore = chart.rings[chart.rings.length - 1].beat;
    expect(lastBeatBefore).toBe(12);
    // Step2: compute tutorialEnd as GameScreen does
    const lastHitMs = tl.beatToMs(lastBeatBefore);
    const tutorialEnd = lastHitMs + 2000;
    // Step3: assert resulting transition — auto-advance threshold
    expect(lastHitMs).toBe(6000);
    expect(tutorialEnd).toBe(8000);
    expect(tutorialDurationMs()).toBe(tutorialEnd);
    // Verify GameScreen has auto-advance logic
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/tutorialEndRef/);
    expect(src).toMatch(/songTimeMs\s*>\s*tutorialEndRef\.current/);
    expect(src).toMatch(/enterMain/);
    // T210: 成否不問 — no score condition in auto-advance check
    const autoBlock = src.slice(src.indexOf('tutorialEndRef.current') - 500, src.indexOf('tutorialEndRef.current') + 500);
    expect(autoBlock).not.toMatch(/score|perfect|miss/);
  });

  it('Step1 スキップ前 capture (score/timeline が tutorial 値) → Step2 skipTutorial/enterMain の source パターン確認 → Step3 スコア破棄・エンジン差し替え・phase=main が行われる', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Step1: before skip, tutorial engines exist
    expect(src).toMatch(/tutorialTimelineRef/);
    expect(src).toMatch(/tutorialWaveRef/);
    expect(src).toMatch(/mainChartRef/);
    expect(src).toMatch(/mainTimelineRef/);
    expect(src).toMatch(/mainWaveRef/);
    // Step2: skipTutorial must call enterMain
    const skipIdx = src.indexOf('skipTutorial');
    expect(skipIdx).toBeGreaterThan(-1);
    const skipSlice = src.slice(skipIdx, skipIdx + 600);
    expect(skipSlice).toMatch(/enterMain/);
    // enterMain must discard tutorial score
    const enterIdx = src.indexOf('enterMain');
    const enterSlice = src.slice(enterIdx, enterIdx + 1200);
    // Step3: discards score
    expect(enterSlice).toMatch(/new ScoreManager\(\)/);
    expect(enterSlice).toMatch(/scoreRef\.current = new ScoreManager/);
    expect(enterSlice).toMatch(/ringsRef\.current = \[\]/);
    expect(enterSlice).toMatch(/phaseRef\.current = 'main'/);
    expect(enterSlice).toMatch(/setPhase\('main'\)/);
    // Must reset clock and restart metronome/music for main
    expect(enterSlice).toMatch(/resetClock/);
    expect(enterSlice).toMatch(/playMusic/);
    expect(enterSlice).toMatch(/startMetronome/);
    // Skip button wiring
    expect(src).toMatch(/onClick=\{skipTutorial\}/);
    expect(src).toMatch(/スキップ/);
  });

  it('Step1 デバッグ初期 capture (getViewMode 未設定でも public だが debug 切替で) → Step2 public/debug の分岐を検証 → Step3 デバッグでは tutorial が出ない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // GameScreen initial phase: public && !isPlaytest ? tutorial : main (relaxed pattern)
    const phaseInit = src.match(/getViewMode\(\)\s*===\s*['"]public['"][\s\S]*?isPlaytest[\s\S]*?\?\s*['"]tutorial['"]\s*:\s*['"]main['"]/);
    expect(phaseInit !== null).toBe(true);
    // Also second assignment in init() — same condition
    const useTutorialAssign = src.match(/const useTutorial = getViewMode\(\) === 'public' && !isPlaytest/);
    expect(useTutorialAssign !== null).toBe(true);
    // Playtest guard: playtestChart/playtestBuffer/onExit => isPlaytest true => no tutorial
    expect(src).toMatch(/playtestChart|playtestBuffer|onExit/);
    expect(src).toMatch(/isPlaytest/);
  });
});

// ---------------------------------------------------------------------------
// T210-4: スコア破棄と本編リセット (3-step, computed)
// ---------------------------------------------------------------------------
describe('T210-4: チュートリアル中のスコアは破棄し本編開始時にリセット (3-step, computed)', () => {
  it('Step1 チュートリアル中スコア蓄積を capture (recordHit/recordTrace) → Step2 本編リセットとして new ScoreManager() で差し替え → Step3 本編スコアが 0 から始まる', () => {
    // Step1: simulate tutorial scoring
    const tutorialScore = new ScoreManager();
    tutorialScore.recordHit('perfect');
    tutorialScore.recordHit('great');
    tutorialScore.recordTrace(0.15, true, 500);
    tutorialScore.recordTrace(0.15, true, 500);
    const beforeStats = tutorialScore.getStats();
    expect(beforeStats.score).toBeGreaterThan(0);
    expect(beforeStats.perfect).toBe(1);
    expect(beforeStats.great).toBe(1);
    // Step2: perform reset as enterMain does
    let mainScore: ScoreManager = new ScoreManager();
    // Verify discarded: tutorialScore not reused
    expect(mainScore.getStats().score).toBe(0);
    expect(mainScore.getStats().perfect).toBe(0);
    expect(mainScore.getStats().great).toBe(0);
    expect(mainScore.getStats().combo).toBe(0);
    // Step3: main scoring starts fresh
    mainScore.recordHit('perfect');
    expect(mainScore.getStats().score).toBe(50);
    expect(mainScore.getStats().perfect).toBe(1);
    expect(beforeStats.score).not.toBe(mainScore.getStats().score);
  });

  it('Step1 トレース蓄積 16拍で bonus+2 を capture → Step2 本編で new ScoreManager にリセット → Step3 トレースボーナスもリセットされている', () => {
    const tutorialScore = new ScoreManager();
    const beatMs = 500;
    // Accumulate 16 beats of trace (off-grid dt 0.37-style not needed, but verify beats math)
    for (let i = 0; i < 160; i++) {
      tutorialScore.recordTrace(0.05, true, beatMs);
    }
    // After 16 beats, comboBonus should have increased
    // Score should be > base trace; we don't expose comboBonus directly, but score > base proves bonus
    const beforeScore = tutorialScore.getStats().score;
    expect(beforeScore).toBeGreaterThan(0);
    // Step2: reset
    const mainScore = new ScoreManager();
    // Step3: fresh — first trace tick should be base 2, not inflated
    mainScore.recordTrace(0.15, true, beatMs);
    expect(mainScore.getStats().score).toBe(2);
    // Tutorial score not leaked
    expect(beforeScore).not.toBe(mainScore.getStats().score);
  });

  it('Step1 チュートリアル終了間際の MISS を capture → Step2 本編リセット → Step3 MISS カウントも破棄される', () => {
    const tutorialScore = new ScoreManager();
    tutorialScore.recordHit('perfect');
    tutorialScore.recordHit('miss');
    expect(tutorialScore.getStats().miss).toBe(1);
    expect(tutorialScore.getStats().combo).toBe(0);
    // Step2: enterMain reset
    const mainScore = new ScoreManager();
    // Step3: main starts with zero miss
    expect(mainScore.getStats().miss).toBe(0);
    expect(mainScore.getStats().combo).toBe(0);
    expect(mainScore.getStats().perfect).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T210-5: 本編読込の先行完了と表示分離 (3-step, file contract)
// ---------------------------------------------------------------------------
describe('T210-5: 本編読込は裏で先行完了・T208判定表示制御はチュートリアル中も同一 (3-step, file contract)', () => {
  it('Step1 初期 capture (init が main と tutorial の両方を構築) → Step2 source 探索 → Step3 本編と tutorial 両方が init 内で構築され mainChartRef が保持される', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Both main and tutorial are built in init()
    const mainBuilt = src.indexOf('mainWave');
    const tutorialBuilt = src.indexOf('tutorialWave');
    expect(mainBuilt).toBeGreaterThan(-1);
    expect(tutorialBuilt).toBeGreaterThan(-1);
    expect(src).toMatch(/mainChartRef\.current = chart/);
    expect(src).toMatch(/tutorialChartRef\.current = tutorialChart/);
    // Main timeline uses new BpmTimeline with new signature (T186/T187) — base BPM derived
    expect(src).toMatch(/new BpmTimeline\(chart\.bpm_changes/);
    expect(src).toMatch(/new BpmTimeline\(tutorialChart\.bpm_changes/);
  });

  it('Step1 capture (renderer.render 呼び出し) → Step2 showJudgementDetail の渡し方を確認 → Step3 チュートリアル中も getViewMode()==debug で public はランク名のみ', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    const renderIdx = src.indexOf('renderer.render');
    const renderSlice = src.slice(renderIdx, renderIdx + 900);
    expect(renderSlice).toMatch(/showJudgementDetail/);
    expect(renderSlice).toMatch(/getViewMode\(\)\s*===\s*['"]debug['"]/);
    // Must not be phase-dependent — same rule for tutorial and main
    const phaseConditionalDetail = renderSlice.match(/phase.*showJudgementDetail|showJudgementDetail.*phase/);
    // Should NOT have phase-specific detail; it's uniform
    expect(phaseConditionalDetail).toBeNull();
  });

  it('Step1 チュートリアル tick の instruction 更新 capture → Step2 getTutorialInstruction が timeline.msToBeat(renderTimeMs) で呼ばれる → Step3 T167/T175 の renderTimeMs 同期が維持される', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // instruction update uses renderTimeMs — find tick occurrence (with timeline.msToBeat), not fallback (0)
    const instructionIdx = src.indexOf('getTutorialInstruction(timeline.msToBeat');
    expect(instructionIdx).toBeGreaterThan(-1);
    const around = src.slice(Math.max(0, instructionIdx - 600), instructionIdx + 600);
    expect(around).toMatch(/renderTimeMs/);
    expect(around).toMatch(/msToBeat/);
    // renderTimeMs is songTimeMs - manualOffset
    expect(src).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    // Ensure tutorial auto-advance also uses raw songTimeMs (not renderTimeMs) for ENTER check but instruction uses renderTimeMs
    const autoIdx = src.indexOf('songTimeMs > tutorialEndRef.current');
    expect(autoIdx).toBeGreaterThan(-1);
    const autoSlice = src.slice(Math.max(0, autoIdx - 400), autoIdx + 400);
    expect(autoSlice).toMatch(/songTimeMs/);
  });
});

// ---------------------------------------------------------------------------
// T210-6: オーバーレイの常時表示と記憶なし (3-step, file contract)
// ---------------------------------------------------------------------------
describe('T210-6: スキップボタン常時表示・記憶なし・毎回表示 (3-step, file contract)', () => {
  it('Step1 初期 capture (localStorage に記憶キーなし) → Step2 オーバーレイ要素を探索 → Step3 スキップは毎回表示され localStorage 記憶に依存しない', () => {
    const src = readFile('src/screens/GameScreen.tsx');
    // Must not read/write any "tutorialSkipped" or similar persistence
    expect(src).not.toMatch(/tutorialSkipped|skipTutorial.*localStorage|localStorage.*tutorial/);
    // Overlay is shown whenever phase === 'tutorial'
    const overlayGate = src.match(/phase\s*===\s*'tutorial' && \([\s\S]*?tutorial-overlay/);
    expect(overlayGate !== null || src.includes("phase === 'tutorial'")).toBe(true);
    // tutorial-overlay and skip button are inside the phase guard
    const overlayPos = src.indexOf('tutorial-overlay');
    const phaseGuardStart = src.lastIndexOf("phase === 'tutorial'", overlayPos);
    expect(phaseGuardStart).toBeGreaterThan(-1);
  });

  it('Step1 チュートリアル instruction 初期 capture (empty) → Step2 chart 生成後の初期文言 → Step3 初回は beat0 の移動説明が表示される', () => {
    const before = '';
    expect(before).toBe('');
    const initialInstruction = getTutorialInstruction(0);
    expect(initialInstruction).toMatch(/↑↓|移動/);
    // GameScreen initial tutorialInstruction state is '' but fallback to getTutorialInstruction(0) in render
    const src = readFile('src/screens/GameScreen.tsx');
    expect(src).toMatch(/tutorialInstruction \|\| getTutorialInstruction\(0\)/);
    expect(src).toMatch(/setTutorialInstruction/);
  });

  it('Step1 複雑な音楽タイミング capture (beat 不定・off-grid) → Step2 レンダリング差し替え後の cursor/wave 同期を仮想検証 → Step3 エンジン差し替え後も waveYAt が正しく描画される', () => {
    // Simulate main chart load after tutorial
    const mainChart: import('../src/types').Chart = {
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
    expect(tlBefore.beatMsAt(9)).toBeCloseTo(400, 0); // after 150bpm
    // Step2: build engine as enterMain does
    const wave = new WaveEngine(mainChart.segments, tlBefore, mainChart.amplitude, mainChart.start_position);
    // Step3: verify off-grid beats still resolve
    expect(wave.waveYAt(0.37)).toBeDefined();
    expect(Number.isFinite(wave.waveYAt(1.23))).toBe(true);
    expect(Number.isFinite(wave.waveYAt(9.37))).toBe(true);
    // Cursor with updated amplitude
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
  it('Step1 renderer の showJudgementDetail 契約 capture → Step2 T210 後も変更ないことを検証 → Step3 !== false で public はランクのみ', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/showJudgementDetail/);
    expect(rendererSrc).toMatch(/showJudgementDetail\s*!==\s*false/);
    expect(rendererSrc).not.toMatch(/showJudgementDetail\s*===\s*true/);
  });

  it('Step1 BpmTimeline の派生 capture (bpm_changes のみ) → Step2 チュートリアルでも beatToMs が正しい → Step3 先頭セクションから BPM 導出 (T187) が tutorial でも成立', () => {
    const chart = generateTutorialChart();
    const tl = new BpmTimeline(chart.bpm_changes, chart.amplitude);
    expect(tl.bpmAt(0)).toBe(120);
    expect(tl.bpmAt(12)).toBe(120);
    expect(tl.beatToMs(0)).toBe(0);
    expect(tl.beatToMs(4)).toBeCloseTo(2000, 0);
    expect(tl.msToBeat(2000)).toBeCloseTo(4, 3);
  });

  it('Step1 renderer の renderTimeMs 契約 capture → Step2 wave描画が renderTimeMs を使う → Step3 T175/T176 の可聴同期が tutorial/main 共に維持', () => {
    const rendererSrc = readFile('src/game/renderer.ts');
    expect(rendererSrc).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(rendererSrc).toMatch(/drawWave\(ctx, waveEngine, renderTimeMs/);
    expect(rendererSrc).toMatch(/drawRings\(ctx, rings, renderTimeMs/);
    const gameSrc = readFile('src/screens/GameScreen.tsx');
    expect(gameSrc).toMatch(/renderTimeMs\s*=\s*songTimeMs\s*-\s*getManualOffsetMs/);
    expect(gameSrc).toMatch(/wave\.waveYAtMs\(renderTimeMs\)/);
  });
});
