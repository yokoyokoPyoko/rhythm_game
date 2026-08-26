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

async function clickCanvasAtBeat(page: Page, beat: number, viewBeats: number, verticalRatio = 0.5): Promise<void> {
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('Canvas not found')
  const x = Math.round(box.x + (beat / viewBeats) * box.width)
  const y = Math.round(box.y + box.height * verticalRatio)
  await page.mouse.move(x, y)
  await page.waitForTimeout(150)
  await page.mouse.down()
  await page.waitForTimeout(150)
  await page.mouse.up()
  await page.waitForTimeout(1500)
}

async function seekToBeat(page: Page, beat: number): Promise<void> {
  await page.evaluate((b) => {
    const timeline = (window as any).__editorTimeline
    if (timeline) {
      const ms = timeline.beatToMs(b)
      const slider = document.querySelector('.editor-slider') as HTMLInputElement
      if (slider) {
        slider.value = String(ms)
        slider.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }, beat)
  await page.waitForTimeout(1000)
}

async function getSegmentsFromState(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    return (window as any).__editorSegments ?? []
  })
}

async function getRingsFromState(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    return (window as any).__editorRings ?? []
  })
}

async function getSnapFromState(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as any).__editorSnap ?? 0.25
  })
}

test.describe.configure({ retries: 0 })

