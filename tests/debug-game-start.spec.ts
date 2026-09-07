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

test('debug game start and songTimeMs', async ({ page }) => {
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
  await page.waitForTimeout(3000)

  // Check status before Space
  const statusBefore = await page.evaluate(() => {
    return (window as any).__gameStatusRef?.current
  })
  console.log('Status before Space:', statusBefore)

  // Check if startedRef is accessible
  const startedBefore = await page.evaluate(() => {
    return (window as any).__gameStartedRef?.current
  })
  console.log('StartedRef before Space:', startedBefore)

  // Press Space to start
  await page.keyboard.press('Space')
  await page.waitForTimeout(1000)

  // Check status after Space
  const statusAfter = await page.evaluate(() => {
    return (window as any).__gameStatusRef?.current
  })
  console.log('Status after Space:', statusAfter)

  const startedAfter = await page.evaluate(() => {
    return (window as any).__gameStartedRef?.current
  })
  console.log('StartedRef after Space:', startedAfter)

  // Check songTimeMs
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000)
    const songTime = await page.evaluate(() => {
      return (window as any).__gameSongTimeMs
    })
    console.log(`songTimeMs at ${i+1}s after Space:`, songTime)
  }
  
  console.log('Console errors:', errors)
})