import { test, expect } from '@playwright/test';

test('T100 Playwright test: Hold ring generation during recording (Space hold creates hold-type ring with duration > 0.3 beats)', async ({ page }) => {
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
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await expect(page.locator('#root')).toBeVisible();
  await page.waitForTimeout(1500);

  // 2. Navigate to editor screen via HashRouter
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 10000 });
  await page.waitForTimeout(2000);

  // 3. Start audio playback (wait for buffer to load)
  const playBtn = page.locator('[data-testid="editor-play"]');
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  await page.waitForTimeout(3000); // Wait for 68.8MB FLAC to load and decode

  // Verify playback started (button text should change to 停止)
  await expect(page.locator('[data-testid="editor-play"]', { hasText: '停止' })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // 4. Enter record mode
  const recordBtn = page.locator('[data-testid="editor-record-toggle"]');
  await expect(recordBtn).toBeVisible();
  await expect(recordBtn).toHaveText('録音モード');
  await recordBtn.click();
  await page.waitForTimeout(500);
  await expect(recordBtn).toHaveText('録音停止');
  await expect(recordBtn).toHaveClass(/editor-record-active/);
  await page.waitForTimeout(1000);

  // 5. Hold Space key to create a hold ring
  // Press and hold Space for ~1.5 seconds to ensure duration > 0.3 beats
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');
  await page.waitForTimeout(500);

  // 6. Stop recording (this commits the recorded trajectory and rings)
  await recordBtn.click();
  await page.waitForTimeout(1000);
  await expect(recordBtn).toHaveText('録音モード');

  // 7. Stop audio playback
  const stopBtn = page.locator('[data-testid="editor-play"]', { hasText: '停止' });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  await page.waitForTimeout(1000);

  // 8. Verify hold ring was created in the ring list (DOM verification)
  const ringPane = page.locator('section.editor-pane', { hasText: 'リング録音' });
  await expect(ringPane).toBeVisible();

  // Open the ring details accordion if collapsed
  const details = ringPane.locator('details[data-testid="ring-list-details"]');
  await expect(details).toBeVisible();
  const isOpen = await details.evaluate(el => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    await details.locator('summary').click();
    await page.waitForTimeout(500);
  }

  // Verify at least one ring exists
  const ringItems = ringPane.locator('[data-testid^="ring-list-item-"]');
  expect(await ringItems.count()).toBeGreaterThan(0);

  // Verify the first ring has type='hold' and duration > 0.3
  const firstTypeSelect = ringPane.locator('.ring-type-select').first();
  await expect(firstTypeSelect).toBeVisible();
  await expect(firstTypeSelect).toHaveValue('hold');

  const firstDurationInput = ringPane.locator('.ring-duration-input').first();
  await expect(firstDurationInput).toBeVisible();
  const durationValue = await firstDurationInput.inputValue();
  const durationNum = Number(durationValue);
  expect(durationNum).toBeGreaterThan(0.3);

  // 9. Verify internal state via window.__editorRings (behavioral contract verification)
  const editorRings = await page.evaluate(() => {
    return (window as unknown as { __editorRings?: unknown }).__editorRings;
  });
  expect(editorRings).toBeDefined();
  expect(Array.isArray(editorRings)).toBe(true);
  expect(editorRings.length).toBeGreaterThan(0);

  // Find the hold ring in internal state
  const holdRing = (editorRings as Array<{ type?: string; duration?: number; beat: number }>).find(r => r.type === 'hold');
  expect(holdRing).toBeDefined();
  expect(holdRing!.duration).toBeGreaterThan(0.3);

  // 10. Export TOML and verify hold attributes persist in exported chart
  const exportBtn = page.locator('[data-testid="editor-export"]');
  await expect(exportBtn).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportBtn.click(),
  ]);

  expect(download.suggestedFilename()).toBe('reply.toml');
  const filePath = await download.path();
  if (filePath) {
    const fs = await import('fs');
    const { parse } = await import('smol-toml');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const parsed = parse(fileContent) as any;
    expect(parsed).toBeDefined();
    expect(Array.isArray(parsed.rings)).toBe(true);
    const exportedHoldRing = parsed.rings.find((r: any) => r.type === 'hold' && r.duration > 0.3);
    expect(exportedHoldRing).toBeDefined();
  }

  // 11. Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});

test('T100 Verification: Short Space press (< 0.3 beats) creates single-type ring, not hold', async ({ page }) => {
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

  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await expect(page.locator('#root')).toBeVisible();
  await page.waitForTimeout(1500);

  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 10000 });
  await page.waitForTimeout(2000);

  // Start playback
  const playBtn = page.locator('[data-testid="editor-play"]');
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  await page.waitForTimeout(3000);
  await expect(page.locator('[data-testid="editor-play"]', { hasText: '停止' })).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // Enter record mode
  const recordBtn = page.locator('[data-testid="editor-record-toggle"]');
  await expect(recordBtn).toBeVisible();
  await recordBtn.click();
  await page.waitForTimeout(500);
  await expect(recordBtn).toHaveText('録音停止');
  await page.waitForTimeout(1000);

  // Short Space press (< 100ms, well under 0.3 beats at 120 BPM where 1 beat = 500ms)
  await page.keyboard.down('Space');
  await page.waitForTimeout(50); // Very short press
  await page.keyboard.up('Space');
  await page.waitForTimeout(500);

  // Stop recording
  await recordBtn.click();
  await page.waitForTimeout(1000);
  await expect(recordBtn).toHaveText('録音モード');

  // Stop playback
  const stopBtn = page.locator('[data-testid="editor-play"]', { hasText: '停止' });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  await page.waitForTimeout(1000);

  // Verify the ring created is 'single' type, not 'hold'
  const ringPane = page.locator('section.editor-pane', { hasText: 'リング録音' });
  const details = ringPane.locator('details[data-testid="ring-list-details"]');
  const isOpen = await details.evaluate(el => (el as HTMLDetailsElement).open);
  if (!isOpen) {
    await details.locator('summary').click();
    await page.waitForTimeout(500);
  }

  const firstTypeSelect = ringPane.locator('.ring-type-select').first();
  await expect(firstTypeSelect).toBeVisible();
  await expect(firstTypeSelect).toHaveValue('single');

  // Duration input should not be visible for single type
  const durationInput = ringPane.locator('.ring-duration-input').first();
  await expect(durationInput).not.toBeVisible();

  // Verify internal state
  const editorRings = await page.evaluate(() => {
    return (window as unknown as { __editorRings?: unknown }).__editorRings;
  });
  expect(editorRings).toBeDefined();
  expect(Array.isArray(editorRings)).toBe(true);
  expect(editorRings.length).toBeGreaterThan(0);

  const singleRing = (editorRings as Array<{ type?: string; duration?: number; beat: number }>).find(r => r.type === 'single');
  expect(singleRing).toBeDefined();
  expect(singleRing!.duration).toBeUndefined();

  // Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});