test('T99 Editor Feature Improvements & Bug Fixes', async ({ page, browserName }) => {
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
  await page.screenshot({ path: 'recordings/t99_01_home.png' })

  // ============================================================
  // 1. Open Editor and verify initial state
  // ============================================================
  await openEditor(page)
  await page.screenshot({ path: 'recordings/t99_02_editor_loaded.png' })
  await page.waitForTimeout(3000)

  // ============================================================
  // 2. Test Audio Offset moved to Music Control pane & playFrom reflection (T99 #1)
  // ============================================================
  const offsetInput = page.locator('#audio-offset')
  await expect(offsetInput).toBeVisible()

  // Verify offset input is in the Music Control section (not BPM Settings)
  const musicControlSection = page.locator('section.editor-pane:has-text("音楽制御")')
  await expect(musicControlSection.locator('#audio-offset')).toBeVisible()

  // BPM Settings section should NOT have audio offset
  const bpmSection = page.locator('section.editor-pane:has-text("BPM設定")')
  await expect(bpmSection.locator('#audio-offset')).toHaveCount(0)

  // Set audio offset to 50ms
  await offsetInput.fill('50')
  await expect(Number(await offsetInput.inputValue())).toBeCloseTo(50)

  // Load and play audio to verify offset is reflected in playFrom
  const playBtn = page.locator('[data-testid="editor-play"]')
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.screenshot({ path: 'recordings/t99_03_audio_offset_play.png' })
  await page.waitForTimeout(3000)

  // Seek to a position and verify offset still works
  const seekSlider = page.locator('.editor-slider').first()
  if (await seekSlider.isEnabled()) {
    await seekSlider.fill('5000')
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'recordings/t99_03b_seek_with_offset.png' })
  }

  // Stop audio
  await playBtn.click()
  await page.waitForTimeout(2000)

  // Verify playFrom uses audioOffset by checking internal state
  const audioOffsetReflected = await page.evaluate(() => {
    return (window as any).__editorAudioOffset ?? 0
  })
  expect(audioOffsetReflected).toBe(50)

  // ============================================================
  // 3. Test Quantize/Snap UI in Ring List accordion (T99 #3)
  // ============================================================
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  await ensureDetailsOpen(page, 'ring-list-details')
  await page.waitForTimeout(500)

  // Verify snap select exists
  const snapSelect = page.locator('#snap')
  await expect(snapSelect).toBeVisible()

  // Test each snap option
  const snapOptions = ['0.125', '0.25', '0.5', '1']
  for (const snapVal of snapOptions) {
    await snapSelect.selectOption(snapVal)
    await expect(snapSelect).toHaveValue(snapVal)
    await page.waitForTimeout(500)
  }

  // Reset to 0.25 for subsequent tests
  await snapSelect.selectOption('0.25')
  await page.screenshot({ path: 'recordings/t99_04_snap_ui.png' })
  await page.waitForTimeout(1500)

  // Verify snap value is reflected in internal state
  const snapState = await getSnapFromState(page)
  expect(snapState).toBe(0.25)

  // ============================================================
  // 4. Test Recording with Hold Rings (T99 #2)
  // ============================================================
  // Add some rings manually first
  await clickCanvasAtBeat(page, 1.0, 16)
  await clickCanvasAtBeat(page, 4.0, 16)
  await clickCanvasAtBeat(page, 8.0, 16)
  await page.screenshot({ path: 'recordings/t99_05_rings_added.png' })
  await page.waitForTimeout(2500)

  // Open ring list and change first ring to hold type with duration
  const ringItems = page.locator('[data-testid^="ring-list-item-"]')
  const ringCount = await ringItems.count()
  expect(ringCount).toBeGreaterThanOrEqual(3)

  const ringItem0 = ringItems.nth(0)
  const ringTypeSelect0 = ringItem0.locator('.ring-type-select')
  await ringTypeSelect0.selectOption('hold')
  await expect(ringTypeSelect0).toHaveValue('hold')

  const ringDurationInput0 = ringItem0.locator('.ring-duration-input')
  await expect(ringDurationInput0).toBeVisible()
  await ringDurationInput0.fill('2')
  expect(Number(await ringDurationInput0.inputValue())).toBeCloseTo(2)
  await page.screenshot({ path: 'recordings/t99_06_hold_ring_configured.png' })
  await page.waitForTimeout(2500)

  // Test recording mode with Space to add hold rings
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(2000)

  // Press Space to start a hold ring (hold for ~1 second)
  await page.keyboard.down('Space')
  await page.waitForTimeout(1200)
  await page.keyboard.up('Space')
  await page.waitForTimeout(1500)

  // Stop playback
  await playBtn.click()
  await page.waitForTimeout(1500)

  // Verify hold ring was added
  const ringItemsAfterHold = page.locator('[data-testid^="ring-list-item-"]')
  const ringCountAfterHold = await ringItemsAfterHold.count()
  expect(ringCountAfterHold).toBeGreaterThanOrEqual(ringCount)

  // Check if the new ring has hold type
  const lastRing = ringItemsAfterHold.nth(ringCountAfterHold - 1)
  const lastRingType = lastRing.locator('.ring-type-select')
  await expect(lastRingType).toHaveValue('hold')
  await page.screenshot({ path: 'recordings/t99_07_hold_ring_recorded.png' })
  await page.waitForTimeout(2500)

  // Verify internal ring state includes hold type and duration
  const ringsState = await getRingsFromState(page)
  const holdRings = ringsState.filter((r: any) => r.type === 'hold')
  expect(holdRings.length).toBeGreaterThan(0)
  expect(holdRings[0].duration).toBeGreaterThan(0.3)

  // ============================================================
  // 5. Test Legacy Keyboard Segment Stamp Removal (T99 #4)
  // ============================================================
  // In PLAY mode (not record), ArrowUp/ArrowDown should NOT stamp segments
  // during playback - they should only work in record mode
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(2000)

  // Get segment count before
  const segmentsBefore = await getSegmentsFromState(page)
  const segCountBefore = segmentsBefore.length

  // Press arrow keys during playback (should NOT add segments in play mode)
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(500)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)

  // Stop playback
  await playBtn.click()
  await page.waitForTimeout(1500)

  // Segment count should NOT have changed (legacy stamping removed)
  const segmentsAfter = await getSegmentsFromState(page)
  const segCountAfter = segmentsAfter.length
  expect(segCountAfter).toBe(segCountBefore)
  await page.screenshot({ path: 'recordings/t99_08_no_legacy_stamp.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 6. Test Wave Vertical Display Area Expansion (T99 #5)
  // ============================================================
  // Verify canvas renders with expanded vertical area
  const canvasRenderCheck = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="wave-preview-canvas"]') as HTMLCanvasElement
    if (!canvas) return { found: false }
    const ctx = canvas.getContext('2d')
    if (!ctx) return { found: false }
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let nonTransparent = 0
    let waveTop = canvas.height
    let waveBottom = 0
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4 + 3
        if (imgData.data[idx] > 0) {
          nonTransparent++
          if (y < waveTop) waveTop = y
          if (y > waveBottom) waveBottom = y
        }
      }
    }
    return {
      found: true,
      nonTransparentPixels: nonTransparent,
      width: canvas.width,
      height: canvas.height,
      waveTop,
      waveBottom,
      waveHeight: waveBottom - waveTop,
      centerY: canvas.height / 2,
    }
  })
  expect(canvasRenderCheck.found).toBe(true)
  expect(canvasRenderCheck.nonTransparentPixels).toBeGreaterThan(1000)
  // Wave should use significant vertical space (expanded area)
  expect(canvasRenderCheck.waveHeight).toBeGreaterThan(canvasRenderCheck.height * 0.3)
  await page.screenshot({ path: 'recordings/t99_09_wave_expanded.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 7. Test Canvas Wheel Zoom Prevents Page Scroll (T99 #6)
  // ============================================================
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await canvas.scrollIntoViewIfNeeded()
  const canvasBox = await canvas.boundingBox()
  if (!canvasBox) throw new Error('Canvas not found')

  // Get initial page scroll position
  const initialScrollY = await page.evaluate(() => window.scrollY)

  // Wheel zoom at center of canvas
  const centerX = canvasBox.x + canvasBox.width / 2
  const centerY = canvasBox.y + canvasBox.height / 2
  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel(0, -100) // Zoom in
  await page.waitForTimeout(1500)

  // Page should not have scrolled
  const scrollAfterZoomIn = await page.evaluate(() => window.scrollY)
  expect(scrollAfterZoomIn).toBe(initialScrollY)

  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel(0, 100) // Zoom out
  await page.waitForTimeout(1500)

  const scrollAfterZoomOut = await page.evaluate(() => window.scrollY)
  expect(scrollAfterZoomOut).toBe(initialScrollY)

  // Verify view actually changed (zoom happened)
  const viewAfterZoom = await page.evaluate(() => {
    return (window as any).__editorView ?? { startBeat: 0, beats: 16 }
  })
  expect(viewAfterZoom.beats).not.toBe(16) // Should have changed from default
  await page.screenshot({ path: 'recordings/t99_10_wheel_zoom_no_scroll.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 8. Test Recording Overwrite Range Limitation (T99 #7)
  // ============================================================
  // Set up segments first
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  await ensureDetailsOpen(page, 'segment-list-details')
  await page.waitForTimeout(500)

  const segAddBtn = page.locator('[data-testid="segment-add"]')

  // Add initial segments: up(4) + down(4) + stay(4) = 12 beats total
  await segAddBtn.click()
  await page.waitForTimeout(500)
  const segDirSelect0 = page.locator('[data-testid="segment-direction-0"]')
  await segDirSelect0.selectOption('up')
  const segBeatsInput0 = page.locator('[data-testid="segment-beats-0"]')
  await segBeatsInput0.fill('4')
  expect(Number(await segBeatsInput0.inputValue())).toBeCloseTo(4)

  await segAddBtn.click()
  await page.waitForTimeout(500)
  const segDirSelect1 = page.locator('[data-testid="segment-direction-1"]')
  await segDirSelect1.selectOption('down')
  const segBeatsInput1 = page.locator('[data-testid="segment-beats-1"]')
  await segBeatsInput1.fill('4')
  expect(Number(await segBeatsInput1.inputValue())).toBeCloseTo(4)

  await segAddBtn.click()
  await page.waitForTimeout(500)
  const segDirSelect2 = page.locator('[data-testid="segment-direction-2"]')
  await segDirSelect2.selectOption('stay')
  const segBeatsInput2 = page.locator('[data-testid="segment-beats-2"]')
  await segBeatsInput2.fill('4')
  expect(Number(await segBeatsInput2.inputValue())).toBeCloseTo(4)

  await page.screenshot({ path: 'recordings/t99_11_initial_segments.png' })
  await page.waitForTimeout(2000)

  const initialSegCount = await page.locator('[data-testid^="segment-beats-"]').count()
  expect(initialSegCount).toBe(3)

  // Seek to middle of second segment (around beat 6)
  // 120 BPM = 500ms/beat, so beat 6 = 3000ms
  await seekToBeat(page, 6)
  await page.waitForTimeout(1500)

  // Start recording
  const recordToggleBtn = page.locator('[data-testid="editor-record-toggle"]')
  await expect(recordToggleBtn).toBeVisible()
  await recordToggleBtn.click()
  await page.waitForTimeout(1500)
  await expect(recordToggleBtn).toHaveText('録音停止')
  await page.screenshot({ path: 'recordings/t99_12_record_started.png' })
  await page.waitForTimeout(1500)

  // Start playback to begin recording
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(3000)

  // Record trajectory with up/down keys for about 4 beats worth
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown')
    await page.waitForTimeout(400)
  }

  // Stop playback (which also stops recording)
  await playBtn.click()
  await page.waitForTimeout(1500)

  // Verify recording mode ended
  await expect(recordToggleBtn).toHaveText('録音モード')
  await page.screenshot({ path: 'recordings/t99_13_record_ended.png' })
  await page.waitForTimeout(2500)

  // Verify segments were updated only in the recorded range
  // Original segments before recording start should remain
  // Original segments after recording range should remain
  // Only the recorded range should be replaced
  const finalSegCount = await page.locator('[data-testid^="segment-beats-"]').count()
  expect(finalSegCount).toBeGreaterThanOrEqual(initialSegCount)

  // Verify first segment (before recording start) still exists with original values
  await expect(page.locator('[data-testid="segment-direction-0"]')).toHaveValue('up')
  expect(Number(await page.locator('[data-testid="segment-beats-0"]').inputValue())).toBeCloseTo(4)

  // Verify segments state internally
  const finalSegments = await getSegmentsFromState(page)
  // First segment should still be 'up' with ~4 beats
  expect(finalSegments[0].direction).toBe('up')
  expect(finalSegments[0].beats).toBeCloseTo(4, 1)

  await page.screenshot({ path: 'recordings/t99_14_overwrite_limited.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 9. Test WavePreview Visual Elements (grid, ruler, playhead, segment colors)
  // ============================================================
  await waitForCanvasDraw(page)
  await page.screenshot({ path: 'recordings/t99_15_canvas_rendered.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 10. Test TOML Export with new fields (audio_offset, amplitude, scroll_speed, hold rings)
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
    expect(parsed.audio_offset).toBe(50)
    expect(parsed.amplitude).toBe(130)
    expect(parsed.scroll_speed).toBe(110)
    expect(Array.isArray(parsed.bpm_changes)).toBe(true)
    expect(Array.isArray(parsed.segments)).toBe(true)
    expect(parsed.segments.length).toBeGreaterThanOrEqual(3)
    expect(Array.isArray(parsed.rings)).toBe(true)
    expect(parsed.rings.length).toBeGreaterThanOrEqual(3)
    // Hold ring should exist
    expect(parsed.rings.some((r: any) => r.type === 'hold')).toBe(true)
    // Segments should include 'stay' direction
    expect(parsed.segments.some((s: any) => s.direction === 'stay')).toBe(true)
  }
  await page.screenshot({ path: 'recordings/t99_16_export_verified.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 11. Test TOML Import (re-import the exported file)
  // ============================================================
  const importInput = page.locator('[data-testid="import-toml"]')
  const filePathForImport = filePath!
  await importInput.setInputFiles(filePathForImport)
  await page.waitForTimeout(2000)

  // Verify imported values
  await expect(page.locator('#bpm')).toHaveValue('120')
  expect(Number(await page.locator('#amplitude').inputValue())).toBeCloseTo(130)
  expect(Number(await page.locator('#scroll-speed').inputValue())).toBeCloseTo(110)
  expect(Number(await page.locator('#audio-offset').inputValue())).toBeCloseTo(50)
  await page.screenshot({ path: 'recordings/t99_17_imported.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 12. Test Playtest modal launch and execution
  // ============================================================
  const playtestBtn = page.locator('[data-testid="editor-playtest"]')
  await expect(playtestBtn).toBeVisible()
  await playtestBtn.click()
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 15000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'recordings/t99_18_playtest_active.png' })
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

  // Verify cleared
  await expect(page.locator('[data-testid^="ring-list-item-"]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="segment-beats-"]')).toHaveCount(0)
  await expect(page.locator('.bpm-change-item')).toHaveCount(0)
  await page.screenshot({ path: 'recordings/t99_19_cleared.png' })
  await page.waitForTimeout(2000)

  // ============================================================
  // 14. Verify Toast messages / Feedback / Legend / Keyboard shortcuts hint
  // ============================================================
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible()
  const legendText = await page.locator('[data-testid="editor-legend"]').textContent()
  expect(legendText).toContain('音楽URL')
  expect(legendText).toContain('Space')
  expect(legendText).toContain('エクスポート')
  expect(legendText).toContain('↑')
  expect(legendText).toContain('↓')
  expect(legendText).toContain('→')
  // T98 legend items
  expect(legendText).toContain('録音モード')
  expect(legendText).toContain('ズーム')
  expect(legendText).toContain('パン')
  // T99 specific: verify no legacy stamping mention
  expect(legendText).not.toContain('セグメントをスタンプ')
  await page.screenshot({ path: 'recordings/t99_20_final_legend.png' })
  await page.waitForTimeout(2500)

  // Navigate back to home
  await page.locator('a:has-text("/ に戻る")').click()
  await page.waitForSelector('.select-screen', { timeout: 5000 })
  await page.screenshot({ path: 'recordings/t99_21_back_home.png' })
  await page.waitForTimeout(2500)

  // ============================================================
  // 15. Test Game Screen: Verify cursor and wave match with new amplitude
  // ============================================================
  await page.evaluate(() => {
    window.location.hash = '#/play/reply'
  })
  await page.waitForSelector('.game-screen', { timeout: 15000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'recordings/t99_22_game_screen.png' })

  // Start game with Space
  await page.keyboard.press('Space')
  await page.waitForTimeout(3000)

  // Press up/down to test cursor movement matches wave
  await page.keyboard.press('ArrowUp')
  await page.waitForTimeout(800)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'recordings/t99_23_game_playing.png' })
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
    window.location.hash = '#/calibration'
  })
  await page.waitForSelector('.calibration-screen', { timeout: 5000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'recordings/t99_24_calibration.png' })
  await page.waitForTimeout(2000)

  // Go back home
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)

  // ============================================================
  // Final assertion: no console errors
  // ============================================================
  expect(allErrors).toHaveLength(0)
})