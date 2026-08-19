import { test, expect } from '@playwright/test';

test('T53 segment editor and live waveform preview test', async ({ page }) => {
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

  // Frame 2: Editor screen loaded (SegmentEditor & WavePreview visible)
  const waveCanvas = page.locator('canvas.wave-preview');
  await expect(waveCanvas).toBeVisible();
  const addBtn = page.locator('.segment-editor-head button', { hasText: '追加' });
  await expect(addBtn).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction: Add first segment
  await addBtn.click();
  const segmentItems = page.locator('.segment-list-item');
  await expect(segmentItems).toHaveCount(1);

  // Configure first segment (up, beats: 2)
  const dirSelect1 = page.locator('.segment-direction').first();
  await dirSelect1.selectOption('up');
  const beatsInput1 = page.locator('.segment-beats').first();
  await beatsInput1.fill('2');

  // Frame 3: First segment added & modified, preview updated
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Add second segment (down, beats: 1.5)
  await addBtn.click();
  await expect(segmentItems).toHaveCount(2);

  const dirSelect2 = page.locator('.segment-direction').nth(1);
  await dirSelect2.selectOption('down');
  const beatsInput2 = page.locator('.segment-beats').nth(1);
  await beatsInput2.fill('1.5');

  // Reorder / move down
  const moveDownBtn = page.locator('.segment-move', { hasText: '▼' }).first();
  await moveDownBtn.click();

  // Frame 4: Second segment added, reordered, waveform preview updated
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Delete first segment
  const deleteBtn = page.locator('.segment-delete').first();
  await deleteBtn.click();
  await expect(segmentItems).toHaveCount(1);

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
