import { test, expect } from '@playwright/test';

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
  }, { timeout: 15000 });
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

async function getRingsFromWindow(page: any): Promise<Array<{ beat: number; type?: string; duration?: number }>> {
  return await page.evaluate(() => (window as any).__editorRings ?? []);
}

async function clearRings(page: any): Promise<void> {
  await page.evaluate(() => {
    (window as any).__editorRings = [];
  });
  await page.waitForTimeout(200);
}

test.describe('T103: レガシー再生中リングスタンプ完全削除', () => {
  let errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors = [];
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
    await waitForAudioReady(page);
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test.afterEach(() => {
    expect(errors).toHaveLength(0);
  });

  test('Negative Control: Play mode - Space key during playback does NOT add rings', async ({ page }) => {
    // Step 1: Capture Initial State
    await clearRings(page);
    const initialRings = await getRingsFromWindow(page);
    const initialCount = initialRings.length;
    expect(initialCount).toBe(0);

    // Step 2: Perform User Interaction - Start playback in PLAY mode (default)
    await startPlayback(page);
    await page.waitForTimeout(1000);

    // Verify we're in play mode (not record mode)
    const recordBtn = page.locator('[data-testid="editor-record-toggle"]');
    await expect(recordBtn).toHaveText('録音モード');

    // Press Space key multiple times during playback
    for (let i = 0; i < 5; i++) {
      await page.keyboard.down('Space');
      await page.waitForTimeout(100);
      await page.keyboard.up('Space');
      await page.waitForTimeout(200);
    }

    // Stop playback
    await stopPlayback(page);
    await page.waitForTimeout(500);

    // Step 3: Assert Resulting Transition - ring count has NOT changed
    const finalRings = await getRingsFromWindow(page);
    expect(finalRings.length).toBe(initialCount);
  });

  test('Positive Control: Record mode - Space key during playback DOES add rings', async ({ page }) => {
    // Step 1: Capture Initial State
    await clearRings(page);
    const initialRings = await getRingsFromWindow(page);
    const initialCount = initialRings.length;
    expect(initialCount).toBe(0);

    // Step 2: Perform User Interaction - Start playback
    await startPlayback(page);
    await page.waitForTimeout(1000);

    // Step 3: Enter RECORD mode
    await enterRecordMode(page);
    await page.waitForTimeout(500);

    // Verify we're in record mode
    const recordBtn = page.locator('[data-testid="editor-record-toggle"]');
    await expect(recordBtn).toHaveText('録音停止');

    // Press Space key multiple times during playback in record mode
    const expectedNewRings = 3;
    for (let i = 0; i < expectedNewRings; i++) {
      await page.keyboard.down('Space');
      await page.waitForTimeout(150);
      await page.keyboard.up('Space');
      await page.waitForTimeout(300);
    }

    // Exit record mode (this commits any recorded trajectory but rings are added on keyup)
    await exitRecordMode(page);
    await page.waitForTimeout(500);

    // Stop playback
    await stopPlayback(page);
    await page.waitForTimeout(500);

    // Step 4: Assert Resulting Transition - ring count HAS increased
    const finalRings = await getRingsFromWindow(page);
    expect(finalRings.length).toBeGreaterThanOrEqual(initialCount + expectedNewRings);

    // Verify the new rings have correct structure
    const newRings = finalRings.slice(initialCount);
    for (const ring of newRings) {
      expect(ring.beat).toBeGreaterThanOrEqual(0);
      expect(['single', 'hold']).toContain(ring.type ?? 'single');
      if (ring.type === 'hold') {
        expect(ring.duration).toBeGreaterThan(0.3);
      }
    }
  });

  test('Mode switching verification: Rings only added in record mode, not in play mode', async ({ page }) => {
    // Step 1: Capture Initial State
    await clearRings(page);
    let initialRings = await getRingsFromWindow(page);
    expect(initialRings.length).toBe(0);

    // Step 2: Start playback
    await startPlayback(page);
    await page.waitForTimeout(1000);

    // --- PHASE 1: Play mode (default) ---
    // Press Space - should NOT add rings
    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    let ringsAfterPlayMode = await getRingsFromWindow(page);
    expect(ringsAfterPlayMode.length).toBe(0);

    // --- PHASE 2: Switch to Record mode ---
    await enterRecordMode(page);
    await page.waitForTimeout(500);

    // Press Space - SHOULD add rings
    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    // Exit record mode
    await exitRecordMode(page);
    await page.waitForTimeout(500);

    let ringsAfterRecordMode = await getRingsFromWindow(page);
    expect(ringsAfterRecordMode.length).toBeGreaterThanOrEqual(2);

    // --- PHASE 3: Back to Play mode ---
    // Press Space again - should NOT add more rings
    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    await page.keyboard.down('Space');
    await page.waitForTimeout(150);
    await page.keyboard.up('Space');
    await page.waitForTimeout(300);

    // Stop playback
    await stopPlayback(page);
    await page.waitForTimeout(500);

    // Step 3: Assert Resulting Transition - ring count should not have changed after returning to play mode
    const finalRings = await getRingsFromWindow(page);
    expect(finalRings.length).toBe(ringsAfterRecordMode.length);
  });
});