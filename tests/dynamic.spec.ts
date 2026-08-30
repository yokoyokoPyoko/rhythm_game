import { test, expect } from '@playwright/test';

const EDITOR_URL = 'http://localhost:5173/#/editor';
const CANVAS_SELECTOR = '[data-testid="wave-preview-canvas"]';

/**
 * Waits for the editor's audio to be ready (play button no longer shows "読込中").
 * The 08.Reply.flac file is ~69MB, so we allow generous timeout.
 */
async function ensureAudioReady(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn && !btn.textContent?.includes('読込中');
    },
    { timeout: 60000 }
  );
  // Give extra moment for canvas to render fully
  await page.waitForTimeout(500);
}

test.describe('T108: Canvasホイールズームでページスクロール防止', () => {
  let errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
      }
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(EDITOR_URL);
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    await expect(page.locator(CANVAS_SELECTOR)).toBeVisible({ timeout: 10000 });
    await ensureAudioReady(page);
    expect(errors).toHaveLength(0);
  });

  test('ホイール操作時に window.scrollY が変化しない（preventDefault が効く）', async ({ page }) => {
    // Step 1: Capture initial state - ensure page is at top, get initial scrollY
    const initialScrollY = await page.evaluate(() => window.scrollY);
    console.log('Initial window.scrollY:', initialScrollY);
    expect(initialScrollY).toBe(0);

    // Step 2: Perform user interaction - scroll mouse wheel over the canvas
    const canvas = page.locator(CANVAS_SELECTOR);
    await canvas.hover();
    await page.waitForTimeout(100);

    // Use page.mouse.wheel for realistic wheel events (triggers native wheel listener)
    // Delta values: positive = scroll down (zoom out), negative = scroll up (zoom in)
    await page.mouse.wheel(0, 100); // scroll down
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, -100); // scroll up
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, 100); // scroll down again
    await page.waitForTimeout(100);

    // Step 3: Assert resulting transition - window.scrollY must remain unchanged
    const finalScrollY = await page.evaluate(() => window.scrollY);
    console.log('Final window.scrollY after wheel:', finalScrollY);

    expect(finalScrollY).toBe(initialScrollY);
    expect(finalScrollY).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('複数回ホイール操作後も scrollY が 0 のまま維持される', async ({ page }) => {
    // Step 1: Verify initial scroll position
    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    // Step 2: Perform repeated wheel interactions
    const canvas = page.locator(CANVAS_SELECTOR);
    await canvas.hover();
    await page.waitForTimeout(100);

    // Simulate continuous zoom in/out (10 cycles)
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, i % 2 === 0 ? 50 : -50);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(200);

    // Step 3: Assert scroll position never changed
    const finalScrollY = await page.evaluate(() => window.scrollY);
    console.log('Final window.scrollY after 10 wheel cycles:', finalScrollY);

    expect(finalScrollY).toBe(initialScrollY);
    expect(finalScrollY).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('ズームUIスライダー操作とは独立してホイール防止が機能する', async ({ page }) => {
    // Step 1: Initial scroll position
    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    // Step 2: First use zoom slider (view beats) to change zoom level
    const zoomSlider = page.locator('#zoom');
    await zoomSlider.fill('8');
    await page.waitForTimeout(300);

    // Then use mouse wheel on canvas
    const canvas = page.locator(CANVAS_SELECTOR);
    await canvas.hover();
    await page.waitForTimeout(100);

    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);

    // Step 3: Assert scroll position unchanged
    const finalScrollY = await page.evaluate(() => window.scrollY);
    console.log('Final window.scrollY after slider + wheel:', finalScrollY);

    expect(finalScrollY).toBe(initialScrollY);
    expect(finalScrollY).toBe(0);

    expect(errors).toHaveLength(0);
  });
});