import { test, expect } from '@playwright/test';

const FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';

test.describe('T106: Local Audio File Loading (File Input & Drag-and-Drop)', () => {
  let errors: string[] = [];
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors = [];
    pageErrors = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) {
          errors.push(`console: ${t}`);
        }
      }
    });

    page.on('pageerror', (err) => {
      if (/TypeError|ReferenceError|Uncaught/.test(err.message)) {
        pageErrors.push(`pageerror: ${err.message}`);
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.evaluate(() => {
      window.location.hash = '#/editor';
    });
    await page.waitForSelector('[data-testid="editor-dropzone"]', { timeout: 10000 });
    // Grant audio autoplay activation with a real user gesture.
    await page.locator('.editor-header').click();
    await page.waitForTimeout(300);
  });

  test.afterEach(() => {
    expect(errors, 'Console errors detected').toHaveLength(0);
    expect(pageErrors, 'Page errors detected').toHaveLength(0);
  });

  test('File input: loads audio, updates title, enables playback and timeline', async ({ page }) => {
    const fileInput = page.locator('[data-testid="audio-file-input"]');
    const playBtn = page.locator('[data-testid="editor-play"]');
    const titleInput = page.locator('#chart-title');
    const slider = page.locator('.editor-slider').first();

    // --- Step 1: Capture Initial State ---
    const initialTitle = await titleInput.inputValue();
    const initialPlayBtnText = await playBtn.textContent();
    const initialSliderDisabled = await slider.getAttribute('disabled');

    expect(initialTitle).toBe('Reply');
    expect(initialPlayBtnText).toBe('読込・再生');
    expect(initialSliderDisabled).not.toBeNull();

    // --- Step 2: Perform User Interaction (File Input) ---
    await fileInput.setInputFiles(FIXTURE);

    // --- Step 3: Assert Resulting Transition (DOM observable) ---
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 30000, message: 'Play button should change from "読込中…" to "再生" after decode' }
    ).toBe('再生');

    await expect.poll(
      async () => await titleInput.inputValue(),
      { timeout: 10000, message: 'Title should update to filename without extension' }
    ).toBe('test-audio');

    await expect(slider).toBeEnabled();

    // --- Step 4: Verify Playback Works ---
    await playBtn.click();
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 5000 }
    ).toBe('停止');

    await page.waitForTimeout(600);

    const posText = await page.locator('.editor-pos-time').textContent();
    expect(posText).not.toBe('0:00.0');

    await playBtn.click();
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 5000 }
    ).toBe('再生');
  });

  test('Drag-and-drop: loads audio, updates title, enables playback and timeline', async ({ page }) => {
    const playBtn = page.locator('[data-testid="editor-play"]');
    const titleInput = page.locator('#chart-title');
    const slider = page.locator('.editor-slider').first();

    // --- Step 1: Capture Initial State ---
    const initialTitle = await titleInput.inputValue();
    const initialPlayBtnText = await playBtn.textContent();
    const initialSliderDisabled = await slider.getAttribute('disabled');

    expect(initialTitle).toBe('Reply');
    expect(initialPlayBtnText).toBe('読込・再生');
    expect(initialSliderDisabled).not.toBeNull();

    // --- Step 2: Perform User Interaction (Drag-and-Drop via DataTransfer) ---
    await page.evaluate(async () => {
      const res = await fetch('/rhythm_game/test-audio.wav');
      const buf = await res.arrayBuffer();
      const file = new File([buf], 'dropped.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const zone = document.querySelector('[data-testid="editor-dropzone"]') as HTMLElement;
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      zone.dispatchEvent(dropEvent);
    });

    // --- Step 3: Assert Resulting Transition ---
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 30000, message: 'Play button should change from "読込中…" to "再生" after decode' }
    ).toBe('再生');

    await expect.poll(
      async () => await titleInput.inputValue(),
      { timeout: 10000, message: 'Title should update to dropped filename without extension' }
    ).toBe('dropped');

    await expect(slider).toBeEnabled();

    // --- Step 4: Verify Playback Works After Drop ---
    await playBtn.click();
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 5000 }
    ).toBe('停止');

    await page.waitForTimeout(600);

    const posText = await page.locator('.editor-pos-time').textContent();
    expect(posText).not.toBe('0:00.0');

    await playBtn.click();
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 5000 }
    ).toBe('再生');
  });

  test('File input then drag-and-drop: second load replaces buffer and updates title', async ({ page }) => {
    const fileInput = page.locator('[data-testid="audio-file-input"]');
    const playBtn = page.locator('[data-testid="editor-play"]');
    const titleInput = page.locator('#chart-title');

    // --- Step 1: Load first file via file input ---
    await fileInput.setInputFiles(FIXTURE);

    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 30000 }
    ).toBe('再生');

    await expect(titleInput).toHaveValue('test-audio');
    const durationFirst = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="editor-play"]');
      return btn?.textContent;
    });
    expect(durationFirst).not.toBeNull();

    // --- Step 2: Perform Drag-and-Drop with different file name ---
    await page.evaluate(async () => {
      const res = await fetch('/rhythm_game/test-audio.wav');
      const buf = await res.arrayBuffer();
      const file = new File([buf], 'second-drop.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const zone = document.querySelector('[data-testid="editor-dropzone"]') as HTMLElement;
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      zone.dispatchEvent(dropEvent);
    });

    // --- Step 3: Assert title updated to second file name ---
    await expect.poll(
      async () => await titleInput.inputValue(),
      { timeout: 15000 }
    ).toBe('second-drop');
  });

  test('Audio offset is applied to playback start', async ({ page }) => {
    const fileInput = page.locator('[data-testid="audio-file-input"]');
    const playBtn = page.locator('[data-testid="editor-play"]');
    const offsetInput = page.locator('#audio-offset');

    // --- Step 1: Load audio file ---
    await fileInput.setInputFiles(FIXTURE);

    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 30000 }
    ).toBe('再生');

    // --- Step 2: Set audio offset to 500ms ---
    await offsetInput.fill('500');
    await offsetInput.press('Tab');

    expect(Number(await offsetInput.inputValue())).toBeCloseTo(500);

    // --- Step 3: Start playback and verify offset is passed to playFrom ---
    await playBtn.click();
    await expect.poll(
      async () => await playBtn.textContent(),
      { timeout: 5000 }
    ).toBe('停止');

    const offsetValue = await page.evaluate(() => (window as any).__editorPlayFromOffset ?? null);
    expect(offsetValue).toBe(500);

    await playBtn.click();
  });

  test('Invalid file type shows error and does not update state', async ({ page }) => {
    const fileInput = page.locator('[data-testid="audio-file-input"]');
    const playBtn = page.locator('[data-testid="editor-play"]');
    const titleInput = page.locator('#chart-title');
    const errorDisplay = page.locator('.editor-error');

    // --- Step 1: Capture Initial State ---
    const initialTitle = await titleInput.inputValue();
    const initialPlayBtnText = await playBtn.textContent();

    expect(initialTitle).toBe('Reply');
    expect(initialPlayBtnText).toBe('読込・再生');

    // --- Step 2: Attempt to load non-audio file ---
    await page.evaluate(async () => {
      const file = new File(['not audio'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('[data-testid="audio-file-input"]') as HTMLInputElement;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // --- Step 3: Assert error shown and state unchanged ---
    await expect.poll(
      async () => await errorDisplay.textContent(),
      { timeout: 10000, message: 'Error should appear for invalid file' }
    ).toContain('デコードに失敗');

    await expect(titleInput).toHaveValue(initialTitle);
    await expect(playBtn).toHaveText('読込・再生');
  });

  test('Dragover event is handled without error on dropzone', async ({ page }) => {
    const dropzone = page.locator('[data-testid="editor-dropzone"]');

    const initialBg = await dropzone.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(initialBg).toBeTruthy();

    // onDragOver calls e.preventDefault() and sets dropEffect; it must not throw.
    await page.evaluate(() => {
      const zone = document.querySelector('[data-testid="editor-dropzone"]') as HTMLElement;
      const dragEvent = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      });
      zone.dispatchEvent(dragEvent);
    });

    await page.waitForTimeout(100);
    await expect(dropzone).toBeVisible();

    // A subsequent real drop still works (functional confirmation).
    await page.evaluate(async () => {
      const res = await fetch('/rhythm_game/test-audio.wav');
      const buf = await res.arrayBuffer();
      const file = new File([buf], 'dropped.wav', { type: 'audio/wav' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const zone = document.querySelector('[data-testid="editor-dropzone"]') as HTMLElement;
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect.poll(async () => await page.locator('[data-testid="editor-play"]').textContent(), {
      timeout: 15000,
    }).toBe('再生');
  });
});
