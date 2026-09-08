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

test('T31 select screen: song cards, click to play, L to calibration', async ({ page }) => {
  // T201: app defaults to public view; import UI / calibration are debug-only
  await page.addInitScript(() => localStorage.setItem('traceWaveViewMode', 'debug'))
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => {
    if (/TypeError|ReferenceError/.test(err.message)) errors.push(err.message);
  });

  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('.select-header h1')).toBeAttached();
  await expect(page.locator('.select-header h1')).toHaveText('トレース・ウェーブ');

  await addCustomSong(page);

  const cards = page.locator('.song-card');
  await expect(cards.first()).toBeVisible({ timeout: 5000 });
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);

  for (let i = 0; i < cardCount; i++) {
    const card = cards.nth(i);
    await expect(card.locator('.song-card-title')).toBeVisible();
    await expect(card.locator('.song-card-artist')).toBeVisible();
    await expect(card.locator('.difficulty-dot')).toHaveCount(5);
  }

  await page.waitForTimeout(2000);

  const firstCard = cards.first();
  const title = await firstCard.locator('.song-card-title').textContent();
  await firstCard.hover();
  await page.waitForTimeout(1500);

  const transform = await firstCard.evaluate(
    (el) => getComputedStyle(el).transform
  );
  expect(transform).not.toBe('none');

  await firstCard.click();
  await expect(page).toHaveURL(/\/play\/[^/]+$/, { timeout: 5000 });
  await expect(page.locator('canvas')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('body')).toBeAttached();
  await page.waitForTimeout(3000);

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/, { timeout: 5000 });
  await expect(page.locator('.select-header h1')).toBeVisible();
  await page.waitForTimeout(2000);

  // Calibration is opened via the debug-mode button (T199 removed the 'L' key)
  await page.locator('[data-testid="select-calibration-button"]').click();
  await expect(page.locator('[data-testid="editor-calibration-modal"]')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('body')).toBeAttached();
  await page.waitForTimeout(2000);
  // Close the overlay (ESC) so subsequent assertions / screenshots are clean
  await page.keyboard.press('Escape');

  expect(errors).toHaveLength(0);
  expect(title).toBeTruthy();
});
