import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('editor full authoring workflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/#/editor');
  await expect(page.locator('.editor-screen')).toBeVisible();
  // legend / instructions panel present (consistency + discoverability)
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible();

  // --- Step 0: chart info / title + BPM (BPM config) ---
  await page.locator('#chart-title').fill('QA Song');
  await page.locator('#bpm').fill('140');
  await page.waitForTimeout(800);

  // --- Step 1: music load / play / seek ---
  const playBtn = page.getByRole('button', { name: /読込|再生/ });
  await playBtn.click();
  // wait until audio buffer is loaded (slider becomes enabled)
  const slider = page.locator('.editor-slider');
  await expect(slider).toBeEnabled({ timeout: 30000 });
  // let playback progress a little to confirm seek/position works
  await page.waitForTimeout(2000);
  const posText = await page.locator('.editor-pos-time').textContent();
  expect(posText).not.toBeNull();

  // seek by clicking the preview ruler strip (top of canvas)
  const canvas = page.locator('[data-testid="wave-preview-canvas"]');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.3, y: 5 } });
  await page.waitForTimeout(800);

  // --- Step 2: place rings (click on preview) ---
  await expect(canvas).toBeVisible();
  for (const frac of [0.2, 0.4, 0.6, 0.8]) {
    await canvas.click({ position: { x: box.width * frac, y: box.height / 2 } });
    await page.waitForTimeout(400);
  }
  // the ring-list <details> is collapsed by default; open it to verify entries
  await page.locator('[data-testid="ring-list-details"] > summary').click();
  await expect(page.locator('[data-testid="ring-list-item-0"]')).toBeVisible();
  await expect(page.locator('[data-testid="ring-list-item-3"]')).toBeVisible();

  // delete one ring to exercise edit/delete
  await page.locator('[data-testid="ring-delete-0"]').click();
  await expect(page.locator('[data-testid="ring-list-item-0"]')).toBeVisible();
  await page.waitForTimeout(600);

  // --- Step 3: place segments ---
  await page.locator('.editor-accordion-summary', { hasText: 'セグメント' }).click();
  await page.getByLabel('セグメントを追加').click();
  await page.locator('[data-testid="segment-direction-0"]').selectOption('down');
  await page.locator('[data-testid="segment-beats-0"]').fill('2');
  await expect(page.locator('[data-testid="segment-direction-0"]')).toHaveValue('down');
  await page.waitForTimeout(600);

  // --- Step 4: waveform preview reflects state ---
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(800);

  // --- Step 5: export TOML ---
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'エクスポート' }).click(),
  ]);
  const dlPath = await download.path();
  const toml = dlPath ? readFileSync(dlPath, 'utf-8') : '';
  expect(toml).toContain('[[rings]]');
  expect(toml).toContain('[[segments]]');
  expect(toml).toContain('bpm = 140');
  // export feedback toast
  await expect(page.locator('[data-testid="editor-toast"]')).toBeVisible();
  await page.waitForTimeout(600);

  // --- Step 6: re-import the exported TOML ---
  await page.locator('[data-testid="import-toml"]').setInputFiles({
    name: 'reply.toml',
    mimeType: 'text/toml',
    buffer: Buffer.from(toml, 'utf-8'),
  });
  await expect(page.locator('#chart-title')).toHaveValue('QA Song');
  await expect(page.locator('#bpm')).toHaveValue('140');
  await page.waitForTimeout(600);

  // --- Step 7: playtest launch ---
  await page.getByRole('button', { name: 'プレイテスト' }).click();
  await expect(page.locator('.game-canvas')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1500);
  // exit playtest (on-screen 終了 button OR ESC)
  await page.getByRole('button', { name: '終了' }).click();
  await expect(page.locator('.editor-screen')).toBeVisible();

  expect(errors).toHaveLength(0);
});
