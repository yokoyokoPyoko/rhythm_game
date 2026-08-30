import { test, expect } from '@playwright/test'

test('debug audio decode', async ({ page }) => {
  await page.goto('http://localhost:5173/')
  await page.waitForLoadState('networkidle', { timeout: 5000 })
  
  // Try to decode the audio file
  const result = await page.evaluate(async () => {
    try {
      const res = await fetch('/rhythm_game/audio/08.Reply.flac')
      const arrayBuffer = await res.arrayBuffer()
      const audioCtx = new AudioContext()
      const buffer = await audioCtx.decodeAudioData(arrayBuffer)
      return { duration: buffer.duration, sampleRate: buffer.sampleRate, length: buffer.length, numberOfChannels: buffer.numberOfChannels }
    } catch (e) {
      return { error: String(e), stack: e instanceof Error ? e.stack : undefined }
    }
  })
  console.log('Audio decode result:', result)
})