import { test, expect } from '@playwright/test'

test('T96 editor UI/UX: preview, accordions, intuitive editing', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text()
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t)
    }
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle', { timeout: 8000 })
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForTimeout(2000)

  // Open the editor
  await page.goto('/#/editor')
  await page.waitForTimeout(3000)
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()

  // --- Pillar 1: WavePreview expanded with grid/judgment line/notes ---
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await expect(canvas).toBeVisible()
  const box = (await canvas.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(600)
  await page.waitForTimeout(2000)

  // --- Pillar 2: ring & segment lists wrapped in <details>, default collapsed ---
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  await expect(ringDetails).toBeVisible()
  await expect(segDetails).toBeVisible()
  expect(await ringDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  expect(await segDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
  await page.waitForTimeout(1500)

  // Toggle the ring accordion open and assert state change
  await ringDetails.locator('summary').click()
  await page.waitForTimeout(1500)
  expect(await ringDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)

  // Toggle the segment accordion open and assert state change
  await segDetails.locator('summary').click()
  await page.waitForTimeout(1500)
  expect(await segDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)

  // Add a segment via the editor so the wave + notes are visible
  await segDetails.locator('.editor-accordion-add').click()
  await page.waitForTimeout(1500)

  // --- Pillar 3: intuitive editing on the preview/timeline ---
  // click-to-add a ring
  const addX = box.x + box.width * 0.25
  const addY = box.y + box.height * 0.5
  await canvas.click({ position: { x: box.width * 0.25, y: box.height * 0.5 } })
  await page.waitForTimeout(1500)
  const ring0 = page.locator('[data-testid="ring-list-item-0"]')
  await expect(ring0).toBeVisible()
  const beatText0 = await ring0.locator('.ring-list-beat').innerText()
  expect(beatText0).toContain('beat:')

  // drag-to-move the ring to a new position
  await page.mouse.move(addX, addY)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.5, addY, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(1500)
  const beatTextMoved = await ring0.locator('.ring-list-beat').innerText()
  expect(beatTextMoved).not.toBe(beatText0)

  // click-to-select the moved ring
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } })
  await page.waitForTimeout(1500)
  await expect(ring0).toHaveClass(/ring-list-item-selected/)

  // Delete-to-remove the selected ring
  await page.keyboard.press('Delete')
  await page.waitForTimeout(1500)
  await expect(ring0).toHaveCount(0)
  await expect(ringDetails.locator('.editor-empty')).toContainText('リングなし')

  // Collapse accordions and verify toggling back closed
  await ringDetails.locator('summary').click()
  await page.waitForTimeout(1500)
  expect(await ringDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)

  await page.waitForTimeout(8000)
  expect(errors).toHaveLength(0)
})
