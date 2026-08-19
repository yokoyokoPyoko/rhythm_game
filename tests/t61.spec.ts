import { test, expect } from '@playwright/test';

test('T61 CalibrationScreen test', async ({ page }) => {
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

  // 1. Navigate to home
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('#root')).toBeVisible();

  // Frame 1: Select screen
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // Navigate to calibration screen by pressing 'l' or updating hash
  await page.keyboard.press('l');
  await page.waitForSelector('.calibration-screen', { timeout: 5000 });

  // Frame 2: Calibration screen initial (0/8)
  await expect(page.locator('.calibration-progress-count')).toHaveText('0');
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Press Space 4 times with intervals to simulate calibration tapping
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
  }

  // Frame 3: Calibration in progress (4/8)
  await expect(page.locator('.calibration-progress-count')).toHaveText('4');
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Press Space 4 more times to complete calibration (8/8)
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
  }

  // Frame 4: Calibration completed
  await expect(page.locator('.calibration-done')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Click '曲選択に戻る' button
  const backButton = page.locator('button.calibration-back', { hasText: '曲選択に戻る' });
  await expect(backButton).toBeVisible();
  await backButton.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
