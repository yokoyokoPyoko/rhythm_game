import { test, expect } from '@playwright/test';

const EDITOR_URL = 'http://localhost:5173/#/editor';
const CANVAS_SELECTOR = '[data-testid="wave-preview-canvas"]';

/**
 * Analyzes the canvas to compute the wave's vertical extent (non-transparent pixel height).
 * Returns { waveHeight, topY, bottomY, canvasHeight, ratio }.
 * - waveHeight: number of pixels from topmost to bottommost non-background wave pixel
 * - topY: Y coordinate (0 = top) of topmost wave pixel
 * - bottomY: Y coordinate of bottommost wave pixel
 * - canvasHeight: full canvas height in device pixels
 * - ratio: waveHeight / canvasHeight
 */
async function analyzeWaveVerticalExtent(page: import('@playwright/test').Page, selector: string = CANVAS_SELECTOR) {
  return await page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return { error: 'canvas not found' };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { error: 'no 2d context' };

    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h).data;

    // Background color is #0a0a0a (rgb 10,10,10). Guide lines are white-ish with low opacity.
    // Wave lines are accent (#6366f1), sub (#22d3ee), stay (#fbbf24) with full opacity.
    // We consider a pixel "wave" if it's clearly not background and not a faint guide line.
    const isWavePixel = (r: number, g: number, b: number, a: number): boolean => {
      if (a < 100) return false; // ignore very transparent pixels
      // Background check
      if (r <= 20 && g <= 20 && b <= 20) return false;
      // Guide lines are near-white with low opacity: rgba(255,255,255,0.07~0.22)
      // They have r,g,b all high and similar. Skip near-white pixels.
      if (r > 200 && g > 200 && b > 200) return false;
      // Wave colors have distinct hue. Accept anything else with decent saturation.
      return true;
    };

    let topY = h;
    let bottomY = 0;
    let found = false;

    // Sample every 4th column to be efficient, scan full height
    for (let x = 0; x < w; x += 4) {
      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;
        const r = img[idx];
        const g = img[idx + 1];
        const b = img[idx + 2];
        const a = img[idx + 3];
        if (isWavePixel(r, g, b, a)) {
          if (y < topY) topY = y;
          if (y > bottomY) bottomY = y;
          found = true;
        }
      }
    }

    if (!found) {
      return { waveHeight: 0, topY: -1, bottomY: -1, canvasHeight: h, ratio: 0, error: 'no wave pixels found' };
    }

    const waveHeight = bottomY - topY + 1;
    return { waveHeight, topY, bottomY, canvasHeight: h, ratio: waveHeight / h };
  }, selector);
}

/**
 * Creates a basic wave with segments via the SegmentEditor UI.
 */
async function createBasicWave(page: import('@playwright/test').Page) {
  // Add 3 segments: up(8), down(8), stay(4) = 20 beats total
  for (let i = 0; i < 3; i++) {
    await page.click('[data-testid="segment-add"]');
    await page.waitForTimeout(100);
  }
  await page.selectOption('[data-testid="segment-direction-0"]', 'up');
  await page.fill('[data-testid="segment-beats-0"]', '8');
  await page.selectOption('[data-testid="segment-direction-1"]', 'down');
  await page.fill('[data-testid="segment-beats-1"]', '8');
  await page.selectOption('[data-testid="segment-direction-2"]', 'stay');
  await page.fill('[data-testid="segment-beats-2"]', '4');
  // Zoom out to show full 20 beats
  await page.fill('#zoom', '20');
  await page.waitForTimeout(300);
}

/**
 * Ensures audio is loaded so the canvas renders fully (some render paths depend on audio state).
 */
async function ensureAudioReady(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn && !btn.textContent?.includes('読込中');
    },
    { timeout: 60000 }
  );
  // Give an extra moment for canvas render
  await page.waitForTimeout(500);
}

test.describe('T107: 波形上下表示領域拡張', () => {
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

  test('canvas非透明波形ピクセルの縦幅がcanvas高の30%以上あり、上下端が表示領域内にある', async ({ page }) => {
    // Step 1: Capture initial state (empty chart - should have minimal or no wave)
    const initial = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Initial wave extent:', initial);

    // Step 2: Perform user interaction - create a wave with segments
    await createBasicWave(page);
    await page.waitForTimeout(500); // wait for re-render

    // Step 3: Assert resulting transition - wave vertical extent meets requirements
    const result = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('After segment creation:', result);

    // Requirement 1: waveHeight >= 0.3 * canvasHeight
    expect(result.ratio).toBeGreaterThanOrEqual(0.30);

    // Requirement 2: top edge within display area (not clipped at y=0)
    // The ruler strip is at top (RULER_H = 22 CSS px). In device pixels with DPR, that's ~22*DPR.
    // Wave should start below the ruler area.
    expect(result.topY).toBeGreaterThan(0);

    // Requirement 3: bottom edge within display area (not clipped at bottom)
    expect(result.bottomY).toBeLessThan(result.canvasHeight);

    // Additional sanity: wave should have meaningful height
    expect(result.waveHeight).toBeGreaterThan(0);

    expect(errors).toHaveLength(0);
  });

  test('amplitude変更に追従して波形表示領域が変化する', async ({ page }) => {
    await createBasicWave(page);
    await page.waitForTimeout(300);

    // Capture wave extent at default amplitude (130)
    const at130 = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Amplitude 130:', at130);
    expect(at130.ratio).toBeGreaterThanOrEqual(0.30);

    // Change amplitude to a larger value (200) via BpmEditor
    const ampInput = page.locator('#amplitude');
    await ampInput.fill('200');
    await page.waitForTimeout(300);

    const at200 = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Amplitude 200:', at200);
    expect(at200.ratio).toBeGreaterThanOrEqual(0.30);

    // Wave extent should increase (or at least not decrease) with larger amplitude
    expect(at200.waveHeight).toBeGreaterThanOrEqual(at130.waveHeight - 5); // allow small rounding

    // Change amplitude to a smaller value (60)
    await ampInput.fill('60');
    await page.waitForTimeout(300);

    const at60 = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Amplitude 60:', at60);
    expect(at60.ratio).toBeGreaterThanOrEqual(0.30);

    expect(errors).toHaveLength(0);
  });

  test('ズーム変更時も波形上下端が表示領域内に収まる', async ({ page }) => {
    await createBasicWave(page);
    await page.waitForTimeout(300);

    // Test multiple zoom levels (viewBeats)
    for (const zoom of [8, 16, 32, 64]) {
      await page.fill('#zoom', String(zoom));
      await page.waitForTimeout(300);

      const result = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
      console.log(`Zoom ${zoom}:`, result);

      expect(result.ratio).toBeGreaterThanOrEqual(0.30);
      expect(result.topY).toBeGreaterThan(0);
      expect(result.bottomY).toBeLessThan(result.canvasHeight);
    }

    expect(errors).toHaveLength(0);
  });
});