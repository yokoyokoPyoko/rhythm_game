import { test, expect } from '@playwright/test';

const EDITOR_URL = 'http://localhost:5173/#/editor';
const CANVAS_SELECTOR = '[data-testid="wave-preview-canvas"]';

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

    await page.addStyleTag({
      content: 'body { height: 4000px; } #root { min-height: 4000px; }',
    });
    await page.waitForTimeout(200);
    expect(errors).toHaveLength(0);
  });

  test('canvas上でホイール操作してもwindow.scrollYが変化しない', async ({ page }) => {
    // [Step 1: Capture Initial State] - Scroll page down to create headroom
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(100);
    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBeGreaterThan(0);

    // [Step 2: Perform User Interaction] - Wheel on canvas center
    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const scrollYOffset = await page.evaluate(() => window.scrollY);
    const cy = box!.y + box!.height / 2 + scrollYOffset;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(30);
    }
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }

    // [Step 3: Assert Resulting Transition] - scrollY must remain unchanged
    const finalScrollY = await page.evaluate(() => window.scrollY);
    expect(finalScrollY).toBe(initialScrollY);
    expect(errors).toHaveLength(0);
  });

  test('非passiveリスナが実際にpreventDefaultを呼んでいる', async ({ page }) => {
    // [Step 1: Capture Initial State] - Verify canvas exists
    const canvas = page.locator(CANVAS_SELECTOR);
    await expect(canvas).toBeVisible();

    // [Step 2: Perform User Interaction] - Dispatch wheel event and capture defaultPrevented
    const result = await page.evaluate(async () => {
      const canvasEl = document.querySelector('[data-testid="wave-preview-canvas"]') as HTMLCanvasElement | null;
      if (!canvasEl) return { error: 'canvas not found' };
      return new Promise<{ defaultPrevented: boolean }>((resolve) => {
        let captured = false;
        const probe = (e: WheelEvent) => {
          captured = e.defaultPrevented;
          canvasEl.removeEventListener('wheel', probe, false);
          resolve({ defaultPrevented: captured });
        };
        canvasEl.addEventListener('wheel', probe, false);
        const evt = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
        canvasEl.dispatchEvent(evt);
      });
    });

    // [Step 3: Assert Resulting Transition] - defaultPrevented must be true
    expect(result.error).toBeUndefined();
    expect(result.defaultPrevented).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('ズーム方向を切り替えて連続ホイールしてもスクロールしない', async ({ page }) => {
    // [Step 1: Capture Initial State]
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(100);
    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBeGreaterThan(0);

    // [Step 2: Perform User Interaction] - Alternate wheel directions
    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const scrollYOffset = await page.evaluate(() => window.scrollY);
    const cy = box!.y + box!.height / 2 + scrollYOffset;
    await page.mouse.move(cx, cy);

    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, i % 2 === 0 ? -100 : 100);
      await page.waitForTimeout(20);
    }

    // [Step 3: Assert Resulting Transition]
    const finalScrollY = await page.evaluate(() => window.scrollY);
    expect(finalScrollY).toBe(initialScrollY);
    expect(errors).toHaveLength(0);
  });
});