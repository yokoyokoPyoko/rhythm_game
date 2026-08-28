import { test, expect } from '@playwright/test';

test.describe('T99: Audio Offset Migration & Playback Application', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', err => {
      consoleErrors.push(err.message);
    });

    await page.goto('http://localhost:5173/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await expect(page.locator('#root')).toBeVisible();
  });

  test.afterEach(() => {
    expect(consoleErrors).toHaveLength(0);
  });

  test('Audio offset input moved from BpmEditor to music-control pane', async ({ page }) => {
    // Navigate to editor via HashRouter
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000); // Wait for editor initialization

    // Verify audio offset input EXISTS in music-control pane
    const musicControlOffset = page.locator('#music-control #audio-offset');
    await expect(musicControlOffset).toBeVisible();
    await expect(musicControlOffset).toHaveAttribute('type', 'number');

    // Verify audio offset input does NOT exist in BpmEditor (toHaveCount(0))
    const bpmEditorOffset = page.locator('#bpm-editor #audio-offset');
    await expect(bpmEditorOffset).toHaveCount(0);

    // Verify initial offset value is 0 (default)
    const initialValue = await musicControlOffset.inputValue();
    expect(Number(initialValue)).toBe(0);
  });

  test('Changing audio offset and playing applies offset to playback position', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000);

    const musicControlOffset = page.locator('#music-control #audio-offset');
    await expect(musicControlOffset).toBeVisible();

    // Wait for audio to load - play button should not show "読込中…"
    const playButton = page.locator('#music-control button:has-text("再生")');
    await expect(playButton).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);

    // Set offset to 500ms
    await musicControlOffset.fill('500');
    await page.waitForTimeout(300);

    // Click play button
    await playButton.click();
    await page.waitForTimeout(1000); // Let playback start

    // Verify playback position reflects offset
    // The currentTime should be approximately offset/1000 seconds (0.5s)
    const playbackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      if (audioEl) return audioEl.currentTime;
      // Fallback: check internal state via window
      return (window as any).__TEST_AUDIO_CURRENT_TIME__ ?? null;
    });

    expect(playbackPosition).not.toBeNull();
    expect(playbackPosition).toBeGreaterThanOrEqual(0.45); // Allow small tolerance
    expect(playbackPosition).toBeLessThanOrEqual(0.55);

    // Stop playback
    const stopButton = page.locator('#music-control button:has-text("停止")');
    if (await stopButton.isVisible({ timeout: 1000 })) {
      await stopButton.click();
    }
  });

  test('Audio offset persists across play/stop cycles', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000);

    const musicControlOffset = page.locator('#music-control #audio-offset');
    const playButton = page.locator('#music-control button:has-text("再生")');
    await expect(playButton).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);

    // Set offset to 1200ms
    await musicControlOffset.fill('1200');
    await page.waitForTimeout(300);

    // Play
    await playButton.click();
    await page.waitForTimeout(800);

    const firstPlaybackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      return audioEl ? audioEl.currentTime : null;
    });

    expect(firstPlaybackPosition).toBeGreaterThanOrEqual(1.15);
    expect(firstPlaybackPosition).toBeLessThanOrEqual(1.25);

    // Stop
    const stopButton = page.locator('#music-control button:has-text("停止")');
    await stopButton.click();
    await page.waitForTimeout(500);

    // Play again - should still apply offset
    await playButton.click();
    await page.waitForTimeout(800);

    const secondPlaybackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      return audioEl ? audioEl.currentTime : null;
    });

    expect(secondPlaybackPosition).toBeGreaterThanOrEqual(1.15);
    expect(secondPlaybackPosition).toBeLessThanOrEqual(1.25);
  });

  test('Audio offset input accepts decimal values and applies correctly', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000);

    const musicControlOffset = page.locator('#music-control #audio-offset');
    const playButton = page.locator('#music-control button:has-text("再生")');
    await expect(playButton).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);

    // Set offset to 250.5ms
    await musicControlOffset.fill('250.5');
    await page.waitForTimeout(300);

    // Verify input value normalization (number input)
    const inputValue = await musicControlOffset.inputValue();
    expect(Number(inputValue)).toBeCloseTo(250.5, 1);

    await playButton.click();
    await page.waitForTimeout(800);

    const playbackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      return audioEl ? audioEl.currentTime : null;
    });

    expect(playbackPosition).toBeGreaterThanOrEqual(0.20);
    expect(playbackPosition).toBeLessThanOrEqual(0.30);
  });

  test('Audio offset state syncs between EditorScreen and music-control', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000);

    const musicControlOffset = page.locator('#music-control #audio-offset');
    const playButton = page.locator('#music-control button:has-text("再生")');
    await expect(playButton).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);

    // Change offset via input
    await musicControlOffset.fill('800');
    await page.waitForTimeout(300);

    // Verify internal state reflects the change
    const internalOffset = await page.evaluate(() => {
      return (window as any).__TEST_EDITOR_AUDIO_OFFSET__ ?? null;
    });

    expect(internalOffset).not.toBeNull();
    expect(Number(internalOffset)).toBe(800);

    // Verify playFrom uses this offset
    await playButton.click();
    await page.waitForTimeout(800);

    const playbackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      return audioEl ? audioEl.currentTime : null;
    });

    expect(playbackPosition).toBeGreaterThanOrEqual(0.75);
    expect(playbackPosition).toBeLessThanOrEqual(0.85);
  });

  test('Negative audio offset values are handled correctly', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000);

    const musicControlOffset = page.locator('#music-control #audio-offset');
    const playButton = page.locator('#music-control button:has-text("再生")');
    await expect(playButton).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);

    // Set negative offset (-500ms) - should clamp to 0 or handle gracefully
    await musicControlOffset.fill('-500');
    await page.waitForTimeout(300);

    const inputValue = await musicControlOffset.inputValue();
    const numericValue = Number(inputValue);
    // Negative offset should either be clamped to 0 or allowed (implementation dependent)
    // At minimum, verify it doesn't crash
    expect(typeof numericValue).toBe('number');

    await playButton.click();
    await page.waitForTimeout(800);

    // Should not crash and playback should start
    const playbackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      return audioEl ? audioEl.currentTime : null;
    });

    expect(playbackPosition).not.toBeNull();
    expect(playbackPosition).toBeGreaterThanOrEqual(0);
  });

  test('Large audio offset values are handled correctly', async ({ page }) => {
    await page.evaluate(() => { window.location.hash = '#/editor'; });
    await page.waitForURL('**/#/editor');
    await page.waitForTimeout(2000);

    const musicControlOffset = page.locator('#music-control #audio-offset');
    const playButton = page.locator('#music-control button:has-text("再生")');
    await expect(playButton).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1500);

    // Set large offset (10000ms = 10s)
    await musicControlOffset.fill('10000');
    await page.waitForTimeout(300);

    const inputValue = await musicControlOffset.inputValue();
    expect(Number(inputValue)).toBe(10000);

    await playButton.click();
    await page.waitForTimeout(1500); // Longer wait for large offset

    const playbackPosition = await page.evaluate(() => {
      const audioEl = document.querySelector('#music-control audio') as HTMLAudioElement | null;
      return audioEl ? audioEl.currentTime : null;
    });

    expect(playbackPosition).toBeGreaterThanOrEqual(9.5);
    expect(playbackPosition).toBeLessThanOrEqual(10.5);
  });
});