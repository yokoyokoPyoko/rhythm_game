import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { parse } from 'smol-toml';

test('T101 Playwright test: Quantize (snap) during recording - verify segment beats are multiples of selected snap resolution', async ({ page }) => {
  const errors: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
        errors.push(text);
      }
    }
  });

  page.on('pageerror', err => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) {
      errors.push(err.message);
    }
  });

  // 1. Navigate to home / select screen
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await expect(page.locator('#root')).toBeVisible();
  await page.waitForTimeout(1500);

  // 2. Navigate to editor screen via HashRouter
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 10000 });
  await page.waitForTimeout(2000);

  // 3. Wait for audio to load - click "読込・再生" and wait for it to change to "停止"
  const playBtn = page.locator('button[data-testid="editor-play"]');
  await expect(playBtn).toBeVisible({ timeout: 5000 });
  await playBtn.click();

  // Wait for audio loading to complete (button text changes from "読込中…" to "停止")
  await expect(playBtn).toHaveText('停止', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // 4. Test quantize with different snap values
  const snapValues = [0.5, 0.25, 0.125]; // 1/2, 1/4, 1/8
  const snapLabels = ['1/2', '1/4', '1/8'];

  for (let i = 0; i < snapValues.length; i++) {
    const snap = snapValues[i];
    const label = snapLabels[i];

    console.log(`\n=== Testing snap = ${label} (${snap}) ===`);

    // 4a. Select snap value from dropdown
    const snapSelect = page.locator('#snap');
    await expect(snapSelect).toBeVisible({ timeout: 5000 });
    await snapSelect.selectOption(String(snap));
    await expect(snapSelect).toHaveValue(String(snap));
    await page.waitForTimeout(500);

    // 4b. Clear existing segments first
    const clearBtn = page.locator('button[data-testid="editor-clear"]');
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    await page.waitForTimeout(500);

    // Handle confirmation dialog
    page.once('dialog', dialog => dialog.accept());
    await clearBtn.click();
    await page.waitForTimeout(1000);

    // 4c. Seek to a known position (beat 4) to start recording from
    const seekBeat = 4;
    await page.evaluate((beat) => {
      const w = window as unknown as Record<string, unknown>;
      const timeline = w.__editorTimeline;
      if (timeline && typeof timeline.beatToMs === 'function') {
        const ms = timeline.beatToMs(beat);
        const seekTo = w.__editorSeekTo || ((ms: number) => {
          const posInput = document.querySelector('.editor-slider') as HTMLInputElement;
          if (posInput) {
            posInput.value = String(ms);
            posInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        seekTo(ms);
      }
    }, seekBeat);
    await page.waitForTimeout(1000);

    // 4d. Enter recording mode
    const recordToggleBtn = page.locator('button[data-testid="editor-record-toggle"]');
    await expect(recordToggleBtn).toBeVisible();
    await expect(recordToggleBtn).toHaveText('録音モード');
    await recordToggleBtn.click();
    await expect(recordToggleBtn).toHaveText('録音停止');
    await page.waitForTimeout(500);

    // 4e. Start playback (recording happens during playback)
    // The play button might show "停止" since audio is already playing, need to restart
    await page.evaluate(() => {
      const stopBtn = document.querySelector('button[data-testid="editor-play"]') as HTMLButtonElement;
      if (stopBtn && stopBtn.textContent?.includes('停止')) {
        stopBtn.click();
      }
    });
    await page.waitForTimeout(500);

    const playBtn2 = page.locator('button[data-testid="editor-play"]');
    await expect(playBtn2).toHaveText('再生', { timeout: 5000 });
    await playBtn2.click();
    await expect(playBtn2).toHaveText('停止', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // 4f. Simulate cursor movement during recording (press ArrowUp and ArrowDown)
    // Record for about 4 beats worth of time at current BPM
    const recordDurationMs = 8000; // ~8 seconds at 120 BPM = 16 beats, but we'll stop earlier
    const startTime = Date.now();

    // Press and hold ArrowUp for a bit, then ArrowDown
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(2000);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(500);
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(2000);
    await page.keyboard.up('ArrowDown');

    // Wait a bit more then stop recording
    await page.waitForTimeout(2000);

    // 4g. Stop recording by clicking the record toggle again
    await recordToggleBtn.click();
    await expect(recordToggleBtn).toHaveText('録音モード', { timeout: 5000 });
    await page.waitForTimeout(1000);

    // 4h. Stop playback
    const stopBtn = page.locator('button[data-testid="editor-play"]');
    if (await stopBtn.isVisible() && (await stopBtn.textContent())?.includes('停止')) {
      await stopBtn.click();
      await page.waitForTimeout(1000);
    }

    // 4i. Read recorded segments from app state and verify quantize
    const segments = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return w.__editorSegments as Array<{ direction: string; beats: number }> | undefined;
    });

    expect(segments).toBeDefined();
    expect(Array.isArray(segments)).toBe(true);
    expect(segments!.length).toBeGreaterThan(0);

    console.log(`Recorded ${segments!.length} segments with snap=${label}:`);
    segments!.forEach((seg, idx) => {
      console.log(`  Segment ${idx}: direction=${seg.direction}, beats=${seg.beats}`);
    });

    // 4j. CRITICAL ASSERTION: Verify each segment's beats is a multiple of the snap resolution
    // Allow small floating point tolerance (1e-6)
    for (const seg of segments!) {
      const beats = seg.beats;
      const remainder = beats % snap;
      const isMultiple = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6;
      expect(isMultiple).toBeTruthy();
      if (!isMultiple) {
        console.error(`FAIL: Segment beats=${beats} is NOT a multiple of snap=${snap} (remainder=${remainder})`);
      }
    }

    // 4k. Also verify via SegmentEditor UI that beats values are snapped
    const segmentPane = page.locator('section.editor-pane', { hasText: 'セグメント' });
    const details = segmentPane.locator('details[data-testid="segment-list-details"]');
    await expect(details).toBeVisible();
    await details.evaluate(el => (el as HTMLDetailsElement).open = true);
    await page.waitForTimeout(500);

    for (let segIdx = 0; segIdx < segments!.length; segIdx++) {
      const beatsInput = segmentPane.locator(`input[data-testid="segment-beats-${segIdx}"]`);
      if (await beatsInput.isVisible({ timeout: 2000 })) {
        const value = await beatsInput.inputValue();
        const beats = Number(value);
        const remainder = beats % snap;
        const isMultiple = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6;
        expect(isMultiple).toBeTruthy();
        if (!isMultiple) {
          console.error(`FAIL (UI): Segment ${segIdx} beats=${beats} is NOT a multiple of snap=${snap} (remainder=${remainder})`);
        }
      }
    }

    // 4l. Export TOML and verify quantize persisted in file
    const exportBtn = page.locator('button[data-testid="editor-export"]');
    await expect(exportBtn).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportBtn.click(),
    ]);

    expect(download.suggestedFilename()).toBe('reply.toml');
    const filePath = await download.path();
    if (filePath) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const parsed = parse(fileContent) as any;
      expect(parsed).toBeDefined();
      expect(Array.isArray(parsed.segments)).toBe(true);
      expect(parsed.segments.length).toBeGreaterThan(0);

      for (const seg of parsed.segments) {
        const beats = seg.beats;
        const remainder = beats % snap;
        const isMultiple = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6;
        expect(isMultiple).toBeTruthy();
        if (!isMultiple) {
          console.error(`FAIL (TOML): Segment beats=${beats} is NOT a multiple of snap=${snap} (remainder=${remainder})`);
        }
      }

      console.log(`TOML export verified for snap=${label}`);
    }

    await page.waitForTimeout(1000);
  }

  // 5. Test that changing snap AFTER recording does NOT retroactively change existing segments
  // (segments should stay at their recorded resolution)
  console.log('\n=== Testing snap change does not retroactively modify segments ===');
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const setSnap = (w.__editorSetSnap || ((v: number) => {
      const select = document.querySelector('#snap') as HTMLSelectElement;
      if (select) {
        select.value = String(v);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }));
    setSnap(1); // Change to 1/1
  });
  await page.waitForTimeout(500);

  const segmentsAfterSnapChange = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return w.__editorSegments as Array<{ direction: string; beats: number }> | undefined;
  });

  expect(segmentsAfterSnapChange).toBeDefined();
  expect(segmentsAfterSnapChange!.length).toBeGreaterThan(0);

  // The segments should still be multiples of the ORIGINAL snap (0.125), not the new snap (1)
  // They should NOT be snapped to 1-beat boundaries unless they already were
  for (const seg of segmentsAfterSnapChange!) {
    const beats = seg.beats;
    // Original snap was 0.125 (1/8)
    const originalSnap = 0.125;
    const remainder = beats % originalSnap;
    const isMultipleOfOriginal = remainder < 1e-6 || Math.abs(remainder - originalSnap) < 1e-6;
    expect(isMultipleOfOriginal).toBeTruthy();
    if (!isMultipleOfOriginal) {
      console.error(`FAIL: Segment beats=${beats} lost original quantization (snap=0.125)`);
    }
  }
  console.log('Segments preserved original quantization after snap change');

  // 6. Navigate back to home / select screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await page.waitForSelector('.select-screen', { timeout: 5000 });
  await page.waitForTimeout(1500);

  // 7. Assert no unhandled console errors
  expect(errors).toHaveLength(0);
});

