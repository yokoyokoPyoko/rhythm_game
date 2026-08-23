import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SAMPLE_TOML = `title = "Trace Wave Workflow Test"
artist = "Gate C Critic"
bpm = 130
audio = "/rhythm_game/audio/08.Reply.flac"
audio_offset = 0
scroll_speed = 110
amplitude = 130

[[bpm_changes]]
beat = 8
bpm = 145

[[segments]]
direction = "up"
beats = 4

[[segments]]
direction = "stay"
beats = 2

[[segments]]
direction = "down"
beats = 4

[[rings]]
beat = 2.0
type = "single"

[[rings]]
beat = 6.0
type = "hold"
duration = 2.0

[[rings]]
beat = 12.0
type = "single"
`

test('T97 comprehensive authoring workflow and usability test', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium only for video recording quality')
  test.setTimeout(120000)

  const errors: string[] = []
  page.on('console', (msg: ConsoleMessage) => {
    const t = msg.text()
    if (msg.type() === 'error' && /Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) {
      errors.push(t)
    }
  })
  page.on('pageerror', (err) => errors.push(err.message))

  // 1. Navigation & initial load
  await page.goto('/')
  await page.waitForLoadState('networkidle', { timeout: 8000 })
  await expect(page.locator('#root')).toBeVisible()
  await page.waitForTimeout(1500)

  // Navigate to Editor via hash routing
  await page.evaluate(() => {
    window.location.hash = '#/editor'
  })
  await page.waitForSelector('[data-testid="wave-preview"]', { timeout: 10000 })
  await page.waitForTimeout(2000)

  // 2. Music Loading & Audio Controls
  const titleInput = page.locator('#chart-title')
  const artistInput = page.locator('#chart-artist')
  await titleInput.fill('Gate C Masterpiece')
  await artistInput.fill('Virtual Maestro')
  await page.waitForTimeout(1000)

  const playBtn = page.locator('[data-testid="editor-play"]')
  await expect(playBtn).toBeVisible()
  // Click load & play
  await playBtn.click()
  await page.waitForTimeout(2500)
  // Stop playback
  await playBtn.click()
  await page.waitForTimeout(1000)

  // 3. BPM & Parameters Settings
  await page.fill('#bpm', '135')
  await expect(page.locator('#bpm')).toHaveValue('135')
  await page.fill('#amplitude', '140')
  await page.fill('#scroll-speed', '120')
  await page.fill('#audio-offset', '15')
  await page.waitForTimeout(1500)

  // Add a BPM change
  const addBpmChangeBtn = page.locator('.bpm-change-add')
  await addBpmChangeBtn.click()
  await page.waitForTimeout(1000)
  const bpmChangeBeatInput = page.locator('.bpm-change-beat').first()
  await bpmChangeBeatInput.fill('6')
  const bpmChangeValInput = page.locator('.bpm-change-bpm').first()
  await bpmChangeValInput.fill('150')
  await page.waitForTimeout(1500)

  // 4. Segment Configuration (Accordions)
  const segDetails = page.locator('[data-testid="segment-list-details"]')
  await segDetails.locator('summary').click()
  await page.waitForTimeout(1000)
  
  const addSegBtn = page.locator('[data-testid="segment-add"]')
  await addSegBtn.click()
  await page.waitForTimeout(1000)

  // Edit segment direction and beats
  const segDir0 = page.locator('[data-testid="segment-direction-0"]')
  await segDir0.selectOption('up')
  const segBeats0 = page.locator('[data-testid="segment-beats-0"]')
  await segBeats0.fill('4')
  await page.waitForTimeout(1500)

  // Add second segment (stay)
  await addSegBtn.click()
  await page.waitForTimeout(800)
  const segDir1 = page.locator('[data-testid="segment-direction-1"]')
  await segDir1.selectOption('stay')
  const segBeats1 = page.locator('[data-testid="segment-beats-1"]')
  await segBeats1.fill('2')
  await page.waitForTimeout(1500)

  // 5. Ring Configuration & Canvas Direct Interaction
  const ringDetails = page.locator('[data-testid="ring-list-details"]')
  await ringDetails.locator('summary').click()
  await page.waitForTimeout(1000)

  const canvas = page.locator('[data-testid="wave-preview-canvas"]')
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()

  // Click on wave preview to add a ring
  const clickX = Math.round(canvasBox!.width * 0.25)
  const clickY = Math.round(canvasBox!.height * 0.5)
  await canvas.click({ position: { x: clickX, y: clickY } })
  await page.waitForTimeout(1500)

  const ringItem0 = page.locator('[data-testid="ring-list-item-0"]')
  await expect(ringItem0).toBeVisible()

  // Add another ring
  const clickX2 = Math.round(canvasBox!.width * 0.6)
  await canvas.click({ position: { x: clickX2, y: clickY } })
  await page.waitForTimeout(1500)

  // Change second ring type to hold
  const ringTypeSelect1 = page.locator('[aria-label*="のタイプ"]').nth(1)
  if (await ringTypeSelect1.isVisible()) {
    await ringTypeSelect1.selectOption('hold')
    await page.waitForTimeout(1000)
  }

  // 6. Wave Preview & Real-time Visual Inspection
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  await page.waitForTimeout(2500)

  // 7. TOML Export & Import Roundtrip
  const exportBtn = page.locator('[data-testid="editor-export"]')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportBtn.click(),
  ])
  expect(download.suggestedFilename()).toBe('reply.toml')
  await expect(page.locator('[data-testid="editor-toast"]')).toContainText('エクスポートしました')
  await page.waitForTimeout(1500)

  // Test importing a TOML file
  const tmpDir = mkdtempSync(join(tmpdir(), 't97-'))
  const tomlFilePath = join(tmpDir, 'test-chart.toml')
  writeFileSync(tomlFilePath, SAMPLE_TOML, 'utf-8')
  await page.setInputFiles('[data-testid="import-toml"]', tomlFilePath)
  await expect(page.locator('[data-testid="editor-toast"]')).toContainText('test-chart.toml を読み込みました')
  await page.waitForTimeout(2000)

  // 8. Playtest Verification
  const playtestBtn = page.locator('[data-testid="editor-playtest"]')
  await playtestBtn.click()
  const playtestCanvas = page.locator('canvas.game-canvas')
  await expect(playtestCanvas).toBeVisible({ timeout: 8000 })
  await page.waitForTimeout(3000)

  // Exit playtest via Escape key
  await page.keyboard.press('Escape')
  await page.waitForSelector('.editor-screen', { timeout: 5000 })
  await page.waitForTimeout(2000)

  // Final review pause for Gate C critic video inspection
  await page.waitForTimeout(3000)

  expect(errors).toHaveLength(0)
})
