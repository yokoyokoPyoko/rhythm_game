import { test, expect } from '@playwright/test'

test('debug game state', async ({ page }) => {
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
        errors.push(text)
      }
    }
  })
  page.on('pageerror', err => errors.push(err.message))

  await page.goto('http://localhost:5173/')
  await page.waitForLoadState('networkidle', { timeout: 5000 })
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForTimeout(2000)

  // Click song card
  const songCard = page.locator('.song-card').first()
  await expect(songCard).toBeVisible()
  await songCard.click()
  await page.waitForTimeout(2000)

  // Press Space to start
  await page.keyboard.press('Space')
  await page.waitForTimeout(500)

  // Check game state periodically
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000)
    
    const state = await page.evaluate(() => {
      // Try to access game internals
      const canvas = document.querySelector('canvas.game-canvas')
      return {
        canvasExists: !!canvas,
        canvasWidth: canvas?.width,
        canvasHeight: canvas?.height,
      }
    })
    console.log(`State at ${(i+1)}s:`, state)
    
    // Check for result screen
    const resultScreen = page.locator('.result-screen')
    if (await resultScreen.isVisible()) {
      console.log('Result screen appeared!')
      break
    }
    
    // Check for error screen
    const errorScreen = page.locator('.game-error')
    if (await errorScreen.isVisible()) {
      const errorText = await errorScreen.textContent()
      console.log('Error screen:', errorText)
      break
    }
  }
  
  console.log('Console errors:', errors)
})