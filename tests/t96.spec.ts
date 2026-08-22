import { test, expect, type ConsoleMessage } from '@playwright/test'

test('T96 editor UI/UX: expanded preview, accordions, intuitive editing', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  test.setTimeout(90000)
  const errors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    const t = msg.text()
    if (msg.type() === 'error' && /Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t)
  })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('http://localhost:5173/rhythm_game/', { waitUntil: 'networkidle' })
  await expect(page.locator('.select-nav-button')).toBeVisible()

  // Open editor
  await page.click('.select-nav-button')
  await page.waitForURL('**/editor')
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await expect(canvas).toBeVisible()

  // (1) Expanded WavePreview with visible grid/judgment line/notes
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox!.height).toBeGreaterThan(400)
  await page.screenshot({ path: 'recordings/t96_expanded_preview.png' })

  // (2) Ring & segment lists default-collapsed in accordion panels
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  const isOpen = (loc: any) => loc.evaluate((el: HTMLElement) => el.hasAttribute('open'))
  expect(await isOpen(ringDetails)).toBe(false)
  expect(await isOpen(segDetails)).toBe(false)

  // Expand on click
  await ringDetails.locator('summary').click()
  await segDetails.locator('summary').click()
  expect(await isOpen(ringDetails)).toBe(true)
  expect(await isOpen(segDetails)).toBe(true)
  await page.waitForTimeout(300)

  // (3a) Add a note via click on the timeline/preview (compute its canvas x)
  const box = canvasBox!
  const lastBeat = 4 // no segments => WavePreview uses lastBeat = max(totalBeats, 4)
  const addX = Math.round(box.width * 0.2)
  const before = await page.locator('[data-testid^="ring-list-item-"]').count()
  await canvas.click({ position: { x: addX, y: 280 } })
  await page.waitForTimeout(300)
  const afterAdd = await page.locator('[data-testid^="ring-list-item-"]').count()
  expect(afterAdd).toBe(before + 1)
  await page.screenshot({ path: 'recordings/t96_ring_added.png' })

  // (3b) Move a note via drag on the timeline/preview
  const ringIdx = afterAdd - 1
  const item = page.locator(`[data-testid="ring-list-item-${ringIdx}"]`)
  const beforeText = await item.locator('.ring-list-beat').textContent()
  const beforeBeat = Number((beforeText || '').replace(/[^0-9.]/g, ''))

  const startX = Math.round((beforeBeat / lastBeat) * box.width)
  const targetX = Math.min(box.width - 4, startX + Math.round(box.width * 0.18))
  await page.mouse.move(box.x + startX, box.y + 280)
  await page.mouse.down()
  await page.mouse.move(box.x + startX + 40, box.y + 280, { steps: 5 })
  await page.mouse.move(box.x + targetX, box.y + 280, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  const afterText = await item.locator('.ring-list-beat').textContent()
  const afterBeat = Number((afterText || '').replace(/[^0-9.]/g, ''))
  expect(afterBeat).not.toBe(beforeBeat)
  await page.screenshot({ path: 'recordings/t96_ring_moved.png' })

  // (3c) Delete a note via click (double-click) on the timeline/preview
  const beforeDel = await page.locator('[data-testid^="ring-list-item-"]').count()
  const delX = Math.round((afterBeat / lastBeat) * box.width)
  await canvas.dblclick({ position: { x: delX, y: 280 } })
  await page.waitForTimeout(300)
  const afterDel = await page.locator('[data-testid^="ring-list-item-"]').count()
  expect(afterDel).toBe(beforeDel - 1)
  await page.screenshot({ path: 'recordings/t96_ring_deleted.png' })

  // Add another note so the preview shows a visible note marker
  await canvas.click({ position: { x: Math.round(box.width * 0.3), y: 320 } })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'recordings/t96_final_preview.png' })

  // Hold the demonstration on the expanded preview for the required duration
  await page.waitForTimeout(28000)

  expect(errors).toHaveLength(0)
})
