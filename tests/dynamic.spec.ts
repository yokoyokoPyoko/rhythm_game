import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { parse } from 'smol-toml';

test('T97 Authoring Tool Comprehensive Usability Workflow Test', async ({ page }) => {
  test.setTimeout(60000);
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

  // 1. Visit Home / Select Screen
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#root')).toBeVisible();
  await page.waitForTimeout(500);

  // 2. Navigate to Editor Screen via HashRouter
  await page.evaluate(() => {
    window.location.hash = '#/editor';
  });
  await page.waitForSelector('[data-testid="editor-legend"]', { timeout: 5000 });
  await page.waitForTimeout(800);

  // 3. Audio Loading & Playback / Seek
  const playBtn = page.locator('button[data-testid="editor-play"]');
  await expect(playBtn).toBeVisible();
  await playBtn.click();
  await page.waitForTimeout(800);

  const slider = page.locator('.editor-slider');
  await expect(slider).toBeVisible();
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = '2000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(800);

  const stopBtn = page.locator('button', { hasText: '停止' });
  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  await page.waitForTimeout(500);

  // 4. BPM & Chart Configuration
  const titleInput = page.locator('#chart-title');
  await titleInput.fill('Test Wave Comprehensive T97');
  const artistInput = page.locator('#chart-artist');
  await artistInput.fill('Gate C Critic Expert');
  await page.waitForTimeout(600);

  // 5. Add Rings & Segments via Playback & Keyboard / Preview Click
  await playBtn.click();
  await page.waitForTimeout(600);

  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);

  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(600);

  if (await stopBtn.isVisible()) {
    await stopBtn.click();
  }
  await page.waitForTimeout(600);

  // 6. Configure Ring as Hold in Ring List Accordion
  const ringPane = page.locator('section.editor-pane', { hasText: 'リング録音' });
  const details = ringPane.locator('details');
  if (await details.isVisible()) {
    await details.evaluate((el: HTMLDetailsElement) => { el.open = true; });
  }
  await page.waitForTimeout(600);

  const typeSelects = ringPane.locator('.ring-type-select');
  if ((await typeSelects.count()) > 0) {
    await typeSelects.first().selectOption('hold');
    await page.waitForTimeout(600);
  }

  // 7. Wave Preview check & direct interaction
  const waveCanvas = page.locator('canvas');
  await expect(waveCanvas.first()).toBeVisible();
  await waveCanvas.first().click({ position: { x: 300, y: 200 } });
  await page.waitForTimeout(600);

  // 8. TOML Export & Re-import verification
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
    expect(parsed.title).toBe('Test Wave Comprehensive T97');
    expect(Array.isArray(parsed.rings)).toBe(true);
    expect(Array.isArray(parsed.segments)).toBe(true);
  }
  await page.waitForTimeout(600);

  if (filePath) {
    const fileInput = page.locator('input[data-testid="import-toml"]');
    await fileInput.setInputFiles(filePath);
    await page.waitForTimeout(800);
  }

  // 9. Playtest verification
  const playtestBtn = page.locator('button[data-testid="editor-playtest"]');
  await expect(playtestBtn).toBeVisible();
  await playtestBtn.click();
  const playtestCanvas = page.locator('canvas');
  await expect(playtestCanvas.last()).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1000);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(600);

  // 10. Return to home screen
  const backLink = page.locator('a', { hasText: '/ に戻る' });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await expect(page.locator('#root')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(600);

  expect(errors).toHaveLength(0);
});
