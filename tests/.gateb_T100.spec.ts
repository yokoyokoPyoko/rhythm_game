import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'
import * as fs from 'fs'
import { parse } from 'smol-toml'

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

async function getRingsFromState(page: Page): Promise<Array<{ beat: number; type?: string; duration?: number }>> {
  return page.evaluate(() => (window as any).__editorRings ?? [])
}

async function getSegmentsFromState(page: Page): Promise<Array<{ direction: string; beats: number }>> {
  return page.evaluate(() => (window as any).__editorSegments ?? [])
}

async function getSnapFromState(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__editorSnap ?? 0.25)
}

async function getBeatFromState(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__editorBeat ?? 0)
}

// Ensure playback is running. If already playing, do nothing (do NOT stop,
// because stopping would auto-commit any active recording and flip the mode).
async function startPlayback(page: Page, playBtn: any): Promise<void> {
  const txt = await playBtn.textContent()
  if (txt?.includes('停止')) return
  await playBtn.click()
  await waitForAudioLoaded(page)
}

async function stopPlayback(page: Page, playBtn: any): Promise<void> {
  const txt = await playBtn.textContent()
  if (txt?.includes('停止')) {
    await playBtn.click()
    await page.waitForTimeout(800)
  }
}

test.describe.configure({ retries: 0 })

test('T100 Editor Recording: hold ring creation on Space press/release and trajectory-based hold generation', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  test.setTimeout(300000)

  const baseURL = process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/'
  const allErrors = await collectErrors(page)

  // 0. Wait for dev server
  let retries = 0
  while (retries < 30) {
    try {
      const resp = await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 5000 })
      if (resp?.ok()) break
    } catch {
      // ignore
    }
    await page.waitForTimeout(1000)
    retries++
  }
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForTimeout(2500)

  // 1. Open Editor
  await openEditor(page)
  await page.waitForTimeout(3000)

  const playBtn = page.locator('[data-testid="editor-play"]')
  const recordBtn = page.locator('[data-testid="editor-record-toggle"]')

  // 2. Load audio
  await expect(playBtn).toBeVisible()
  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(3000)

  // 3. Initial state
  let rings = await getRingsFromState(page)
  expect(rings.length).toBe(0)

  const snap = await getSnapFromState(page)

  // helper to seek by beat (120 BPM => 500ms/beat)
  const seekToBeat = async (beat: number) => {
    const slider = page.locator('.editor-slider').first()
    await slider.fill(String(beat * 500))
    // Blur the slider so Space keydown is not swallowed by the editable guard.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.waitForTimeout(1200)
  }

  // ============================================================
  // 4. Trajectory-based segment generation (up/down).
  //    Done first while the waveform is empty so the recording starts
  //    from the center and both up and down movement are possible.
  // ============================================================
  await recordBtn.click()
  await page.waitForTimeout(1000)
  await expect(recordBtn).toHaveClass(/editor-record-active/)
  await startPlayback(page, playBtn)
  await page.waitForTimeout(2000)

  await page.keyboard.down('ArrowUp')
  await page.waitForTimeout(2000)
  await page.keyboard.up('ArrowUp')
  await page.waitForTimeout(1000)
  await page.keyboard.down('ArrowDown')
  await page.waitForTimeout(2000)
  await page.keyboard.up('ArrowDown')
  await page.waitForTimeout(1000)

  await recordBtn.click()
  await page.waitForTimeout(2000)

  const segments = await getSegmentsFromState(page)
  expect(segments.length).toBeGreaterThan(0)
  const directions = segments.map((s) => s.direction)
  expect(directions).toContain('up')
  expect(directions).toContain('down')

  // ============================================================
  // 5. Hold ring via Space hold (~4 beats).
  // ============================================================
  await recordBtn.click()
  await page.waitForTimeout(1000)
  await startPlayback(page, playBtn)
  await page.waitForTimeout(2000)

  const holdStartBeat = 4.0
  await seekToBeat(holdStartBeat)
  const holdLiveBeat = await getBeatFromState(page)
  await page.keyboard.down('Space')
  await page.waitForTimeout(2000)
  await page.keyboard.up('Space')
  await page.waitForTimeout(2000)

  await recordBtn.click()
  await page.waitForTimeout(2000)

  rings = await getRingsFromState(page)
  expect(rings.length).toBeGreaterThanOrEqual(1)
  const holdRing = rings.find((r) => r.type === 'hold')
  expect(holdRing).toBeDefined()
  expect(holdRing!.type).toBe('hold')
  expect(Number.isFinite(holdRing!.duration)).toBe(true)
  expect(holdRing!.duration).toBeGreaterThan(0.3)
  expect(holdRing!.beat).toBeCloseTo(Math.round(holdLiveBeat / snap) * snap, 2)
  expect(holdRing!.duration).toBeCloseTo(Math.round(holdRing!.duration! / snap) * snap, 2)

  // ============================================================
  // 6. Single ring via quick Space press.
  // ============================================================
  await recordBtn.click()
  await page.waitForTimeout(1000)
  await startPlayback(page, playBtn)
  await page.waitForTimeout(2000)

  const singleBeat = 8.0
  await seekToBeat(singleBeat)
  const singleLiveBeat = await getBeatFromState(page)
  await page.keyboard.down('Space')
  await page.waitForTimeout(100)
  await page.keyboard.up('Space')
  await page.waitForTimeout(1500)

  await recordBtn.click()
  await page.waitForTimeout(2000)

  rings = await getRingsFromState(page)
  const singleRing = rings.find((r) => r.type === 'single' || r.type === undefined)
  expect(singleRing).toBeDefined()
  expect(singleRing!.type !== 'hold').toBe(true)
  expect(Math.abs(singleRing!.beat - Math.round(singleLiveBeat / snap) * snap)).toBeLessThanOrEqual(snap)

  // ============================================================
  // 7. Ring list UI reflects hold ring.
  // ============================================================
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  await expect(ringDetails).toBeVisible()
  const isOpen = await ringDetails.evaluate((el) => (el as HTMLDetailsElement).open)
  if (!isOpen) {
    await ringDetails.locator('summary').click()
    await page.waitForTimeout(1000)
  }
  const holdRingItems = ringDetails.locator('.ring-duration-input')
  expect(await holdRingItems.count()).toBeGreaterThanOrEqual(1)
  const durationInput = ringDetails.locator('.ring-duration-input')
  await expect(durationInput).toBeVisible()

  // ============================================================
  // 8. Canvas renders hold ring.
  // ============================================================
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await expect(canvas).toBeVisible()

  // ============================================================
  // 9. TOML export includes hold ring.
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
    expect(Array.isArray(parsed.rings)).toBe(true)
    expect(parsed.rings.some((r: any) => r.type === 'hold' && Number.isFinite(r.duration) && r.duration > 0.3)).toBe(true)
  }
  await page.waitForTimeout(1000)

  await stopPlayback(page, playBtn)
  await page.waitForTimeout(2000)

  expect(allErrors).toHaveLength(0)
})
