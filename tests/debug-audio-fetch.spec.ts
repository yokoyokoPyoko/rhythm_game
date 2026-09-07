import { test, expect } from '@playwright/test'

test('debug audio fetch', async ({ page }) => {
  await page.goto('http://localhost:5173/')
  await page.waitForLoadState('networkidle', { timeout: 5000 })
  
  // Try to fetch the generated/fixture audio file directly
  const response = await page.evaluate(async () => {
    try {
      const res = await fetch('/rhythm_game/test-audio.wav')
      return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type'), size: res.headers.get('content-length') }
    } catch (e) {
      return { error: String(e) }
    }
  })
  console.log('Audio fetch result:', response)
})