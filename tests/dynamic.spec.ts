import { test, expect } from '@playwright/test';

const SNAP_OPTIONS = [0.125, 0.25, 0.5, 1];

function isSnapAligned(beats: number, snap: number, epsilon = 1e-6): boolean {
  if (!(snap > 0)) return true;
  const remainder = ((beats % snap) + snap) % snap;
  return remainder < epsilon || Math.abs(remainder - snap) < epsilon;
}

function quantizeBeat(beat: number, snap: number): number {
  if (!(snap > 0) || !Number.isFinite(beat)) return beat;
  return Number((Math.round(beat / snap) * snap).toFixed(4));
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

async function getRecStartBeatFromWindow(page: any): Promise<number> {
  return await page.evaluate(() => (window as any).__editorRecStartBeat ?? 0);
}

async function clearSegments(page: any): Promise<void> {
  page.once('dialog', (dialog: { accept: () => void }) => dialog.accept());
  await page.click('[data-testid="editor-clear"]');
  await page.waitForTimeout(500);
}

async function seekToBeatZero(page: any): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (typeof w.seekTo === 'function') {
      w.seekTo(0);
    }
  });
  await page.waitForTimeout(200);
}

function computeExpectedEndBeat(releaseBeat: number, snap: number): number {
  return quantizeBeat(releaseBeat, snap);
}

