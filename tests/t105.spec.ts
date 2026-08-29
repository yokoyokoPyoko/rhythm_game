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

async function getRecTrajFromWindow(page: any): Promise<Array<{ beat: number; y: number }>> {
  return await page.evaluate(() => (window as any).__editorRecTraj ?? []);
}

async function clearSegments(page: any): Promise<void> {
  page.once('dialog', (dialog: { accept: () => void }) => dialog.accept());
  await page.click('[data-testid="editor-clear"]');
  await page.waitForTimeout(500);
}

// Find the beat at which the recorded trajectory stops moving (key release
// point). Before release the y changes; after release it is flat (stay).
function releaseBeatOf(traj: Array<{ beat: number; y: number }>): number {
  const sorted = [...traj].sort((a, b) => a.beat - b.beat);
  let releaseBeat = sorted.length > 0 ? sorted[sorted.length - 1].beat : 0;
  for (let i = 1; i < sorted.length; i++) {
    const dy = Math.abs(sorted[i].y - sorted[i - 1].y);
    if (dy > 0.5) {
      releaseBeat = sorted[i].beat;
    }
  }
  return releaseBeat;
}

test.describe('T105: 録音クオンタイズのキー離し（リリース）位置吸着', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
      }
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('http://localhost:5173/#/editor');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await expect(page.locator('#snap')).toBeVisible();
    await waitForAudioReady(page);
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  for (const snapValue of SNAP_OPTIONS) {
    test(`Press+release with snap=${snapValue}: segments are snap-aligned and do not overshoot past release`, async ({ page }) => {
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);
      const snapUsed = await getSnapFromWindow(page);
      expect(snapUsed).toBe(snapValue);

      await clearSegments(page);
      const segsBefore = await getSegmentsFromWindow(page);
      expect(segsBefore.length).toBe(0);

      await startPlayback(page);
      await page.waitForTimeout(500);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      // Press ArrowUp, hold, then release. Capture pre/post trajectory action.
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(450);
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(200);

      const trajDuring = await getRecTrajFromWindow(page);
      expect(trajDuring.length).toBeGreaterThan(1);

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      // Core requirement: every produced segment's `beats` is an integer
      // multiple of the selected snap resolution.
      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapUsed)).toBeTruthy();
      }

      // Determine where the cursor actually stopped moving (the release beat).
      const releaseBeat = releaseBeatOf(trajDuring);

      // Moving (up/down) segments represent the held key period. Their total
      // span must end at (or within one snap cell of) the release beat and
      // must NOT extend further (overshoot) into a later snap cell.
      const movingBeats = segments
        .filter((s) => s.direction !== 'stay')
        .reduce((sum, s) => sum + s.beats, 0);

      expect(movingBeats).toBeGreaterThan(0);
      expect(movingBeats).toBeLessThanOrEqual(releaseBeat + snapUsed + 1e-3);

      // No moving segment may begin after the released beat (no trailing slope
      // beyond the release point).
      let cum = 0;
      for (const seg of segments) {
        if (seg.direction !== 'stay') {
          expect(cum).toBeLessThanOrEqual(releaseBeat + snapUsed + 1e-3);
        }
        cum += seg.beats;
      }

      await stopPlayback(page);
    });
  }

  test('Hold ArrowUp then ArrowDown produces alternating snap-aligned segments without overshoot', async ({ page }) => {
    const snapValue = 0.25;
    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(400);

    await enterRecordMode(page);
    await page.waitForTimeout(150);

    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(150);
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowDown');
    await page.waitForTimeout(150);

    const traj = await getRecTrajFromWindow(page);
    await exitRecordMode(page);
    await page.waitForTimeout(500);

    const segments = await getSegmentsFromWindow(page);
    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
    }

    const releaseBeat = releaseBeatOf(traj);
    const movingBeats = segments
      .filter((s) => s.direction !== 'stay')
      .reduce((sum, s) => sum + s.beats, 0);
    expect(movingBeats).toBeLessThanOrEqual(releaseBeat + snapValue + 1e-3);

    await stopPlayback(page);
  });
});
