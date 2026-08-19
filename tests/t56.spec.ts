import { test, expect } from '@playwright/test';

test('T56 in-editor playtest test', async ({ page }) => {
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

  // 1. Navigate to home page
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('#root')).toBeVisible();

  // Frame 1: Home / Select screen
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // Navigate to editor screen
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });

  // Frame 2: Editor screen loaded
  const playtestBtn = page.locator('button', { hasText: 'プレイテスト' });
  await expect(playtestBtn).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction: click playtest button
  await playtestBtn.click();
  
  // Verify game screen (playtest overlay) is shown
  const gameCanvas = page.locator('canvas.game-canvas');
  await expect(gameCanvas).toBeVisible();

  // Frame 3: Playtest active (GameScreen rendered from editor memory)
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Press Escape to exit playtest
  await page.keyboard.press('Escape');
  await page.waitForSelector('.editor-screen', { timeout: 5000 });

  // Frame 4: Exited playtest, returned to editor screen
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Navigate back to home screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
