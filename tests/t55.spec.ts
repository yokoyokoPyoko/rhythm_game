import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { parse } from 'smol-toml';

test('T55 TOML export test', async ({ page }) => {
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

  // Frame 1: Home / Select screen
  await page.screenshot({ path: 'screenshots/frame_1.png' });

  // Navigate to editor screen
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });

  // Frame 2: Editor screen loaded
  const exportBtn = page.locator('button', { hasText: 'エクスポート' });
  await expect(exportBtn).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction: modify BPM and add a segment to customize editor state
  const bpmInput = page.locator('#bpm');
  await bpmInput.fill('140');
  await expect(bpmInput).toHaveValue('140');

  const addSegmentBtn = page.locator('[data-testid="segment-add"]');
  await addSegmentBtn.click();
  const segmentItem = page.locator('.segment-list-item');
  await expect(segmentItem).toHaveCount(1);

  // Frame 3: Editor state modified
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Click export button and handle download
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportBtn.click(),
  ]);

  expect(download.suggestedFilename()).toBe('reply.toml');
  const filePath = await download.path();
  if (filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const parsed = parse(fileContent);
    expect(parsed).toBeDefined();
    expect((parsed as any).bpm).toBe(140);
  }

  // Frame 4: Export completed and verified
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Navigate back to home screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
