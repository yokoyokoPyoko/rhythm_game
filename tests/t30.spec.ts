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

test('T30 React app shell routing test', async ({ page }) => {
  // T201: app defaults to public view; import UI / editor / calibration are debug-only
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

  // Route 1: / -> SelectScreen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);
  await addCustomSong(page);

  // Route 2: /play/:songId -> GameScreen (click song card)
  const songCard = page.locator('.song-card').first();
  await expect(songCard).toBeVisible();
  await songCard.click();
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.waitForTimeout(2000);

  // Start game with Space, then simulate rhythm hits + cursor movement
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowUp');
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowDown');
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2000);

  // Route 3: /result -> ResultScreen (wait for natural transition after song end)
  await page.waitForSelector('.result-screen', { timeout: 15000 });
  await expect(page.locator('.result-rank')).toBeVisible();
  await page.waitForTimeout(2000);

  // Back to select screen
  const selectButton = page.locator('button', { hasText: '曲選択' });
  await expect(selectButton).toBeVisible();
  await selectButton.click();
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);

  // Route 4: /editor -> EditorScreen
  await page.goto('http://localhost:5173/#/editor');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.editor-screen')).toBeVisible();
  await page.waitForTimeout(2000);

  // Route 5: calibration overlay opened via L key (no dedicated /calibration route)
  await page.goto('http://localhost:5173/');
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.locator('[data-testid="select-calibration-button"]').click();
  await expect(page.locator('[data-testid="editor-calibration-modal"]')).toBeVisible();
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="editor-calibration-modal"]')).toHaveCount(0);

  // Back to select screen
  await page.goto('http://localhost:5173/');
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.waitForTimeout(1500);

  expect(errors).toHaveLength(0);
});
