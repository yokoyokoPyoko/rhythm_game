import { test, expect, type Page, type ConsoleMessage, type Download } from '@playwright/test';
import { writeFileSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP_TOML_DIR = mkdtempSync(join(tmpdir(), 't97-'));
const EXPORTED_TOML_PATH = join(TMP_TOML_DIR, 'reply.toml');
const REIMPORT_TOML_PATH = join(TMP_TOML_DIR, 'reimport.toml');

const AUDIO_URL = '/rhythm_game/audio/08.Reply.flac';

const SAMPLE_TOML = `title = "Reply"
artist = ""
bpm = 120
audio = "${AUDIO_URL}"
audio_offset = 0
scroll_speed = 110
amplitude = 130

[[segments]]
direction = "up"
beats = 2

[[segments]]
direction = "down"
beats = 2

[[rings]]
beat = 4.0
type = "single"

[[rings]]
beat = 8.0
type = "single"
`;

async function gotoEditor(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/rhythm_game/#/editor', { waitUntil: 'networkidle' });
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);
  return errors;
}

const ringCount = (page: Page) => page.locator('[data-testid^="ring-list-item-"]').count();
const segmentCount = (page: Page) => page.locator('[data-testid^="segment-direction-"]').count();
const bpmChangeCount = (page: Page) => page.locator('[data-testid^="bpm-change-"]').count().catch(() => 0);

async function waitForToast(page: Page, text: string, timeout = 5000) {
  await expect(page.locator('[data-testid="editor-toast"]')).toContainText(text, { timeout });
  await page.waitForTimeout(800);
}

test.describe.configure({ retries: 0 });

