import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173/';

test('T74 screen transition animations (fade-in via CSS transition)', async ({ page }) => {
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

  // --- Frame 1: Select screen (fade-in on mount) ---
  await page.goto(BASE);
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('body')).toBeAttached();
  const selectScreen = page.locator('.select-screen.screen-fade');
  await expect(selectScreen).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.song-card').first()).toBeVisible();
  await page.waitForTimeout(2000);

  // --- Frame 2: Game screen (click song card -> navigate /play/:songId) ---
  await page.locator('.song-card').first().click();
  await expect(page.locator('.game-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await page.locator('.game-canvas').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(2500);

  // --- Frame 3: Back to select screen (ESC) ---
  await page.keyboard.press('Escape');
  await expect(page.locator('.select-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // --- Frame 4: Calibration screen (L shortcut) ---
  await page.keyboard.press('l');
  await expect(page.locator('.calibration-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.calibration-title')).toBeVisible();
  await page.waitForTimeout(2000);

  // --- Frame 5: Back to select screen (ESC) ---
  await page.keyboard.press('Escape');
  await expect(page.locator('.select-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // --- Frame 6: Editor screen (hash navigation) ---
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await expect(page.locator('.editor-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.editor-header h1')).toHaveText('オーサリングツール');
  await page.waitForTimeout(2000);

  // --- Frame 7: Result screen (hash navigation, score count-up animation) ---
  await page.evaluate(() => {
    window.location.hash = '#/result';
  });
  await expect(page.locator('.result-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.result-rank')).toBeVisible();
  await page.waitForTimeout(2500);

  // --- Frame 8: Back to select screen via result button ---
  await page.getByRole('button', { name: '曲選択' }).click();
  await expect(page.locator('.select-screen.screen-fade')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(2000);

  // --- Assert fade-in class + animation applied on every screen ---
  const fadeApplied = await page.evaluate(() => {
    const el = document.querySelector('.screen-fade');
    if (!el) return false;
    const anim = getComputedStyle(el).animationName;
    return anim === 'screen-fade-in';
  });
  expect(fadeApplied).toBe(true);

  // --- No unhandled errors ---
  expect(errors).toHaveLength(0);
});
