import { test, expect } from '@playwright/test';

test('T54 BPM editor basic BPM, BPM changes list, and tap tempo test', async ({ page }) => {
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

  // Frame 2: Editor screen loaded, locate BPM editor elements
  const bpmInput = page.locator('#bpm');
  await expect(bpmInput).toBeVisible();
  await expect(bpmInput).toHaveValue('120');
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate user interaction: modify basic BPM
  await bpmInput.fill('135');
  await expect(bpmInput).toHaveValue('135');

  // Add BPM change item
  const addBpmChangeBtn = page.locator('.bpm-change-add');
  await expect(addBpmChangeBtn).toBeVisible();
  await addBpmChangeBtn.click();

  const bpmChangeItem = page.locator('.bpm-change-item');
  await expect(bpmChangeItem).toHaveCount(1);

  const beatInput = page.locator('.bpm-change-beat');
  const changeBpmInput = page.locator('.bpm-change-bpm');
  await beatInput.fill('16');
  await changeBpmInput.fill('150');

  // Frame 3: Basic BPM modified and BPM change item added & configured
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Simulate tap tempo interaction (4 taps)
  const tapButton = page.locator('button', { hasText: 'タップ' });
  await expect(tapButton).toBeVisible();

  for (let i = 0; i < 4; i++) {
    await tapButton.click();
    await page.waitForTimeout(250);
  }

  // Frame 4: Tap tempo completed, base BPM updated
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
