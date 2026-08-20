import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { parse } from 'smol-toml';

test('T94 Playwright test: Segment direction "stay" (horizontal hold) & real-time segment recording in editor', async ({ page }) => {
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
  await page.screenshot({ path: 'screenshots/t94_select.png' });
  await page.waitForTimeout(1500);

  // 2. Navigate to editor screen
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t94_editor_loaded.png' });
  await page.waitForTimeout(2000);

  // 3. Test manual segment addition and setting direction to 'stay' (―)
  const segmentPane = page.locator('section.editor-pane', { hasText: 'セグメント' });
  const addSegmentBtn = segmentPane.locator('button', { hasText: '追加' });
  await expect(addSegmentBtn).toBeVisible();
  await addSegmentBtn.click();
  await page.waitForTimeout(500);

  const segmentSelect = segmentPane.locator('.segment-direction').first();
  await expect(segmentSelect).toBeVisible();
  await segmentSelect.selectOption('stay');
  await expect(segmentSelect).toHaveValue('stay');

  const segmentBeatsInput = segmentPane.locator('.segment-beats').first();
  await expect(segmentBeatsInput).toBeVisible();
  await segmentBeatsInput.fill('2');
  await expect(segmentBeatsInput).toHaveValue('2');

  await page.screenshot({ path: 'screenshots/t94_stay_segment_added.png' });
  await page.waitForTimeout(2000);

  // 4. Start audio playback in editor to test real-time key recording
  const playBtn = page.locator('button', { hasText: '再生' });
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  await page.waitForTimeout(1000);

  // 5. Simulate real-time key presses during playback for stamping segments (ArrowUp, ArrowDown, ArrowRight / stay)
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(600);
  await page.keyboard.press('ArrowRight'); // stay segment key
  await page.waitForTimeout(600);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(800);

  // Stop playback
  const stopBtn = page.locator('button', { hasText: '停止' });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  await page.screenshot({ path: 'screenshots/t94_realtime_recorded.png' });
  await page.waitForTimeout(2000);

  // 6. Test playtest with 'stay' segments
  const playtestBtn = page.locator('button', { hasText: 'プレイテスト' });
  await expect(playtestBtn).toBeVisible();
  await playtestBtn.click();
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t94_playtest_active.png' });
  await page.waitForTimeout(3000);

  // Exit playtest with Escape
  await page.keyboard.press('Escape');
  await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1500);

  // 7. Export TOML and verify that segments with 'stay' direction are correctly serialized
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
    expect(Array.isArray(parsed.segments)).toBe(true);
    expect(parsed.segments.some((s: any) => s.direction === 'stay')).toBe(true);
  }

  await page.screenshot({ path: 'screenshots/t94_export_verified.png' });
  await page.waitForTimeout(2000);

  // 8. Navigate back to home / select screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });
  await page.screenshot({ path: 'screenshots/t94_back_select.png' });
  await page.waitForTimeout(1500);

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});
