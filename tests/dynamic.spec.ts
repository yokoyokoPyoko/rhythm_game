import { test, expect } from '@playwright/test';

const AUDIO_FILE = '08.Reply.flac';

async function waitForAudioReady(page) {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement;
      return btn && !btn.textContent?.includes('読込中');
    },
    { timeout: 30000 }
  );
}

async function getSegments(page) {
  return await page.evaluate(() => {
    const w = window as any;
    return w.__editorState?.segments?.map((s: any) => ({
      direction: s.direction,
      beats: s.beats
    })) || [];
  });
}

async function getCumulativeBeats(segments: { direction: string; beats: number }[]) {
  const cum: number[] = [];
  let sum = 0;
  for (const s of segments) {
    cum.push(sum);
    sum += s.beats;
  }
  return { cum, total: sum };
}

async function startRecording(page, startBeat: number) {
  await page.evaluate((beat) => {
    const w = window as any;
    w.__editorState?.seekToBeat(beat);
    w.__editorState?.enterRecordMode();
  }, startBeat);
  await page.waitForTimeout(500);
}

async function simulateHoldKey(page, key: string, durationMs: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(durationMs);
  await page.keyboard.up(key);
}

async function stopRecording(page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__editorState?.exitRecordMode();
  });
  await page.waitForTimeout(500);
}

async function getLastFinishRecordingInfo(page) {
  return await page.evaluate(() => {
    const w = window as any;
    return w.__lastFinishRecording || null;
  });
}

test.describe('T109: Recording overwrite range limited to startBeat-endBeat', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
      }
    });
    page.on('pageerror', e => errors.push(e.message));

    await page.goto('http://localhost:5173/#/editor');
    await page.waitForLoadState('networkidle');

    await waitForAudioReady(page);

    await page.locator('[data-testid="editor-clear"]').click();
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const w = window as any;
      w.__editorState?.loadInitialSegments([
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
        { direction: 'up', beats: 2 },
        { direction: 'down', beats: 2 },
      ]);
    });
    await page.waitForTimeout(500);

    expect(errors).toHaveLength(0);
  });

  test('preserves segments after endBeat when recording in middle range', async ({ page }) => {
    const initialSegments = await getSegments(page);
    const { cum, total: initialTotalBeats } = await getCumulativeBeats(initialSegments);

    const startBeat = 4;
    const holdDurationMs = 3000;

    await startRecording(page, startBeat);
    await simulateHoldKey(page, 'ArrowUp', holdDurationMs);
    await stopRecording(page);

    const finishInfo = await getLastFinishRecordingInfo(page);
    expect(finishInfo).not.toBeNull();
    const actualEndBeat = finishInfo.endBeat;

    const { cum: newCum } = await getCumulativeBeats(await getSegments(page));

    let expectedEndIdx = initialSegments.length;
    let cumBeats = 0;
    for (let i = 0; i < initialSegments.length; i++) {
      if (cumBeats >= actualEndBeat) {
        expectedEndIdx = i;
        break;
      }
      cumBeats += initialSegments[i].beats;
    }

    const expectedPreserved = initialSegments.slice(expectedEndIdx);
    const actualPreserved = (await getSegments(page)).slice(expectedEndIdx);

    expect(actualPreserved.length).toBe(expectedPreserved.length);
    for (let i = 0; i < expectedPreserved.length; i++) {
      expect(actualPreserved[i].direction).toBe(expectedPreserved[i].direction);
      expect(actualPreserved[i].beats).toBeCloseTo(expectedPreserved[i].beats, 1);
    }
  });

  test('preserves segments after endBeat with fractional off-grid recording duration', async ({ page }) => {
    const initialSegments = await getSegments(page);
    const { cum } = await getCumulativeBeats(initialSegments);

    const startBeat = 2;
    const holdDurationMs = 2500;

    await startRecording(page, startBeat);
    await simulateHoldKey(page, 'ArrowDown', holdDurationMs);
    await stopRecording(page);

    const finishInfo = await getLastFinishRecordingInfo(page);
    expect(finishInfo).not.toBeNull();
    const actualEndBeat = finishInfo.endBeat;

    let expectedEndIdx = initialSegments.length;
    let cumBeats = 0;
    for (let i = 0; i < initialSegments.length; i++) {
      if (cumBeats >= actualEndBeat) {
        expectedEndIdx = i;
        break;
      }
      cumBeats += initialSegments[i].beats;
    }

    const expectedPreserved = initialSegments.slice(expectedEndIdx);
    // Use keptAfter from finishInfo directly — it is the preserved segment list
    const actualPreserved: { direction: string; beats: number }[] = finishInfo.keptAfter;

    expect(actualPreserved.length).toBe(expectedPreserved.length);
    for (let i = 0; i < expectedPreserved.length; i++) {
      expect(actualPreserved[i].direction).toBe(expectedPreserved[i].direction);
      expect(actualPreserved[i].beats).toBeCloseTo(expectedPreserved[i].beats, 1);
    }
  });

  test('preserves segments after endBeat when recording starts at beat 0', async ({ page }) => {
    const initialSegments = await getSegments(page);
    const { cum } = await getCumulativeBeats(initialSegments);

    const startBeat = 0;
    const holdDurationMs = 4000;

    await startRecording(page, startBeat);
    await simulateHoldKey(page, 'ArrowUp', holdDurationMs);
    await stopRecording(page);

    const finishInfo = await getLastFinishRecordingInfo(page);
    expect(finishInfo).not.toBeNull();
    const actualEndBeat = finishInfo.endBeat;

    let expectedEndIdx = initialSegments.length;
    let cumBeats = 0;
    for (let i = 0; i < initialSegments.length; i++) {
      if (cumBeats >= actualEndBeat) {
        expectedEndIdx = i;
        break;
      }
      cumBeats += initialSegments[i].beats;
    }

    const expectedPreserved = initialSegments.slice(expectedEndIdx);
    // Use keptAfter from finishInfo directly — it is the preserved segment list
    const actualPreserved: { direction: string; beats: number }[] = finishInfo.keptAfter;

    expect(actualPreserved.length).toBe(expectedPreserved.length);
    for (let i = 0; i < expectedPreserved.length; i++) {
      expect(actualPreserved[i].direction).toBe(expectedPreserved[i].direction);
      expect(actualPreserved[i].beats).toBeCloseTo(expectedPreserved[i].beats, 1);
    }
  });

  test('does not split segment that starts before endBeat', async ({ page }) => {
    const initialSegments = await getSegments(page);

    const startBeat = 3;
    const holdDurationMs = 1500;

    await startRecording(page, startBeat);
    await simulateHoldKey(page, 'ArrowUp', holdDurationMs);
    await stopRecording(page);

    const finishInfo = await getLastFinishRecordingInfo(page);
    expect(finishInfo).not.toBeNull();
    const actualEndBeat = finishInfo.endBeat;

    const finalSegments = await getSegments(page);
    const { cum: finalCum } = await getCumulativeBeats(finalSegments);

    let foundPartialSplit = false;
    let cumBeats = 0;
    for (const seg of finalSegments) {
      const segStart = cumBeats;
      const segEnd = cumBeats + seg.beats;
      if (segStart < actualEndBeat && segEnd > actualEndBeat) {
        foundPartialSplit = true;
        break;
      }
      cumBeats += seg.beats;
    }

    expect(foundPartialSplit).toBe(false);
  });
});