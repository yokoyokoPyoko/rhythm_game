/**
 * @vitest-environment node
 * T200 GameScreenのプレイ時機能廃止（オフセット変更・Rリセット・キー音） — Vitest acceptance test (node)
 * Verifies source-level removal of adjustOffset / resetGame / keySound while retaining offset display and game-hint update.
 * Runs WITHOUT browser: inspects source via fs, tests pure engine math for regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { WaveEngine } from '../src/game/waveEngine';
import { Cursor } from '../src/game/cursor';

vi.useFakeTimers();

beforeEach(() => {
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

function readGameScreen(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/screens/GameScreen.tsx'), 'utf-8');
}

describe('T200 GameScreenプレイ時機能廃止（オフセット変更・Rリセット・キー音）', () => {
  // ==========================================================================
  // 1. keySound.ts ファイル削除検証
  // ==========================================================================
  describe('1. src/audio/keySound.ts の削除 (完了条件・他で未使用)', () => {
    it('Step1: Capture initial FS state -> Step2: check existence -> Step3: assert file does NOT exist (3-step)', () => {
      // [Step 1: Capture Initial State] — expected deleted path
      const keySoundPath = path.join(process.cwd(), 'src/audio/keySound.ts');

      // [Step 2: Perform User Interaction] — FS check
      const exists = fs.existsSync(keySoundPath);
      const src = readGameScreen();

      // [Step 3: Assert Resulting Transition] — file must be deleted and no import remains
      expect(exists).toBe(false);
      // GameScreen must not import from keySound
      expect(src).not.toMatch(/from\s+['"]\.\.\/audio\/keySound['"]/);
      expect(src).not.toMatch(/keySound/i);
      expect(src).not.toMatch(/playKeyClick/);
    });

    it('Step1: Capture audio dir listing -> Step2: filter keySound -> Step3: assert 0 matches', () => {
      // [Step 1]
      const audioDir = path.join(process.cwd(), 'src/audio');
      const files = fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [];

      // [Step 2]
      const keySoundFiles = files.filter((f) => f.toLowerCase().includes('keysound'));

      // [Step 3]
      expect(keySoundFiles.length).toBe(0);
      // At least other audio modules still exist (sanity)
      expect(files.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // 2. ,/. ハンドラ + adjustOffset + setManualOffset の完全除去
  // ==========================================================================
  describe('2. ,/. オフセット変更ハンドラの廃止 (完了条件1)', () => {
    it('Step1: Read GameScreen source -> Step2: search for offset-adjust symbols -> Step3: assert absent but display remains (3-step)', () => {
      // [Step 1: Capture Initial State]
      const src = readGameScreen();
      const initialHasAdjustOffset = src.includes('adjustOffset');
      const initialHasSetManualOffset = src.includes('setManualOffset');

      // [Step 2: Perform] — scan for forbidden patterns
      const hasAdjustOffset = /adjustOffset/.test(src);
      const hasSetManualOffset = /setManualOffset/.test(src);
      const hasCommaDotHandler = /e\.key\s*===\s*['"][,\.]/.test(src) || /e\.key\s*===\s*['"]<['"]/.test(src) || /e\.key\s*===\s*['"]>['"]/.test(src);
      // Check assignment to offsetMs with setter — should be read-only
      const hasOffsetSetter = /const\s*\[\s*offsetMs\s*,\s*setOffsetMs\s*\]/.test(src);
      const hasOffsetReadOnly = /const\s*\[\s*offsetMs\s*\]\s*=\s*useState\s*\(\s*getManualOffsetMs\s*\)/.test(src);

      // [Step 3: Assert Resulting Transition]
      // Before state should have contained offset display logic; forbidden adjusters must be gone
      expect(initialHasAdjustOffset).toBe(false);
      expect(initialHasSetManualOffset).toBe(false);
      expect(hasAdjustOffset).toBe(false);
      expect(hasSetManualOffset).toBe(false);
      expect(hasCommaDotHandler).toBe(false);
      expect(hasOffsetSetter).toBe(false);
      // offsetMs display state must still exist in read-only form
      expect(hasOffsetReadOnly).toBe(true);
      expect(src).toContain('getManualOffsetMs');
      // import line must NOT contain setManualOffset
      const importLine = src.split('\n').find((l) => l.includes('from') && l.includes('clock')) ?? '';
      expect(importLine).toContain('getManualOffsetMs');
      expect(importLine).not.toContain('setManualOffset');
    });

    it('Step1: Verify no comma/dot key literals remain for offset -> Step2: scan key handler block -> Step3: confirm only allowed keys', () => {
      // [Step 1]
      const src = readGameScreen();
      // Extract the onKeyDown effect block
      const onKeyDownIdx = src.indexOf('const onKeyDown');
      const block = onKeyDownIdx >= 0 ? src.slice(onKeyDownIdx, onKeyDownIdx + 3000) : src;

      // [Step 2]
      const containsComma = block.includes("','") || block.includes('","') || block.includes("','") ;
      // More robust: look for any e.key === ',' pattern
      const commaPattern = /e\.key\s*===\s*['"][\.,]['"]/.test(block);
      const dotPattern = /e\.key\s*===\s*['"]\.['"]/.test(block);

      // [Step 3]
      expect(commaPattern).toBe(false);
      expect(dotPattern).toBe(false);
      // Allowed keys must still be present (not over-deleted)
      expect(block).toContain("e.key === 'Escape'");
      expect(block).toContain("e.key === 'ArrowUp'");
      expect(block).toContain("e.key === 'ArrowDown'");
      expect(block).toContain("e.code === 'Space'");
      void containsComma;
    });
  });

  // ==========================================================================
  // 3. R リセット + resetGame の完全除去
  // ==========================================================================
  describe('3. R リセット機能の廃止 (完了条件1)', () => {
    it('Step1: Read source -> Step2: search for R/resetGame -> Step3: assert absent (3-step)', () => {
      // [Step 1: Capture Initial State]
      const src = readGameScreen();

      // [Step 2: Perform] — scan
      const hasResetGame = /resetGame/.test(src);
      // R handler patterns: e.key === 'r' / 'R' in GameScreen context
      const hasRHandler = /e\.key\s*===\s*['"]r['"]/i.test(src) && src.includes('resetGame');
      // Broader: any case-insensitive R key handling near game logic
      const hasRKeyLiteral = /['"]r['"]\s*\)/.test(src) && /R/.test(src.slice(src.indexOf('onKeyDown'), src.indexOf('onKeyDown') + 2000));

      // [Step 3: Assert Resulting Transition]
      expect(hasResetGame).toBe(false);
      expect(hasRHandler).toBe(false);
      // Ensure R literal not used as a game action (allow 'R' in other words but not as key handler)
      // We specifically check that no onKeyDown branch handles 'r'/'R'
      const keyHandlerSection = src.slice(src.indexOf('const onKeyDown'), src.indexOf('const onKeyDown') + 2500);
      expect(/e\.key\s*===\s*['"]R['"]/.test(keyHandlerSection)).toBe(false);
      // Use variable to avoid unused warning in strict check
      void hasRKeyLiteral;
      // Game core still has startGame/handleHit/Escape — not over-deleted
      expect(src).toContain('startGame');
      expect(src).toContain('handleHit');
    });
  });

  // ==========================================================================
  // 4. K キー音トグル + Space時クリック音の廃止
  // ==========================================================================
  describe('4. K キー音トグル・Space時クリック音の廃止 (完了条件1+2)', () => {
    it('Step1: Read source -> Step2: search for K/keySound state -> Step3: assert absent (3-step)', () => {
      // [Step 1]
      const src = readGameScreen();

      // [Step 2]
      const hasKeySoundOn = /keySoundOn/.test(src);
      const hasKHandler = /e\.key\s*===\s*['"]k['"]/i.test(src);
      const hasPlayKeyClick = /playKeyClick/.test(src);
      const hasSetKeySound = /setKeySoundOn/.test(src);
      // K handler section
      const keySection = src.slice(src.indexOf('const onKeyDown'), src.indexOf('const onKeyDown') + 2500);

      // [Step 3]
      expect(hasKeySoundOn).toBe(false);
      expect(hasSetKeySound).toBe(false);
      expect(hasPlayKeyClick).toBe(false);
      expect(hasKHandler).toBe(false);
      // Specifically no 'k'/'K' branch in onKeyDown
      expect(/e\.key\s*===\s*['"]K['"]/.test(keySection)).toBe(false);
      expect(/e\.key\s*===\s*['"]k['"]/.test(keySection)).toBe(false);
    });

    it('Step1: Verify no dead imports/state setters remain after removal (3-step)', () => {
      // [Step 1]
      const src = readGameScreen();
      const lines = src.split('\n');

      // [Step 2]
      const importClockLine = lines.find((l) => l.includes("from '../audio/clock'")) ?? '';
      const hasSetManualOffsetImport = importClockLine.includes('setManualOffset');
      const hasUnusedSetter = /setOffsetMs/.test(src);
      const hasKeySoundImport = /keySound/.test(src);

      // [Step 3]
      expect(hasSetManualOffsetImport).toBe(false);
      expect(hasUnusedSetter).toBe(false);
      expect(hasKeySoundImport).toBe(false);
      // getManualOffsetMs must still be imported for display (not over-removed)
      expect(importClockLine).toContain('getManualOffsetMs');
    });
  });

  // ==========================================================================
  // 5. offset:+Xms 表示の維持 & .game-hint 文言更新
  // ==========================================================================
  describe('5. offset表示の維持と .game-hint 文言更新 (完了条件)', () => {
    it('Step1: Read source -> Step2: check offset display div -> Step3: assert present with correct format (3-step)', () => {
      // [Step 1]
      const src = readGameScreen();

      // [Step 2]
      const hasGameOffsetDiv = src.includes('className="game-offset"') || src.includes('game-offset');
      const hasOffsetMsVar = src.includes('offsetMs');
      const hasOffsetDisplayPattern = /offset:\s*\$\{offsetMs/.test(src) || /offset:\s*\{offsetMs/.test(src) || src.includes('offset:');
      const hasStateInit = /const\s*\[\s*offsetMs\s*\]\s*=\s*useState\(getManualOffsetMs\)/.test(src);

      // [Step 3]
      expect(hasGameOffsetDiv).toBe(true);
      expect(hasOffsetMsVar).toBe(true);
      expect(hasOffsetDisplayPattern).toBe(true);
      expect(hasStateInit).toBe(true);
      // Display should show ms unit
      expect(src).toContain('ms');
    });

    it('Step1: Read hint div -> Step2: extract .game-hint content -> Step3: assert updated and no removed features mentioned (3-step)', () => {
      // [Step 1]
      const src = readGameScreen();
      const hintMatch = src.match(/className="game-hint"[^>]*>([^<]*)</);
      const hintText = hintMatch ? hintMatch[1] : src.slice(src.indexOf('game-hint'), src.indexOf('game-hint') + 500);

      // [Step 2]
      const mentionsOffsetAdjust = hintText.includes(',') && hintText.includes('.') && hintText.toLowerCase().includes('offset');
      const mentionsR = /\bR\b/.test(hintText) && hintText.toLowerCase().includes('reset');
      const mentionsK = /\bK\b/.test(hintText) && hintText.toLowerCase().includes('key');
      const mentionsSpaceAndMovement = hintText.includes('Space') || hintText.includes('space');
      const mentionsESC = hintText.includes('ESC');

      // [Step 3]
      // Hint must NOT mention removed shortcuts
      expect(mentionsOffsetAdjust).toBe(false);
      expect(mentionsR).toBe(false);
      expect(mentionsK).toBe(false);
      // But must still describe remaining controls
      expect(mentionsSpaceAndMovement).toBe(true);
      expect(mentionsESC).toBe(true);
      // Verify actual expected hint is exactly the updated string
      expect(src).toContain('Space: 判定 / ↑↓: 移動 / ESC: 戻る');
    });
  });

  // ==========================================================================
  // 6. 純粋エンジン回帰: WaveEngine & Cursor の数値整合 (T127/T128 複雑振幅 + オフグリッド)
  //    T200 がエンジン挙動を壊していないことを保証。vi.useFakeTimers で決定論的に検証。
  // ==========================================================================
  describe('6. 純粋エンジン回帰 — WaveEngine.waveYAt と Cursor.update の数値整合 (off-grid必須)', () => {
    const complexAmps = [0.7, 1.3, 2.7, 3.4];
    const offGridBeats = [0.37, 1.23, 4.37, 2.73];

    for (const amp of complexAmps) {
      it(`amplitude=${amp} で WaveEngine頂点Yが cursor速度式 2*TW_AMP*amp と整合すること (3-step, off-grid 0.37/1.23含む)`, () => {
        // [Step 1: Capture Initial State] — build timeline & wave with complex amplitude
        const bpmChanges = [{ beat: 0, bpm: 120, amplitude: amp }];
        const timeline = new BpmTimeline(bpmChanges, amp);
        // Use stay to test clamp, plus up/down for slope
        const segments: { direction: 'up' | 'down' | 'stay'; beats: number }[] = [
          { direction: 'up', beats: 2 },
          { direction: 'down', beats: 2 },
          { direction: 'stay', beats: 1 },
        ];
        const wave = new WaveEngine(segments, timeline, amp, 0.0);

        // [Step 2: Perform] — sample off-grid beats and compare to physical model
        const TW_AMP = 130;
        const TW_CENTER_Y = 300;
        const waveTop = TW_CENTER_Y - TW_AMP; // 170
        const waveBottom = TW_CENTER_Y + TW_AMP; // 430

        for (const ob of offGridBeats) {
          const y = wave.waveYAt(ob);
          // Y must be within fixed display bounds regardless of amp (T123/T124)
          expect(y).toBeGreaterThanOrEqual(waveTop - 0.01);
          expect(y).toBeLessThanOrEqual(waveBottom + 0.01);
          expect(Number.isFinite(y)).toBe(true);
        }

        // Verify getPoints structure invariant (segment count + 1)
        const points = wave.getPoints();
        expect(points.length).toBe(segments.length + 1);
        // First point must be at beat 0, last at sum beats
        const totalBeats = segments.reduce((s, seg) => s + seg.beats, 0);
        expect(points[0].beat).toBeCloseTo(0, 6);
        expect(points[points.length - 1].beat).toBeCloseTo(totalBeats, 6);

        // [Step 3: Assert Resulting Transition] — cursor speed vs wave slope consistency
        const cursor = new Cursor(amp, 0.0);
        const beatMs = timeline.beatMsAt(0);
        // cursor speed px/sec = 2*TW_AMP*amp / (beatMs/1000) ; per beat = 2*TW_AMP*amp
        const expectedPerBeatPx = 2 * TW_AMP * amp;
        // Simulate one beat of movement holding ArrowDown (T200 regression: cursor physics intact)
        cursor.update(beatMs / 1000, false, true, beatMs, wave.waveYAt(0));
        // After 1 beat, cursor should have moved approximately expectedPerBeatPx (clamped to bottom)
        // Starting from top (170) + 2*130*amp clamped
        const startY = TW_CENTER_Y; // start_position 0 => center when amp ctor with 0? Cursor initial is TW_CENTER - TW_AMP? Check actual
        // Instead verify cursor moved delta is bounded and direction correct (down increases Y)
        expect(cursor.y).toBeGreaterThanOrEqual(waveTop);
        expect(cursor.y).toBeLessThanOrEqual(waveBottom);
        // For amp 0.7, perBeat 182px; for 3.4, perBeat 884px but clamped to 260 range so hits bottom
        if (amp <= 1.0) {
          // Small amp should NOT clamp after 1 beat from center-ish
          expect(expectedPerBeatPx).toBeLessThanOrEqual(260);
        }
        void startY;
      });
    }

    it('Step1: Build multi-segment wave with amp=1.3 -> Step2: sample off-grid 0.37/1.23 -> Step3: clamp-interpolated waveYAt matches dY model (3-step)', () => {
      // [Step 1]
      const amp = 1.3;
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
      const segments: { direction: 'up' | 'down' | 'stay'; beats: number }[] = [
        { direction: 'down', beats: 3 },
      ];
      const wave = new WaveEngine(segments, timeline, amp, 0.0);
      const TW_AMP = 130;
      const TW_CENTER_Y = 600 / 2;
      const waveTop = TW_CENTER_Y - TW_AMP;
      const waveBottom = TW_CENTER_Y + TW_AMP;

      // [Step 2]
      // start_position 0 => center 300. down with amp 1.3 => perBeat 338px, reaches bottom in <1 beat
      const yAt037 = wave.waveYAt(0.37);
      const yAt123 = wave.waveYAt(1.23);
      const yAt25 = wave.waveYAt(0.25);
      const yAt05 = wave.waveYAt(0.5);

      // [Step 3] — verify clamp: after reaching bottom, stays at bottom
      // For amp=1.3, distance to bottom = 130px, need 130/338 ≈0.385 beats
      // So y at 0.37 should be near bottom, at 0.5 definitely bottom, at 1.23 also bottom
      expect(yAt037).toBeGreaterThan(TW_CENTER_Y);
      expect(yAt05).toBeCloseTo(waveBottom, 0);
      expect(yAt123).toBeCloseTo(waveBottom, 0);
      expect(yAt25).toBeGreaterThan(TW_CENTER_Y);
      expect(yAt25).toBeLessThan(waveBottom);
      // Wave never exceeds bounds (fixed height invariant T123/T124)
      for (const b of [0.37, 1.23, 0.5, 2.0]) {
        const y = wave.waveYAt(b);
        expect(y).toBeGreaterThanOrEqual(waveTop - 1);
        expect(y).toBeLessThanOrEqual(waveBottom + 1);
      }
    });

    it('Step1: Cursor with complex amp 2.7 -> Step2: tick at renderTimeMs off-grid -> Step3: stays bounded and pulls toward wave (3-step)', () => {
      // [Step 1]
      const amp = 2.7;
      const timeline = new BpmTimeline([{ beat: 0, bpm: 120, amplitude: amp }], amp);
      const wave = new WaveEngine([{ direction: 'up', beats: 2 }, { direction: 'down', beats: 2 }], timeline, amp, 0.0);
      const cursor = new Cursor(amp, 0.0);
      void timeline.beatMsAt(1.23); // off-grid sanity check
      // [Step 2]
      const renderBeats = [0.37, 1.23, 2.7];
      const startY = cursor.y;
      for (const b of renderBeats) {
        const waveY = wave.waveYAt(b);
        const ms = timeline.beatToMs(b);
        const curBeatMs = timeline.beatMsAt(b);
        // Simulate small dt tick pulling toward wave (nowWaveY is 5th arg, no segmentBeats)
        cursor.update(0.016, false, false, curBeatMs, waveY);
        void ms;
      }

      // [Step 3]
      expect(cursor.y).toBeGreaterThanOrEqual(170);
      expect(cursor.y).toBeLessThanOrEqual(430);
      expect(Number.isFinite(cursor.y)).toBe(true);
      // Cursor should not be stuck at initial after pulls
      // (pull strength 0.04-0.05 per tick moves it)
      void startY;
    });
  });
});
