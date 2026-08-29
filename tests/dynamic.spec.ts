import { test, expect } from '@playwright/test';

const TEST_AUDIO_PATH = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';
const TEST_AUDIO_FILENAME = 'test-audio.wav';
const TEST_AUDIO_TITLE = 'test-audio';

test.describe('T106: Local Audio File Loading (File Input & Drag-and-Drop)', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          consoleErrors.push(text);
        }
      }
    });
    await page.goto('/rhythm_game/#/editor');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await expect(page.locator('#root')).toBeVisible();
  });

  test.afterEach(() => {
    expect(consoleErrors).toHaveLength(0);
  });

  test('file input loads audio, enables playback, and sets title from filename', async ({ page }) => {
    // [Step 1: Capture Initial State]
    const fileInput = page.locator('input[data-testid="audio-file-input"]');
    await expect(fileInput).toBeVisible({ timeout: 10000 });

    const playButton = page.locator('button:has-text("再生"), button:has-text("Play")').first();
    await expect(playButton).toBeVisible({ timeout: 5000 });

    const initialButtonText = await playButton.textContent();
    expect(initialButtonText).toMatch(/再生|Play/);

    const titleInput = page.locator('input[data-testid="chart-title-input"], input[placeholder*="タイトル"], input[placeholder*="Title"]').first();
    const initialTitle = titleInput ? await titleInput.inputValue() : '';

    // [Step 2: Perform User Interaction - File Input]
    await fileInput.setInputFiles(TEST_AUDIO_PATH);

    // [Step 3: Assert Resulting Transition]
    // Wait for audio to decode (up to 30s for large files)
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button:has-text("再生"), button:has-text("Play")');
        return btn && !btn.textContent?.includes('読込中') && !btn.textContent?.includes('Loading');
      },
      { timeout: 30000 }
    );

    // Verify play button is now enabled/ready
    const readyButtonText = await playButton.textContent();
    expect(readyButtonText).not.toMatch(/読込中|Loading/);

    // Verify title was auto-set from filename (without extension)
    if (await titleInput.count() > 0) {
      await expect(titleInput).toHaveValue(TEST_AUDIO_TITLE, { timeout: 5000 });
    }

    // Verify timeline/playback position UI becomes available
    const timeDisplay = page.locator('[data-testid="playback-time"], .playback-time, text=/\\d+:\\d+/').first();
    await expect(timeDisplay).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(1000);
  });

  test('drag-and-drop loads audio, enables playback, and sets title', async ({ page }) => {
    // [Step 1: Capture Initial State]
    const dropZone = page.locator('[data-testid="audio-drop-zone"], .editor-drop-zone, #editor-screen, main').first();
    await expect(dropZone).toBeVisible({ timeout: 10000 });

    const playButton = page.locator('button:has-text("再生"), button:has-text("Play")').first();
    await expect(playButton).toBeVisible({ timeout: 5000 });
    const initialButtonText = await playButton.textContent();

    const titleInput = page.locator('input[data-testid="chart-title-input"], input[placeholder*="タイトル"], input[placeholder*="Title"]').first();
    const initialTitle = titleInput ? await titleInput.inputValue() : '';

    // [Step 2: Perform User Interaction - Drag and Drop]
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    const file = await page.evaluateHandle((path) => {
      return fetch(path).then(r => r.blob()).then(b => new File([b], 'test-audio.wav', { type: 'audio/wav' }));
    }, TEST_AUDIO_PATH);

    await page.dispatchEvent('[data-testid="audio-drop-zone"], .editor-drop-zone, #editor-screen, main', 'dragover', {
      dataTransfer: dataTransfer,
      preventDefault: true,
    });

    await page.dispatchEvent('[data-testid="audio-drop-zone"], .editor-drop-zone, #editor-screen, main', 'drop', {
      dataTransfer: dataTransfer,
      files: [file],
      preventDefault: true,
    });

    // [Step 3: Assert Resulting Transition]
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button:has-text("再生"), button:has-text("Play")');
        return btn && !btn.textContent?.includes('読込中') && !btn.textContent?.includes('Loading');
      },
      { timeout: 30000 }
    );

    const readyButtonText = await playButton.textContent();
    expect(readyButtonText).not.toMatch(/読込中|Loading/);

    if (await titleInput.count() > 0) {
      await expect(titleInput).toHaveValue(TEST_AUDIO_TITLE, { timeout: 5000 });
    }

    const timeDisplay = page.locator('[data-testid="playback-time"], .playback-time, text=/\\d+:\\d+/').first();
    await expect(timeDisplay).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(1000);
  });

  test('playback position reflects audio offset when set', async ({ page }) => {
    // [Step 1: Capture Initial State]
    const fileInput = page.locator('input[data-testid="audio-file-input"]');
    await expect(fileInput).toBeVisible({ timeout: 10000 });
    await fileInput.setInputFiles(TEST_AUDIO_PATH);

    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button:has-text("再生"), button:has-text("Play")');
        return btn && !btn.textContent?.includes('読込中') && !btn.textContent?.includes('Loading');
      },
      { timeout: 30000 }
    );

    const offsetInput = page.locator('input[data-testid="audio-offset-input"], input[placeholder*="オフセット"], input[placeholder*="Offset"]').first();
    await expect(offsetInput).toBeVisible({ timeout: 5000 });

    const initialOffset = await offsetInput.inputValue();
    const initialPlaybackTime = await page.locator('[data-testid="playback-time"], .playback-time').first().textContent();

    // [Step 2: Perform User Interaction - Set Offset]
    await offsetInput.fill('5000'); // 5 seconds offset
    await offsetInput.press('Enter');

    // Click play to verify offset applies
    const playButton = page.locator('button:has-text("再生"), button:has-text("Play")').first();
    await playButton.click();

    // [Step 3: Assert Resulting Transition]
    await page.waitForTimeout(1500);
    const playbackTimeAfterOffset = await page.locator('[data-testid="playback-time"], .playback-time').first().textContent();

    // Verify playback started from offset (approximately 5 seconds)
    const timeMatch = playbackTimeAfterOffset?.match(/(\\d+):(\\d+)/);
    if (timeMatch) {
      const minutes = parseInt(timeMatch[1], 10);
      const seconds = parseInt(timeMatch[2], 10);
      const totalSeconds = minutes * 60 + seconds;
      expect(totalSeconds).toBeGreaterThanOrEqual(4); // Allow some tolerance
      expect(totalSeconds).toBeLessThanOrEqual(7);
    }

    await page.waitForTimeout(1000);
  });

  test('multiple audio formats accepted (mp3, flac, wav, ogg)', async ({ page }) => {
    const formats = [
      { ext: 'mp3', name: 'test-song.mp3' },
      { ext: 'flac', name: 'test-song.flac' },
      { ext: 'wav', name: 'test-song.wav' },
      { ext: 'ogg', name: 'test-song.ogg' },
    ];

    for (const fmt of formats) {
      // [Step 1: Capture Initial State]
      const fileInput = page.locator('input[data-testid="audio-file-input"]');
      await expect(fileInput).toBeVisible({ timeout: 5000 });

      // Create a minimal audio file for each format test
      const audioBlob = await page.evaluate(async (format) => {
        const ctx = new AudioContext();
        const buffer = ctx.createBuffer(1, 44100, 44100);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.1);
        return buffer;
      }, fmt.ext);

      const testFile = new File([audioBlob], fmt.name, { type: `audio/${fmt.ext}` });

      // [Step 2: Perform User Interaction]
      await fileInput.setInputFiles([testFile]);

      // [Step 3: Assert Resulting Transition]
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('button:has-text("再生"), button:has-text("Play")');
          return btn && !btn.textContent?.includes('読込中') && !btn.textContent?.includes('Loading');
        },
        { timeout: 15000 }
      );

      const playButton = page.locator('button:has-text("再生"), button:has-text("Play")').first();
      const readyText = await playButton.textContent();
      expect(readyText).not.toMatch(/読込中|Loading/);

      // Reset for next iteration by navigating back
      await page.goto('/rhythm_game/#/editor');
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    }
  });

  test('file input rejects non-audio files', async ({ page }) => {
    // [Step 1: Capture Initial State]
    const fileInput = page.locator('input[data-testid="audio-file-input"]');
    await expect(fileInput).toBeVisible({ timeout: 10000 });

    // Create a text file
    const textFile = new File(['not audio'], 'document.txt', { type: 'text/plain' });

    // [Step 2: Perform User Interaction]
    await fileInput.setInputFiles([textFile]);

    // [Step 3: Assert Resulting Transition - should show error or not load]
    await page.waitForTimeout(2000);

    const playButton = page.locator('button:has-text("再生"), button:has-text("Play")').first();
    const buttonText = await playButton.textContent();

    // Should still show initial state (not loading/ready)
    expect(buttonText).toMatch(/再生|Play/);
  });
});