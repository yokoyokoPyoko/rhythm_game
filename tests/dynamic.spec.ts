import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'

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

async function startPlayback(page: Page): Promise<void> {
  await page.click('[data-testid="editor-play"]')
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]')
    return btn && btn.textContent?.includes('停止')
  }, { timeout: 10000 })
}

async function stopPlayback(page: Page): Promise<void> {
  await page.click('[data-testid="editor-play"]')
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]')
    return btn && !btn.textContent?.includes('停止')
  }, { timeout: 5000 })
}

async function clearSegments(page: Page): Promise<void> {
  page.once('dialog', (dialog: { accept: () => void }) => dialog.accept())
  await page.click('[data-testid="editor-clear"]')
  await page.waitForTimeout(500)
}

async function getSegmentsFromWindow(page: Page): Promise<Array<{ direction: string; beats: number }>> {
  return await page.evaluate(() => (window as any).__editorSegments ?? [])
}

test.describe.configure({ retries: 0 })

test.describe('T102: レガシー再生中セグメントスタンプ完全削除', () => {
  let allErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    allErrors = await collectErrors(page)

    const baseURL = process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/'
    await waitForServerReady(page, baseURL)
    await page.goto(baseURL, { waitUntil: 'networkidle' })
    await expect(page.locator('#root')).toBeVisible()
    await page.waitForTimeout(2500)

    await openEditor(page)
    await page.waitForTimeout(3000)

    await waitForAudioLoaded(page)
    await page.waitForTimeout(2000)
  })

  test.afterEach(async () => {
    expect(allErrors).toHaveLength(0)
  })

  test('Playback mode: ArrowUp/ArrowDown/W/S key presses do NOT modify segment array', async ({ page }) => {
    // Get initial segment count (default is play mode, not record mode)
    const initialSegments = await getSegmentsFromWindow(page)
    const initialCount = initialSegments.length

    // Start playback in play mode (NOT record mode)
    await startPlayback(page)
    await page.waitForTimeout(1000)

    // Verify playback started (button shows '停止')
    const playBtn = page.locator('[data-testid="editor-play"]')
    await expect(playBtn).toHaveText('停止')

    // Simulate ArrowUp key press
    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(100)
    await page.keyboard.up('ArrowUp')
    await page.waitForTimeout(500)

    let segmentsAfterArrowUp = await getSegmentsFromWindow(page)
    expect(segmentsAfterArrowUp.length).toBe(initialCount)

    // Simulate ArrowDown key press
    await page.keyboard.down('ArrowDown')
    await page.waitForTimeout(100)
    await page.keyboard.up('ArrowDown')
    await page.waitForTimeout(500)

    let segmentsAfterArrowDown = await getSegmentsFromWindow(page)
    expect(segmentsAfterArrowDown.length).toBe(initialCount)

    // Simulate KeyW (W key) press
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(100)
    await page.keyboard.up('KeyW')
    await page.waitForTimeout(500)

    let segmentsAfterKeyW = await getSegmentsFromWindow(page)
    expect(segmentsAfterKeyW.length).toBe(initialCount)

    // Simulate KeyS (S key) press
    await page.keyboard.down('KeyS')
    await page.waitForTimeout(100)
    await page.keyboard.up('KeyS')
    await page.waitForTimeout(500)

    let segmentsAfterKeyS = await getSegmentsFromWindow(page)
    expect(segmentsAfterKeyS.length).toBe(initialCount)

    // Stop playback
    await stopPlayback(page)
    await page.waitForTimeout(1000)

    // Final verification after playback stops
    const finalSegments = await getSegmentsFromWindow(page)
    expect(finalSegments.length).toBe(initialCount)
  })

  test('Playback mode with existing segments: key presses do NOT add/modify segments', async ({ page }) => {
    // Clear any existing segments first
    await clearSegments(page)
    await page.waitForTimeout(500)

    // Manually add some segments via the segment editor to have a non-zero baseline
    const segmentEditor = page.locator('section.editor-pane', { hasText: 'セグメント' })
    const addSegmentBtn = segmentEditor.locator('button', { hasText: '追加' })
    if (await addSegmentBtn.isVisible()) {
      await addSegmentBtn.click()
      await page.waitForTimeout(300)
      await addSegmentBtn.click()
      await page.waitForTimeout(300)
    }

    const segmentsBeforePlay = await getSegmentsFromWindow(page)
    const countBeforePlay = segmentsBeforePlay.length
    expect(countBeforePlay).toBeGreaterThan(0)

    // Start playback (play mode, NOT record mode)
    await startPlayback(page)
    await page.waitForTimeout(1000)

    // Verify playback started
    const playBtn = page.locator('[data-testid="editor-play"]')
    await expect(playBtn).toHaveText('停止')

    // Simulate multiple key presses
    const keysToTest = ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS']
    for (const key of keysToTest) {
      await page.keyboard.down(key)
      await page.waitForTimeout(100)
      await page.keyboard.up(key)
      await page.waitForTimeout(300)

      const segmentsAfterKey = await getSegmentsFromWindow(page)
      expect(segmentsAfterKey.length).toBe(countBeforePlay)
    }

    // Stop playback
    await stopPlayback(page)
    await page.waitForTimeout(1000)

    // Final verification
    const finalSegments = await getSegmentsFromWindow(page)
    expect(finalSegments.length).toBe(countBeforePlay)
  })

  test('Record mode: ArrowUp/ArrowDown/W/S key presses DO modify trajectory (positive control)', async ({ page }) => {
    // This test serves as a positive control to verify that record mode DOES work
    // It should pass both before and after T102 fix

    // Clear any existing segments first
    await clearSegments(page)
    await page.waitForTimeout(500)

    // Start playback
    await startPlayback(page)
    await page.waitForTimeout(1000)

    // Enter record mode
    await page.click('[data-testid="editor-record-toggle"]')
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="editor-record-toggle"]')
      return btn && btn.textContent?.includes('録音停止')
    }, { timeout: 5000 })
    await page.waitForTimeout(500)

    // Verify record mode active (button shows '録音停止')
    const recordBtn = page.locator('[data-testid="editor-record-toggle"]')
    await expect(recordBtn).toHaveText('録音停止')

    // Simulate key presses in record mode - these SHOULD affect trajectory
    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(200)
    await page.keyboard.up('ArrowUp')
    await page.waitForTimeout(200)

    await page.keyboard.down('ArrowDown')
    await page.waitForTimeout(200)
    await page.keyboard.up('ArrowDown')
    await page.waitForTimeout(200)

    // Exit record mode (this commits the trajectory as segments)
    await page.click('[data-testid="editor-record-toggle"]')
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="editor-record-toggle"]')
      return btn && btn.textContent?.includes('録音モード')
    }, { timeout: 5000 })
    await page.waitForTimeout(1000)

    // In record mode, segments SHOULD have been added
    const segmentsAfterRecord = await getSegmentsFromWindow(page)
    expect(segmentsAfterRecord.length).toBeGreaterThan(0)

    // Stop playback
    await stopPlayback(page)
    await page.waitForTimeout(1000)
  })
})