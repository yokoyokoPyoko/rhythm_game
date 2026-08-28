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
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]');
    return btn && btn.textContent?.includes('停止');
  }, { timeout: 10000 });
}

async function stopPlayback(page: any): Promise<void> {
  await page.click('[data-testid="editor-play"]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]');
    return btn && !btn.textContent?.includes('停止');
  }, { timeout: 5000 });
}

async function enterRecordMode(page: any): Promise<void> {
  await page.click('[data-testid="editor-record-toggle"]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-record-toggle"]');
    return btn && btn.textContent?.includes('録音停止');
  }, { timeout: 5000 });
}

async function exitRecordMode(page: any): Promise<void> {
  await page.click('[data-testid="editor-record-toggle"]');
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-record-toggle"]');
    return btn && btn.textContent?.includes('録音モード');
  }, { timeout: 5000 });
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

  test('Snap dropdown exists and updates internal state', async ({ page }) => {
    await expect(page.locator('[data-testid="snap-select"]')).toBeVisible();

    const initialSnap = await getSnapFromWindow(page);
    expect(SNAP_OPTIONS).toContain(initialSnap);

    for (const snapValue of SNAP_OPTIONS) {
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(100);
      const currentSnap = await getSnapFromWindow(page);
      expect(currentSnap).toBe(snapValue);
    }
  });

  for (const snapValue of SNAP_OPTIONS) {
    test(`Recording with snap=${snapValue} produces segments with beats quantized to ${snapValue}`, async ({ page }) => {
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);
      const snapUsed = await getSnapFromWindow(page);
      expect(snapUsed).toBe(snapValue);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      for (let i = 0; i < 20; i++) {
        await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
        await page.waitForTimeout(100);
      }

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapUsed)).toBeTruthy();
      }
    });
  }

  test('Negative test: patching segmentize to return non-quantized beats causes test failure', async ({ page }) => {
    await page.addInitScript(() => {
      const originalSegmentize = (window as any).__originalSegmentize;
      (window as any).__originalSegmentize = originalSegmentize;
    });

    await page.evaluate(() => {
      const mod = (window as any).__segmentizeModule;
      if (mod) {
        (window as any).__originalSegmentize = mod.segmentize;
        mod.segmentize = function(traj: any, snap: number, amplitude: number) {
          const result = (window as any).__originalSegmentize(traj, snap, amplitude);
          return result.map((s: any) => ({ ...s, beats: s.beats + 0.1 }));
        };
      }
    });

    const snapValue = 0.25;
    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(500);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    for (let i = 0; i < 20; i++) {
      await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(100);
    }

    await exitRecordMode(page);
    await page.waitForTimeout(500);

    const segments = await getSegmentsFromWindow(page);
    const allAligned = segments.every((seg) => isSnapAligned(seg.beats, snapValue));
    expect(allAligned).toBeFalsy();
  });

  test('Live trajectory during recording is quantized to snap grid', async ({ page }) => {
    const snapValue = 0.25;
    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(500);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    await simulateKeyPress(page, 'ArrowUp');
    await page.waitForTimeout(150);

    const recLive = await getRecLiveFromWindow(page);
    expect(recLive).not.toBeNull();
    expect(recLive.trajectory.length).toBeGreaterThan(1);

    for (const point of recLive.trajectory) {
      expect(isSnapAligned(point.beat, snapValue)).toBeTruthy();
    }

    await exitRecordMode(page);
  });

  test('Different snap values produce correctly quantized segments', async ({ page }) => {
    for (const snapValue of SNAP_OPTIONS) {
       await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      for (let i = 0; i < 15; i++) {
        await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
        await page.waitForTimeout(100);
      }

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      await stopPlayback(page);
      await page.waitForTimeout(300);
    }
  });

  test('Segment list in UI shows quantized beats', async ({ page }) => {
    const snapValue = 0.5;
    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);

    await startPlayback(page);
    await page.waitForTimeout(500);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    for (let i = 0; i < 15; i++) {
      await simulateKeyPress(page, i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(100);
    }

    await exitRecordMode(page);
    await page.waitForTimeout(500);

    await page.click('[data-testid="ring-list-details"] summary');
    await page.waitForTimeout(200);

    const segmentItems = page.locator('[data-testid^="ring-list-item-"]');
    const count = await segmentItems.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const beatText = await segmentItems.nth(i).locator('.ring-list-beat').textContent();
        const beatMatch = beatText?.match(/beat:\s*([\d.]+)/);
        if (beatMatch) {
          const beat = parseFloat(beatMatch[1]);
          expect(isSnapAligned(beat, snapValue)).toBeTruthy();
        }
      }
    }
  });
});