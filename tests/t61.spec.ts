import { test, expect } from '@playwright/test';

test('T61 calibration overlay test', async ({ page }) => {
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

  // Open calibration overlay by pressing 'l'
  await page.keyboard.press('l');
  await page.waitForSelector('[data-testid="editor-calibration-modal"]', { timeout: 5000 });

  // Frame 2: Calibration overlay visible with HUD
  await expect(page.locator('[data-testid="calibration-canvas"]')).toBeVisible();
  await expect(page.locator('[data-testid="calibration-offset"]')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Adjust offset with . (plus) / , (minus) keys and verify display updates
  await page.keyboard.press('.');
  await page.waitForTimeout(150);
  await page.keyboard.press(',');
  await page.waitForTimeout(150);

  // Frame 3: overlay after offset tweaks
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Cancel via ESC should close overlay without navigating
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="editor-calibration-modal"]')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.select-header h1')).toBeVisible();

  // Frame 4: back to select screen
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