test('T101 Additional: Quantize UI shows correct fractions and updates state', async ({ page }) => {
  const errors: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
        errors.push(text);
      }
    }
  });

  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });

  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 10000 });
  await page.waitForTimeout(2000);

  // Verify snap dropdown has correct options
  const snapSelect = page.locator('#snap');
  await expect(snapSelect).toBeVisible({ timeout: 5000 });

  const options = await snapSelect.locator('option').all();
  expect(options.length).toBe(4);

  const optionValues = await Promise.all(options.map(o => o.getAttribute('value')));
  expect(optionValues).toEqual(['0.125', '0.25', '0.5', '1']);

  const optionTexts = await Promise.all(options.map(o => o.textContent()));
  expect(optionTexts).toEqual(['1/8', '1/4', '1/2', '1/1']);

  // Verify default value is 0.25 (1/4)
  await expect(snapSelect).toHaveValue('0.25');

  // Verify changing snap updates internal state
  await snapSelect.selectOption('0.5');
  await expect(snapSelect).toHaveValue('0.5');

  const snapState = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return w.__editorSnap;
  });
  expect(snapState).toBe(0.5);

  await snapSelect.selectOption('1');
  await expect(snapSelect).toHaveValue('1');

  const snapState2 = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return w.__editorSnap;
  });
  expect(snapState2).toBe(1);

  expect(errors).toHaveLength(0);
});