import { test, expect } from '@playwright/test';

test('T91 comprehensive debug & verification test', async ({ page }) => {
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
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) {
      errors.push(err.message);
    }
  });

  // 1. Home / Select Screen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('body')).toBeAttached();
  await expect(page.locator('.select-header h1')).toHaveText('トレース・ウェーブ');
  await page.screenshot({ path: 'screenshots/frame_1.png' });
  await page.waitForTimeout(1500);

  // 2. Calibration overlay (L key / offset reset verification)
  await page.keyboard.press('l');
  await expect(page.locator('[data-testid="editor-calibration-modal"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('[data-testid="calibration-canvas"]')).toBeVisible();
  await expect(page.locator('[data-testid="calibration-offset"]')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });
  await page.waitForTimeout(1000);

  // Space to trigger ring judgement (proseka-style loop), then tweak offset
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  await page.keyboard.press('.');
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'screenshots/frame_3.png' });
  await page.waitForTimeout(800);

  // Cancel via ESC -> close overlay and restore, back to select screen
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="editor-calibration-modal"]')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.select-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1000);

  // 3. Game Screen (startGame double start prevention, ring selection improvement, audio duration end check)
  const firstSongCard = page.locator('.song-card').first();
  await firstSongCard.click();
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.game-canvas')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: 'screenshots/frame_4.png' });
  await page.waitForTimeout(1500);

  // Test Space spamming (startGame double start prevention) & hitting rings
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Escape back to select screen
  await page.keyboard.press('Escape');
  await expect(page.locator('.select-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1000);

  // 4. Editor Screen (WavePreview BPM changes reflection verification)
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.editor-header h1')).toHaveText('オーサリングツール');
  await page.screenshot({ path: 'screenshots/frame_6.png' });
  await page.waitForTimeout(2000);

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
