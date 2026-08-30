import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const TEST_AUDIO = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';
const CHART_TOML = `
title = "Test Chart"
artist = "Test Artist"
bpm = 120
audio = "test-audio.wav"

[[segments]]
direction = "up"
beats = 2

[[segments]]
direction = "down"
beats = 2

[[rings]]
beat = 4.0

[[rings]]
beat = 8.0
`;

async function writeTempChart(chartContent: string): Promise<string> {
  const tmpDir = '/tmp/rhythm_game_test';
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `chart-${Date.now()}.toml`);
  fs.writeFileSync(filePath, chartContent);
  return filePath;
}

async function runOrderPermutation(
  page: ReturnType<typeof test>,
  chartPath: string,
  audioPath: string,
  order: 'chart-first' | 'audio-first'
) {
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
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.select-header h1')).toBeVisible();

  // Verify file inputs and dropzone exist
  const chartInput = page.locator('input[data-testid="home-chart-input"]');
  const audioInput = page.locator('input[data-testid="home-audio-input"]');
  const dropzone = page.locator('[data-testid="home-dropzone"]');

  await expect(chartInput).toBeVisible({ timeout: 5000 });
  await expect(audioInput).toBeVisible({ timeout: 5000 });
  await expect(dropzone).toBeVisible({ timeout: 5000 });

  // Verify accept attributes
  await expect(chartInput).toHaveAttribute('accept', '.toml');
  await expect(audioInput).toHaveAttribute('accept', 'audio/*');

  const playButton = page.locator('button:has-text("この譜面でプレイ")');
  await expect(playButton).toBeDisabled();

  // Step 1: Capture initial state - button is disabled
  const initialDisabled = await playButton.isDisabled();
  expect(initialDisabled).toBe(true);

  // Step 2: Perform user interaction - setInputFiles in specified order
  if (order === 'chart-first') {
    await chartInput.setInputFiles(chartPath);
    await audioInput.setInputFiles(audioPath);
  } else {
    await audioInput.setInputFiles(audioPath);
    await chartInput.setInputFiles(chartPath);
  }

  // Step 3: Assert resulting transition - button becomes enabled
  await expect(playButton).toBeEnabled({ timeout: 10000 });

  // Click the play button
  await playButton.click();

  // Verify navigation to /play/custom with canvas
  await expect(page).toHaveURL(/\/play\/custom/, { timeout: 10000 });
  await expect(page.locator('canvas[data-testid="playtest-canvas"]')).toBeVisible({ timeout: 10000 });

  // Wait for game to initialize
  await page.waitForTimeout(2000);

  // Verify no console errors
  expect(errors).toHaveLength(0);

  // Return to select screen for next test
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/, { timeout: 5000 });
  await expect(page.locator('.select-header h1')).toBeVisible();
}

async function runDropzoneTest(page: ReturnType<typeof test>, chartPath: string, audioPath: string) {
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
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('.select-header h1')).toBeVisible();

  const dropzone = page.locator('[data-testid="home-dropzone"]');
  await expect(dropzone).toBeVisible({ timeout: 5000 });

  const playButton = page.locator('button:has-text("この譜面でプレイ")');
  await expect(playButton).toBeDisabled();

  // Read file contents for drag-and-drop simulation
  const chartContent = fs.readFileSync(chartPath);
  const audioContent = fs.readFileSync(audioPath);

  // Simulate drop via evaluate with DataTransfer
  await page.evaluate(async ([chartBuf, audioBuf]) => {
    const chartFile = new File([new Uint8Array(chartBuf)], 'chart.toml', { type: 'text/toml' });
    const audioFile = new File([new Uint8Array(audioBuf)], 'test-audio.wav', { type: 'audio/wav' });
    const dt = new DataTransfer();
    dt.items.add(chartFile);
    dt.items.add(audioFile);
    const zone = document.querySelector('[data-testid="home-dropzone"]') as HTMLElement;
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [chartContent, audioContent]);

  // Wait for pairing and button enable
  await expect(playButton).toBeEnabled({ timeout: 10000 });

  // Click the play button
  await playButton.click();

  // Verify navigation to /play/custom with canvas
  await expect(page).toHaveURL(/\/play\/custom/, { timeout: 10000 });
  await expect(page.locator('canvas[data-testid="playtest-canvas"]')).toBeVisible({ timeout: 10000 });

  await page.waitForTimeout(2000);

  expect(errors).toHaveLength(0);

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/, { timeout: 5000 });
  await expect(page.locator('.select-header h1')).toBeVisible();
}

test.describe('T110: SelectScreen local chart & audio drag-and-drop', () => {
  let chartPath: string;

  test.beforeAll(async () => {
    chartPath = await writeTempChart(CHART_TOML);
  });

  test.afterAll(async () => {
    if (chartPath && fs.existsSync(chartPath)) {
      fs.unlinkSync(chartPath);
    }
  });

  test('file input: chart first, then audio', async ({ page }) => {
    await runOrderPermutation(page, chartPath, TEST_AUDIO, 'chart-first');
  });

  test('file input: audio first, then chart', async ({ page }) => {
    await runOrderPermutation(page, chartPath, TEST_AUDIO, 'audio-first');
  });

  test('drag-and-drop both files', async ({ page }) => {
    await runDropzoneTest(page, chartPath, TEST_AUDIO);
  });
});