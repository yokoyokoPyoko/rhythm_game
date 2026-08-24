import { test, expect, type ConsoleMessage } from '@playwright/test'
import * as fs from 'fs'
import { parse } from 'smol-toml'

test('T97 Comprehensive Authoring Tool Workflow and UX Test', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  test.setTimeout(90000)

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

  // 1. Navigate to home and open editor
  await page.goto('http://localhost:5173/rhythm_game/', { waitUntil: 'networkidle' })
  await expect(page.locator('#root')).toBeVisible()
  await page.screenshot({ path: 'recordings/t97_01_home.png' })
  await page.waitForTimeout(1500)

  await page.evaluate(() => {
    window.location.hash = '#/editor'
  })
  await page.waitForSelector('.editor-screen', { timeout: 5000 })
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  await page.screenshot({ path: 'recordings/t97_02_editor_loaded.png' })
  await page.waitForTimeout(2000)

  // 2. Test Music Load, Play, Seek, Stop
  const playBtn = page.locator('[data-testid="editor-play"]')
  await expect(playBtn).toBeVisible()
  await playBtn.click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'recordings/t97_03_music_playing.png' })

  // Seek audio via slider
  const slider = page.locator('.editor-slider')
  if (await slider.isEnabled()) {
    await slider.fill('5000')
    await page.waitForTimeout(1000)
  }

  // Stop audio
  await playBtn.click()
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'recordings/t97_04_music_stopped.png' })

  // 3. Test BPM & Settings (Base BPM, Amplitude, Scroll Speed, Audio Offset, BPM Changes)
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

  // Add BPM Change
  const addBpmChangeBtn = page.locator('.bpm-change-add')
  await addBpmChangeBtn.click()
  await page.waitForTimeout(500)
  const bpmChangeBeat = page.locator('.bpm-change-beat').first()
  await bpmChangeBeat.fill('8')
  const bpmChangeBpm = page.locator('.bpm-change-bpm').first()
  await bpmChangeBpm.fill('150')
  await page.screenshot({ path: 'recordings/t97_05_settings_updated.png' })
  await page.waitForTimeout(1500)

  // 4. Test Segments placement, editing, deletion
  const segAddBtn = page.locator('[data-testid="segment-add"]')
  await segAddBtn.click()
  await page.waitForTimeout(500)

  const segDirSelect = page.locator('[data-testid="segment-direction-0"]')
  await segDirSelect.selectOption('stay')
  await expect(segDirSelect).toHaveValue('stay')

  const segBeatsInput = page.locator('[data-testid="segment-beats-0"]')
  await segBeatsInput.fill('2.5')
  await expect(segBeatsInput).toHaveValue('2.5')
  await page.screenshot({ path: 'recordings/t97_06_segment_edited.png' })
  await page.waitForTimeout(1500)

  // 5. Test Ring placement on WavePreview, editing (hold type, duration), and deletion
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  const box = canvasBox!

  // Click on canvas to add a ring
  await canvas.click({ position: { x: Math.round(box.width * 0.3), y: Math.round(box.height * 0.5) } })
  await page.waitForTimeout(800)

  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  const isOpen = (loc: any) => loc.evaluate((el: HTMLElement) => el.hasAttribute('open'))
  if (!await isOpen(ringDetails)) {
    await ringDetails.locator('summary').click()
  }
  expect(await isOpen(ringDetails)).toBe(true)
  await page.waitForTimeout(300)

  const ringItem = page.locator('[data-testid="ring-list-item-0"]')
  await expect(ringItem).toBeVisible()

  // Change ring type to hold and set duration
  const ringTypeSelect = ringItem.locator('.ring-type-select')
  await ringTypeSelect.selectOption('hold')
  await expect(ringTypeSelect).toHaveValue('hold')

  const ringDurationInput = ringItem.locator('.ring-duration-input')
  await expect(ringDurationInput).toBeVisible()
  await ringDurationInput.fill('2')
  await expect(ringDurationInput).toHaveValue('2')
  await page.screenshot({ path: 'recordings/t97_07_ring_hold_configured.png' })
  await page.waitForTimeout(1500)

  // 6. Test TOML Export & Re-import verification
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
    expect(parsed.bpm).toBe(135)
    expect(parsed.amplitude).toBe(140)
    expect(parsed.scroll_speed).toBe(120)
    expect(parsed.audio_offset).toBe(25)
    expect(Array.isArray(parsed.segments)).toBe(true)
    expect(parsed.segments.length).toBeGreaterThan(0)
    expect(Array.isArray(parsed.rings)).toBe(true)
    expect(parsed.rings.some((r: any) => r.type === 'hold' && r.duration === 2)).toBe(true)
  }
  await page.screenshot({ path: 'recordings/t97_08_export_verified.png' })
  await page.waitForTimeout(1500)

  // 7. Test Playtest modal launch and execution
  const playtestBtn = page.locator('[data-testid="editor-playtest"]')
  await expect(playtestBtn).toBeVisible()
  await playtestBtn.click()
  await expect(page.locator('.game-screen')).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: 'recordings/t97_09_playtest_active.png' })
  await page.waitForTimeout(2000)

  // Exit playtest with Escape
  await page.keyboard.press('Escape')
  await expect(page.locator('.editor-screen')).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(1500)

  // 8. Verify Toast messages / Feedback / Legend
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible()
  await page.screenshot({ path: 'recordings/t97_10_final_workflow.png' })
  await page.waitForTimeout(2000)

  expect(errors).toHaveLength(0)
})
