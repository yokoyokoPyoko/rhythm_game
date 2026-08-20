import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { parse } from 'smol-toml';

test('T93 Playwright test: Chart settings extension (amplitude, scroll_speed, audio_offset) in editor and TOML export', async ({ page }) => {
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

  // 1. Navigate to home / select screen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('#root')).toBeVisible();
  await page.screenshot({ path: 'screenshots/t93_select.png' });
  await page.waitForTimeout(1500);

  // 2. Navigate to editor screen
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t93_editor_loaded.png' });
  await page.waitForTimeout(2000);

  // 3. Edit chart settings: amplitude, scroll_speed, audio_offset
  const amplitudeInput = page.locator('#amplitude');
  await expect(amplitudeInput).toBeVisible();
  await amplitudeInput.fill('160');
  await expect(amplitudeInput).toHaveValue('160');

  const scrollSpeedInput = page.locator('#scroll-speed');
  await expect(scrollSpeedInput).toBeVisible();
  await scrollSpeedInput.fill('130');
  await expect(scrollSpeedInput).toHaveValue('130');

  const audioOffsetInput = page.locator('#audio-offset');
  await expect(audioOffsetInput).toBeVisible();
  await audioOffsetInput.fill('250');
  await expect(audioOffsetInput).toHaveValue('250');

  await page.screenshot({ path: 'screenshots/t93_settings_edited.png' });
  await page.waitForTimeout(2000);

  // 4. Export TOML and verify download contains updated amplitude, scroll_speed, audio_offset
  const exportBtn = page.locator('button', { hasText: 'エクスポート' });
  await expect(exportBtn).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportBtn.click(),
  ]);

  expect(download.suggestedFilename()).toBe('reply.toml');
  const filePath = await download.path();
  if (filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const parsed = parse(fileContent) as any;
    expect(parsed).toBeDefined();
    expect(parsed.amplitude).toBe(160);
    expect(parsed.scroll_speed).toBe(130);
    expect(parsed.audio_offset).toBe(250);
  }

  await page.screenshot({ path: 'screenshots/t93_export_verified.png' });
  await page.waitForTimeout(2000);

  // 5. Test in-editor playtest to verify settings reflection
  const playtestBtn = page.locator('button', { hasText: 'プレイテスト' });
  if (await playtestBtn.isVisible()) {
    await playtestBtn.click();
    await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'screenshots/t93_playtest_active.png' });
    await page.waitForTimeout(2500);

    // Exit playtest / press Escape
    await page.keyboard.press('Escape');
    await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(1500);
  }

  // 6. Navigate back to home / select screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t93_back_select.png' });
  await page.waitForTimeout(1500);

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
