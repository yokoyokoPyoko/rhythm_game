import { test, expect, type ConsoleMessage } from '@playwright/test'

test('T96 editor UI verification', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium only')
  const errors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    const t = msg.text()
    if (msg.type() === 'error' && /Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t)
  })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('http://localhost:5173/rhythm_game/', { waitUntil: 'networkidle' })
  await expect(page.locator('.select-nav-button')).toBeVisible()

  // Open editor via nav button
  await page.click('.select-nav-button')
  await page.waitForURL('**/editor')
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  await expect(page.locator('[data-testid="wave-preview-canvas"]')).toBeVisible()

  // Accordions default collapsed
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  const isOpen = (loc: any) => loc.evaluate((el: HTMLElement) => el.hasAttribute('open'))
  expect(await isOpen(ringDetails)).toBe(false)
  expect(await isOpen(segDetails)).toBe(false)

  // Canvas height expanded (>400px)
  const canvasH = await page.locator('[data-testid="wave-preview-canvas"]').evaluate((el) => el.getBoundingClientRect().height)
  expect(canvasH).toBeGreaterThan(400)

  // Open accordions to reveal content; verify click/drag editing works
  await ringDetails.locator('summary').click()
  await segDetails.locator('summary').click()
  expect(await isOpen(ringDetails)).toBe(true)
  expect(await isOpen(segDetails)).toBe(true)

  // Direct click on preview adds a ring (intuitive editing)
  const before = await page.locator('[data-testid^="ring-list-item-"]').count()
  await page.locator('[data-testid="wave-preview-canvas"]').click({ position: { x: 200, y: 280 } })
  const after = await page.locator('[data-testid^="ring-list-item-"]').count()
  expect(after).toBe(before + 1)

  expect(errors).toHaveLength(0)
})
