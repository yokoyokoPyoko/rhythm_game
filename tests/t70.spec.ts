import { test, expect } from '@playwright/test';

test('T70 select screen polish and interaction test', async ({ page }) => {
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

  // Frame 1: Select screen loaded with song cards, borders, and difficulty dots
  const selectScreen = page.locator('.select-screen');
  await expect(selectScreen).toBeVisible();
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // 2. Hover over song card to test hover animation
  await songCard.hover();
  await page.waitForTimeout(300);

  // Frame 2: Hovered song card
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // 3. Click song card to navigate to game screen
  await songCard.click();
  await page.waitForTimeout(1000);

  // Frame 3: Game screen or gameplay state
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // 4. Return to select screen
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 4: Back on select screen
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // 5. Press 'l' to open calibration screen
  await page.keyboard.press('l');
  await page.waitForTimeout(1000);

  // Frame 5: Calibration screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
