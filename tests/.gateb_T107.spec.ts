import { test, expect } from '@playwright/test';

const EDITOR_URL = 'http://localhost:5173/#/editor';
const CANVAS_SELECTOR = '[data-testid="wave-preview-canvas"]';

async function analyzeWaveVerticalExtent(page: import('@playwright/test').Page, selector: string = CANVAS_SELECTOR) {
  return await page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) return { error: 'canvas not found' };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { error: 'no 2d context' };

    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h).data;

    const isWavePixel = (r: number, g: number, b: number, a: number): boolean => {
      if (a < 100) return false;
      if (r <= 20 && g <= 20 && b <= 20) return false;
      if (r > 200 && g > 200 && b > 200) return false;
      return true;
    };

    let topY = h;
    let bottomY = 0;
    let found = false;

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

async function createBasicWave(page: import('@playwright/test').Page) {
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
  await page.fill('#zoom', '20');
  await page.waitForTimeout(300);
}

async function ensureAudioReady(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn && !btn.textContent?.includes('読込中');
    },
    { timeout: 60000 }
  );
  await page.waitForTimeout(500);
}

test.describe('T107: 波形上下表示領域拡張 (dynamic.spec.ts)', () => {
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

  test('波形の非透明ピクセル縦幅がcanvas高の30%以上で上下端が表示領域内にある', async ({ page }) => {
    // Step 1: Capture Initial State (empty chart - minimal wave)
    const initial = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Initial wave extent (empty):', initial);

    // Step 2: Perform User Interaction - create wave with segments
    await createBasicWave(page);
    await page.waitForTimeout(500);

    // Step 3: Assert Resulting Transition - wave meets vertical extent requirements
    const result = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('After segment creation:', result);

    // Requirement 1: waveHeight >= 0.3 * canvasHeight
    expect(result.ratio).toBeGreaterThanOrEqual(0.30);

    // Requirement 2: top edge within display area (not clipped at y=0)
    // The ruler strip is at top (RULER_H = 22 CSS px). Wave should start below ruler.
    expect(result.topY).toBeGreaterThan(0);

    // Requirement 3: bottom edge within display area (not clipped at bottom)
    expect(result.bottomY).toBeLessThan(result.canvasHeight);

    // Additional sanity: wave should have meaningful height
    expect(result.waveHeight).toBeGreaterThan(0);

    expect(errors).toHaveLength(0);
  });

  test('振幅変更に追従して波形表示領域が変化し30%以上を維持する', async ({ page }) => {
    // Step 1: Create base wave
    await createBasicWave(page);
    await page.waitForTimeout(300);

    // Step 2: Capture state at default amplitude (130)
    const at130 = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Amplitude 130:', at130);
    expect(at130.ratio).toBeGreaterThanOrEqual(0.30);

    // Step 3: Increase amplitude to 200
    const ampInput = page.locator('#amplitude');
    await ampInput.fill('200');
    await page.waitForTimeout(300);

    const at200 = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Amplitude 200:', at200);
    expect(at200.ratio).toBeGreaterThanOrEqual(0.30);
    expect(at200.waveHeight).toBeGreaterThanOrEqual(at130.waveHeight - 5);

    // Step 4: Decrease amplitude to 60
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

  test('リング追加時も波形上下領域が維持される', async ({ page }) => {
    await createBasicWave(page);
    await page.waitForTimeout(300);

    const beforeRings = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Before rings:', beforeRings);
    expect(beforeRings.ratio).toBeGreaterThanOrEqual(0.30);

    // Add rings by clicking on canvas
    const canvas = page.locator(CANVAS_SELECTOR);
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
      await page.waitForTimeout(200);
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
      await page.waitForTimeout(200);
    }

    const afterRings = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('After rings:', afterRings);
    expect(afterRings.ratio).toBeGreaterThanOrEqual(0.30);
    expect(afterRings.topY).toBeGreaterThan(0);
    expect(afterRings.bottomY).toBeLessThan(afterRings.canvasHeight);

    expect(errors).toHaveLength(0);
  });

  test('BPM変更時も波形表示領域が維持される', async ({ page }) => {
    await createBasicWave(page);
    await page.waitForTimeout(300);

    const beforeBpm = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Before BPM change:', beforeBpm);
    expect(beforeBpm.ratio).toBeGreaterThanOrEqual(0.30);

    // Change BPM via BpmEditor
    const bpmInput = page.locator('#bpm');
    await bpmInput.fill('150');
    await page.waitForTimeout(300);

    const afterBpm = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('After BPM 150:', afterBpm);
    expect(afterBpm.ratio).toBeGreaterThanOrEqual(0.30);
    expect(afterBpm.topY).toBeGreaterThan(0);
    expect(afterBpm.bottomY).toBeLessThan(afterBpm.canvasHeight);

    expect(errors).toHaveLength(0);
  });

  test('スナップ解像度変更が波形描画に影響しない', async ({ page }) => {
    await createBasicWave(page);
    await page.waitForTimeout(300);

    const beforeSnap = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Before snap change:', beforeSnap);
    expect(beforeSnap.ratio).toBeGreaterThanOrEqual(0.30);

    // Change snap resolution
    const snapSelect = page.locator('[data-testid="snap-select"]');
    await snapSelect.selectOption('0.125');
    await page.waitForTimeout(300);

    const afterSnap = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('After snap 0.125:', afterSnap);
    expect(afterSnap.ratio).toBeGreaterThanOrEqual(0.30);
    expect(afterSnap.topY).toBeGreaterThan(0);
    expect(afterSnap.bottomY).toBeLessThan(afterSnap.canvasHeight);

    expect(errors).toHaveLength(0);
  });

  test('セグメントなし時のフォールバック波形も領域内', async ({ page }) => {
    // Clear all segments to test fallback
    const clearBtn = page.locator('[data-testid="editor-clear"]');
    await clearBtn.click();
    await page.waitForTimeout(300);

    // Wait for canvas to re-render
    await page.waitForTimeout(500);

    const result = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('Empty segments fallback:', result);

    // Even with no segments, the fallback horizontal line should be within display area
    expect(result.ratio).toBeGreaterThanOrEqual(0.30);
    expect(result.topY).toBeGreaterThan(0);
    expect(result.bottomY).toBeLessThan(result.canvasHeight);

    expect(errors).toHaveLength(0);
  });

  test('録音モードでの軌跡記録が波形表示に反映され縦幅要件を満たす', async ({ page }) => {
    // Start playback
    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(1000);

    // Enter record mode
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForTimeout(200);

    // Simulate up key press to record trajectory
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(1000);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(200);

    // Stop recording
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForTimeout(500);

    const result = await analyzeWaveVerticalExtent(page, CANVAS_SELECTOR);
    console.log('After recording trajectory:', result);
    expect(result.ratio).toBeGreaterThanOrEqual(0.30);
    expect(result.topY).toBeGreaterThan(0);
    expect(result.bottomY).toBeLessThan(result.canvasHeight);

    expect(errors).toHaveLength(0);
  });
});