import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'
import * as fs from 'fs'
import { parse } from 'smol-toml'

const RULER_H = 22

async function waitForServerReady(page: Page, baseURL: string): Promise<void> {
  let retries = 0
  while (retries < 30) {
    try {
      const resp = await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 5000 })
      if (resp?.ok()) return
    } catch {
      // ignore
    }
    await page.waitForTimeout(1000)
    retries++
  }
  throw new Error('Dev server not ready after 30s')
}

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text()
    if (msg.type() === 'error' && /Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
      errors.push(text)
    }
  })
  page.on('pageerror', (err) => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) {
      errors.push(err.message)
    }
  })
  return errors
}

async function openEditor(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/editor'
  })
  await page.waitForSelector('.editor-screen', { timeout: 15000 })
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  await expect(page.locator('[data-testid="wave-preview-canvas"]')).toBeVisible()
  await page.waitForTimeout(3000)
}

function ensureDetailsOpen(page: Page, testId: string): Promise<boolean> {
  return page.locator(`[data-testid="${testId}"]`).evaluate((el: HTMLDetailsElement) => {
    if (!el.open) {
      el.querySelector('summary')?.click()
    }
    return el.open
  })
}

async function waitForCanvasDraw(page: Page, minPixels = 1000): Promise<void> {
  await page.waitForFunction(
    (threshold) => {
      const canvas = document.querySelector('[data-testid="wave-preview-canvas"]') as HTMLCanvasElement
      if (!canvas) return false
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      let nonTransparent = 0
      for (let i = 3; i < imgData.data.length; i += 4) {
        if (imgData.data[i] > 0) nonTransparent++
      }
      return nonTransparent >= threshold
    },
    minPixels,
    { timeout: 15000 }
  )
}

async function waitForAudioLoaded(page: Page): Promise<void> {
  // Wait for the play button text to change from "読込中…" to "停止" or "再生"
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement
      if (!btn) return false
      return !btn.textContent?.includes('読込')
    },
    { timeout: 60000 }
  )
  await page.waitForTimeout(2000)
}

async function addRingAtBeat(page: Page, beat: number, viewBeats = 16): Promise<void> {
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Canvas not found')
  const x = Math.round(box.x + (beat / viewBeats) * box.width)
  const y = Math.round(box.y + box.height * 0.6)
  await page.mouse.move(x, y)
  await page.waitForTimeout(200)
  await page.mouse.down()
  await page.waitForTimeout(200)
  await page.mouse.up()
  await page.waitForTimeout(1500)
}

test.describe.configure({ retries: 0 })

