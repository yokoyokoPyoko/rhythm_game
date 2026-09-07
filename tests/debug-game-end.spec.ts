import { test, expect } from '@playwright/test'

const CHART_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/tests/fixtures/custom-song.toml'
const AUDIO_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav'

async function addCustomSong(page: import('@playwright/test').Page) {
  await page.locator('input[data-testid="home-chart-input"]').setInputFiles(CHART_FIXTURE)
  await page.locator('input[data-testid="home-audio-input"]').setInputFiles(AUDIO_FIXTURE)
  const addBtn = page.locator('button[data-testid="home-play-button"]')
  await expect(addBtn).toBeEnabled({ timeout: 10000 })
  await addBtn.click()
  await expect(page.locator('.song-card').first()).toBeVisible({ timeout: 10000 })
}

test('debug game end and result screen', async ({ page }) => {
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

  await addCustomSong(page)

  // Click song card
  const songCard = page.locator('.song-card').first()
  await expect(songCard).toBeVisible()
  await songCard.click()
  await page.waitForTimeout(2000)

  // Check if game canvas is visible
  const gameCanvas = page.locator('canvas.game-canvas')
  await expect(gameCanvas).toBeVisible({ timeout: 5000 })
  console.log('Game canvas visible')

  // Press Space to start
  await page.keyboard.press('Space')
  await page.waitForTimeout(1000)

  // Check status
  const status = await page.evaluate(() => {
    return (window as any).__gameStatus
  })
  console.log('Game status:', status)

  // Wait for game to potentially end
  await page.waitForTimeout(15000)

  // Check if result screen appeared
  const resultScreen = page.locator('.result-screen')
  const isVisible = await resultScreen.isVisible()
  console.log('Result screen visible:', isVisible)
  
  // Check for error screen
  const errorScreen = page.locator('.game-error')
  const errorVisible = await errorScreen.isVisible()
  console.log('Error screen visible:', errorVisible)
  
  if (errorVisible) {
    const errorText = await errorScreen.textContent()
    console.log('Error text:', errorText)
  }
  
  console.log('Console errors:', errors)
})