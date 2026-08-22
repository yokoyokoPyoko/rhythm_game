import { test, expect, type Page } from '@playwright/test'
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

async function gotoEditor(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text()
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t)
    }
  })
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto('/rhythm_game/#/editor')
  await page.waitForSelector('[data-testid="editor-legend"]', { timeout: 10000 })
  return errors
}

const ringCount = (page: Page) => page.locator('[data-testid^="ring-list-item-"]').count()
const segmentCount = (page: Page) => page.locator('[data-testid^="segment-direction-"]').count()

test('editor full workflow: import -> bpm/segment -> ring -> preview -> export -> playtest', async ({ page }) => {
  const errors = await gotoEditor(page)

  // ① 音楽/譜面の読込 (TOMLインポートでチャート全体を読み込む)
  const tmp = mkdtempSync(join(tmpdir(), 'chart-'))
  const tomlPath = join(tmp, 'demo.toml')
  writeFileSync(tomlPath, DEMO_TOML, 'utf-8')
  await page.setInputFiles('[data-testid="import-toml"]', tomlPath)
  await expect(page.locator('[data-testid="editor-toast"]')).toContainText('demo.toml を読み込みました')
  expect(await ringCount(page)).toBe(2)
  expect(await segmentCount(page)).toBe(2)

  // ② BPM / セグメント設定
  await page.fill('#bpm', '140')
  await expect(page.locator('#bpm')).toHaveValue('140')
  await page.locator('[data-testid="segment-list-details"] > summary').click()
  await page.locator('[data-testid="segment-add"]').click()
  await expect(page.locator('[data-testid="segment-direction-2"]')).toBeVisible()

  // ③ リング配置 (プレビュー上クリックで追加)
  const before = await ringCount(page)
  await page.locator('[data-testid="wave-preview-canvas"]').click({ position: { x: 220, y: 320 } })
  await expect
    .poll(async () => await ringCount(page), { timeout: 3000 })
    .toBe(before + 1)

  // ④ 波形プレビューは常に描画されている
  await expect(page.locator('[data-testid="wave-preview-canvas"]')).toBeVisible()

  // ⑤ TOMLエクスポート
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-testid="editor-export"]').click(),
  ])
  expect(download.suggestedFilename()).toBe('reply.toml')
  await expect(page.locator('[data-testid="editor-toast"]')).toContainText('エクスポートしました')

  // ⑥ プレイテストで内容確認
  await page.locator('[data-testid="editor-playtest"]').click()
  const canvas = page.locator('[data-testid="playtest-canvas"]')
  await expect(canvas).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="playtest-exit"]').click()
  await expect(canvas).toHaveCount(0)

  expect(errors).toHaveLength(0)
})