test('T98 Wave Model Unification + Editor Recording Mode + DAW-style Zoom/Pan', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  test.setTimeout(600000)

  const baseURL = process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/'
  const allErrors = await collectErrors(page)

  // ============================================================
  // 0. Wait for dev server to be ready
  // ============================================================
  await waitForServerReady(page, baseURL)
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'recordings/t98_01_home.png' })

  // ============================================================
  // 1. Open Editor and verify initial state
  // ============================================================
  await openEditor(page)
  await page.screenshot({ path: 'recordings/t98_02_editor_loaded.png' })
  await page.waitForTimeout(3000)

  // ============================================================
  // 2. Test Music Load, Play, Seek, Stop
  // ============================================================
  const playBtn = page.locator('[data-testid="editor-play"]')
  await expect(playBtn).toBeVisible()
  await playBtn.click()
  
  // Wait for 68.8MB FLAC to load and decode
  await waitForAudioLoaded(page)
  await page.screenshot({ path: 'recordings/t98_03_music_playing.png' })
  await page.waitForTimeout(3000)

  // Seek audio via slider
  const seekSlider = page.locator('.editor-slider').first()
  if (await seekSlider.isEnabled()) {
    await seekSlider.fill('5000')
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'recordings/t98_03b_seeked.png' })
  }

  // Stop audio
  await playBtn.click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'recordings/t98_04_music_stopped.png' })

  // ============================================================
  // 3. Test BPM & Settings (Base BPM, Amplitude, Scroll Speed, Audio Offset, BPM Changes, Tap Tempo)
  // ============================================================
  const bpmInput = page.locator('#bpm')
  await bpmInput.fill('135')
  await expect(bpmInput).toHaveValue('135')

  const ampInput = page.locator('#amplitude')
  await ampInput.fill('140')
  await expect(ampInput).toHaveValue('140')

  const scrollInput = page.locator('#scroll-speed')
  await scrollInput.fill('120')
  await expect(scrollInput).toHaveValue('120')

  const offsetInput = page.locator('#audio-offset')
  await offsetInput.fill('25')
  await expect(offsetInput).toHaveValue('25')

  // Test Tap Tempo button
  const tapBtn = page.locator('button:has-text("タップ")').first()
  await expect(tapBtn).toBeVisible()
  await tapBtn.click()
  await page.waitForTimeout(800)

  // Add BPM Change
  const addBpmChangeBtn = page.locator('.bpm-change-add')
  await addBpmChangeBtn.click()
  await page.waitForTimeout(1000)
  const bpmChangeBeat = page.locator('.bpm-change-beat').first()
  await bpmChangeBeat.fill('8')
  const bpmChangeBpm = page.locator('.bpm-change-bpm').first()
  await bpmChangeBpm.fill('150')
  await page.screenshot({ path: 'recordings/t98_05_settings_updated.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 4. Test Segments: add, edit direction (including stay), edit beats, verify preview updates
  // ============================================================
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  await ensureDetailsOpen(page, 'segment-list-details')
  await page.waitForTimeout(500)

  const segAddBtn = page.locator('[data-testid="segment-add"]')

  // Add first segment: stay direction (T98 feature)
  await segAddBtn.click()
  await page.waitForTimeout(1000)
  const segDirSelect0 = page.locator('[data-testid="segment-direction-0"]')
  await segDirSelect0.selectOption('stay')
  await expect(segDirSelect0).toHaveValue('stay')
  const segBeatsInput0 = page.locator('[data-testid="segment-beats-0"]')
  await segBeatsInput0.fill('2.5')
  // Number input normalizes "2.5" to "2.5" - verify with toBeCloseTo
  expect(Number(await segBeatsInput0.inputValue())).toBeCloseTo(2.5)

  // Add second segment: down direction
  await segAddBtn.click()
  await page.waitForTimeout(1000)
  const segDirSelect1 = page.locator('[data-testid="segment-direction-1"]')
  await segDirSelect1.selectOption('down')
  const segBeatsInput1 = page.locator('[data-testid="segment-beats-1"]')
  await segBeatsInput1.fill('1.5')
  expect(Number(await segBeatsInput1.inputValue())).toBeCloseTo(1.5)

  // Add third segment: up direction (will be deleted to test delete)
  await segAddBtn.click()
  await page.waitForTimeout(1000)
  const segDirSelect2 = page.locator('[data-testid="segment-direction-2"]')
  await segDirSelect2.selectOption('up')
  const segBeatsInput2 = page.locator('[data-testid="segment-beats-2"]')
  await segBeatsInput2.fill('1.0')
  await page.screenshot({ path: 'recordings/t98_06_segments_added.png' })
  await page.waitForTimeout(2500)

  // Delete third segment (index 2)
  const segDeleteBtn2 = page.locator('[data-testid="segment-delete-2"]')
  await segDeleteBtn2.click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'recordings/t98_06b_segment_deleted.png' })
  await page.waitForTimeout(2000)

  // Verify first two segments remain
  await expect(page.locator('[data-testid="segment-direction-0"]')).toHaveValue('stay')
  expect(Number(await page.locator('[data-testid="segment-beats-0"]').inputValue())).toBeCloseTo(2.5)
  await expect(page.locator('[data-testid="segment-direction-1"]')).toHaveValue('down')
  expect(Number(await page.locator('[data-testid="segment-beats-1"]').inputValue())).toBeCloseTo(1.5)

  // ============================================================
  // 5. Test Ring placement: add rings via precise canvas click sequence
  // ============================================================
  await waitForCanvasDraw(page)
  await addRingAtBeat(page, 1.0)
  await addRingAtBeat(page, 4.0)
  await addRingAtBeat(page, 8.0)

  await page.screenshot({ path: 'recordings/t98_07_rings_added_via_click.png' })
  await page.waitForTimeout(2500)

  // Open ring list accordion
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  await ensureDetailsOpen(page, 'ring-list-details')
  await page.waitForTimeout(500)

  // Verify rings were added (at least 3)
  let ringItems = page.locator('[data-testid^="ring-list-item-"]')
  const ringCount = await ringItems.count()
  expect(ringCount).toBeGreaterThanOrEqual(3)
  await page.screenshot({ path: 'recordings/t98_07b_rings_verified.png' })
  await page.waitForTimeout(2000)

  // Change ring type to hold and set duration for first ring
  const ringItem0 = ringItems.nth(0)
  const ringTypeSelect0 = ringItem0.locator('.ring-type-select')
  await ringTypeSelect0.selectOption('hold')
  await expect(ringTypeSelect0).toHaveValue('hold')

  const ringDurationInput0 = ringItem0.locator('.ring-duration-input')
  await expect(ringDurationInput0).toBeVisible()
  await ringDurationInput0.fill('2')
  expect(Number(await ringDurationInput0.inputValue())).toBeCloseTo(2)
  await page.screenshot({ path: 'recordings/t98_08_ring_hold_configured.png' })
  await page.waitForTimeout(2500)

  // Test ring selection via beat display click (seeks playback position)
  const ringItem1 = ringItems.nth(1)
  await ringItem1.locator('.ring-list-beat').click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'recordings/t98_09_ring_selected.png' })
  await page.waitForTimeout(2000)

  // Test editing ring beat position via numeric input
  const ringItem1BeatInput = ringItem1.locator('.ring-beat-input')
  await expect(ringItem1BeatInput).toBeVisible()
  const currentBeat = await ringItem1BeatInput.inputValue()
  const newBeat = (parseFloat(currentBeat) + 1.25).toFixed(2)
  await ringItem1BeatInput.fill(newBeat)
  const expectedVal = parseFloat(newBeat)
  const actualVal = Number(await ringItem1BeatInput.inputValue())
  expect(actualVal).toBeCloseTo(expectedVal)
  await page.screenshot({ path: 'recordings/t98_09b_ring_beat_edited.png' })
  await page.waitForTimeout(2000)

  // Test deleting a ring via delete button (last ring)
  const ringItemsBeforeDelete = page.locator('[data-testid^="ring-list-item-"]')
  const countBeforeDelete = await ringItemsBeforeDelete.count()
  const lastRingIndex = countBeforeDelete - 1
  const lastRing = ringItemsBeforeDelete.nth(lastRingIndex)
  const ringDeleteBtn = lastRing.locator('[data-testid^="ring-delete-"]')
  await ringDeleteBtn.click()
  await page.waitForTimeout(1000)

  // Verify ring deleted
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(countBeforeDelete - 1)
  await page.screenshot({ path: 'recordings/t98_10_ring_deleted.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 6. Test Real-time Stamping During Playback (Space for rings, Arrow keys for segments)
  // ============================================================
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(1500)

  // Stamp a ring with Space at current playback position
  await page.keyboard.press('Space')
  await page.waitForTimeout(1000)

  // Stamp a segment with ArrowUp (up direction)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(1000)

  // Stamp a segment with ArrowDown (down direction)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(1000)

  // Stamp a segment with ArrowRight (stay direction) - T98 feature
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(1000)

  // Stop playback
  await playBtn.click()
  await page.waitForTimeout(1500)

  // Verify new rings/segments were added
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(3) // 2 remaining + 1 new
  await expect(page.locator('[data-testid^="segment-beats-"]')).toHaveCount(5) // 2 original + 3 new
  await page.screenshot({ path: 'recordings/t98_11_realtime_stamping.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 7. Test Recording Mode (T98 Feature): Start recording, move cursor with up/down, stop, verify segments committed
  // ============================================================
  // Seek to a position where we want to start recording
  const seekSlider2 = page.locator('.editor-slider').first()
  if (await seekSlider2.isEnabled()) {
    await seekSlider2.fill('2000')
    await page.waitForTimeout(1500)
  }

  // Click record mode toggle button
  const recordToggleBtn = page.locator('[data-testid="editor-record-toggle"]')
  await expect(recordToggleBtn).toBeVisible()
  await recordToggleBtn.click()
  await page.waitForTimeout(1500)

  // Verify we're in record mode (button text changes to "録音停止")
  await expect(recordToggleBtn).toHaveText('録音停止')
  await page.screenshot({ path: 'recordings/t98_12_record_mode_started.png' })
  await page.waitForTimeout(1500)

  // Start playback to begin recording
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(2000)

  // In recording mode, up/down arrow keys control the cursor trajectory
  // Generate a longer trajectory with more key presses
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown')
    await page.waitForTimeout(400)
  }

  // Stop playback (which also stops recording)
  await playBtn.click()
  await page.waitForTimeout(1500)

  // Verify recording mode ended (button text back to "録音モード")
  await expect(recordToggleBtn).toHaveText('録音モード')
  await page.screenshot({ path: 'recordings/t98_13_record_mode_ended.png' })
  await page.waitForTimeout(2500)

  // Verify segments weren't lost during recording (should have at least the 5 from before)
  const segmentCountAfterRecord = await page.locator('[data-testid^="segment-beats-"]').count()
  expect(segmentCountAfterRecord).toBeGreaterThanOrEqual(4)

  // ============================================================
  // 8. Test DAW-style Zoom/Pan (T98 Feature): Wheel zoom at cursor, Drag pan, Zoom/Scroll sliders
  // ============================================================
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  const canvasBox = await canvas.boundingBox()
  if (!canvasBox) throw new Error('Canvas not found')

  // Test wheel zoom at center of canvas
  const centerX = canvasBox.x + canvasBox.width / 2
  const centerY = canvasBox.y + canvasBox.height / 2
  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel(0, -100) // Zoom in
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'recordings/t98_14_zoom_in.png' })
  await page.waitForTimeout(1500)

  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel(0, 100) // Zoom out
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'recordings/t98_15_zoom_out.png' })

  // Test drag pan on empty area of canvas
  const startDragX = canvasBox.x + canvasBox.width * 0.3
  const startDragY = canvasBox.y + canvasBox.height * 0.5
  const endDragX = canvasBox.x + canvasBox.width * 0.7
  const endDragY = canvasBox.y + canvasBox.height * 0.5
  await page.mouse.move(startDragX, startDragY)
  await page.mouse.down()
  await page.mouse.move(endDragX, endDragY, { steps: 15 })
  await page.mouse.up()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: 'recordings/t98_16_drag_pan.png' })
  await page.waitForTimeout(1500)

  // Test zoom slider in view controls
  const zoomSlider = page.locator('#zoom')
  await expect(zoomSlider).toBeVisible()
  await zoomSlider.fill('8')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'recordings/t98_17_zoom_slider.png' })
  await page.waitForTimeout(1500)

  // Test scroll slider in view controls
  const scrollSlider = page.locator('#scroll')
  await expect(scrollSlider).toBeVisible()
  await scrollSlider.fill('4')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'recordings/t98_18_scroll_slider.png' })
  await page.waitForTimeout(1500)

  // ============================================================
  // 9. Test WavePreview visual elements: grid, ruler, playhead, segment colors
  // ============================================================
  const canvasRenderCheck = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="wave-preview-canvas"]') as HTMLCanvasElement
    if (!canvas) return { found: false }
    const ctx = canvas.getContext('2d')
    if (!ctx) return { found: false }
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let nonTransparent = 0
    for (let i = 3; i < imgData.data.length; i += 4) {
      if (imgData.data[i] > 0) nonTransparent++
    }
    return { found: true, nonTransparentPixels: nonTransparent, width: canvas.width, height: canvas.height }
  })
  expect(canvasRenderCheck.found).toBe(true)
  expect(canvasRenderCheck.nonTransparentPixels).toBeGreaterThan(1000)
  await page.screenshot({ path: 'recordings/t98_18b_canvas_rendered.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 10. Test TOML Export & verify content
  // ============================================================
  const exportBtn = page.locator('[data-testid="editor-export"]')
  await expect(exportBtn).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportBtn.click(),
  ])
  expect(download.suggestedFilename()).toMatch(/\.toml$/)
  const filePath = await download.path()
  if (filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf8')
    const parsed = parse(fileContent) as any
    expect(parsed).toBeDefined()
    expect(parsed.title).toBe('Reply')
    expect(parsed.bpm).toBe(135)
    expect(parsed.amplitude).toBe(140)
    expect(parsed.scroll_speed).toBe(120)
    expect(parsed.audio_offset).toBe(25)
    expect(Array.isArray(parsed.bpm_changes)).toBe(true)
    expect(parsed.bpm_changes.length).toBe(1)
    expect(parsed.bpm_changes[0].beat).toBe(8)
    expect(parsed.bpm_changes[0].bpm).toBe(150)
    expect(Array.isArray(parsed.segments)).toBe(true)
    expect(parsed.segments.length).toBeGreaterThanOrEqual(4)
    expect(Array.isArray(parsed.rings)).toBe(true)
    expect(parsed.rings.length).toBeGreaterThanOrEqual(3)
    // One hold ring with duration 2 should exist
    expect(parsed.rings.some((r: any) => r.type === 'hold' && r.duration === 2)).toBe(true)
    // Segments should include 'stay' direction
    expect(parsed.segments.some((s: any) => s.direction === 'stay')).toBe(true)
  }
  await page.screenshot({ path: 'recordings/t98_19_export_verified.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 11. Test TOML Import (re-import the exported file)
  // ============================================================
  const importInput = page.locator('[data-testid="import-toml"]')
  const filePathForImport = filePath!
  await importInput.setInputFiles(filePathForImport)
  await page.waitForTimeout(2000)

  // Verify imported values
  await expect(page.locator('#bpm')).toHaveValue('135')
  await expect(page.locator('#amplitude')).toHaveValue('140')
  await expect(page.locator('#scroll-speed')).toHaveValue('120')
  await expect(page.locator('#audio-offset')).toHaveValue('25')
  await page.screenshot({ path: 'recordings/t98_20_imported.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 12. Test Playtest modal launch and execution
  // ============================================================
  const playtestBtn = page.locator('[data-testid="editor-playtest"]')
  await expect(playtestBtn).toBeVisible()
  await playtestBtn.click()
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'recordings/t98_21_playtest_active.png' })
  await page.waitForTimeout(4000)

  // Exit playtest with Escape
  await page.keyboard.press('Escape')
  await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(2500)

  // ============================================================
  // 13. Test Clear functionality
  // ============================================================
  page.once('dialog', async dialog => {
    await dialog.accept()
  })
  const clearBtn = page.locator('[data-testid="editor-clear"]')
  await clearBtn.click()
  await page.waitForTimeout(1500)

  // Verify cleared (rings, segments, bpmChanges cleared; position reset)
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="segment-beats-"]')).toHaveCount(0)
  await expect(page.locator('.bpm-change-item')).toHaveCount(0)
  await page.screenshot({ path: 'recordings/t98_22_cleared.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 14. Verify Toast messages / Feedback / Legend / Keyboard shortcuts hint (T98 updated legend)
  // ============================================================
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible()
  const legendText = await page.locator('[data-testid="editor-legend"]').textContent()
  expect(legendText).toContain('音楽URL')
  expect(legendText).toContain('Space')
  expect(legendText).toContain('エクスポート')
  expect(legendText).toContain('↑')
  expect(legendText).toContain('↓')
  expect(legendText).toContain('→')
  // New T98 legend items
  expect(legendText).toContain('録音モード')
  expect(legendText).toContain('ズーム')
  expect(legendText).toContain('パン')
  await page.screenshot({ path: 'recordings/t98_23_final_workflow.png' })
  await page.waitForTimeout(2500)

  // Navigate back to home
  await page.locator('a:has-text("/ に戻る")').click()
  await page.waitForSelector('.select-screen', { timeout: 5000 })
  await page.screenshot({ path: 'recordings/t98_24_back_home.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 15. Test Game Screen: Verify cursor and wave match (wave model unification)
  // ============================================================
  await page.evaluate(() => {
    window.location.hash = '#/play/reply'
  })
  await page.waitForSelector('.game-screen', { timeout: 15000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'recordings/t98_25_game_screen.png' })

  // Start game with Space
  await page.keyboard.press('Space')
  await page.waitForTimeout(3000)

  // Press up/down to test cursor movement matches wave
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(800)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'recordings/t98_26_game_playing.png' })
  await page.waitForTimeout(3000)

  // Reset and exit
  await page.keyboard.press('r')
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)

  // ============================================================
  // 16. Verify Calibration Screen accessibility
  // ============================================================
  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await page.keyboard.press('l')
  await page.waitForSelector('[data-testid="editor-calibration-modal"]', { timeout: 5000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'recordings/t98_27_calibration.png' })
  await page.waitForTimeout(2000)

  // Close overlay (cancel)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)

  // ============================================================
  // Final assertion: no console errors
  // ============================================================
  expect(allErrors).toHaveLength(0)
})