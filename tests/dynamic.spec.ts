import { test, expect } from '@playwright/test';

test('T32 GameScreen smoke and interaction test', async ({ page }) => {
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

  // Click song card to navigate to GameScreen
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await page.waitForTimeout(1000);

  // Frame 2: Game screen canvas loaded
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate start game with Space
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);

  // Frame 3: Game running
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Simulate gameplay interactions (Arrow keys and Space hits)
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);

  // Frame 4: Ongoing gameplay
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Test reset feature (R key)
  await page.keyboard.press('r');
  await page.waitForTimeout(500);

  // Frame 5: Post-reset game state
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // 3. Assert no unhandled errors
  expect(errors).toHaveLength(0);
});
