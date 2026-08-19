import { test, expect } from '@playwright/test';

test('T71 game screen polish test', async ({ page }) => {
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

  // Frame 1: Select screen
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // 2. Click song card to navigate to game screen
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await page.waitForTimeout(1000);

  // Frame 2: Game screen loaded with polished wave gradient and beat pulse background
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // 3. Simulate user interaction / gameplay (hitting space for judgements and combo)
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);

  // Frame 3: Judgement display (PERFECT! / GOOD) and combo rendering
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // 4. Continue gameplay interactions
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);

  // Frame 4: Combo progression and animation states
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // 5. Final state during game session or completion
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
