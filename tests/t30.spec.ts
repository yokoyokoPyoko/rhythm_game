import { test, expect } from '@playwright/test';

test('T30 React app shell routing test', async ({ page }) => {
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

  // Route 1: / -> SelectScreen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);

  // Route 2: /play/:songId -> GameScreen (click song card)
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.waitForTimeout(2000);

  // Start game with Space, then simulate rhythm hits + cursor movement
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowUp');
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowDown');
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);

  // Route 3: /result -> ResultScreen (wait for natural transition after song end)
  await page.waitForSelector('.result-screen', { timeout: 15000 });
  await expect(page.locator('.result-rank')).toBeVisible();
  await page.waitForTimeout(2000);

  // Back to select screen
  const selectButton = page.locator('button', { hasText: '曲選択' });
  await expect(selectButton).toBeVisible();
  await selectButton.click();
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);

  // Route 4: /editor -> EditorScreen
  await page.goto('http://localhost:5173/#/editor');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.editor-screen')).toBeVisible();
  await page.waitForTimeout(2000);

  // Route 5: /calibration -> CalibrationScreen (tap Space to hear metronome)
  await page.goto('http://localhost:5173/#/calibration');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.calibration-screen')).toBeVisible();
  await page.keyboard.press('Space');
  await page.waitForTimeout(3000);
  await page.keyboard.press('Escape');

  // Back to select screen
  await page.goto('http://localhost:5173/');
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);

  expect(errors).toHaveLength(0);
});
