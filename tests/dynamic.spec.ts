import { test, expect } from '@playwright/test';

test('T52 ring recording test', async ({ page }) => {
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
  const snapSelect = page.locator('#snap');
  await expect(snapSelect).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction 1: Change snap setting
  await snapSelect.selectOption('0.5');
  await page.waitForTimeout(300);

  // Frame 3: Snap setting updated
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Simulate user interaction 2: Click play or simulate audio state / ring recording interaction
  const playButton = page.locator('button', { hasText: '再生' });
  if (await playButton.isVisible()) {
    await playButton.click();
    await page.waitForTimeout(300);
  }

  // Simulate Space keypress or check ring recording section & ring list container
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  // Frame 4: Ring recording interaction & list state
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Click back link to return to home screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
