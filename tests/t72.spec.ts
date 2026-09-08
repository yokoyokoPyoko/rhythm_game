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

test('T72 ResultScreen polish test', async ({ page }) => {
  // T201: app defaults to public view; custom import UI is debug-only
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

  // Frame 1: Select screen
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // 2. Click song card to navigate to game screen
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await page.waitForTimeout(1000);

  // Frame 2: Game screen loaded
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // 3. Start game with Space
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);

  // Frame 3: Game running / gameplay interaction
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Wait for game completion and transition to ResultScreen
  await page.waitForSelector('.result-screen', { timeout: 15000 });

  // Frame 4: Result screen with rank big display, count-up score, and stats cards
  await expect(page.locator('.result-rank')).toBeVisible();
  await expect(page.locator('.result-score')).toBeVisible();
  await expect(page.locator('.result-stats')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // 4. Click '曲選択' to return to select screen
  const selectButton = page.locator('button', { hasText: '曲選択' });
  await expect(selectButton).toBeVisible();
  await selectButton.click();
  await page.waitForTimeout(1000);

  // Frame 5: Returned to select screen
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
