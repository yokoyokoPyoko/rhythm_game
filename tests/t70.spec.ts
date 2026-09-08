import { test, expect } from '@playwright/test';

const CHART_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/tests/fixtures/custom-song.toml';
const AUDIO_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';

async function addCustomSong(page: import('@playwright/test').Page) {
  await page.locator('input[data-testid="home-chart-input"]').setInputFiles(CHART_FIXTURE);
  await page.locator('input[data-testid="home-audio-input"]').setInputFiles(AUDIO_FIXTURE);
  const addBtn = page.locator('button[data-testid="home-play-button"]');
  await expect(addBtn).toBeEnabled({ timeout: 10000 });
  await addBtn.click();
  await expect(page.locator('.song-card').first()).toBeVisible({ timeout: 10000 });
}

test('T70 select screen polish and interaction test', async ({ page }) => {
  // T201: app defaults to public view; calibration button is debug-only
  await page.addInitScript(() => localStorage.setItem('traceWaveViewMode', 'debug'))

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

  await addCustomSong(page);

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

  // 5. Open calibration overlay via debug-mode button (T199 removed 'L' key)
  await page.locator('[data-testid="select-calibration-button"]').click();
  await page.waitForTimeout(1000);

  // Frame 5: Calibration overlay
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
