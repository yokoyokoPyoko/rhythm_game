import { test, expect } from '@playwright/test'

test('debug wave preview canvas', async ({ page }) => {
  await page.goto('/rhythm_game/#/editor')
  await page.waitForSelector('[data-testid="editor-legend"]', { timeout: 10000 })
  await page.waitForTimeout(2000)
  
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await expect(canvas).toBeVisible()
  
  const box = await canvas.boundingBox()
  console.log('Canvas box:', box)
  
  // Check canvas size
  const width = await canvas.evaluate(el => el.width)
  const height = await canvas.evaluate(el => el.height)
  const clientWidth = await canvas.evaluate(el => el.clientWidth)
  const clientHeight = await canvas.evaluate(el => el.clientHeight)
  console.log('Canvas intrinsic size:', width, 'x', height)
  console.log('Canvas client size:', clientWidth, 'x', clientHeight)
  
  // Try clicking at different positions
  await canvas.click({ position: { x: 100, y: 360 } })
  await page.waitForTimeout(1000)
  
  const ringCount = await page.locator('[data-testid^="ring-list-item-"]').count()
  console.log('Ring count after click:', ringCount)
  
  // Check if onAddRing was called
  const added = await page.evaluate(() => {
    return (window as any).__editorAddedRing
  })
  console.log('Added ring:', added)
})