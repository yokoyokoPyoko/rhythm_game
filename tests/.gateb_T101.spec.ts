import { test, expect } from '@playwright/test';

const SNAP_OPTIONS = [0.125, 0.25, 0.5, 1];

function isSnapAligned(beats: number, snap: number, epsilon = 1e-6): boolean {
  if (!(snap > 0)) return true;
  const remainder = ((beats % snap) + snap) % snap;
  return remainder < epsilon || Math.abs(remainder - snap) < epsilon;
}

async function waitForAudioReady(page: any, timeout = 120000): Promise<void> {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn && !btn.textContent?.includes('読込中');
    },
    { timeout }
  );
}

async function startPlayback(page: any): Promise<void> {
  await page.click('[data-testid="editor-play"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn && btn.textContent?.includes('停止');
    },
    { timeout: 10000 }
  );
}

async function stopPlayback(page: any): Promise<void> {
  await page.click('[data-testid="editor-play"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn && !btn.textContent?.includes('停止');
    },
    { timeout: 5000 }
  );
}

async function enterRecordMode(page: any): Promise<void> {
  await page.click('[data-testid="editor-record-toggle"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-record-toggle"]');
      return btn && btn.textContent?.includes('録音停止');
    },
    { timeout: 5000 }
  );
}

async function exitRecordMode(page: any): Promise<void> {
  await page.click('[data-testid="editor-record-toggle"]');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-record-toggle"]');
      return btn && btn.textContent?.includes('録音モード');
    },
    { timeout: 5000 }
  );
}

async function getSegmentsFromWindow(page: any): Promise<Array<{ direction: string; beats: number }>> {
  return await page.evaluate(() => (window as any).__editorSegments ?? []);
}

async function getSnapFromWindow(page: any): Promise<number> {
  return await page.evaluate(() => (window as any).__editorSnap ?? 0.25);
}

async function getRecLiveFromWindow(page: any): Promise<any> {
  return await page.evaluate(() => (window as any).__editorRecLive ?? null);
}

async function clearSegments(page: any): Promise<void> {
  page.once('dialog', (dialog: { accept: () => void }) => dialog.accept());
  await page.click('[data-testid="editor-clear"]');
  await page.waitForTimeout(500);
}

async function simulateKeyPress(page: any, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(50);
  await page.keyboard.up(key);
}

