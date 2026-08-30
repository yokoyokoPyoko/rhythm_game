import { test, expect } from '@playwright/test'

test('debug drag ring', async ({ page }) => {
  await page.goto('/rhythm_game/#/editor')
  await page.waitForSelector('[data-testid="editor-legend"]', { timeout: 10000 })
  await page.waitForTimeout(2000)
  
  // Add a ring by clicking on canvas
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await canvas.click({ position: { x: 100, y: 360 } })
  await page.waitForTimeout(1000)
  
  let ringCount = await page.locator('[data-testid^="ring-list-item-"]').count()
  console.log('Ring count after click:', ringCount)
  
  const ring0 = page.locator('[data-testid="ring-list-item-0"]')
  await expect(ring0).toBeVisible()
  const beatText0 = await ring0.locator('.ring-list-beat').innerText()
  console.log('Initial beat text:', beatText0)
  
  const box = await canvas.boundingBox()!
  console.log('Canvas box:', box)
  
  // Drag the ring from x=0.25*width to x=0.5*width
  const addX = box.x + box.width * 0.25
  const addY = box.y + box.height * 0.5
  const targetX = box.x + box.width * 0.5
  const targetY = box.y + box.height * 0.5
  
  console.log('Drag from:', addX, addY, 'to:', targetX, targetY)
  
  await page.mouse.move(addX, addY)
  await page.mouse.down()
  await page.mouse.move(targetX, targetY, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(1500)
  
  const beatTextMoved = await ring0.locator('.ring-list-beat').innerText()
  console.log('Beat text after drag:', beatTextMoved)
  
  // Check if the ring was selected
  const className = await ring0.getAttribute('class')
  console.log('Ring class:', className)
})