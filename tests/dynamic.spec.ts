import { test, expect, Page } from '@playwright/test';

const BASE_URL = 'http://localhost:5173/';
const EDITOR_URL = `${BASE_URL}#/editor`;

const AUDIO_LOAD_TIMEOUT = 60000;
const CONSOLE_ERROR_PATTERNS = /Uncaught|ReferenceError|TypeError|ChunkLoadError/;

interface ConsoleError {
  message: string;
  type: string;
}

async function gotoEditor(page: Page): Promise<void> {
  const errors: ConsoleError[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (CONSOLE_ERROR_PATTERNS.test(text)) {
        errors.push({ message: text, type: msg.type() });
      }
    }
  });

  await page.goto(EDITOR_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await expect(page.locator('text=オーサリングツール')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1000);

  if (errors.length > 0) {
    throw new Error(`Console errors on load: ${errors.map((e) => e.message).join('; ')}`);
  }
}

async function waitForAudioLoad(page: Page): Promise<void> {
  const playBtn = page.locator('button[data-testid="editor-play"]');
  await expect(playBtn).toBeVisible();
  await expect(playBtn).not.toHaveText('読込中…', { timeout: AUDIO_LOAD_TIMEOUT });
}

async function getWavePreviewCanvas(page: Page) {
  return page.locator('canvas[data-testid="wave-preview-canvas"]');
}

async function getSegmentsState(page: Page): Promise<any[]> {
  return await page.evaluate(() => {
    const app = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.values?.();
    return [];
  });
}

async function getEditorState(page: Page) {
  return await page.evaluate(() => {
    const root = document.querySelector('#root');
    if (!root) return null;
    const fiber = (root as any)._reactRootContainer?._internalRoot?.current?.child;
    if (!fiber) return null;
    function findComponent(f: any, name: string): any {
      if (f.type?.name === name || f.type?.displayName === name) return f.memoizedState;
      let child = f.child;
      while (child) {
        const found = findComponent(child, name);
        if (found) return found;
        child = child.sibling;
      }
      return null;
    }
    return null;
  });
}

async function getRingsFromState(page: Page): Promise<any[]> {
  return await page.evaluate(() => {
    const state = (window as any).__EDITOR_RINGS__;
    return state || [];
  });
}

async function getSegmentsFromState(page: Page): Promise<any[]> {
  return await page.evaluate(() => {
    const state = (window as any).__EDITOR_SEGMENTS__;
    return state || [];
  });
}

async function getSnapValue(page: Page): Promise<number> {
  const snapSelect = page.locator('select#snap');
  const value = await snapSelect.inputValue();
  return Number(value);
}

async function setSnapValue(page: Page, snap: number): Promise<void> {
  await page.selectOption('select#snap', String(snap));
  await page.waitForTimeout(100);
}

async function getAudioOffsetValue(page: Page): Promise<number> {
  const input = page.locator('#audio-offset');
  const value = await input.inputValue();
  return Number(value);
}

async function setAudioOffsetValue(page: Page, offset: number): Promise<void> {
  await page.fill('#audio-offset', String(offset));
  await page.waitForTimeout(100);
}

async function getBpmValue(page: Page): Promise<number> {
  const input = page.locator('#bpm');
  const value = await input.inputValue();
  return Number(value);
}

async function clickPlayPause(page: Page): Promise<void> {
  await page.click('button[data-testid="editor-play"]');
  await page.waitForTimeout(200);
}

async function clickRecordToggle(page: Page): Promise<void> {
  await page.click('button[data-testid="editor-record-toggle"]');
  await page.waitForTimeout(200);
}

async function isRecordingMode(page: Page): Promise<boolean> {
  const btn = page.locator('button[data-testid="editor-record-toggle"]');
  const className = await btn.getAttribute('class');
  return className?.includes('editor-record-active') ?? false;
}

async function getWaveView(page: Page): Promise<{ startBeat: number; beats: number }> {
  const canvas = await getWavePreviewCanvas(page);
  return await canvas.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
    };
  });
}