test.describe('T101: 録音時クオンタイズ（スナップ吸着）＋分解能UI', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
      }
    });
    page.on('pageerror', (err) => {
      errors.push(err.message);
    });

    await page.goto('http://localhost:5173/#/editor');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await expect(page.locator('#snap')).toBeVisible();
    await waitForAudioReady(page);
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test('Snap dropdown exists and updates internal snap state', async ({ page }) => {
    const snapSelect = page.locator('[data-testid="snap-select"]');
    await expect(snapSelect).toBeVisible();

    // [Step 1: Capture Initial State] Read initial snap value from internal state
    const initialSnap = await getSnapFromWindow(page);
    expect(SNAP_OPTIONS).toContain(initialSnap);

    // [Step 2: Perform User Interaction] Select each snap option and verify state transition
    for (const snapValue of SNAP_OPTIONS) {
      await snapSelect.selectOption(String(snapValue));
      await page.waitForTimeout(100);

      // [Step 3: Assert Resulting Transition] Internal snap state must equal selected value
      const currentSnap = await getSnapFromWindow(page);
      expect(currentSnap).toBe(snapValue);
    }
  });

  for (const snapValue of SNAP_OPTIONS) {
    test(`Recording with snap=${snapValue} produces segments with beats quantized to integer multiples of ${snapValue}`, async ({ page }) => {
      const snapSelect = page.locator('[data-testid="snap-select"]');

      // [Step 1: Capture Initial State] Select snap and verify it's set
      await snapSelect.selectOption(String(snapValue));
      await page.waitForTimeout(200);
      const snapUsed = await getSnapFromWindow(page);
      expect(snapUsed).toBe(snapValue);

      // Clear any existing segments
      await clearSegments(page);

      // [Step 2: Perform User Interaction] Start playback, enter record mode, simulate key presses
      await startPlayback(page);
      await page.waitForTimeout(500);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      for (let i = 0; i < 20; i++) {
        await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
        await page.waitForTimeout(100);
      }

      // Exit record mode to trigger finishRecording()
      await exitRecordMode(page);
      await page.waitForTimeout(500);

      // [Step 3: Assert Resulting Transition] All segments must have beats quantized to snap
      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapUsed)).toBeTruthy();
      }
    });
  }

  test('Positive test: short key presses are quantized to snap grid', async ({ page }) => {
    const snapValue = 0.25;
    await page.locator('[data-testid="snap-select"]').selectOption(String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(500);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    for (let i = 0; i < 20; i++) {
      await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(60);
    }

    await exitRecordMode(page);
    await page.waitForTimeout(500);

    const segments = await getSegmentsFromWindow(page);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
    }
  });

  test('Live trajectory during recording is quantized to snap grid', async ({ page }) => {
    const snapValue = 0.25;
    await page.locator('[data-testid="snap-select"]').selectOption(String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(500);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    // [Step 2: Perform User Interaction] Single key press to generate trajectory points
    await simulateKeyPress(page, 'ArrowUp');
    await page.waitForTimeout(150);

    // [Step 3: Assert Resulting Transition] Live trajectory beat values must be snap-aligned
    const recLive = await getRecLiveFromWindow(page);
    expect(recLive).not.toBeNull();
    expect(recLive.trajectory.length).toBeGreaterThan(1);

    for (const point of recLive.trajectory) {
      expect(isSnapAligned(point.beat, snapValue)).toBeTruthy();
    }

    await exitRecordMode(page);
  });

  test('Different snap values produce correctly quantized segments in sequence', async ({ page }) => {
    const snapSelect = page.locator('[data-testid="snap-select"]');

    for (const snapValue of SNAP_OPTIONS) {
      // [Step 1: Capture Initial State] Select snap value
      await snapSelect.selectOption(String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);

      // [Step 2: Perform User Interaction] Record with current snap
      await enterRecordMode(page);
      await page.waitForTimeout(200);

      for (let i = 0; i < 15; i++) {
        await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
        await page.waitForTimeout(100);
      }

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      // [Step 3: Assert Resulting Transition] Segments quantized to current snap
      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      await stopPlayback(page);
      await page.waitForTimeout(300);
    }
  });

  test('Segment list in UI shows quantized beats for ring list', async ({ page }) => {
    const snapValue = 0.5;
    const snapSelect = page.locator('[data-testid="snap-select"]');

    // [Step 1: Capture Initial State] Set snap to 0.5
    await snapSelect.selectOption(String(snapValue));
    await page.waitForTimeout(200);

    await startPlayback(page);
    await page.waitForTimeout(500);

    // [Step 2: Perform User Interaction] Record and generate rings
    await enterRecordMode(page);
    await page.waitForTimeout(200);

    for (let i = 0; i < 15; i++) {
      await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(100);
    }

    await exitRecordMode(page);
    await page.waitForTimeout(500);

    // Open ring list accordion to see segments
    await page.click('[data-testid="ring-list-details"] summary');
    await page.waitForTimeout(200);

    // [Step 3: Assert Resulting Transition] Ring list beat values must be snap-aligned
    const ringItems = page.locator('[data-testid^="ring-list-item-"]');
    const count = await ringItems.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const beatText = await ringItems.nth(i).locator('.ring-list-beat').textContent();
        const beatMatch = beatText?.match(/beat:\s*([\d.]+)/);
        if (beatMatch) {
          const beat = parseFloat(beatMatch[1]);
          expect(isSnapAligned(beat, snapValue)).toBeTruthy();
        }
      }
    }
  });
});