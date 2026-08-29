import { test, expect } from '@playwright/test'

test('T103 legacy Space ring stamp removed in play mode, allowed in record mode', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text()
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t)
    }
  })
  page.on('dialog', (d) => d.accept())

  await page.goto('/#/editor')
  await page.waitForLoadState('networkidle', { timeout: 8000 })
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  await page.waitForTimeout(1500)

  // Start from a clean chart (clears rings/segments/bpmChanges)
  await page.locator('[data-testid="editor-clear"]').click()
  await page.waitForTimeout(500)
  const ringsBefore = await page.evaluate(() => (window as any).__editorRings?.length ?? -1)
  expect(ringsBefore).toBe(0)

  const getRings = () => page.evaluate(() => (window as any).__editorRings?.length ?? -1)

  // --- NEGATIVE CONTROL: play mode, Space must NOT add rings ---
  await page.locator('[data-testid="editor-play"]').click()
  // wait until playback started (button shows 停止)
  await expect(page.locator('[data-testid="editor-play"]')).toHaveText(/停止/)
  await page.waitForTimeout(500)

  // focus away from any button so Space is not interpreted as a click
  await page.locator('[data-testid="wave-preview-canvas"]').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(200)

  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(800)
  const ringsPlayMode = await getRings()
  expect(ringsPlayMode).toBe(0)

  // --- POSITIVE CONTROL: record mode, Space must add rings ---
  await page.locator('[data-testid="editor-record-toggle"]').click()
  await expect(page.locator('[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/)
  await page.waitForTimeout(500)

  // ensure still playing
  await expect(page.locator('[data-testid="editor-play"]')).toHaveText(/停止/)

  await page.locator('[data-testid="wave-preview-canvas"]').click({ position: { x: 5, y: 5 } })
  await page.waitForTimeout(200)

  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
  const ringsRecordMode = await getRings()
  expect(ringsRecordMode).toBe(1)

  await page.waitForTimeout(500)
  expect(errors).toHaveLength(0)
})
