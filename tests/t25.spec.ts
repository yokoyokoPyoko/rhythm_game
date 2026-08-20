import { test, expect } from '@playwright/test';

test('T25 canvas renderer visual test', async ({ page }) => {
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

  // Frame 1: Select screen (minimal dark UI)
  await page.screenshot({ path: 'screenshots/t25_frame_1.png' });

  // 2. Click song card to start the game
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await page.waitForTimeout(2500);

  // Frame 2: Game screen — canvas mounted, wave/rings/judge line rendering
  const canvas = page.locator('canvas.game-canvas');
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: 'screenshots/t25_frame_2.png' });

  // Broken-visual-state check: canvas must contain non-background pixels (wave/rings drawn)
  const hasContent = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('2d');
    if (!ctx) return false;
    const { width, height } = el;
    const data = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < data.length; i += 4 * 97) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r !== 0x0a || g !== 0x0a || b !== 0x0a) return true;
    }
    return false;
  });
  expect(hasContent).toBe(true);

  // 3. Cursor movement with arrow keys (up/down), 60fps animation visible in video
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1200);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(800);
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(1200);
  await page.keyboard.up('ArrowDown');
  await page.waitForTimeout(800);

  // Frame 3: Cursor repositioned on wave
  await page.screenshot({ path: 'screenshots/t25_frame_3.png' });

  // 4. Rhythm taps — Space presses spread out so the video captures hit judgements + key sound
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(2200);
  }

  // Frame 4: Judgement text / combo HUD on screen
  await page.screenshot({ path: 'screenshots/t25_frame_4.png' });

  // 5. Cursor follows the wave while scrolling continues
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(2000);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(1500);

  // Frame 5: Late-game state — rings converging on judge line
  await page.screenshot({ path: 'screenshots/t25_frame_5.png' });

  // Final state before exit
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'screenshots/t25_frame_6.png' });

  // Assert no unhandled console errors or broken visual states
  expect(errors).toHaveLength(0);
});
