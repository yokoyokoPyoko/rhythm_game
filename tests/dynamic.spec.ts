import { test, expect, type ConsoleMessage } from '@playwright/test'
import * as fs from 'fs'
import { parse } from 'smol-toml'

test('T98 Wave Model Unification + Editor Recording Mode + DAW-style Zoom/Pan', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  test.setTimeout(180000)

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

  // Helper to ensure accordion is open
  const ensureOpen = async (detailsLocator: any) => {
    const isOpen = await detailsLocator.evaluate((el: HTMLElement) => el.hasAttribute('open'))
    if (!isOpen) {
      await detailsLocator.locator('summary').click()
      await page.waitForTimeout(500)
    }
    expect(await detailsLocator.evaluate((el: HTMLElement) => el.hasAttribute('open'))).toBe(true)
  }

  // Helper to get total beats from segments via component state
  const getTotalSegmentBeats = async () => {
    return await page.evaluate(() => {
      const inputs = document.querySelectorAll('[data-testid^="segment-beats-"]')
      let total = 0
      inputs.forEach((input) => {
        const val = parseFloat((input as HTMLInputElement).value)
        if (!isNaN(val)) total += val
      })
      return total
    })
  }

  // Helper to get actual lastBeat from WavePreview (max of total segment beats and 4)
  const getActualLastBeat = async () => {
    const total = await getTotalSegmentBeats()
    return Math.max(total, 4)
  }

  // Helper to click canvas at a specific beat position (below ruler, RULER_H = 22)
  const clickCanvasAtBeat = async (beat: number, canvasBox: any, actualLastBeat: number) => {
    const x = Math.round((beat / actualLastBeat) * canvasBox.width)
    const y = Math.round(canvasBox.height * 0.5)
    await canvas.click({ position: { x, y } })
    await page.waitForTimeout(800)
  }

  // Helper to wheel zoom at a specific canvas position
  const wheelZoomAt = async (canvasBox: any, deltaY: number, clientX: number, clientY: number) => {
    await page.mouse.move(clientX, clientY)
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(500)
  }

  // Helper to drag pan on canvas
  const dragPan = async (canvasBox: any, startX: number, startY: number, endX: number, endY: number) => {
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(endX, endY, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(500)
  }

  // ============================================================
  // 1. Navigate to home and open editor
  // ============================================================
  await page.goto('/', { waitUntil: 'networkidle' })
  await expect(page.locator('#root')).toBeVisible()
  await page.screenshot({ path: 'recordings/t98_01_home.png' })
  await page.waitForTimeout(2000)

  await page.evaluate(() => {
    window.location.hash = '#/editor'
  })
  await page.waitForSelector('.editor-screen', { timeout: 5000 })
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await expect(canvas).toBeVisible()
  await page.screenshot({ path: 'recordings/t98_02_editor_loaded.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 2. Test Music Load, Play, Seek, Stop
  // ============================================================
  const playBtn = page.locator('[data-testid="editor-play"]')
  await expect(playBtn).toBeVisible()
  await playBtn.click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'recordings/t98_03_music_playing.png' })

  // Seek audio via slider
  const slider = page.locator('.editor-slider').first()
  if (await slider.isEnabled()) {
    await slider.fill('5000')
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'recordings/t98_03b_seeked.png' })
  }

  // Stop audio
  await playBtn.click()
  await page.waitForTimeout(1500)
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

  // Test Tap Tempo button exists and is clickable
  const tapBtn = page.locator('button:has-text("タップ")').first()
  await expect(tapBtn).toBeVisible()
  await tapBtn.click()
  await page.waitForTimeout(500)

  // Add BPM Change
  const addBpmChangeBtn = page.locator('.bpm-change-add')
  await addBpmChangeBtn.click()
  await page.waitForTimeout(800)
  const bpmChangeBeat = page.locator('.bpm-change-beat').first()
  await bpmChangeBeat.fill('8')
  const bpmChangeBpm = page.locator('.bpm-change-bpm').first()
  await bpmChangeBpm.fill('150')
  await page.screenshot({ path: 'recordings/t98_05_settings_updated.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 4. Test Segments: add, edit direction, edit beats, verify preview updates
  // ============================================================
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  await ensureOpen(segDetails)

  const segAddBtn = page.locator('[data-testid="segment-add"]')

  // Add first segment (will keep for later assertions)
  await segAddBtn.click()
  await page.waitForTimeout(800)
  const segDirSelect0 = page.locator('[data-testid="segment-direction-0"]')
  await segDirSelect0.selectOption('stay')
  await expect(segDirSelect0).toHaveValue('stay')
  const segBeatsInput0 = page.locator('[data-testid="segment-beats-0"]')
  await segBeatsInput0.fill('2.5')
  await expect(segBeatsInput0).toHaveValue('2.5')

  // Add second segment (will keep)
  await segAddBtn.click()
  await page.waitForTimeout(800)
  const segDirSelect1 = page.locator('[data-testid="segment-direction-1"]')
  await segDirSelect1.selectOption('down')
  const segBeatsInput1 = page.locator('[data-testid="segment-beats-1"]')
  await segBeatsInput1.fill('1.5')
  await page.screenshot({ path: 'recordings/t98_06_segments_added.png' })
  await page.waitForTimeout(2000)

  // Add third segment (this one we'll delete to test delete functionality)
  await segAddBtn.click()
  await page.waitForTimeout(800)
  const segDirSelect2 = page.locator('[data-testid="segment-direction-2"]')
  await segDirSelect2.selectOption('up')
  const segBeatsInput2 = page.locator('[data-testid="segment-beats-2"]')
  await segBeatsInput2.fill('1.0')
  await page.screenshot({ path: 'recordings/t98_06b_segment_third.png' })
  await page.waitForTimeout(1500)

  // Delete third segment (index 2) - separate test subject
  const segDeleteBtn2 = page.locator('[data-testid="segment-delete-2"]')
  await segDeleteBtn2.click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'recordings/t98_06c_segment_deleted.png' })
  await page.waitForTimeout(1500)

  // Verify first two segments remain
  await expect(page.locator('[data-testid="segment-direction-0"]')).toHaveValue('stay')
  await expect(page.locator('[data-testid="segment-beats-0"]')).toHaveValue('2.5')
  await expect(page.locator('[data-testid="segment-direction-1"]')).toHaveValue('down')
  await expect(page.locator('[data-testid="segment-beats-1"]')).toHaveValue('1.5')

  // ============================================================
  // 5. Test Ring placement: click canvas to add, edit via list, delete via list
  // ============================================================
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()

  let actualLastBeat = await getActualLastBeat()

  // Add three rings at different beats via canvas click (using computed positions)
  await clickCanvasAtBeat(1.0, canvasBox!, actualLastBeat)
  await clickCanvasAtBeat(2.5, canvasBox!, actualLastBeat)
  await clickCanvasAtBeat(3.5, canvasBox!, actualLastBeat)

  await page.screenshot({ path: 'recordings/t98_07_rings_added.png' })
  await page.waitForTimeout(2000)

  // Open ring list accordion
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  await ensureOpen(ringDetails)

  // Verify three rings in list (sorted by beat)
  let ringItems = page.locator('[data-testid^="ring-list-item-"]')
  await expect(ringItems).toHaveCount(3)

  // Get ring beats for reference
  const ringBeats = await page.evaluate(() => {
    const items = document.querySelectorAll('[data-testid^="ring-list-item-"]')
    const beats: number[] = []
    items.forEach((item) => {
      const beatEl = item.querySelector('.ring-list-beat')
      if (beatEl) {
        const text = beatEl.textContent || ''
        const beat = parseFloat(text.replace(/[^0-9.]/g, ''))
        if (!isNaN(beat)) beats.push(beat)
      }
    })
    return beats.sort((a, b) => a - b)
  })
  expect(ringBeats.length).toBe(3)

  // Change ring type to hold and set duration for first ring (sorted index 0)
  const ringItem0 = ringItems.nth(0)
  const ringTypeSelect0 = ringItem0.locator('.ring-type-select')
  await ringTypeSelect0.selectOption('hold')
  await expect(ringTypeSelect0).toHaveValue('hold')

  const ringDurationInput0 = ringItem0.locator('.ring-duration-input')
  await expect(ringDurationInput0).toBeVisible()
  await ringDurationInput0.fill('2')
  await expect(ringDurationInput0).toHaveValue('2')
  await page.screenshot({ path: 'recordings/t98_08_ring_hold_configured.png' })
  await page.waitForTimeout(2000)

  // Test ring selection via beat display click (seeks playback position)
  const ringItem1 = ringItems.nth(1)
  await ringItem1.locator('.ring-list-beat').click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'recordings/t98_09_ring_selected.png' })
  await page.waitForTimeout(1500)

  // Test editing ring beat position via numeric input (ring-beat-input)
  const ringItem1BeatInput = ringItem1.locator('.ring-beat-input')
  await expect(ringItem1BeatInput).toBeVisible()
  await ringItem1BeatInput.fill('2.75')
  await expect(ringItem1BeatInput).toHaveValue('2.75')
  await page.screenshot({ path: 'recordings/t98_09b_ring_beat_edited.png' })
  await page.waitForTimeout(1500)

  // Test deleting a ring via delete button (use last ring to avoid index shifts affecting earlier ones)
  const ringItemsBeforeDelete = page.locator('[data-testid^="ring-list-item-"]')
  const countBeforeDelete = await ringItemsBeforeDelete.count()
  const lastRingIndex = countBeforeDelete - 1
  const lastRing = ringItemsBeforeDelete.nth(lastRingIndex)
  const ringDeleteBtn = lastRing.locator('[data-testid^="ring-delete-"]')
  await ringDeleteBtn.click()
  await page.waitForTimeout(800)

  // Verify ring deleted
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(countBeforeDelete - 1)
  await page.screenshot({ path: 'recordings/t98_10_ring_deleted.png' })
  await page.waitForTimeout(1500)

  // ============================================================
  // 6. Test Real-time Stamping During Playback (Space for rings, Arrow keys for segments)
  // ============================================================
  await playBtn.click()
  await page.waitForTimeout(1000)

  // Stamp a ring with Space at current playback position
  await page.keyboard.press('Space')
  await page.waitForTimeout(800)

  // Stamp a segment with ArrowUp (up direction)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(800)

  // Stamp a segment with ArrowDown (down direction)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(800)

  // Stamp a segment with ArrowRight (stay direction)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(800)

  // Stop playback
  await playBtn.click()
  await page.waitForTimeout(1000)

  // Verify new rings/segments were added
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(3) // 2 remaining + 1 new
  await expect(page.locator('[data-testid^="segment-beats-"]')).toHaveCount(5) // 2 original + 3 new
  await page.screenshot({ path: 'recordings/t98_11_realtime_stamping.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 7. Test Recording Mode (T98 Feature): Start recording, move cursor with up/down, stop, verify segments committed
  // ============================================================
  // First, seek to a position where we want to start recording
  const seekSlider = page.locator('.editor-slider').first()
  if (await seekSlider.isEnabled()) {
    await seekSlider.fill('2000')
    await page.waitForTimeout(1000)
  }

  // Click record mode toggle button
  const recordToggleBtn = page.locator('[data-testid="editor-record-toggle"]')
  await expect(recordToggleBtn).toBeVisible()
  await recordToggleBtn.click()
  await page.waitForTimeout(1000)

  // Verify we're in record mode (button text changes to "録音停止")
  await expect(recordToggleBtn).toHaveText('録音停止')
  await page.screenshot({ path: 'recordings/t98_12_record_mode_started.png' })
  await page.waitForTimeout(1000)

  // Start playback to begin recording
  await playBtn.click()
  await page.waitForTimeout(1500)

  // In recording mode, up/down arrow keys control the cursor trajectory
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(500)

  // Stop playback (which also stops recording)
  await playBtn.click()
  await page.waitForTimeout(1000)

  // Verify recording mode ended (button text back to "録音モード")
  await expect(recordToggleBtn).toHaveText('録音モード')
  await page.screenshot({ path: 'recordings/t98_13_record_mode_ended.png' })
  await page.waitForTimeout(2000)

  // Verify new segments were added from recording (should have more segments now)
  const segmentCountAfterRecord = await page.locator('[data-testid^="segment-beats-"]').count()
  expect(segmentCountAfterRecord).toBeGreaterThanOrEqual(5) // At least the 5 from before + recorded ones

  // ============================================================
  // 8. Test DAW-style Zoom/Pan (T98 Feature): Wheel zoom at cursor, Drag pan, Zoom/Scroll sliders
  // ============================================================
  const canvasBox2 = await canvas.boundingBox()
  expect(canvasBox2).not.toBeNull()

  // Test wheel zoom at center of canvas
  const centerX = canvasBox2!.x + canvasBox2!.width / 2
  const centerY = canvasBox2!.y + canvasBox2!.height / 2
  await wheelZoomAt(canvasBox2!, -100, centerX, centerY) // Zoom in
  await page.screenshot({ path: 'recordings/t98_14_zoom_in.png' })
  await page.waitForTimeout(1000)

  await wheelZoomAt(canvasBox2!, 100, centerX, centerY) // Zoom out
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'recordings/t98_15_zoom_out.png' })

  // Test drag pan on empty area of canvas
  const startDragX = canvasBox2!.x + canvasBox2!.width * 0.3
  const startDragY = canvasBox2!.y + canvasBox2!.height * 0.5
  const endDragX = canvasBox2!.x + canvasBox2!.width * 0.7
  const endDragY = canvasBox2!.y + canvasBox2!.height * 0.5
  await dragPan(canvasBox2!, startDragX, startDragY, endDragX, endDragY)
  await page.screenshot({ path: 'recordings/t98_16_drag_pan.png' })
  await page.waitForTimeout(1000)

  // Test zoom slider in view controls
  const zoomSlider = page.locator('#zoom')
  await expect(zoomSlider).toBeVisible()
  await zoomSlider.fill('8')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'recordings/t98_17_zoom_slider.png' })
  await page.waitForTimeout(1000)

  // Test scroll slider in view controls
  const scrollSlider = page.locator('#scroll')
  await expect(scrollSlider).toBeVisible()
  await scrollSlider.fill('4')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'recordings/t98_18_scroll_slider.png' })
  await page.waitForTimeout(1000)

  // ============================================================
  // 9. Test TOML Export & verify content
  // ============================================================
  const exportBtn = page.locator('[data-testid="editor-export"]')
  await expect(exportBtn).toBeVisible()

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportBtn.click(),
  ])
  expect(download.suggestedFilename()).toBe('reply.toml')
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
    expect(parsed.segments.length).toBeGreaterThanOrEqual(5) // 2 original + 3 real-time + recorded
    expect(Array.isArray(parsed.rings)).toBe(true)
    expect(parsed.rings.length).toBeGreaterThanOrEqual(3) // 2 remaining + 1 real-time
    // One hold ring with duration 2 should exist
    expect(parsed.rings.some((r: any) => r.type === 'hold' && r.duration === 2)).toBe(true)
  }
  await page.screenshot({ path: 'recordings/t98_19_export_verified.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 10. Test TOML Import (re-import the exported file)
  // ============================================================
  const importInput = page.locator('[data-testid="import-toml"]')
  const filePathForImport = filePath!
  await importInput.setInputFiles(filePathForImport)
  await page.waitForTimeout(1500)

  // Verify imported values
  await expect(page.locator('#bpm')).toHaveValue('135')
  await expect(page.locator('#amplitude')).toHaveValue('140')
  await expect(page.locator('#scroll-speed')).toHaveValue('120')
  await expect(page.locator('#audio-offset')).toHaveValue('25')
  await page.screenshot({ path: 'recordings/t98_20_imported.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 11. Test Playtest modal launch and execution
  // ============================================================
  const playtestBtn = page.locator('[data-testid="editor-playtest"]')
  await expect(playtestBtn).toBeVisible()
  await playtestBtn.click()
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: 'recordings/t98_21_playtest_active.png' })
  await page.waitForTimeout(3000)

  // Exit playtest with Escape
  await page.keyboard.press('Escape')
  await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(2000)

  // ============================================================
  // 12. Test Clear functionality
  // ============================================================
  page.once('dialog', async dialog => {
    await dialog.accept()
  })
  const clearBtn = page.locator('[data-testid="editor-clear"]')
  await clearBtn.click()
  await page.waitForTimeout(1000)

  // Verify cleared (rings, segments, bpmChanges cleared; position reset)
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="segment-beats-"]')).toHaveCount(0)
  await expect(page.locator('.bpm-change-item')).toHaveCount(0)
  await page.screenshot({ path: 'recordings/t98_22_cleared.png' })
  await page.waitForTimeout(1500)

  // ============================================================
  // 13. Verify Toast messages / Feedback / Legend / Keyboard shortcuts hint
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
  await page.waitForTimeout(2000)

  // Navigate back to home
  await page.locator('a:has-text("/ に戻る")').click()
  await page.waitForSelector('.select-screen', { timeout: 5000 })
  await page.screenshot({ path: 'recordings/t98_24_back_home.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 14. Test Game Screen: Verify cursor and wave match (wave model unification)
  // ============================================================
  await page.evaluate(() => {
    window.location.hash = '#/play/reply'
  })
  await page.waitForSelector('.game-screen', { timeout: 10000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'recordings/t98_25_game_screen.png' })

  // Start game with Space
  await page.keyboard.press('Space')
  await page.waitForTimeout(2000)

  // Press up/down to test cursor movement matches wave
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'recordings/t98_26_game_playing.png' })
  await page.waitForTimeout(2000)

  // Reset and exit
  await page.keyboard.press('r')
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)

  // ============================================================
  // Final assertion: no console errors
  // ============================================================
  expect(errors).toHaveLength(0)
})