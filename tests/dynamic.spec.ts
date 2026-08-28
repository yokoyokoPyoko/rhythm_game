import { test, expect } from '@playwright/test';

async function getSegmentsFromWindow(page: any): Promise<Array<{ direction: string; beats: number }>> {
  return await page.evaluate(() => (window as any).__editorSegments ?? []);
}

async function getModeFromUI(page: any): Promise<'play' | 'record'> {
  return await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="editor-record-toggle"]');
    if (!btn) return 'play';
    const text = btn.textContent || '';
    return text.includes('録音停止') ? 'record' : 'play';
  });
}

async function ensurePlayMode(page: any): Promise<void> {
  const mode = await getModeFromUI(page);
  if (mode === 'record') {
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="editor-record-toggle"]');
      return btn && btn.textContent?.includes('録音モード');
    }, { timeout: 10000 });
  }
}

async function clearSegments(page: any): Promise<void> {
  page.once('dialog', (dialog: { accept: () => void }) => dialog.accept());
  await page.click('[data-testid="editor-clear"]');
  await page.waitForTimeout(400);
}

async function simulateKeyPress(page: any, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(60);
  await page.keyboard.up(key);
  await page.waitForTimeout(60);
}

test.describe('T102: レガシー再生中セグメントスタンプ完全削除', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
      }
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('http://localhost:5173/#/editor', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible({ timeout: 30000 });
    await ensurePlayMode(page);
    expect(errors).toHaveLength(0);
  });

  test('Playback mode: ArrowUp/ArrowDown/W/S key presses do NOT create segments', async ({ page }) => {
    // Ensure we are in playback (play) mode and start with a clean slate
    await ensurePlayMode(page);
    await clearSegments(page);

    const initialSegments = await getSegmentsFromWindow(page);
    const initialCount = initialSegments.length;

    // Verify we are in 'play' mode
    const initialMode = await getModeFromUI(page);
    expect(initialMode).toBe('play');

    // Try to start playback, but do not block the negative test on audio availability.
    try {
      await page.click('[data-testid="editor-play"]', { timeout: 5000 });
    } catch {
      /* audio playback may be unavailable in headless; negative assertion still valid */
    }
    await page.waitForTimeout(500);

    // Simulate key presses that would have stamped segments in the legacy implementation
    for (const key of ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyS']) {
      await simulateKeyPress(page, key);
    }

    const segmentsAfter = await getSegmentsFromWindow(page);
    expect(segmentsAfter.length).toBe(initialCount);

    // Still in play mode (no accidental mode switch)
    expect(await getModeFromUI(page)).toBe('play');
  });

  test('Playback mode with pre-existing segments: key presses leave them unchanged', async ({ page }) => {
    await ensurePlayMode(page);
    await clearSegments(page);

    // Add a couple of segments via the segment editor accordion
    const segDetails = page.locator('[data-testid="segment-list-details"]');
    if (!(await segDetails.getAttribute('open'))) {
      await segDetails.locator('summary').click();
    }
    await page.waitForTimeout(200);
    await page.locator('[data-testid="segment-add"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="segment-add"]').click();
    await page.waitForTimeout(200);

    const initialSegments = await getSegmentsFromWindow(page);
    const initialCount = initialSegments.length;
    expect(initialCount).toBeGreaterThanOrEqual(2);
    const initialData = JSON.stringify(initialSegments);

    await ensurePlayMode(page);
    try {
      await page.click('[data-testid="editor-play"]', { timeout: 5000 });
    } catch {
      /* ignore audio unavailability */
    }
    await page.waitForTimeout(500);

    for (const key of ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyS']) {
      await simulateKeyPress(page, key);
    }

    const segmentsAfter = await getSegmentsFromWindow(page);
    expect(segmentsAfter.length).toBe(initialCount);
    expect(JSON.stringify(segmentsAfter)).toBe(initialData);
  });
});
