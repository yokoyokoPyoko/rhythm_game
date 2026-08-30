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

    // Make the page scrollable so a non-prevented wheel would actually scroll.
    await page.addStyleTag({
      content: 'body { height: 4000px; } #root { min-height: 4000px; }',
    });
    await page.waitForTimeout(200);
    expect(errors).toHaveLength(0);
  });

  test('canvas上でホイール操作してもwindow.scrollYが変化しない', async ({ page }) => {
    // Make the page tall so it is actually scrollable (a non-prevented wheel
    // over the page background / canvas would scroll it).
    await page.addStyleTag({
      content: 'body { height: 4000px; } #root { min-height: 4000px; }',
    });

    // Bring the canvas into the visible viewport (the editor may have scrolled
    // it out of view). boundingBox() returns viewport-relative coordinates,
    // which is exactly what page.mouse.* expects, so no scroll offset must be
    // added. Using the viewport coordinates directly guarantees the wheel
    // event actually lands on the canvas element.
    await page.locator(CANVAS_SELECTOR).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);

    const before = await page.evaluate(() => window.scrollY);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    // Guard: the canvas center must be inside the viewport, otherwise the wheel
    // would not target the canvas. scrollIntoViewIfNeeded should guarantee this.
    const viewport = await page.evaluate(() => ({
      h: window.innerHeight,
      w: window.innerWidth,
    }));
    expect(cy).toBeGreaterThan(0);
    expect(cy).toBeLessThan(viewport.h);
    expect(cx).toBeGreaterThan(0);
    expect(cx).toBeLessThan(viewport.w);

    await page.mouse.move(cx, cy);
    await page.waitForTimeout(50);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(30);
    }
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(30);
    }

    const after = await page.evaluate(() => window.scrollY);
    expect(after).toBe(before);
    expect(errors).toHaveLength(0);
  });

  test('非passiveリスナが実際にpreventDefaultを呼んでいる', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const canvas = document.querySelector('[data-testid="wave-preview-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return { error: 'canvas not found' };
      return new Promise<{ defaultPrevented: boolean }>((resolve) => {
        let captured = false;
        const probe = (e: WheelEvent) => {
          // Allow the component's own handler to run first via capture phase check.
          captured = e.defaultPrevented;
          canvas.removeEventListener('wheel', probe, true);
          resolve({ defaultPrevented: captured });
        };
        // Listen in capture phase AFTER default (capture fires before, bubble after).
        canvas.addEventListener('wheel', probe, false);
        const evt = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
        canvas.dispatchEvent(evt);
      });
    });

    expect(result.error).toBeUndefined();
    expect(result.defaultPrevented).toBe(true);
    expect(errors).toHaveLength(0);
  });
});
