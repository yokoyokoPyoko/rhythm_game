import { test, expect } from '@playwright/test';

test('T42 game and chart integration test', async ({ page }) => {
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

  // 1. Navigate to home and simulate user interaction
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('#root')).toBeVisible();

  // Frame 1: Select screen
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // Click song card to navigate to GameScreen (songs.toml -> chart.toml -> audio load -> game loop)
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await page.waitForTimeout(1000);

  // Frame 2: Game screen loaded
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate gameplay interaction
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);

  // Frame 3: Game running / synchronization active
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Wait for game completion / transition to ResultScreen
  await page.waitForSelector('.result-screen', { timeout: 15000 });

  // Frame 4: Result screen
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Return to select screen
  const selectButton = page.locator('button', { hasText: '曲選択' });
  await expect(selectButton).toBeVisible();
  await selectButton.click();
  await page.waitForTimeout(1000);

  // Frame 5: Returned to select screen
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // 3. Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
