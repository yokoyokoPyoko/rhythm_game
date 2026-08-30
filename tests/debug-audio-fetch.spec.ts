import { test, expect } from '@playwright/test'

test('debug audio fetch', async ({ page }) => {
  await page.goto('http://localhost:5173/')
  await page.waitForLoadState('networkidle', { timeout: 5000 })
  
  // Try to fetch the audio file directly
  const response = await page.evaluate(async () => {
    try {
      const res = await fetch('/rhythm_game/audio/08.Reply.flac')
      return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type'), size: res.headers.get('content-length') }
    } catch (e) {
      return { error: String(e) }
    }
  })
  console.log('Audio fetch result:', response)
  
  // Also check the chart file
  const chartResponse = await page.evaluate(async () => {
    try {
      const res = await fetch('/rhythm_game/charts/reply.toml')
      const text = await res.text()
      return { status: res.status, ok: res.ok, text: text.substring(0, 200) }
    } catch (e) {
      return { error: String(e) }
    }
  })
  console.log('Chart fetch result:', chartResponse)
  
  // Check songs.toml
  const songsResponse = await page.evaluate(async () => {
    try {
      const res = await fetch('/rhythm_game/songs.toml')
      const text = await res.text()
      return { status: res.status, ok: res.ok, text: text.substring(0, 200) }
    } catch (e) {
      return { error: String(e) }
    }
  })
  console.log('Songs fetch result:', songsResponse)
})