test('T97: Editor complete workflow - audio load → BPM → rings/segments → preview → export → reimport → playtest', async ({ page }) => {
  test.setTimeout(180000);
  const errors = await gotoEditor(page);

  // Helper to expand accordion if collapsed
  const expandIfClosed = async (detailsLocator: any) => {
    const isOpen = await detailsLocator.evaluate((el: HTMLDetailsElement) => el.open);
    if (!isOpen) {
      await detailsLocator.locator('summary').click();
      await page.waitForTimeout(300);
    }
  };

  // Helper to collapse accordion if open
  const collapseIfOpen = async (detailsLocator: any) => {
    const isOpen = await detailsLocator.evaluate((el: HTMLDetailsElement) => el.open);
    if (isOpen) {
      await detailsLocator.locator('summary').click();
      await page.waitForTimeout(300);
    }
  };

  // ============================================================
  // PHASE 1: Load audio, verify playback & seek
  // ============================================================
  await page.waitForTimeout(1000);

  // Verify audio URL field has default
  await expect(page.locator('#audio-url')).toHaveValue(AUDIO_URL);

  // Click play/load button
  await page.locator('[data-testid="editor-play"]').click();
  await page.waitForTimeout(3000); // Wait for audio to load and start playing
  await waitForToast(page, '再生');

  // Verify position slider updates (playback working)
  await expect(page.locator('.editor-slider')).not.toBeDisabled();
  await page.waitForTimeout(2000);

  // Test seek via slider
  const slider = page.locator('.editor-slider');
  const maxVal = await slider.getAttribute('max');
  if (maxVal && Number(maxVal) > 1000) {
    await slider.fill(String(Math.floor(Number(maxVal) * 0.3)));
    await page.waitForTimeout(800);
    await expect(page.locator('.editor-pos-time')).not.toHaveText('0:00.0');
  }

  // Test seek via ruler click on wave preview
  const canvas = page.locator('[data-testid="wave-preview-canvas"]');
  const box = await canvas.boundingBox();
  if (box) {
    await canvas.click({ position: { x: Math.round(box.width * 0.15), y: 10 } }); // ruler area
    await page.waitForTimeout(800);
  }

  // Pause
  await page.locator('[data-testid="editor-play"]').click();
  await page.waitForTimeout(500);
  await waitForToast(page, '停止');

  // ============================================================
  // PHASE 2: BPM Settings (basic, amplitude, scroll, offset, tap tempo, BPM changes)
  // ============================================================
  await page.waitForTimeout(500);

  // Basic BPM
  await page.fill('#bpm', '135');
  await expect(page.locator('#bpm')).toHaveValue('135');
  await page.waitForTimeout(400);

  // Amplitude
  await page.fill('#amplitude', '140');
  await expect(page.locator('#amplitude')).toHaveValue('140');
  await page.waitForTimeout(400);

  // Scroll speed
  await page.fill('#scroll-speed', '120');
  await expect(page.locator('#scroll-speed')).toHaveValue('120');
  await page.waitForTimeout(400);

  // Audio offset
  await page.fill('#audio-offset', '-50');
  await expect(page.locator('#audio-offset')).toHaveValue('-50');
  await page.waitForTimeout(400);

  // Tap tempo (4 taps)
  const tapBtn = page.locator('button', { hasText: /タップ/ });
  for (let i = 0; i < 4; i++) {
    await tapBtn.click();
    await page.waitForTimeout(150); // Simulate human tempo ~120-140 BPM
  }
  await page.waitForTimeout(500);
  // BPM should update to tapped value (approximately)
  const tappedBpm = await page.locator('#bpm').inputValue();
  expect(Number(tappedBpm)).toBeGreaterThan(100);
  expect(Number(tappedBpm)).toBeLessThan(200);

  // Reset tap
  await page.locator('button', { hasText: 'リセット' }).click();
  await page.waitForTimeout(300);

  // Add BPM change
  await page.locator('.bpm-change-add').click();
  await page.waitForTimeout(400);
  await expect(page.locator('[data-testid="segment-list-details"]')).toBeVisible(); // Just verify UI updated

  // Verify BPM change entry exists
  await expect(page.locator('.bpm-change-beat').first()).toBeVisible();
  await expect(page.locator('.bpm-change-bpm').first()).toBeVisible();

  // Modify BPM change
  await page.fill('.bpm-change-beat', '8');
  await page.fill('.bpm-change-bpm', '160');
  await page.waitForTimeout(400);

  // ============================================================
  // PHASE 3: Segment editing (accordion interactions)
  // ============================================================
  await page.waitForTimeout(500);

  const segDetails = page.locator('[data-testid="segment-list-details"]');
  await expandIfClosed(segDetails);
  await page.waitForTimeout(500);

  // Initial segments from TOML (2 segments)
  expect(await segmentCount(page)).toBe(2);

  // Add segment via "+" button in accordion header
  await page.locator('[data-testid="segment-add"]').click();
  await page.waitForTimeout(400);
  expect(await segmentCount(page)).toBe(3);

  // Modify new segment: direction=stay, beats=1.5
  await page.locator('[data-testid="segment-direction-2"]').selectOption('stay');
  await page.fill('[data-testid="segment-beats-2"]', '1.5');
  await page.waitForTimeout(500);

  // Reorder: move segment 2 up
  await page.locator('[data-testid="segment-list-details"] >> button[aria-label="セグメント3を上に移動"]').click();
  await page.waitForTimeout(400);

  // Delete segment (the one we just moved)
  await page.locator('[data-testid="segment-delete-1"]').click();
  await page.waitForTimeout(400);
  expect(await segmentCount(page)).toBe(2);

  // Verify wave preview updates in real-time (visual check via canvas)
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1000);

  // Collapse segment accordion
  await collapseIfOpen(segDetails);
  await page.waitForTimeout(400);

  // ============================================================
  // PHASE 4: Ring editing (preview click, drag, double-click, list operations)
  // ============================================================
  await page.waitForTimeout(500);

  const ringDetails = page.locator('[data-testid="ring-list-details"]');
  await expandIfClosed(ringDetails);
  await page.waitForTimeout(500);

  // Initial rings from TOML (2 rings)
  const initialRings = await ringCount(page);
  expect(initialRings).toBe(2);

  // 4a: Add ring via canvas click
  if (box) {
    await canvas.click({ position: { x: Math.round(box.width * 0.35), y: Math.round(box.height * 0.5) } });
    await page.waitForTimeout(600);
    expect(await ringCount(page)).toBe(initialRings + 1);
    await waitForToast(page, 'リング追加');
  }

  // 4b: Add ring via Space key during playback
  await page.locator('[data-testid="editor-play"]').click(); // Resume playback
  await page.waitForTimeout(1000);
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);
  expect(await ringCount(page)).toBe(initialRings + 2);
  await waitForToast(page, 'リング追加');
  await page.locator('[data-testid="editor-play"]').click(); // Pause
  await page.waitForTimeout(400);

  // 4c: Move ring via drag on canvas
  const ringIdxToMove = initialRings; // 0-indexed, the one added via click
  const ringItem = page.locator(`[data-testid="ring-list-item-${ringIdxToMove}"]`);
  const beatText = await ringItem.locator('.ring-list-beat').textContent();
  const beatVal = Number((beatText || '').replace(/[^0-9.]/g, ''));
  if (box && !isNaN(beatVal)) {
    const startX = Math.round((beatVal / 4) * box.width); // lastBeat defaults to 4 when no segments or max(totalBeats, 4)
    const targetX = Math.min(box.width - 20, startX + Math.round(box.width * 0.2));
    await page.mouse.move(box.x + startX, box.y + Math.round(box.height * 0.5));
    await page.mouse.down();
    await page.mouse.move(box.x + targetX, box.y + Math.round(box.height * 0.5), { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const newBeatText = await ringItem.locator('.ring-list-beat').textContent();
    const newBeatVal = Number((newBeatText || '').replace(/[^0-9.]/g, ''));
    expect(newBeatVal).not.toBe(beatVal);
  }

  // 4d: Change ring type to hold and set duration
  await ringItem.locator('.ring-type-select').selectOption('hold');
  await page.waitForTimeout(300);
  await ringItem.locator('.ring-duration-input').fill('2');
  await page.waitForTimeout(300);

  // 4e: Delete ring via double-click on canvas
  const ringIdxToDelete = initialRings + 1; // The one added via Space
  const ringToDelete = page.locator(`[data-testid="ring-list-item-${ringIdxToDelete}"]`);
  const delBeatText = await ringToDelete.locator('.ring-list-beat').textContent();
  const delBeatVal = Number((delBeatText || '').replace(/[^0-9.]/g, ''));
  if (box && !isNaN(delBeatVal)) {
    const delX = Math.round((delBeatVal / 4) * box.width);
    await canvas.dblclick({ position: { x: delX, y: Math.round(box.height * 0.5) } });
    await page.waitForTimeout(600);
    expect(await ringCount(page)).toBe(initialRings + 1);
  }

  // 4f: Delete ring via list delete button
  const beforeListDelete = await ringCount(page);
  await page.locator('[data-testid="ring-delete-0"]').click();
  await page.waitForTimeout(500);
  expect(await ringCount(page)).toBe(beforeListDelete - 1);

  // 4g: Select ring via list click (should seek)
  await ringDetails.locator('.ring-list-beat').first().click();
  await page.waitForTimeout(500);

  // 4h: Test snap selector changes
  await page.locator('#snap').selectOption('0.5');
  await page.waitForTimeout(300);
  await page.locator('#snap').selectOption('0.25');
  await page.waitForTimeout(300);

  // Collapse ring accordion
  await collapseIfOpen(ringDetails);
  await page.waitForTimeout(500);

  // ============================================================
  // PHASE 5: Waveform preview real-time verification
  // ============================================================
  // The canvas should show: grid, ruler, segments (colored), rings (markers), playhead
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox!.height).toBeGreaterThan(400); // Expanded preview
  await page.waitForTimeout(1500); // Hold for video capture

  // ============================================================
  // PHASE 6: TOML Export
  // ============================================================
  await page.waitForTimeout(500);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="editor-export"]').click(),
  ]);
  expect(download.suggestedFilename()).toBe('reply.toml');
  await download.saveAs(EXPORTED_TOML_PATH);
  await waitForToast(page, 'エクスポート');
  await page.waitForTimeout(800);

  // Verify exported TOML content
  const exportedContent = readFileSync(EXPORTED_TOML_PATH, 'utf-8');
  expect(exportedContent).toContain('title = "Reply"');
  expect(exportedContent).toContain('bpm = 135'); // Updated BPM
  expect(exportedContent).toContain('amplitude = 140');
  expect(exportedContent).toContain('scroll_speed = 120');
  expect(exportedContent).toContain('audio_offset = -50');
  expect(exportedContent).toContain('direction = "stay"'); // Our stay segment
  expect(exportedContent).toContain('type = "hold"'); // Hold ring

  // ============================================================
  // PHASE 7: Re-import exported TOML (round-trip)
  // ============================================================
  await page.waitForTimeout(500);
  await page.setInputFiles('[data-testid="import-toml"]', EXPORTED_TOML_PATH);
  await waitForToast(page, '読み込みました');
  await page.waitForTimeout(1000);

  // Verify re-imported values
  await expect(page.locator('#bpm')).toHaveValue('135');
  await expect(page.locator('#amplitude')).toHaveValue('140');
  await expect(page.locator('#scroll-speed')).toHaveValue('120');
  await expect(page.locator('#audio-offset')).toHaveValue('-50');

  // Verify segments restored
  await expandIfClosed(segDetails);
  await page.waitForTimeout(400);
  expect(await segmentCount(page)).toBe(2);
  await collapseIfOpen(segDetails);

  // Verify rings restored
  await expandIfClosed(ringDetails);
  await page.waitForTimeout(400);
  expect(await ringCount(page)).toBeGreaterThan(0);
  await collapseIfOpen(ringDetails);

  // ============================================================
  // PHASE 8: Playtest (in-editor)
  // ============================================================
  await page.waitForTimeout(500);
  await page.locator('[data-testid="editor-playtest"]').click();
  await page.waitForTimeout(3000); // Wait for GameScreen to mount and start

  // Verify playtest overlay with game canvas
  const playtestCanvas = page.locator('[data-testid="playtest-canvas"], canvas.game-canvas');
  await expect(playtestCanvas.first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(3000); // Let game run for video capture

  // Exit playtest
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible();
  await page.waitForTimeout(1000);

  // ============================================================
  // PHASE 9: Clear all and verify empty state handling
  // ============================================================
  await page.waitForTimeout(500);
  page.on('dialog', async dialog => {
    expect(dialog.message()).toContain('クリア');
    await dialog.accept();
  });
  await page.locator('[data-testid="editor-clear"]').click();
  await page.waitForTimeout(800);
  expect(await ringCount(page)).toBe(0);
  expect(await segmentCount(page)).toBe(0);
  await waitForToast(page, 'クリア');

  // Verify empty states show helpful text
  await expandIfClosed(segDetails);
  await page.waitForTimeout(300);
  await expect(page.locator('.editor-empty')).toContainText('セグメントなし');
  await collapseIfOpen(segDetails);

  await expandIfClosed(ringDetails);
  await page.waitForTimeout(300);
  await expect(page.locator('.editor-empty')).toContainText('リングなし');
  await collapseIfOpen(ringDetails);

  // ============================================================
  // PHASE 10: Error handling - invalid TOML import
  // ============================================================
  const invalidTomlPath = join(TMP_TOML_DIR, 'invalid.toml');
  writeFileSync(invalidTomlPath, 'not valid toml [[[');
  await page.setInputFiles('[data-testid="import-toml"]', invalidTomlPath);
  await page.waitForTimeout(800);
  await expect(page.locator('.editor-error')).toBeVisible();
  await expect(page.locator('.editor-error')).toContainText('読み込みに失敗');
  await page.waitForTimeout(500);

  // ============================================================
  // PHASE 11: Return to select screen
  // ============================================================
  await page.locator('text=/ に戻る').click();
  await page.waitForURL('**/#/', { timeout: 5000 });
  await expect(page.locator('.select-screen, .song-grid, h1')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1500); // Final capture

  // Final assertion: no console errors
  expect(errors).toHaveLength(0);
});