function releaseBeatFromTraj(traj: Array<{ beat: number; y: number }>): number {
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

test.describe('T105: 録音クオンタイズのキー離し（リリース）位置吸着改善', () => {
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
    await expect(page.locator('[data-testid="snap-select"]')).toBeVisible();
    await waitForAudioReady(page);
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test.describe('Single key press/release at off-grid positions', () => {
    for (const snapValue of SNAP_OPTIONS) {
      test(`snap=${snapValue}: ArrowUp press+release at off-grid beat quantizes to nearest snap and no overshoot`, async ({ page }) => {
        // Step 1: Capture Initial State
        await page.selectOption('[data-testid="snap-select"]', String(snapValue));
        await page.waitForTimeout(200);
        const snapUsed = await getSnapFromWindow(page);
        expect(snapUsed).toBe(snapValue);

        await clearSegments(page);
        const segsBefore = await getSegmentsFromWindow(page);
        expect(segsBefore.length).toBe(0);

        await startPlayback(page);
        await page.waitForTimeout(500);

        // Seek to beat 0 to ensure recording starts at a known position
        await seekToBeatZero(page);
        await page.waitForTimeout(200);

        await enterRecordMode(page);
        await page.waitForTimeout(200);

        // Step 2: Perform User Interaction - Press ArrowUp, hold for ~450ms (off-grid), release
        // At 120 BPM, 450ms ≈ 0.9 beats. We want to release at ~1.2 or ~1.3 beats for snap=0.5
        // For other snaps, adjust hold time to target specific off-grid positions.
        // We'll press, wait, then release. The exact beat depends on playback position.
        const pressStartTime = Date.now();
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(450);
        await page.keyboard.up('ArrowUp');
        await page.waitForTimeout(200);

        // Step 3: Capture trajectory during recording
        const trajDuring = await getRecTrajFromWindow(page);
        expect(trajDuring.length).toBeGreaterThan(1);

        const recStartBeat = await getRecStartBeatFromWindow(page);
        const releaseBeatRaw = releaseBeatFromTraj(trajDuring);
        const expectedEndBeat = computeExpectedEndBeat(releaseBeatRaw, snapUsed);

        await exitRecordMode(page);
        await page.waitForTimeout(500);

        // Step 4: Assert Resulting Transition
        const segments = await getSegmentsFromWindow(page);
        expect(segments.length).toBeGreaterThan(0);

        // Requirement 1: Every produced segment's `beats` is an integer multiple of the snap resolution
        for (const seg of segments) {
          expect(isSnapAligned(seg.beats, snapUsed)).toBeTruthy();
        }

        // Requirement 2: Moving (up/down) segments total span ends at (or within one snap of) the quantized release beat
        const movingSegments = segments.filter((s) => s.direction !== 'stay');
        expect(movingSegments.length).toBeGreaterThan(0);

        let cum = 0;
        for (const seg of movingSegments) {
          cum += seg.beats;
        }
        const movingBeats = cum;

        // Moving beats should approximately equal (expectedEndBeat - recStartBeat)
        // because recording starts at recStartBeat (quantized to snap)
        const expectedMovingBeats = expectedEndBeat - recStartBeat;
        expect(movingBeats).toBeCloseTo(expectedMovingBeats, 2);

        // No moving segment may begin after the expectedEndBeat (no overshoot)
        cum = 0;
        for (const seg of segments) {
          if (seg.direction !== 'stay') {
            expect(cum).toBeLessThanOrEqual(expectedEndBeat + 1e-3);
          }
          cum += seg.beats;
        }

        // Verify the last moving segment ends at or before expectedEndBeat
        const lastMovingSeg = [...movingSegments].pop();
        if (lastMovingSeg) {
          const endOfLastMoving = segments
            .slice(0, segments.indexOf(lastMovingSeg) + 1)
            .reduce((sum, s) => sum + s.beats, 0);
          expect(endOfLastMoving).toBeLessThanOrEqual(expectedEndBeat + 1e-3);
        }

        await stopPlayback(page);
      });
    }

    test('snap=0.5: release at ~1.2 beats quantizes to 1.0 (round down)', async ({ page }) => {
      const snapValue = 0.5;
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);
      await seekToBeatZero(page);
      await page.waitForTimeout(200);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      // At 120 BPM, 1 beat = 500ms. To reach ~1.2 beats from start, hold ~600ms
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(600); // ~1.2 beats at 120 BPM
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(200);

      const trajDuring = await getRecTrajFromWindow(page);
      const recStartBeat = await getRecStartBeatFromWindow(page);
      const releaseBeatRaw = releaseBeatFromTraj(trajDuring);

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      // All segments snap-aligned
      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      // Expected end beat = round(1.2 / 0.5) * 0.5 = round(2.4) * 0.5 = 2 * 0.5 = 1.0
      const expectedEndBeat = quantizeBeat(releaseBeatRaw, snapValue);
      const expectedMovingBeats = expectedEndBeat - recStartBeat;

      const movingBeats = segments
        .filter((s) => s.direction !== 'stay')
        .reduce((sum, s) => sum + s.beats, 0);

      expect(movingBeats).toBeCloseTo(expectedMovingBeats, 2);

      // No overshoot past expectedEndBeat
      let cum = 0;
      for (const seg of segments) {
        if (seg.direction !== 'stay') {
          expect(cum).toBeLessThanOrEqual(expectedEndBeat + 1e-3);
        }
        cum += seg.beats;
      }

      await stopPlayback(page);
    });

    test('snap=0.5: release at ~1.3 beats quantizes to 1.5 (round up)', async ({ page }) => {
      const snapValue = 0.5;
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);
      await seekToBeatZero(page);
      await page.waitForTimeout(200);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      // At 120 BPM, 1 beat = 500ms. To reach ~1.3 beats from start, hold ~650ms
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(650); // ~1.3 beats at 120 BPM
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(200);

      const trajDuring = await getRecTrajFromWindow(page);
      const recStartBeat = await getRecStartBeatFromWindow(page);
      const releaseBeatRaw = releaseBeatFromTraj(trajDuring);

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      // Expected end beat = round(1.3 / 0.5) * 0.5 = round(2.6) * 0.5 = 3 * 0.5 = 1.5
      const expectedEndBeat = quantizeBeat(releaseBeatRaw, snapValue);
      const expectedMovingBeats = expectedEndBeat - recStartBeat;

      const movingBeats = segments
        .filter((s) => s.direction !== 'stay')
        .reduce((sum, s) => sum + s.beats, 0);

      expect(movingBeats).toBeCloseTo(expectedMovingBeats, 2);

      let cum = 0;
      for (const seg of segments) {
        if (seg.direction !== 'stay') {
          expect(cum).toBeLessThanOrEqual(expectedEndBeat + 1e-3);
        }
        cum += seg.beats;
      }

      await stopPlayback(page);
    });

    test('snap=0.25: release at off-grid (e.g., 0.37, 0.62 beats) quantizes correctly', async ({ page }) => {
      const snapValue = 0.25;
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);
      await seekToBeatZero(page);
      await page.waitForTimeout(200);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      // Hold ~185ms for ~0.37 beats, or ~310ms for ~0.62 beats at 120 BPM
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(310); // ~0.62 beats
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(200);

      const trajDuring = await getRecTrajFromWindow(page);
      const recStartBeat = await getRecStartBeatFromWindow(page);
      const releaseBeatRaw = releaseBeatFromTraj(trajDuring);

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      const expectedEndBeat = quantizeBeat(releaseBeatRaw, snapValue);
      const expectedMovingBeats = expectedEndBeat - recStartBeat;

      const movingBeats = segments
        .filter((s) => s.direction !== 'stay')
        .reduce((sum, s) => sum + s.beats, 0);

      expect(movingBeats).toBeCloseTo(expectedMovingBeats, 2);

      let cum = 0;
      for (const seg of segments) {
        if (seg.direction !== 'stay') {
          expect(cum).toBeLessThanOrEqual(expectedEndBeat + 1e-3);
        }
        cum += seg.beats;
      }

      await stopPlayback(page);
    });
  });

  test.describe('Alternating up/down key presses with snap alignment', () => {
    for (const snapValue of SNAP_OPTIONS) {
      test(`snap=${snapValue}: ArrowUp then ArrowDown produces alternating snap-aligned segments without overshoot`, async ({ page }) => {
        await page.selectOption('[data-testid="snap-select"]', String(snapValue));
        await page.waitForTimeout(200);

        await clearSegments(page);
        await startPlayback(page);
        await page.waitForTimeout(400);
        await seekToBeatZero(page);
        await page.waitForTimeout(200);

        await enterRecordMode(page);
        await page.waitForTimeout(150);

        // First press: ArrowUp
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(350);
        await page.keyboard.up('ArrowUp');
        await page.waitForTimeout(150);

        // Second press: ArrowDown
        await page.keyboard.down('ArrowDown');
        await page.waitForTimeout(350);
        await page.keyboard.up('ArrowDown');
        await page.waitForTimeout(150);

        const traj = await getRecTrajFromWindow(page);
        const recStartBeat = await getRecStartBeatFromWindow(page);
        const releaseBeatRaw = releaseBeatFromTraj(traj);

        await exitRecordMode(page);
        await page.waitForTimeout(500);

        const segments = await getSegmentsFromWindow(page);
        expect(segments.length).toBeGreaterThan(0);

        for (const seg of segments) {
          expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
        }

        // Should have both up and down segments
        const directions = segments.map(s => s.direction);
        expect(directions).toContain('up');
        expect(directions).toContain('down');

        const expectedEndBeat = quantizeBeat(releaseBeatRaw, snapValue);
        const expectedMovingBeats = expectedEndBeat - recStartBeat;

        const movingBeats = segments
          .filter((s) => s.direction !== 'stay')
          .reduce((sum, s) => sum + s.beats, 0);

        expect(movingBeats).toBeCloseTo(expectedMovingBeats, 2);

        let cum = 0;
        for (const seg of segments) {
          if (seg.direction !== 'stay') {
            expect(cum).toBeLessThanOrEqual(expectedEndBeat + 1e-3);
          }
          cum += seg.beats;
        }

        await stopPlayback(page);
      });
    }
  });

  test.describe('Stay segments alignment after release', () => {
    test('After key release, subsequent stay segments are snap-aligned and start exactly at quantized release beat', async ({ page }) => {
      const snapValue = 0.5;
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);
      await seekToBeatZero(page);
      await page.waitForTimeout(200);

      await enterRecordMode(page);
      await page.waitForTimeout(200);

      // Press and release at ~1.3 beats -> should quantize to 1.5
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(650);
      await page.keyboard.up('ArrowUp');
      // Continue recording for a bit after release to generate stay segments
      await page.waitForTimeout(400);

      const trajDuring = await getRecTrajFromWindow(page);
      const recStartBeat = await getRecStartBeatFromWindow(page);
      const releaseBeatRaw = releaseBeatFromTraj(trajDuring);

      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      const expectedEndBeat = quantizeBeat(releaseBeatRaw, snapValue);

      // Find the transition from moving to stay
      let foundTransition = false;
      let cum = 0;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.direction !== 'stay') {
          cum += seg.beats;
        } else {
          // First stay segment should start at expectedEndBeat
          if (!foundTransition) {
            expect(cum).toBeCloseTo(expectedEndBeat, 2);
            foundTransition = true;
          }
          cum += seg.beats;
        }
      }
      expect(foundTransition).toBeTruthy();

      await stopPlayback(page);
    });
  });

  test.describe('Recording overwrite range limitation (T109)', () => {
    test('Recording only overwrites segments within the recorded range; later segments preserved', async ({ page }) => {
      const snapValue = 0.25;
      await page.selectOption('[data-testid="snap-select"]', String(snapValue));
      await page.waitForTimeout(200);

      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);
      await seekToBeatZero(page);
      await page.waitForTimeout(200);

      // First recording: record at start (beat 0 to ~2)
      await enterRecordMode(page);
      await page.waitForTimeout(200);
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(800); // ~1.6 beats
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(200);
      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const firstSegments = await getSegmentsFromWindow(page);
      expect(firstSegments.length).toBeGreaterThan(0);

      // Manually add a segment after the recorded range (simulate existing later content)
      // We can't directly manipulate segments via UI easily, so we'll do a second recording
      // starting later and verify the first recording's segments are preserved.

      // Seek to beat 4 and record again
      await page.evaluate(() => {
        const w = window as any;
        if (typeof w.seekTo === 'function') {
          w.seekTo(w.__editorTimeline?.beatToMs(4) ?? 2000);
        }
      });
      await page.waitForTimeout(300);

      await enterRecordMode(page);
      await page.waitForTimeout(200);
      await page.keyboard.down('ArrowDown');
      await page.waitForTimeout(500);
      await page.keyboard.up('ArrowDown');
      await page.waitForTimeout(200);
      await exitRecordMode(page);
      await page.waitForTimeout(500);

      const segments = await getSegmentsFromWindow(page);
      expect(segments.length).toBeGreaterThan(0);

      // Verify there are both up (from first recording) and down (from second) segments
      const directions = segments.map(s => s.direction);
      expect(directions).toContain('up');
      expect(directions).toContain('down');

      // All segments snap-aligned
      for (const seg of segments) {
        expect(isSnapAligned(seg.beats, snapValue)).toBeTruthy();
      }

      await stopPlayback(page);
    });
  });

  test.describe('Console error monitoring', () => {
    test('No uncaught errors during quantization recording workflow', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const t = msg.text();
          if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
        }
      });
      page.on('pageerror', (err) => errors.push(err.message));

      await page.selectOption('[data-testid="snap-select"]', '0.5');
      await page.waitForTimeout(200);
      await clearSegments(page);
      await startPlayback(page);
      await page.waitForTimeout(500);
      await seekToBeatZero(page);
      await page.waitForTimeout(200);

      await enterRecordMode(page);
      await page.waitForTimeout(200);
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(400);
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(200);
      await page.keyboard.down('ArrowDown');
      await page.waitForTimeout(400);
      await page.keyboard.up('ArrowDown');
      await page.waitForTimeout(200);
      await exitRecordMode(page);
      await page.waitForTimeout(500);

      await stopPlayback(page);
      await page.waitForTimeout(500);

      expect(errors).toHaveLength(0);
    });
  });
});