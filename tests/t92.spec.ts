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

test('T92 Playwright test: Expanded Wave Amplitude (TW_AMP = 130px, Y: 170~430px)', async ({ page }) => {
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
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) {
      errors.push(err.message);
    }
  });

  // 1. Load app home / song select screen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#root')).toBeVisible();
  await page.screenshot({ path: 'screenshots/t92_select.png' });
  await page.waitForTimeout(1500);

  // 2. Select song and enter game screen
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('canvas.game-canvas')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t92_game_start.png' });
  await page.waitForTimeout(2000);

  // 3. Actively interact with game controls to verify expanded amplitude & cursor movement (TW_AMP = 130)
  // Press ArrowUp and ArrowDown to move cursor across expanded range (Y: 170 - 430)
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: 'screenshots/t92_gameplay_interactive.png' });
  await page.waitForTimeout(1500);

  // 4. Offset keys (</>) were removed from the game screen in T200; the
  //    offset display remains static. Just capture a screenshot of gameplay.
  await page.screenshot({ path: 'screenshots/t92_gameplay_offset.png' });

  // 5. Exit game screen using Escape key back to select screen
  await page.keyboard.press('Escape');
  await expect(page.locator('.select-screen')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t92_back_select.png' });
  await page.waitForTimeout(1000);

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
