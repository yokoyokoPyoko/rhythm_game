import { test, expect } from '@playwright/test';

test('T32 GameScreen: game loop, ESC, R reset, result transition', async ({ page }) => {
  const errors: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
        errors.push(text);
      }
    }
  });

  page.on('pageerror', err => {
    errors.push(err.message);
  });

  // 1. Navigate to select screen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('body')).toBeAttached();

  // 2. Enter game screen via song card (songId -> songs.toml -> chart -> audio)
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();

  // 3. Canvas mounted; wait so the video records the loading -> ready transition
  const canvas = page.locator('canvas.game-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(2500);

  // 4. Start game with Space (initializes AudioContext: metronome + music playback)
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);

  // 5. First ring at beat 4.0 (120bpm -> 2000ms). Hit Space near it.
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');

  // 6. Move cursor with Arrow keys between rings (video: input responsiveness)
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(700);
  await page.keyboard.up('ArrowDown');

  // 7. Second ring at beat 8.0 (4000ms). Hit Space near it.
  await page.waitForTimeout(800);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);

  // 8. R: restart the game, then Space to (re)start audio
  await page.keyboard.press('r');
  await page.waitForTimeout(800);
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);

  // 9. Song ends (last ring hitTime + 2s) -> auto navigate to ResultScreen
  await expect(page.locator('.result-screen')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(2000);

  // 10. 「もう一回」 -> back to GameScreen (replay path)
  const retryButton = page.locator('.result-button.primary');
  await expect(retryButton).toBeVisible();
  await retryButton.click();
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.waitForTimeout(1500);

  // 11. ESC -> back to SelectScreen
  await page.keyboard.press('Escape');
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);

  // 12. No unhandled runtime errors
  expect(errors).toHaveLength(0);
});
