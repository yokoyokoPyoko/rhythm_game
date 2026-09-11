/**
 * T227 behavioral E2E: holding Space must not auto-play the chart.
 * Dense stay-wave chart (cursor always on wave) + hold Space entire song.
 * Without the e.repeat guard, repeats hit every ring (perfect≈17).
 * With the fix, only the initial press judges (null, no rings in window),
 * repeats are ignored, rings expire unhit (miss=17, perfect=0).
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const CHART_PATH = '/tmp/opencode/t227-dense.toml';
const AUDIO_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';

function buildDenseChart(): string {
  const lines = [
    'title = "T227 Dense Hold"',
    'artist = "QA"',
    'bpm = 120',
    'audio = "test-audio.wav"',
    'audio_offset = 0',
    'amplitude = 1.0',
    'start_position = 0.0',
    'end_beat = 8.0',
    '',
    '[[segments]]',
    'direction = "stay"',
    'beats = 8',
    '',
  ];
  for (let b = 2; b <= 6.001; b += 0.25) {
    lines.push('[[rings]]', `beat = ${b.toFixed(2)}`, '');
  }
  return lines.join('\n');
}

test('T227: holding Space through dense rings does not auto-hit (repeat ignored)', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('traceWaveViewMode', 'debug'));
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) errors.push(err.message);
  });

  await page.goto('http://127.0.0.1:5173/rhythm_game/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await page.waitForTimeout(1000);
  await page.locator('.select-header h1').click();

  writeFileSync(CHART_PATH, buildDenseChart(), 'utf-8');
  await page.locator('input[data-testid="home-chart-input"]').setInputFiles(CHART_PATH);
  await page.locator('input[data-testid="home-audio-input"]').setInputFiles(AUDIO_FIXTURE);
  const addBtn = page.locator('button[data-testid="home-play-button"]');
  await expect(addBtn).toBeEnabled({ timeout: 10000 });
  await addBtn.click();
  const card = page.locator('.song-card', { hasText: 'T227 Dense Hold' });
  await expect(card).toBeVisible({ timeout: 10000 });
  await card.click();

  const canvas = page.locator('canvas[data-testid="playtest-canvas"]');
  await expect(canvas).toBeVisible({ timeout: 15000 });
  // Debug: main-wait overlay → first press starts music (consumed, no judgement).
  await expect(page.locator('[data-testid="main-wait-overlay"]')).toBeVisible({ timeout: 15000 });
  await page.keyboard.press('Space');
  await expect(page.locator('[data-testid="main-wait-overlay"]')).toHaveCount(0, { timeout: 5000 });

  // Hold Space for the rest of the song, injecting OS-style repeats.
  await page.keyboard.down('Space');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    await page.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true, bubbles: true }),
      );
    });
    await page.waitForTimeout(120);
  }
  await page.keyboard.up('Space');

  // Song ends at beat 8 (4s) → result screen.
  await expect(page.locator('.result-screen')).toBeVisible({ timeout: 20000 });
  const text = async (cls: string) =>
    Number(await page.locator(`.result-stat.${cls} .result-stat-value`).textContent());
  const perfect = await text('perfect');
  const great = await text('great');
  const good = await text('good');
  const miss = await text('miss');
  console.log(`T227 result: perfect=${perfect} great=${great} good=${good} miss=${miss}`);
  console.log(`T227 errors: ${JSON.stringify(errors)}`);
  // 17 rings total. Holding must not judge at all: only expiry MISSes remain.
  expect(perfect).toBe(0);
  expect(great).toBe(0);
  expect(good).toBe(0);
  expect(miss).toBe(17);
  expect(errors).toHaveLength(0);
});
