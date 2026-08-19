import { test, expect } from '@playwright/test';

test('T51 editor audio player and BPM setting test', async ({ page }) => {
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
  const urlInput = page.locator('#audio-url');
  await expect(urlInput).toBeVisible();
  await expect(urlInput).toHaveValue('/rhythm_game/audio/08.Reply.flac');
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction: modify BPM and audio URL / test play/stop button & position display
  const bpmInput = page.locator('#bpm');
  await expect(bpmInput).toBeVisible();
  await bpmInput.fill('130');

  // Frame 3: BPM changed & URL inspected
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Click play / stop button or interact with timeline/slider
  const playButton = page.locator('button', { hasText: '再生' });
  if (await playButton.isVisible()) {
    await playButton.click();
    await page.waitForTimeout(500);
  }

  // Frame 4: Audio playback / time & beat display
  const timeDisplay = page.locator('.editor-pos-time');
  const beatDisplay = page.locator('.editor-pos-beat');
  await expect(timeDisplay).toBeVisible();
  await expect(beatDisplay).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Click back link to return to home screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
