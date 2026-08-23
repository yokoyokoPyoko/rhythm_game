import { test, expect } from '@playwright/test';

test('T73 editor polish test (timeline ring vertical lines & segment color coding)', async ({ page }) => {
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
  const waveCanvas = page.locator('canvas.wave-preview');
  await expect(waveCanvas).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Add segments (up and down) for color coding
  const addSegmentBtn = page.locator('[data-testid="segment-add"]');
  await addSegmentBtn.click();
  const dirSelect1 = page.locator('.segment-direction').first();
  await dirSelect1.selectOption('up');
  const beatsInput1 = page.locator('.segment-beats').first();
  await beatsInput1.fill('2');

  await addSegmentBtn.click();
  const dirSelect2 = page.locator('.segment-direction').nth(1);
  await dirSelect2.selectOption('down');
  const beatsInput2 = page.locator('.segment-beats').nth(1);
  await beatsInput2.fill('2');

  // Frame 3: Segments with up (accent) and down (sub) color coding rendered in wave preview
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Simulate ring recording or adding rings
  const playBtn = page.locator('button', { hasText: '再生' });
  await playBtn.click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  // Frame 4: Timeline with ring vertical lines rendered
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Stop playback and navigate back
  const stopBtn = page.locator('button', { hasText: '停止' });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }

  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
