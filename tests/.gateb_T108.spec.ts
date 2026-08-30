import { test, expect } from '@playwright/test';

const EDITOR_URL = 'http://localhost:5173/#/editor';
const CANVAS_SELECTOR = '[data-testid="wave-preview-canvas"]';
const ZOOM_SLIDER_SELECTOR = '#zoom';

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
    await page.waitForTimeout(500);
    expect(errors).toHaveLength(0);
  });

  test('canvas上でホイール操作してもページのscrollYが変化しない（3ステップ: 初期状態取得→ホイール操作→結果検証）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    // Make the page actually scrollable so a default wheel event would scroll.
    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!box) throw new Error('canvas bounding box not found');

    const vh = await page.evaluate(() => window.innerHeight);
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, vh - 5);
    if (cy < box.y) throw new Error('canvas not visible in viewport');

    // === Step 2: Perform User Interaction ===
    // Dispatch multiple wheel events directly over the canvas.
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(50);
    }

    // === Step 3: Assert Resulting Transition ===
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('ホイールによるズームビュー更新が行われる（preventDefaultと共存）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    // Get the initial viewBeats from the zoom slider
    const initialViewBeats = await page.evaluate(() => {
      const el = document.querySelector('#zoom') as HTMLInputElement | null;
      return el ? Number(el.value) : null;
    });
    expect(initialViewBeats).not.toBeNull();

    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!box) throw new Error('canvas bounding box not found');
    const vh = await page.evaluate(() => window.innerHeight);
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, vh - 5);
    if (cy < box.y) throw new Error('canvas not visible in viewport');

    // === Step 2: Perform User Interaction ===
    // Wheel up (zoom in)
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(300);

    // === Step 3: Assert Resulting Transition ===
    const viewBeatsAfterZoom = await page.evaluate(() => {
      const el = document.querySelector('#zoom') as HTMLInputElement | null;
      return el ? Number(el.value) : null;
    });
    expect(viewBeatsAfterZoom).not.toBeNull();
    expect(viewBeatsAfterZoom).not.toBe(initialViewBeats);

    // Verify page scrollY remained unchanged
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('ホイール操作でズームアウトしてもscrollYが変化しない（負のdeltaY）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!box) throw new Error('canvas bounding box not found');
    const vh = await page.evaluate(() => window.innerHeight);
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, vh - 5);
    if (cy < box.y) throw new Error('canvas not visible in viewport');

    // === Step 2: Perform User Interaction ===
    // Wheel down (zoom out) multiple times
    for (let i = 0; i < 3; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(50);
    }

    // === Step 3: Assert Resulting Transition ===
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('canvasの端付近でホイール操作してもscrollYが変化しない（ヒットテスト検証）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!box) throw new Error('canvas bounding box not found');
    const vh = await page.evaluate(() => window.innerHeight);

    // Test multiple positions on the canvas (top, center, bottom, left, right)
    const testPositions = [
      { x: box.x + 10, y: Math.min(box.y + 10, vh - 5) }, // top-left
      { x: box.x + box.width / 2, y: Math.min(box.y + 10, vh - 5) }, // top-center
      { x: box.x + box.width - 10, y: Math.min(box.y + 10, vh - 5) }, // top-right
      { x: box.x + 10, y: Math.min(box.y + box.height / 2, vh - 5) }, // middle-left
      { x: box.x + box.width - 10, y: Math.min(box.y + box.height / 2, vh - 5) }, // middle-right
      { x: box.x + box.width / 2, y: Math.min(box.y + box.height - 10, vh - 5) }, // bottom-center
    ];

    // === Step 2: Perform User Interaction ===
    for (const pos of testPositions) {
      if (pos.y < box.y) continue;
      await page.mouse.move(pos.x, pos.y);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(50);
    }

    // === Step 3: Assert Resulting Transition ===
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('canvas外でホイール操作するとページがスクロールする（通常動作確認）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    const initialScrollY = await page.evaluate(() => window.scrollY);
    expect(initialScrollY).toBe(0);

    // Position outside canvas (top of page)
    const canvasBox = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!canvasBox) throw new Error('canvas bounding box not found');
    const outsideY = canvasBox.y - 100;
    const outsideX = canvasBox.x + canvasBox.width / 2;

    // === Step 2: Perform User Interaction ===
    await page.mouse.move(outsideX, outsideY);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);

    // === Step 3: Assert Resulting Transition ===
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    // Page SHOULD scroll when wheeling outside canvas
    expect(scrollYAfter).toBeGreaterThan(0);

    expect(errors).toHaveLength(0);
  });

  test('連続ホイール操作でズーム値が連続的に変化し続ける（viewBeatsの動的変化検証）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    const initialViewBeats = await page.evaluate(() => {
      const el = document.querySelector('#zoom') as HTMLInputElement | null;
      return el ? Number(el.value) : null;
    });
    expect(initialViewBeats).not.toBeNull();

    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!box) throw new Error('canvas bounding box not found');
    const vh = await page.evaluate(() => window.innerHeight);
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, vh - 5);
    if (cy < box.y) throw new Error('canvas not visible in viewport');

    const viewBeatsHistory: number[] = [initialViewBeats!];

    // === Step 2: Perform User Interaction ===
    // Zoom in multiple times
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(100);
      const currentViewBeats = await page.evaluate(() => {
        const el = document.querySelector('#zoom') as HTMLInputElement | null;
        return el ? Number(el.value) : null;
      });
      if (currentViewBeats !== null) viewBeatsHistory.push(currentViewBeats);
    }

    // Zoom out multiple times
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(100);
      const currentViewBeats = await page.evaluate(() => {
        const el = document.querySelector('#zoom') as HTMLInputElement | null;
        return el ? Number(el.value) : null;
      });
      if (currentViewBeats !== null) viewBeatsHistory.push(currentViewBeats);
    }

    // === Step 3: Assert Resulting Transition ===
    // viewBeats should have changed at least once
    const uniqueValues = new Set(viewBeatsHistory);
    expect(uniqueValues.size).toBeGreaterThan(1);

    // Final scrollY should still be 0
    const finalScrollY = await page.evaluate(() => window.scrollY);
    expect(finalScrollY).toBe(0);

    expect(errors).toHaveLength(0);
  });

  test('canvasが画面外にあってもドキュメントレベルのリスナで防止される（スクロール後ホイール）', async ({ page }) => {
    // === Step 1: Capture Initial State ===
    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    // Scroll page down so canvas might be partially off-screen
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(100);

    const scrolledScrollY = await page.evaluate(() => window.scrollY);
    expect(scrolledScrollY).toBe(500);

    const box = await page.locator(CANVAS_SELECTOR).boundingBox();
    if (!box) throw new Error('canvas bounding box not found');
    const vh = await page.evaluate(() => window.innerHeight);
    const cx = box.x + box.width / 2;
    const cy = Math.min(box.y + box.height / 2, vh - 5);
    if (cy < box.y) throw new Error('canvas not visible in viewport after scroll');

    // === Step 2: Perform User Interaction ===
    // Wheel on canvas while page is scrolled
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);

    // === Step 3: Assert Resulting Transition ===
    // scrollY should NOT change from the scrolled position
    const finalScrollY = await page.evaluate(() => window.scrollY);
    expect(finalScrollY).toBe(500);

    expect(errors).toHaveLength(0);
  });
});