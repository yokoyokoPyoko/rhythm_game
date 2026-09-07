import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CUSTOM_TOML = `title = "T42 Custom"
artist = "QA"
bpm = 120
audio = "test-audio.wav"
audio_offset = 0
amplitude = 1.0
start_position = 0.0
end_beat = 8.0

[[sections]]
beat = 0
bpm = 120

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

test('T42 game and chart integration test', async ({ page }) => {
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
    errors.push(err.message);
  });

  // 1. Navigate to home
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('#root')).toBeVisible();

  // Frame 1: Select screen (0 built-in songs + import UI + empty message)
  await page.screenshot({ path: 'screenshots/frame_1.png' });
  await expect(page.locator('[data-testid="empty-song-list"]')).toBeVisible();

  // Import a chart via the custom import flow (home-chart-input)
  const tmp = mkdtempSync(join(tmpdir(), 't42-'));
  const tomlPath = join(tmp, 'custom.toml');
  writeFileSync(tomlPath, CUSTOM_TOML, 'utf-8');
  await page.locator('[data-testid="home-chart-input"]').setInputFiles(tomlPath);
  await page.locator('[data-testid="home-audio-input"]').setInputFiles(
    '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav'
  );

  // "追加" button becomes active once chart + audio are paired
  const addButton = page.locator('[data-testid="home-play-button"]');
  await expect(addButton).toBeEnabled();
  await addButton.click();

  // New custom song card appears
  const songCard = page.locator('.song-card', { hasText: 'T42 Custom' });
  await expect(songCard).toBeVisible();
  await songCard.click();
  await page.waitForTimeout(1000);

  // Frame 2: Game screen loaded
  await expect(page.locator('canvas.game-canvas')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_2.png' });

  // Simulate gameplay interaction
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);

  // Frame 3: Game running / synchronization active
  await page.screenshot({ path: 'screenshots/frame_3.png' });

  // Wait for game completion / transition to ResultScreen
  await page.waitForSelector('.result-screen', { timeout: 15000 });

  // Frame 4: Result screen
  await page.screenshot({ path: 'screenshots/frame_4.png' });

  // Return to select screen
  const selectButton = page.locator('button', { hasText: '曲選択' });
  await expect(selectButton).toBeVisible();
  await selectButton.click();
  await page.waitForTimeout(1000);

  // Frame 5: Returned to select screen
  await expect(page.locator('.select-screen')).toBeVisible();
  await page.screenshot({ path: 'screenshots/frame_5.png' });

  // 3. Assert no unhandled console errors or broken states
  expect(errors).toHaveLength(0);
});