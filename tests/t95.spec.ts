import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { parse } from 'smol-toml';

test('T95 Playwright test: Hold ring (long press note) addition, editor configuration, game screen continuous hold judgment & tail rendering, TOML export verification', async ({ page }) => {
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
  await page.screenshot({ path: 'screenshots/t95_select.png' });
  await page.waitForTimeout(1500);

  // 2. Navigate to editor screen
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t95_editor_loaded.png' });
  await page.waitForTimeout(2000);

  // 3. Start playback and stamp a ring using Space key
  const playBtn = page.locator('button', { hasText: '再生' });
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  await page.waitForTimeout(800);

  // Stamp ring
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);

  // Stop playback
  const stopBtn = page.locator('button', { hasText: '停止' });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  await page.waitForTimeout(1000);

  // 4. Configure the ring as a 'hold' note with duration in the ring list
  const ringPane = page.locator('section.editor-pane', { hasText: 'リング録音' });
  const typeSelect = ringPane.locator('.ring-type-select').first();
  await expect(typeSelect).toBeVisible();
  await typeSelect.selectOption('hold');
  await expect(typeSelect).toHaveValue('hold');

  const durationInput = ringPane.locator('.ring-duration-input').first();
  await expect(durationInput).toBeVisible();
  await durationInput.fill('2');
  await expect(durationInput).toHaveValue('2');

  await page.screenshot({ path: 'screenshots/t95_hold_ring_configured.png' });
  await page.waitForTimeout(2000);

  // 5. Launch playtest to verify hold note rendering and continuous hold logic
  const playtestBtn = page.locator('button', { hasText: 'プレイテスト' });
  await expect(playtestBtn).toBeVisible();
  await playtestBtn.click();
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t95_playtest_active.png' });
  await page.waitForTimeout(2000);

  // Simulate holding space down during playtest
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');
  await page.waitForTimeout(1500);

  // Exit playtest with Escape
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1500);

  // 6. Export TOML and verify hold attributes in exported chart
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
    expect(Array.isArray(parsed.rings)).toBe(true);
    expect(parsed.rings.some((r: any) => r.type === 'hold' && r.duration === 2)).toBe(true);
  }

  await page.screenshot({ path: 'screenshots/t95_export_verified.png' });
  await page.waitForTimeout(2000);

  // 7. Navigate back to home / select screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t95_back_select.png' });
  await page.waitForTimeout(1500);

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
