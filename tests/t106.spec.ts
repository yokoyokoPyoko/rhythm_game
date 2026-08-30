import { test, expect } from '@playwright/test';

const FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';

test('T106 local audio file load via file input and drag-and-drop', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) errors.push(err.message);
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('.editor-screen', { timeout: 5000 });

  // Grant audio autoplay activation with a real click before loading.
  await page.locator('.editor-header').click();

  const fileInput = page.locator('input[data-testid="audio-file-input"]');
  await expect(fileInput).toBeVisible({ timeout: 10000 });

  const playBtn = page.locator('button[data-testid="editor-play"]');
  await expect(playBtn).toHaveText('読込・再生');

  // 1. File input -> setInputFiles with absolute path
  await fileInput.setInputFiles(FIXTURE);

  // buffer loaded -> play button changes to 再生
  await expect(playBtn).toHaveText('再生', { timeout: 15000 });
  // title reflects file name without extension
  const titleInput = page.locator('#chart-title');
  await expect(titleInput).toHaveValue('test-audio', { timeout: 5000 });

  // slider (timeline) becomes enabled once buffer is present
  const slider = page.locator('.editor-slider').first();
  await expect(slider).toBeEnabled();

  // 2. Playback works without error
  await playBtn.click();
  await expect(playBtn).toHaveText('停止', { timeout: 5000 });
  await page.waitForTimeout(400);
  const posText = await page.locator('.editor-pos-time').textContent();
  expect(posText).not.toBe('0:00.0');
  await playBtn.click();
  await expect(playBtn).toHaveText('再生', { timeout: 5000 });

  // 3. Drag-and-drop path (real file bytes via DataTransfer)
  await page.evaluate(async () => {
    const res = await fetch('/rhythm_game/test-audio.wav');
    const buf = await res.arrayBuffer();
    const file = new File([buf], 'dropped.wav', { type: 'audio/wav' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const zone = document.querySelector('[data-testid="editor-dropzone"]') as HTMLElement;
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  // After drop, title should reflect the dropped file name
  await expect(titleInput).toHaveValue('dropped', { timeout: 15000 });
  await expect(playBtn).toHaveText('再生', { timeout: 5000 });

  expect(errors).toHaveLength(0);
});
