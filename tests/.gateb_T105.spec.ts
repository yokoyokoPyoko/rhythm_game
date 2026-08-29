import { test, expect } from '@playwright/test';

const SNAP_OPTIONS = [0.125, 0.25, 0.5, 1];

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

async function clearSegments(page: any): Promise<void> {
  page.once('dialog', (dialog: { accept: () => void }) => dialog.accept());
  await page.click('[data-testid="editor-clear"]');
  await page.waitForTimeout(500);
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

async function getRecStartBeatFromWindow(page: any): Promise<number> {
  return await page.evaluate(() => (window as any).__editorRecStartBeat ?? 0);
}

async function seekToBeat(page: any, beat: number): Promise<void> {
  await page.evaluate((b) => {
    const w = window as unknown as Record<string, unknown>;
    if (w.__editorSeekToBeat) (w.__editorSeekToBeat as (b: number) => void)(b);
  }, beat);
  await page.waitForTimeout(200);
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

  // --- Unit-level tests for quantizeBeat (uses the real exposed module) ---
  for (const snap of SNAP_OPTIONS) {
    test(`quantizeBeat: off-grid inputs snap to nearest grid (snap=${snap})`, async ({ page }) => {
      const results = await page.evaluate((s) => {
        const { quantizeBeat } = (window as any).__editorQuantizeModule ?? {};
        if (typeof quantizeBeat !== 'function') {
          throw new Error('quantizeBeat is not a function (module not exposed)');
        }
        const testCases = [
          1.2, 1.3, 0.7, 2.6, 0.12, 0.18,
        ];
        return testCases.map((input) => {
          const expected = Math.round(input / s) * s;
          const actual = quantizeBeat(input, s);
          return {
            input,
            expected: Number(expected.toFixed(4)),
            actual: Number(actual.toFixed(4)),
            pass: Number(actual.toFixed(4)) === Number(expected.toFixed(4)),
          };
        });
      }, snap);

      for (const r of results) {
        expect(r.pass).toBe(true);
        expect(r.actual).toBeCloseTo(r.expected, 4);
      }
    });
  }

  // --- Unit-level tests for segmentize (uses the real exposed module) ---
  for (const snap of SNAP_OPTIONS) {
    test(`segmentize: off-grid release produces snap-aligned segments without overshoot (snap=${snap})`, async ({ page }) => {
      const trajectory = await page.evaluate((s) => {
        const { segmentize } = (window as any).__editorQuantizeModule ?? {};
        if (typeof segmentize !== 'function') {
          throw new Error('segmentize is not a function (module not exposed)');
        }
        // Trajectory 1: press at beat 0, release at 1.2 (y changes while held,
        // flat after release). `down` encodes the pressed state.
        const traj1 = [
          { beat: 0, y: 170, down: true },
          { beat: 0.5, y: 230, down: true },
          { beat: 1.0, y: 290, down: true },
          { beat: 1.2, y: 410, down: false },
        ];
        // Trajectory 2: release at 1.3.
        const traj2 = [
          { beat: 0, y: 170, down: true },
          { beat: 0.5, y: 230, down: true },
          { beat: 1.0, y: 290, down: true },
          { beat: 1.3, y: 430, down: false },
        ];
        return {
          case1: segmentize(traj1, s, 130),
          case2: segmentize(traj2, s, 130),
        };
      }, snap);

      const case1 = trajectory.case1;
      const case2 = trajectory.case2;

      for (const seg of case1) {
        expect(seg.beats % snap).toBeLessThan(1e-4);
      }
      for (const seg of case2) {
        expect(seg.beats % snap).toBeLessThan(1e-4);
      }

      const lastMovingEnd = (segs: Array<{ direction: string; beats: number }>) => {
        let cum = 0;
        let end = 0;
        for (const seg of segs) {
          if (seg.direction !== 'stay') {
            cum += seg.beats;
            end = cum;
          }
        }
        return end;
      };

      const expectedEnd1 = Math.round(1.2 / snap) * snap;
      expect(lastMovingEnd(case1)).toBeCloseTo(expectedEnd1, 3);

      const expectedEnd2 = Math.round(1.3 / snap) * snap;
      expect(lastMovingEnd(case2)).toBeCloseTo(expectedEnd2, 3);

      // No moving segment may begin after the release beat (no overshoot).
      const assertNoOvershoot = (segs: Array<{ direction: string; beats: number }>, end: number) => {
        let cum = 0;
        for (const seg of segs) {
          if (seg.direction !== 'stay') {
            expect(cum).toBeLessThanOrEqual(end + 1e-3);
          }
          cum += seg.beats;
        }
      };
      assertNoOvershoot(case1, expectedEnd1);
      assertNoOvershoot(case2, expectedEnd2);
    });
  }

  // --- Integration test: Real recording workflow with off-grid timing ---
  test('Recording workflow: key held for off-grid duration snaps correctly (snap=0.5)', async ({ page }) => {
    const snapValue = 0.5;

    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);
    const snapUsed = await getSnapFromWindow(page);
    expect(snapUsed).toBe(snapValue);

    await clearSegments(page);
    const segsBefore = await getSegmentsFromWindow(page);
    expect(segsBefore.length).toBe(0);

    await startPlayback(page);
    await page.waitForTimeout(500);

    await seekToBeat(page, 0);
    await page.waitForTimeout(200);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    // Recording start may drift slightly from beat 0 due to playback timing;
    // the key invariant is the *relative* held duration snapping correctly.
    // Hold ArrowUp for ~1.2 beats worth of time (600ms @ 120 BPM).
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(600);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(200);

    const trajDuring = await getRecTrajFromWindow(page);
    expect(trajDuring.length).toBeGreaterThan(1);

    await exitRecordMode(page);
    await page.waitForTimeout(500);

    const segments = await getSegmentsFromWindow(page);
    expect(segments.length).toBeGreaterThan(0);

    for (const seg of segments) {
      const remainder = ((seg.beats % snapUsed) + snapUsed) % snapUsed;
      expect(remainder < 1e-4 || Math.abs(remainder - snapUsed) < 1e-4).toBe(true);
    }

    const movingBeats = segments
      .filter((s) => s.direction !== 'stay')
      .reduce((sum, s) => sum + s.beats, 0);

    // Relative held duration in beats (120 BPM => 500ms/beat): 600ms = 1.2 beats.
    const heldBeats = 600 / 500;
    const expectedRel = Math.round(heldBeats / snapUsed) * snapUsed; // 1.0
    expect(movingBeats).toBeGreaterThan(0);
    // Within one snap cell of the expected relative snap (timing jitter tolerant).
    expect(Math.abs(movingBeats - expectedRel)).toBeLessThanOrEqual(snapUsed + 1e-3);

    let cum = 0;
    for (const seg of segments) {
      if (seg.direction !== 'stay') {
        expect(cum).toBeLessThanOrEqual(expectedRel + snapUsed + 1e-3);
      }
      cum += seg.beats;
    }

    await stopPlayback(page);
  });

  test('Recording workflow: key held for 1.3 beats snaps to 1.5 (snap=0.5)', async ({ page }) => {
    const snapValue = 0.5;

    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(500);
    await seekToBeat(page, 0);
    await page.waitForTimeout(200);

    await enterRecordMode(page);
    await page.waitForTimeout(200);

    // Hold for ~1.3 beats = 650ms at 120 BPM
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(650);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(200);

    const trajDuring = await getRecTrajFromWindow(page);
    await exitRecordMode(page);
    await page.waitForTimeout(500);

    const segments = await getSegmentsFromWindow(page);
    expect(segments.length).toBeGreaterThan(0);

    for (const seg of segments) {
      const remainder = ((seg.beats % snapValue) + snapValue) % snapValue;
      expect(remainder < 1e-4 || Math.abs(remainder - snapValue) < 1e-4).toBe(true);
    }

    const movingBeats = segments
      .filter((s) => s.direction !== 'stay')
      .reduce((sum, s) => sum + s.beats, 0);

    // Relative held duration: 650ms = 1.3 beats => snapped 1.5 (snap 0.5).
    const heldBeats = 650 / 500;
    const expectedRel = Math.round(heldBeats / snapValue) * snapValue; // 1.5
    expect(movingBeats).toBeGreaterThan(0);
    expect(Math.abs(movingBeats - expectedRel)).toBeLessThanOrEqual(snapValue + 1e-3);

    let cum = 0;
    for (const seg of segments) {
      if (seg.direction !== 'stay') {
        expect(cum).toBeLessThanOrEqual(expectedRel + snapValue + 1e-3);
      }
      cum += seg.beats;
    }

    await stopPlayback(page);
  });

  test('Recording workflow: alternating up/down with off-grid releases (snap=0.25)', async ({ page }) => {
    const snapValue = 0.25;

    await page.selectOption('[data-testid="snap-select"]', String(snapValue));
    await page.waitForTimeout(200);

    await clearSegments(page);
    await startPlayback(page);
    await page.waitForTimeout(400);
    await seekToBeat(page, 0);
    await page.waitForTimeout(200);

    await enterRecordMode(page);
    await page.waitForTimeout(150);

    // Up for ~0.7 beats (snaps to 0.75), then Down for ~0.6 beats (snaps to 0.5)
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(150);
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowDown');
    await page.waitForTimeout(150);

    const traj = await getRecTrajFromWindow(page);
    await exitRecordMode(page);
    await page.waitForTimeout(500);

    const segments = await getSegmentsFromWindow(page);
    expect(segments.length).toBeGreaterThan(0);

    for (const seg of segments) {
      const remainder = ((seg.beats % snapValue) + snapValue) % snapValue;
      expect(remainder < 1e-4 || Math.abs(remainder - snapValue) < 1e-4).toBe(true);
    }

    const movingBeats = segments
      .filter((s) => s.direction !== 'stay')
      .reduce((sum, s) => sum + s.beats, 0);
    // Relative held duration: 350ms + 300ms = 650ms = 1.3 beats => snapped 1.25 (snap 0.25).
    const heldBeats = (350 + 300) / 500;
    const expectedRel = Math.round(heldBeats / snapValue) * snapValue; // 1.25
    expect(movingBeats).toBeGreaterThan(0);
    expect(Math.abs(movingBeats - expectedRel)).toBeLessThanOrEqual(snapValue + 1e-3);

    let cum = 0;
    for (const seg of segments) {
      if (seg.direction !== 'stay') {
        expect(cum).toBeLessThanOrEqual(expectedRel + snapValue + 1e-3);
      }
      cum += seg.beats;
    }

    await stopPlayback(page);
  });

  // --- Test that stay segments are also snap-aligned ---
  test('segmentize: stay segments are also snap-aligned multiples', async ({ page }) => {
    for (const snap of SNAP_OPTIONS) {
      const result = await page.evaluate((s) => {
        const { segmentize } = (window as any).__editorQuantizeModule ?? {};
        if (typeof segmentize !== 'function') {
          throw new Error('segmentize is not a function (module not exposed)');
        }
        // Flat (stay) section after the moving part: release at 1.2, flat to 2.0.
        const traj = [
          { beat: 0, y: 170, down: true },
          { beat: 0.5, y: 230, down: true },
          { beat: 1.0, y: 290, down: true },
          { beat: 1.2, y: 410, down: false },
          { beat: 1.5, y: 410, down: false },
          { beat: 2.0, y: 410, down: false },
        ];
        return segmentize(traj, s, 130);
      }, snap);

      for (const seg of result) {
        const remainder = ((seg.beats % snap) + snap) % snap;
        expect(remainder < 1e-4 || Math.abs(remainder - snap) < 1e-4).toBe(true);
      }
    }
  });
});
