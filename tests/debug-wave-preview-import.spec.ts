import { test, expect } from '@playwright/test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const DEMO_TOML = `title = "Demo"
artist = "Tester"
bpm = 120
audio = "/rhythm_game/audio/08.Reply.flac"
audio_offset = 0
scroll_speed = 110
amplitude = 130

[[segments]]
direction = "up"
beats = 2

[[segments]]
direction = "down"
beats = 2

[[rings]]
beat = 4.0

[[rings]]
beat = 8.0
`

test('debug wave preview with import', async ({ page }) => {
  await page.goto('/rhythm_game/#/editor')
  await page.waitForSelector('[data-testid="editor-legend"]', { timeout: 10000 })
  await page.waitForTimeout(2000)
  
  // Import TOML
  const tmp = mkdtempSync(join(tmpdir(), 'chart-'))
  const tomlPath = join(tmp, 'demo.toml')
  writeFileSync(tomlPath, DEMO_TOML, 'utf-8')
  await page.setInputFiles('[data-testid="import-toml"]', tomlPath)
  await expect(page.locator('[data-testid="editor-toast"]')).toContainText('demo.toml を読み込みました')
  await page.waitForTimeout(1000)
  
  let ringCount = await page.locator('[data-testid^="ring-list-item-"]').count()
  console.log('Ring count after import:', ringCount)
  
  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  await canvas.click({ position: { x: 220, y: 320 } })
  await page.waitForTimeout(1000)
  
  ringCount = await page.locator('[data-testid^="ring-list-item-"]').count()
  console.log('Ring count after click:', ringCount)
})