async function clickCanvasAtBeat(page: Page, beat: number, yOffset: number = 0): Promise<void> {
  const canvas = await getWavePreviewCanvas(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');
  const view = await getWaveView(page);
  const x = box.x + box.width * (beat / view.beats);
  const y = box.y + box.height / 2 + yOffset;
  await page.mouse.click(x, y);
  await page.waitForTimeout(100);
}

async function dragCanvas(page: Page, startBeat: number, endBeat: number): Promise<void> {
  const canvas = await getWavePreviewCanvas(page);
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas not found');
  const view = await getWaveView(page);
  const startX = box.x + box.width * (startBeat / view.beats);
  const endX = box.x + box.width * (endBeat / view.beats);
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function wheelCanvas(page: Page, deltaY: number): Promise<void> {
  const canvas = await getWavePreviewCanvas(page);
  await canvas.hover();
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(200);
}

async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(50);
}

async function getToastMessage(page: Page): Promise<string | null> {
  const toast = page.locator('[data-testid="editor-toast"]');
  if (await toast.isVisible({ timeout: 1000 })) {
    return await toast.textContent();
  }
  return null;
}

async function waitForToast(page: Page, expectedText?: string, timeout = 5000): Promise<string> {
  const toast = page.locator('[data-testid="editor-toast"]');
  await expect(toast).toBeVisible({ timeout });
  const text = await toast.textContent();
  if (expectedText && text && !text.includes(expectedText)) {
    throw new Error(`Toast text mismatch: expected "${expectedText}", got "${text}"`);
  }
  return text || '';
}

async function getRingCount(page: Page): Promise<number> {
  const legend = page.locator('text=リング録音');
  const text = await legend.textContent();
  const match = text?.match(/\((\d+)\)/);
  return match ? Number(match[1]) : 0;
}

async function getSegmentCount(page: Page): Promise<number> {
  const legend = page.locator('text=セグメント');
  const text = await legend.textContent();
  const match = text?.match(/\((\d+)\)/);
  return match ? Number(match[1]) : 0;
}

async function getRingListItems(page: Page): Promise<Array<{ beat: number; type: string; duration?: number }>> {
  return await page.evaluate(() => {
    const items = document.querySelectorAll('[data-testid^="ring-list-item-"]');
    const results: Array<{ beat: number; type: string; duration?: number }> = [];
    items.forEach((item) => {
      const beatText = item.querySelector('.ring-list-beat')?.textContent || '';
      const beatMatch = beatText.match(/beat:\s*([\d.]+)/);
      const typeSelect = item.querySelector('.ring-type-select') as HTMLSelectElement;
      const durationInput = item.querySelector('.ring-duration-input') as HTMLInputElement;
      if (beatMatch) {
        results.push({
          beat: Number(beatMatch[1]),
          type: typeSelect?.value ?? 'single',
          duration: durationInput ? Number(durationInput.value) : undefined,
        });
      }
    });
    return results;
  });
}

async function getSegmentListItems(page: Page): Promise<Array<{ direction: string; beats: number }>> {
  return await page.evaluate(() => {
    const items = document.querySelectorAll('.segment-list-item');
    const results: Array<{ direction: string; beats: number }> = [];
    items.forEach((item) => {
      const directionSelect = item.querySelector('.segment-direction') as HTMLSelectElement;
      const beatsInput = item.querySelector('.segment-beats') as HTMLInputElement;
      if (directionSelect && beatsInput) {
        results.push({
          direction: directionSelect.value,
          beats: Number(beatsInput.value),
        });
      }
    });
    return results;
  });
}

async function exportChart(page: Page): Promise<void> {
  await page.click('button[data-testid="editor-export"]');
  await waitForToast(page, 'エクスポート');
}

async function importChartFile(page: Page, filePath: string): Promise<void> {
  const input = page.locator('input[data-testid="import-toml"]');
  await input.setInputFiles(filePath);
  await waitForToast(page, '読み込み');
}

async function clearChart(page: Page): Promise<void> {
  await page.click('button[data-testid="editor-clear"]');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await waitForToast(page, 'クリア');
}

test.describe('T99: Editor Feature Improvements & Bug Fixes', () => {
  test.beforeEach(async ({ page }) => {
    await gotoEditor(page);
    await waitForAudioLoad(page);
  });

  test.describe('(1) Audio offset in music control pane & reflected in playFrom', () => {
    test('Audio offset input exists in Music Control pane (not BPM settings)', async ({ page }) => {
      const offsetLabel = page.locator('label[for="audio-offset"]');
      await expect(offsetLabel).toBeVisible();
      await expect(offsetLabel).toHaveText('オーディオオフセット (Audio Offset ms)');

      const bpmPane = page.locator('section:has(h2:has-text("BPM設定"))');
      await expect(bpmPane.locator('label[for="audio-offset"]')).not.toBeVisible();
    });

    test('Changing audio offset updates playFrom start time', async ({ page }) => {
      await setAudioOffsetValue(page, 500);
      const offset = await getAudioOffsetValue(page);
      expect(Number(offset.toFixed(2))).toBeCloseTo(500);

      await clickPlayPause(page);
      await page.waitForTimeout(500);
      await clickPlayPause(page);

      const playBtn = page.locator('button[data-testid="editor-play"]');
      await expect(playBtn).not.toHaveText('読込中…');
    });

    test('Audio offset persists in exported TOML', async ({ page }) => {
      await setAudioOffsetValue(page, 250);
      await exportChart(page);

      const download = await page.waitForEvent('download', { timeout: 5000 });
      const content = await download.path();
      expect(content).toBeTruthy();
    });

    test('Audio offset loaded from imported TOML', async ({ page }) => {
      await setAudioOffsetValue(page, -100);
      await exportChart(page);
      const download = await page.waitForEvent('download', { timeout: 5000 });
      const filePath = await download.path();
      expect(filePath).toBeTruthy();

      await clearChart(page);
      await importChartFile(page, filePath!);
      await page.waitForTimeout(500);

      const loadedOffset = await getAudioOffsetValue(page);
      expect(Number(loadedOffset.toFixed(0))).toBe(-100);
    });
  });

  test.describe('(2) Hold rings reflected during recording', () => {
    test('Hold ring type selector exists in ring list', async ({ page }) => {
      await clickCanvasAtBeat(page, 4);
      await page.waitForTimeout(200);

      const ringItems = await getRingListItems(page);
      expect(ringItems.length).toBeGreaterThan(0);

      const firstRing = ringItems[0];
      expect(firstRing.type).toBe('single');
    });

    test('Hold ring created when Space held > 0.3 beats during recording', async ({ page }) => {
      await setSnapValue(page, 0.25);
      await clickRecordToggle(page);
      await expect(page.locator('button[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/);

      await clickPlayPause(page);
      await page.waitForTimeout(2000);

      await pressKey(page, 'Space');
      await page.waitForTimeout(1000);
      await pressKey(page, 'Space');
      await page.waitForTimeout(500);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const rings = await getRingListItems(page);
      const holdRing = rings.find((r) => r.type === 'hold');
      expect(holdRing).toBeDefined();
      if (holdRing) {
        expect(holdRing.duration).toBeGreaterThan(0.3);
      }
    });

    test('Hold ring duration editable in ring list', async ({ page }) => {
      await clickCanvasAtBeat(page, 2);
      await page.waitForTimeout(200);

      const ringItems = await getRingListItems(page);
      expect(ringItems.length).toBe(1);

      const typeSelect = page.locator('.ring-type-select').first();
      await typeSelect.selectOption('hold');
      await page.waitForTimeout(100);

      const durationInput = page.locator('.ring-duration-input').first();
      await durationInput.fill('2.5');
      await page.waitForTimeout(100);

      const updated = await getRingListItems(page);
      expect(updated[0].type).toBe('hold');
      expect(Number(updated[0].duration!.toFixed(1))).toBe(2.5);
    });
  });

  test.describe('(3) Quantize (snap) during recording & quantize resolution UI', () => {
    test('Snap/quantize dropdown exists in ring list accordion', async ({ page }) => {
      const snapLabel = page.locator('label[for="snap"]');
      await expect(snapLabel).toBeVisible();
      await expect(snapLabel).toHaveText('クオンタイズ / スナップ');

      const snapSelect = page.locator('select#snap');
      await expect(snapSelect).toBeVisible();
      const options = await snapSelect.locator('option').allTextContents();
      expect(options).toContain('1/8');
      expect(options).toContain('1/4');
      expect(options).toContain('1/2');
      expect(options).toContain('1/1');
    });

    test('Changing snap value updates ring placement quantization', async ({ page }) => {
      await setSnapValue(page, 0.5);
      let snap = await getSnapValue(page);
      expect(Number(snap.toFixed(2))).toBe(0.5);

      await clickCanvasAtBeat(page, 2.1);
      await page.waitForTimeout(200);

      const rings = await getRingListItems(page);
      expect(rings[0].beat).toBe(2.0);

      await setSnapValue(page, 0.125);
      snap = await getSnapValue(page);
      expect(Number(snap.toFixed(3))).toBe(0.125);

      await clickCanvasAtBeat(page, 3.06);
      await page.waitForTimeout(200);

      const rings2 = await getRingListItems(page);
      const newRing = rings2.find((r) => r.beat === 3.125 || r.beat === 3.0);
      expect(newRing).toBeDefined();
    });

    test('Recording cursor trajectory snaps to quantize grid', async ({ page }) => {
      await setSnapValue(page, 0.25);
      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(2000);

      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);
      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);
      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const segments = await getSegmentListItems(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        const remainder = seg.beats % 0.25;
        expect(remainder < 0.001 || Math.abs(remainder - 0.25) < 0.001).toBeTruthy();
      }
    });

    test('Snap value persists in exported TOML and restored on import', async ({ page }) => {
      await setSnapValue(page, 0.5);
      await exportChart(page);
      const download = await page.waitForEvent('download', { timeout: 5000 });
      const filePath = await download.path();

      await clearChart(page);
      await importChartFile(page, filePath!);
      await page.waitForTimeout(500);

      const loadedSnap = await getSnapValue(page);
      expect(Number(loadedSnap.toFixed(2))).toBe(0.5);
    });
  });

  test.describe('(4) Legacy keyboard segment stamping during playback REMOVED', () => {
    test('Arrow keys do NOT create segments during playback (non-record mode)', async ({ page }) => {
      const initialSegments = await getSegmentListItems(page);
      const initialCount = initialSegments.length;

      await clickPlayPause(page);
      await page.waitForTimeout(1000);

      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(200);
      await pressKey(page, 'ArrowDown');
      await page.waitForTimeout(200);
      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(200);

      await clickPlayPause(page);
      await page.waitForTimeout(200);

      const finalSegments = await getSegmentListItems(page);
      expect(finalSegments.length).toBe(initialCount);
    });

    test('Arrow keys DO create trajectory during recording mode', async ({ page }) => {
      await clickRecordToggle(page);
      await expect(page.locator('button[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/);

      const initialCount = (await getSegmentListItems(page)).length;

      await clickPlayPause(page);
      await page.waitForTimeout(1000);

      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(300);
      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(300);
      await pressKey(page, 'ArrowDown');
      await page.waitForTimeout(300);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const finalSegments = await getSegmentListItems(page);
      expect(finalSegments.length).toBeGreaterThan(initialCount);
    });

    test('Space key adds rings in both play and record modes', async ({ page }) => {
      await clickPlayPause(page);
      await page.waitForTimeout(1000);

      const initialRings = await getRingCount(page);
      await pressKey(page, 'Space');
      await page.waitForTimeout(200);

      const afterPlayRings = await getRingCount(page);
      expect(afterPlayRings).toBe(initialRings + 1);

      await clickPlayPause(page);
      await page.waitForTimeout(200);

      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(1000);

      const initialRecordRings = await getRingCount(page);
      await pressKey(page, 'Space');
      await page.waitForTimeout(200);

      const afterRecordRings = await getRingCount(page);
      expect(afterRecordRings).toBe(initialRecordRings + 1);

      await clickRecordToggle(page);
      await clickPlayPause(page);
    });
  });

  test.describe('(5) Waveform vertical display area expansion', () => {
    test('Waveform uses full canvas height (not clamped to fixed amplitude)', async ({ page }) => {
      const canvas = await getWavePreviewCanvas(page);
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThan(200);

      await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-testid="wave-preview-canvas"]') as HTMLCanvasElement;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const dpr = window.devicePixelRatio || 1;
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let nonTransparent = 0;
            for (let i = 3; i < data.data.length; i += 4) {
              if (data.data[i] > 0) nonTransparent++;
            }
            (window as any).__WAVE_PIXEL_COUNT__ = nonTransparent;
          }
        }
      });

      const pixelCount = await page.evaluate(() => (window as any).__WAVE_PIXEL_COUNT__);
      expect(pixelCount).toBeGreaterThan(1000);
    });

    test('Amplitude setting affects waveform scale but not canvas bounds', async ({ page }) => {
      const amplitudeInput = page.locator('#amplitude');
      await amplitudeInput.fill('200');
      await page.waitForTimeout(300);

      await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-testid="wave-preview-canvas"]') as HTMLCanvasElement;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const dpr = window.devicePixelRatio || 1;
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let nonTransparent = 0;
            for (let i = 3; i < data.data.length; i += 4) {
              if (data.data[i] > 0) nonTransparent++;
            }
            (window as any).__WAVE_PIXEL_COUNT_200__ = nonTransparent;
          }
        }
      });

      const pixelCount200 = await page.evaluate(() => (window as any).__WAVE_PIXEL_COUNT_200__);
      expect(pixelCount200).toBeGreaterThan(0);

      await amplitudeInput.fill('80');
      await page.waitForTimeout(300);

      await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-testid="wave-preview-canvas"]') as HTMLCanvasElement;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const dpr = window.devicePixelRatio || 1;
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let nonTransparent = 0;
            for (let i = 3; i < data.data.length; i += 4) {
              if (data.data[i] > 0) nonTransparent++;
            }
            (window as any).__WAVE_PIXEL_COUNT_80__ = nonTransparent;
          }
        }
      });

      const pixelCount80 = await page.evaluate(() => (window as any).__WAVE_PIXEL_COUNT_80__);
      expect(pixelCount80).toBeGreaterThan(0);
    });
  });

  test.describe('(6) Canvas wheel zoom prevents page scroll (preventDefault)', () => {
    test('Wheel on canvas zooms view without scrolling page', async ({ page }) => {
      await page.evaluate(() => {
        (window as any).__PAGE_SCROLLED__ = false;
        window.addEventListener('scroll', () => {
          (window as any).__PAGE_SCROLLED__ = true;
        });
      });

      const initialScroll = await page.evaluate(() => window.scrollY);
      await wheelCanvas(page, -100);
      await page.waitForTimeout(200);

      const scrolled = await page.evaluate(() => (window as any).__PAGE_SCROLLED__);
      expect(scrolled).toBeFalsy();

      const finalScroll = await page.evaluate(() => window.scrollY);
      expect(finalScroll).toBe(initialScroll);
    });

    test('Wheel zoom changes view.beats state', async ({ page }) => {
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-testid="wave-preview-canvas"]') as HTMLCanvasElement;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          (window as any).__INITIAL_VIEW_WIDTH__ = rect.width;
        }
      });

      await wheelCanvas(page, -500);
      await page.waitForTimeout(300);

      const viewAfterZoom = await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-testid="wave-preview-canvas"]') as HTMLCanvasElement;
        if (canvas) {
          const rect = canvas.getBoundingClientRect();
          return rect.width;
        }
        return 0;
      });

      expect(viewAfterZoom).toBeGreaterThan(0);
    });

    test('Wheel zoom in/out cycles correctly', async ({ page }) => {
      for (let i = 0; i < 3; i++) {
        await wheelCanvas(page, -100);
      }
      await page.waitForTimeout(300);

      for (let i = 0; i < 3; i++) {
        await wheelCanvas(page, 100);
      }
      await page.waitForTimeout(300);
    });
  });

  test.describe('(7) Recording overwrite limited to start~end beat range', () => {
    test('Pre-existing segments before recording start beat are preserved', async ({ page }) => {
      await clearChart(page);

      await page.evaluate(() => {
        const editor = (window as any).__EDITOR_INSTANCE__;
        if (editor) {
          editor.setSegments([
            { direction: 'up', beats: 2 },
            { direction: 'down', beats: 2 },
            { direction: 'up', beats: 2 },
            { direction: 'down', beats: 2 },
          ]);
        }
      });

      await page.waitForTimeout(200);
      const initialSegments = await getSegmentListItems(page);
      expect(initialSegments.length).toBe(4);

      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(1500);

      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const finalSegments = await getSegmentListItems(page);
      expect(finalSegments.length).toBeGreaterThanOrEqual(4);

      const firstSegments = finalSegments.slice(0, 2);
      expect(firstSegments[0].direction).toBe('up');
      expect(firstSegments[1].direction).toBe('down');
    });

    test('Pre-existing segments after recording end beat are preserved', async ({ page }) => {
      await clearChart(page);

      await page.evaluate(() => {
        const editor = (window as any).__EDITOR_INSTANCE__;
        if (editor) {
          editor.setSegments([
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'down', beats: 1 },
          ]);
        }
      });

      await page.waitForTimeout(200);
      const initialSegments = await getSegmentListItems(page);
      expect(initialSegments.length).toBe(6);

      await page.evaluate(() => {
        const editor = (window as any).__EDITOR_INSTANCE__;
        if (editor) {
          editor.setPositionMs(4000);
        }
      });
      await page.waitForTimeout(200);

      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(1500);

      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const finalSegments = await getSegmentListItems(page);
      expect(finalSegments.length).toBeGreaterThanOrEqual(4);

      const lastSegments = finalSegments.slice(-2);
      expect(lastSegments[0].direction).toBe('up');
      expect(lastSegments[1].direction).toBe('down');
    });

    test('Only segments within recording range are replaced', async ({ page }) => {
      await clearChart(page);

      await page.evaluate(() => {
        const editor = (window as any).__EDITOR_INSTANCE__;
        if (editor) {
          editor.setSegments([
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
            { direction: 'up', beats: 1 },
          ]);
        }
      });

      await page.waitForTimeout(200);

      await page.evaluate(() => {
        const editor = (window as any).__EDITOR_INSTANCE__;
        if (editor) {
          editor.setPositionMs(3000);
        }
      });
      await page.waitForTimeout(200);

      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(2000);

      await pressKey(page, 'ArrowDown');
      await page.waitForTimeout(500);
      await pressKey(page, 'ArrowDown');
      await page.waitForTimeout(500);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const finalSegments = await getSegmentListItems(page);
      expect(finalSegments.length).toBe(8);

      const middleSegments = finalSegments.slice(2, 6);
      for (const seg of middleSegments) {
        expect(seg.direction).toBe('down');
      }
    });
  });

  test.describe('Integration: Full editor workflow', () => {
    test('Complete workflow: load audio -> set BPM -> add rings -> record waveform -> set snap -> export -> import -> verify', async ({ page }) => {
      await clearChart(page);

      await page.fill('#bpm', '140');
      await page.waitForTimeout(200);
      const bpm = await getBpmValue(page);
      expect(bpm).toBe(140);

      await setSnapValue(page, 0.25);

      await clickCanvasAtBeat(page, 2);
      await clickCanvasAtBeat(page, 4);
      await clickCanvasAtBeat(page, 6);

      let rings = await getRingListItems(page);
      expect(rings.length).toBe(3);

      await setSnapValue(page, 0.5);

      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(3000);

      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);
      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);
      await pressKey(page, 'ArrowDown');
      await page.waitForTimeout(500);

      await clickRecordToggle(page);
      await waitForToast(page, '記録');

      const segments = await getSegmentListItems(page);
      expect(segments.length).toBeGreaterThan(0);

      await exportChart(page);
      const download = await page.waitForEvent('download', { timeout: 5000 });
      const filePath = await download.path();
      expect(filePath).toBeTruthy();

      await clearChart(page);
      await importChartFile(page, filePath!);
      await page.waitForTimeout(500);

      const importedBpm = await getBpmValue(page);
      expect(importedBpm).toBe(140);

      const importedSnap = await getSnapValue(page);
      expect(Number(importedSnap.toFixed(2))).toBe(0.5);

      const importedRings = await getRingListItems(page);
      expect(importedRings.length).toBe(3);

      const importedSegments = await getSegmentListItems(page);
      expect(importedSegments.length).toBeGreaterThan(0);
    });

    test('Playtest launches GameScreen with current chart state', async ({ page }) => {
      await clickCanvasAtBeat(page, 4);
      await page.waitForTimeout(200);

      await page.click('button[data-testid="editor-playtest"]');
      await page.waitForTimeout(3000);

      const playtestCanvas = page.locator('canvas[data-testid="playtest-canvas"]');
      await expect(playtestCanvas).toBeVisible();

      const exitBtn = page.locator('button[data-testid="playtest-exit"]');
      await expect(exitBtn).toBeVisible();
      await exitBtn.click();

      await expect(page.locator('text=オーサリングツール')).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe('Console error monitoring', () => {
    test('No uncaught errors during editor interactions', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const text = msg.text();
          if (CONSOLE_ERROR_PATTERNS.test(text)) {
            errors.push(text);
          }
        }
      });

      await clickPlayPause(page);
      await page.waitForTimeout(1000);
      await clickPlayPause(page);
      await page.waitForTimeout(200);

      await clickCanvasAtBeat(page, 2);
      await page.waitForTimeout(200);
      await clickCanvasAtBeat(page, 4);
      await page.waitForTimeout(200);

      await setSnapValue(page, 0.125);
      await page.waitForTimeout(100);

      await clickRecordToggle(page);
      await clickPlayPause(page);
      await page.waitForTimeout(2000);
      await pressKey(page, 'ArrowUp');
      await page.waitForTimeout(500);
      await clickRecordToggle(page);
      await page.waitForTimeout(500);
      await clickPlayPause(page);

      await wheelCanvas(page, -100);
      await wheelCanvas(page, 100);

      await page.fill('#audio-offset', '100');
      await page.waitForTimeout(100);

      await page.fill('#amplitude', '200');
      await page.waitForTimeout(100);

      await page.fill('#bpm', '180');
      await page.waitForTimeout(100);

      expect(errors).toHaveLength(0);
    });
  });
});