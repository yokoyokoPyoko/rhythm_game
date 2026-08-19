import { test, expect } from '@playwright/test';

test('T50 EditorScreen layout and interaction test', async ({ page }) => {
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

  // Simulate user interaction to navigate to Editor screen
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });

  // Frame 2: Editor screen loaded (left pane 320px, right pane flex, header)
  const sidebar = page.locator('.editor-sidebar');
  await expect(sidebar).toBeVisible();
  const mainPane = page.locator('.editor-main');
  await expect(mainPane).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction 1: Interact with audio controls / BPM settings in left pane
  const urlInput = page.locator('#audio-url');
  await expect(urlInput).toBeVisible();
  await urlInput.fill('/rhythm_game/audio/08.Reply.flac');

  // Frame 3: Interaction in left pane
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Simulate user interaction 2: Interact with right pane / ring recording or segments
  const snapSelect = page.locator('#snap');
  if (await snapSelect.isVisible()) {
    await snapSelect.selectOption('0.5');
  }
  await page.waitForTimeout(500);

  // Frame 4: Interaction in right pane / timeline
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Click back link ("/ に戻る") to return to home screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });

  // Frame 5: Returned to select screen
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});
