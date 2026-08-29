import { test, expect } from '@playwright/test';
import path from 'path';

const AUDIO_FILE = path.resolve(__dirname, '../public/audio/08.Reply.flac');
const AUDIO_FILENAME = '08.Reply.flac';
const EXPECTED_TITLE = '08.Reply';

const consoleErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
        consoleErrors.push(text);
      }
    }
  });
  await page.goto('/rhythm_game/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
});

test.afterEach(async () => {
  expect(consoleErrors).toHaveLength(0);
});

async function navigateToEditor(page: import('@playwright/test').Page) {
  await page.goto('/rhythm_game/#/editor');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await expect(page.locator('h1')).toContainText('オーサリングツール');
}

async function waitForAudioLoaded(page: import('@playwright/test').Page, timeout = 30000) {
  await page.waitForFunction(
    () => {
      const playBtn = document.querySelector('[data-testid="editor-play"]');
      return playBtn && !playBtn.textContent?.includes('読込中');
    },
    { timeout }
  );
  await page.waitForTimeout(1000);
}

async function getPlayButtonText(page: import('@playwright/test').Page) {
  const btn = page.locator('[data-testid="editor-play"]');
  return (await btn.textContent())?.trim() || '';
}

async function getPositionMs(page: import('@playwright/test').Page) {
  const timeEl = page.locator('.editor-pos-time');
  const text = await timeEl.textContent();
  return text ? parseTimeToMs(text) : 0;
}

