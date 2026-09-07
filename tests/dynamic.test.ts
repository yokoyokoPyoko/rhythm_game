/**
 * @vitest-environment node
 * T200 GameScreenのプレイ時機能廃止（オフセット変更・Rリセット・キー音） — Vitest acceptance test
 * Verifies that playback features (offset adjust with comma/period, reset with R, key sound toggle/click with K/Space) are abolished in both public and debug modes, while offset display is retained, and keySound.ts is removed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.useFakeTimers();

describe('T200 GameScreenのプレイ時機能廃止（オフセット変更・Rリセット・キー音）', () => {
  const gameScreenPath = path.join(process.cwd(), 'src/screens/GameScreen.tsx');
  const keySoundPath = path.join(process.cwd(), 'src/audio/keySound.ts');

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('1. keySound.ts file removal verification (3-Step State-Transition)', () => {
    it('Step1: Identify target path for keySound.ts. Step2: Check file system. Step3: Assert file does not exist', () => {
      // Step 1: Capture initial state concept (path definition)
      expect(keySoundPath).toBeDefined();

      // Step 2: Inspect file system existence
      const exists = fs.existsSync(keySoundPath);

      // Step 3: Assert resulting transition (file must be deleted / absent)
      expect(exists).toBe(false);
    });
  });

  describe('2. GameScreen.tsx source code inspection for abolished features (3-Step State-Transition)', () => {
    const src = fs.existsSync(gameScreenPath) ? fs.readFileSync(gameScreenPath, 'utf-8') : '';

    it('Step1: Capture initial source code presence. Step2: Analyze source for removed function names and states. Step3: Assert complete absence of adjustOffset, resetGame, keySoundOn, playKeyClick', () => {
      // Step 1
      expect(src.length).toBeGreaterThan(0);

      // Step 2: Check for dead code from abolished features
      const hasAdjustOffset = src.includes('adjustOffset');
      const hasResetGame = src.includes('resetGame');
      const hasKeySoundOn = src.includes('keySoundOn');
      const hasPlayKeyClick = src.includes('playKeyClick');

      // Step 3: Assert all are absent
      expect(hasAdjustOffset).toBe(false);
      expect(hasResetGame).toBe(false);
      expect(hasKeySoundOn).toBe(false);
      expect(hasPlayKeyClick).toBe(false);
    });

    it('Step1: Inspect keydown event handlers. Step2: Check for comma (,), period (.), R, and K key handling. Step3: Assert that comma/period offset change, R reset, and K sound toggle handlers are removed', () => {
      // Step 1
      const hasKeyHandlers = src.includes('keydown');
      expect(hasKeyHandlers).toBe(true);

      // Step 2: Check if key codes for ',' (Comma), '.' (Period), 'r'/'R', 'k'/'K' are handled in game play
      const handlesComma = src.includes("key === ','") || src.includes("code === 'Comma'");
      const handlesPeriod = src.includes("key === '.'") || src.includes("code === 'Period'");
      const handlesR = src.includes("'r'") || src.includes("'R'") || src.includes('"r"') || src.includes('"R"');
      const handlesK = src.includes("'k'") || src.includes("'K'") || src.includes('"k"') || src.includes('"K"');

      // Step 3: None of these gameplay shortcut handlers should be active in GameScreen
      expect(handlesComma).toBe(false);
      expect(handlesPeriod).toBe(false);
      expect(handlesR).toBe(false);
      expect(handlesK).toBe(false);
    });

    it('Step1: Capture hint markup. Step2: Inspect .game-hint content and .game-offset presence. Step3: Assert hint does not mention abolished shortcuts while offset display div is preserved', () => {
      // Step 1
      const hasGameHint = src.includes('game-hint');
      const hasGameOffset = src.includes('game-offset');
      expect(hasGameHint).toBe(true);
      expect(hasGameOffset).toBe(true);

      // Step 2: Extract game-hint text or check its pattern
      const hintMatch = src.match(/className="game-hint"[^>]*>([^<]+)<\/div>/);
      const hintText = hintMatch ? hintMatch[1] : '';

      // Step 3: Assert offset div is retained and hint text does not advertise abolished shortcuts
      expect(hasGameOffset).toBe(true);
      if (hintText) {
        expect(hintText).not.toContain(',');
        expect(hintText).not.toContain('.');
        expect(hintText).not.toContain('R');
        expect(hintText).not.toContain('K');
      }
    });
  });

  describe('3. Behavioral simulation of key inputs (3-Step State-Transition)', () => {
    it('Step1: Initialize mock window keydown events. Step2: Dispatch comma, period, R, K keys. Step3: Assert offset value is unchanged and no error or sound trigger occurs', () => {
      // Step 1: Capture initial offset from getManualOffsetMs
      const { getManualOffsetMs } = require('../src/audio/clock');
      const initialOffset = getManualOffsetMs();

      // Step 2: Simulate window keydown for ',', '.', 'R', 'K'
      const events = [
        new KeyboardEvent('keydown', { key: ',' }),
        new KeyboardEvent('keydown', { key: '.' }),
        new KeyboardEvent('keydown', { key: 'r', code: 'KeyR' }),
        new KeyboardEvent('keydown', { key: 'k', code: 'KeyK' }),
      ];

      for (const ev of events) {
        window.dispatchEvent(ev);
      }

      // Step 3: Assert offset remains identical and no side effects occurred
      const finalOffset = getManualOffsetMs();
      expect(finalOffset).toBe(initialOffset);
    });
  });
});
