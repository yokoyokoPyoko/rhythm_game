import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'
import * as fs from 'fs'
import { parse } from 'smol-toml'

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

async function getAudioOffsetFromState(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as any).__editorAudioOffset ?? 0
  })
}

async function getPlayFromAudioOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as any).__editorPlayFromOffset ?? 0
  })
}

test.describe.configure({ retries: 0 })

test('T99 Audio Offset: Music Control pane placement & playFrom reflection', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  test.setTimeout(300000)

  const baseURL = process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/'
  const allErrors = await collectErrors(page)

  // ============================================================
  // 0. Wait for dev server to be ready
  // ============================================================
  await waitForServerReady(page, baseURL)
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForTimeout(2500)

  // ============================================================
  // 1. Open Editor
  // ============================================================
  await openEditor(page)
  await page.waitForTimeout(3000)

  // ============================================================
  // 2. Verify Audio Offset input is in Music Control pane (NOT BPM Settings)
  // ============================================================
  const offsetInput = page.locator('#audio-offset')
  await expect(offsetInput).toBeVisible()

  // Verify offset input exists in Music Control section
  const musicControlSection = page.locator('section.editor-pane:has-text("音楽制御")')
  await expect(musicControlSection).toBeVisible()
  await expect(musicControlSection.locator('#audio-offset')).toBeVisible()

  // BPM Settings section should NOT contain audio offset
  const bpmSection = page.locator('section.editor-pane:has-text("BPM設定")')
  await expect(bpmSection).toBeVisible()
  await expect(bpmSection.locator('#audio-offset')).toHaveCount(0)

  // ============================================================
  // 3. Set audio offset and verify internal state reflects it
  // ============================================================
  const testOffset = 150 // ms
  await offsetInput.fill(String(testOffset))
  await expect(Number(await offsetInput.inputValue())).toBeCloseTo(testOffset)

  // Verify internal state has the offset
  const stateOffset = await getAudioOffsetFromState(page)
  expect(stateOffset).toBe(testOffset)

  // ============================================================
  // 4. Test playFrom reflection: load audio, play from position, verify offset used
  // ============================================================
  const playBtn = page.locator('[data-testid="editor-play"]')
  await expect(playBtn).toBeVisible()
  await playBtn.click()

  // Wait for 68.8MB FLAC to load and decode
  await waitForAudioLoaded(page)
  await page.waitForTimeout(3000)

  // Verify audio offset is passed to playFrom by checking internal flag
  // (The implementation should set __editorPlayFromOffset when playFrom is called)
  const playFromOffset = await getPlayFromAudioOffset(page)
  expect(playFromOffset).toBe(testOffset)

  // Stop audio
  await playBtn.click()
  await page.waitForTimeout(2000)

  // ============================================================
  // 5. Test seek + playFrom with offset
  // ============================================================
  const seekSlider = page.locator('.editor-slider').first()
  if (await seekSlider.isEnabled()) {
    await seekSlider.fill('5000')
    await page.waitForTimeout(2000)

    // Play again from seeked position
    await playBtn.click()
    await waitForAudioLoaded(page)
    await page.waitForTimeout(3000)

    // Verify playFrom still uses the same audio offset
    const playFromOffsetAfterSeek = await getPlayFromAudioOffset(page)
    expect(playFromOffsetAfterSeek).toBe(testOffset)

    await playBtn.click()
    await page.waitForTimeout(2000)
  }

  // ============================================================
  // 6. Test negative audio offset
  // ============================================================
  const negativeOffset = -100
  await offsetInput.fill(String(negativeOffset))
  await expect(Number(await offsetInput.inputValue())).toBeCloseTo(negativeOffset)

  const stateNegativeOffset = await getAudioOffsetFromState(page)
  expect(stateNegativeOffset).toBe(negativeOffset)

  await playBtn.click()
  await waitForAudioLoaded(page)
  await page.waitForTimeout(3000)

  const playFromNegativeOffset = await getPlayFromAudioOffset(page)
  expect(playFromNegativeOffset).toBe(negativeOffset)

  await playBtn.click()
  await page.waitForTimeout(2000)

  // ============================================================
  // 7. Test TOML Export includes audio_offset
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
    expect(parsed.audio_offset).toBe(negativeOffset) // Last set value
  }

  // ============================================================
  // 8. Test TOML Import restores audio_offset in Music Control pane
  // ============================================================
  const importInput = page.locator('[data-testid="import-toml"]')
  const filePathForImport = filePath!
  await importInput.setInputFiles(filePathForImport)
  await page.waitForTimeout(2000)

  // Verify imported audio_offset appears in Music Control pane
  const importedOffset = Number(await page.locator('#audio-offset').inputValue())
  expect(importedOffset).toBeCloseTo(negativeOffset)

  // Verify BPM Settings still doesn't have audio offset
  await expect(bpmSection.locator('#audio-offset')).toHaveCount(0)

  // ============================================================
  // 9. Final assertions
  // ============================================================
  expect(allErrors).toHaveLength(0)
})