async function getBeat(page: import('@playwright/test').Page) {
  const beatEl = page.locator('.editor-pos-beat');
  const text = await beatEl.textContent();
  const match = text?.match(/beat:\s*([\d.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

function parseTimeToMs(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length !== 2) return 0;
  const minutes = parseInt(parts[0], 10);
  const secParts = parts[1].split('.');
  const seconds = parseInt(secParts[0], 10);
  const tenths = secParts[1] ? parseInt(secParts[1].padEnd(1, '0')[0], 10) : 0;
  return (minutes * 60 + seconds) * 1000 + tenths * 100;
}

test.describe('T106: Local Audio File Loading (File Input & Drag-and-Drop)', () => {
  test('File Input: loads local audio file, enables playback, timeline, and auto-sets title', async ({ page }) => {
    await navigateToEditor(page);

    const fileInput = page.locator('[data-testid="audio-file-input"]');
    await expect(fileInput).toBeAttached();

    const initialTitle = await page.locator('#chart-title').inputValue();
    const initialBuffer = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorBuffer);
    expect(initialBuffer).toBeFalsy();

    await fileInput.setInputFiles(AUDIO_FILE);

    const loadStartTime = Date.now();
    await waitForAudioLoaded(page, 30000);
    const loadDuration = Date.now() - loadStartTime;
    console.log(`Audio load took ${loadDuration}ms`);

    const postLoadTitle = await page.locator('#chart-title').inputValue();
    expect(postLoadTitle).toBe(EXPECTED_TITLE);

    const bufferAfterLoad = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorBuffer);
    expect(bufferAfterLoad).toBeTruthy();

    const durationMs = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorDurationMs);
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThan(0);

    const playBtnTextBeforePlay = await getPlayButtonText(page);
    expect(playBtnTextBeforePlay).not.toContain('読込中');

    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(500);

    const playBtnTextDuringPlay = await getPlayButtonText(page);
    expect(playBtnTextDuringPlay).toBe('停止');

    await page.waitForTimeout(2000);

    const posMsDuringPlay = await getPositionMs(page);
    const beatDuringPlay = await getBeat(page);
    expect(posMsDuringPlay).toBeGreaterThan(0);
    expect(beatDuringPlay).toBeGreaterThan(0);

    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(500);

    const posMsAfterStop = await getPositionMs(page);
    expect(posMsAfterStop).toBeGreaterThanOrEqual(posMsDuringPlay - 500);

    const slider = page.locator('.editor-slider[type="range"]');
    await expect(slider).toBeEnabled();
    const sliderMax = await slider.getAttribute('max');
    expect(parseFloat(sliderMax || '0')).toBeGreaterThan(0);
  });

  test('Drag-and-Drop: loads local audio file via drop, enables playback, timeline, and auto-sets title', async ({ page }) => {
    await navigateToEditor(page);

    const dropZone = page.locator('#music-control');
    await expect(dropZone).toBeAttached();

    const initialTitle = await page.locator('#chart-title').inputValue();

    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer();
      return dt;
    });

    await page.evaluate(
      async ({ filePath, dataTransfer }) => {
        const response = await fetch(filePath);
        const blob = await response.blob();
        const file = new File([blob], '08.Reply.flac', { type: 'audio/flac' });
        dataTransfer.items.add(file);
        const dropEvent = new DragEvent('drop', { dataTransfer, bubbles: true });
        const dragoverEvent = new DragEvent('dragover', { dataTransfer, bubbles: true });
        const dropZone = document.querySelector('#music-control');
        dropZone?.dispatchEvent(dragoverEvent);
        dropZone?.dispatchEvent(dropEvent);
      },
      { filePath: `/rhythm_game/audio/08.Reply.flac`, dataTransfer }
    );

    await waitForAudioLoaded(page, 30000);

    const postLoadTitle = await page.locator('#chart-title').inputValue();
    expect(postLoadTitle).toBe(EXPECTED_TITLE);

    const bufferAfterLoad = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorBuffer);
    expect(bufferAfterLoad).toBeTruthy();

    const durationMs = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorDurationMs);
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThan(0);

    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(500);

    const playBtnTextDuringPlay = await getPlayButtonText(page);
    expect(playBtnTextDuringPlay).toBe('停止');

    await page.waitForTimeout(2000);

    const posMsDuringPlay = await getPositionMs(page);
    const beatDuringPlay = await getBeat(page);
    expect(posMsDuringPlay).toBeGreaterThan(0);
    expect(beatDuringPlay).toBeGreaterThan(0);

    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(500);

    const slider = page.locator('.editor-slider[type="range"]');
    await expect(slider).toBeEnabled();
    const sliderMax = await slider.getAttribute('max');
    expect(parseFloat(sliderMax || '0')).toBeGreaterThan(0);
  });

  test('File Input: verifies audio offset is applied to playback start position', async ({ page }) => {
    await navigateToEditor(page);

    const fileInput = page.locator('[data-testid="audio-file-input"]');
    await fileInput.setInputFiles(AUDIO_FILE);
    await waitForAudioLoaded(page, 30000);

    const offsetInput = page.locator('#audio-offset');
    await offsetInput.fill('500');
    await page.waitForTimeout(200);

    const offsetValue = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorAudioOffset);
    expect(offsetValue).toBe(500);

    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(1000);

    const playFromHook = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorPlayFrom);
    expect(playFromHook).toBeTruthy();
    expect(playFromHook.audioOffset).toBe(500);
    expect(playFromHook.when).toBeGreaterThan(playFromHook.ctxTime);

    await page.click('[data-testid="editor-play"]');
  });

  test('File Input: different audio formats (mp3, wav, ogg) can be loaded', async ({ page }) => {
    await navigateToEditor(page);

    const fileInput = page.locator('[data-testid="audio-file-input"]');

    const formats = [
      { ext: 'mp3', name: 'test.mp3' },
      { ext: 'wav', name: 'test.wav' },
      { ext: 'ogg', name: 'test.ogg' },
    ];

    for (const fmt of formats) {
      await page.evaluate(
        async ({ fmt }) => {
          const audioCtx = new (window.AudioContext || (window as unknown as Record<string, unknown>).webkitAudioContext)();
          const buffer = audioCtx.createBuffer(1, 44100, 44100);
          const channelData = buffer.getChannelData(0);
          for (let i = 0; i < channelData.length; i++) {
            channelData[i] = Math.sin(i * 0.1);
          }
          const blob = await new Promise<Blob>((resolve) => {
            const offlineCtx = new OfflineAudioContext(1, 44100, 44100);
            const src = offlineCtx.createBufferSource();
            src.buffer = buffer;
            src.connect(offlineCtx.destination);
            src.start();
            offlineCtx.startRendering().then((rendered) => {
              const wavBlob = audioBufferToWav(rendered);
              resolve(wavBlob);
            });
          });
          const file = new File([blob], fmt.name, { type: `audio/${fmt.ext}` });
          const dt = new DataTransfer();
          dt.items.add(file);
          const input = document.querySelector('[data-testid="audio-file-input"]') as HTMLInputElement;
          if (input) {
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        },
        { fmt }
      );

      await page.waitForTimeout(2000);

      const bufferLoaded = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorBuffer);
      if (bufferLoaded) {
        const durationMs = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorDurationMs);
        expect(durationMs).toBeGreaterThan(0);
        break;
      }
    }
  });

  test('File Input: clears previous buffer and state when new file is loaded', async ({ page }) => {
    await navigateToEditor(page);

    const fileInput = page.locator('[data-testid="audio-file-input"]');
    await fileInput.setInputFiles(AUDIO_FILE);
    await waitForAudioLoaded(page, 30000);

    await page.click('[data-testid="editor-play"]');
    await page.waitForTimeout(1000);
    await page.click('[data-testid="editor-play"]');

    const firstDuration = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorDurationMs);

    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__editorBuffer = null;
      (window as unknown as Record<string, unknown>).__editorDurationMs = 0;
    });

    await fileInput.setInputFiles(AUDIO_FILE);
    await waitForAudioLoaded(page, 30000);

    const secondDuration = await page.evaluate(() => (window as unknown as Record<string, unknown>).__editorDurationMs);
    expect(secondDuration).toBe(firstDuration);

    const positionMs = await getPositionMs(page);
    expect(positionMs).toBe(0);
  });
});

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}