import { test, expect, type Page } from '@playwright/test'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const LONG_CHART_TOML = `title = "Long Chart"
artist = "Test"
bpm = 120
audio = "/rhythm_game/audio/08.Reply.flac"
audio_offset = 0
scroll_speed = 110
amplitude = 130

[[segments]]
direction = "up"
beats = 4

[[segments]]
direction = "down"
beats = 4

[[segments]]
direction = "up"
beats = 4

[[segments]]
direction = "down"
beats = 4

[[segments]]
direction = "up"
beats = 4

[[segments]]
direction = "down"
beats = 4
`

async function waitForAudioReady(page: Page, timeout = 120000): Promise<void> {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]')
      return btn && !btn.textContent?.includes('読込中')
    },
    { timeout }
  )
}

async function startPlayback(page: Page): Promise<void> {
  await page.click('[data-testid="editor-play"]')
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]')
    return btn && btn.textContent?.includes('停止')
  }, { timeout: 10000 })
}

async function stopPlayback(page: Page): Promise<void> {
  await page.click('[data-testid="editor-play"]')
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]')
    return btn && !btn.textContent?.includes('停止')
  }, { timeout: 5000 })
}

async function enterRecordMode(page: Page): Promise<void> {
  await page.click('[data-testid="editor-record-toggle"]')
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-record-toggle"]')
    return btn && btn.textContent?.includes('録音停止')
  }, { timeout: 5000 })
}

async function exitRecordMode(page: Page): Promise<void> {
  await page.click('[data-testid="editor-record-toggle"]')
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-record-toggle"]')
    return btn && btn.textContent?.includes('録音モード')
  }, { timeout: 5000 })
}

async function getSegmentsFromWindow(page: Page): Promise<Array<{ direction: string; beats: number }>> {
  return await page.evaluate(() => (window as any).__editorSegments ?? [])
}

async function seekToBeat(page: Page, beat: number): Promise<void> {
  await page.evaluate((b) => {
    const w = window as unknown as Record<string, unknown>
    if (w.__editorSeekToBeat) (w.__editorSeekToBeat as (b: number) => void)(b)
  }, beat)
  await page.waitForTimeout(200)
}

test.describe('T109: 録音上書き範囲の限定 (startBeat〜endBeatのみ上書き、それ以降は維持)', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t)
      }
    })
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/rhythm_game/#/editor')
    await page.waitForLoadState('networkidle', { timeout: 10000 })
    await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible({ timeout: 10000 })
    await waitForAudioReady(page)
    await page.waitForTimeout(1000)
    expect(errors).toHaveLength(0)
  })

  test('recording overwrite preserves segments after endBeat intact', async ({ page }) => {
    // ============================================================
    // Step 1: Capture Initial State
    // Load a chart with many segments (total 24 beats worth)
    // ============================================================
    const tmp = mkdtempSync(join(tmpdir(), 'chart-'))
    const tomlPath = join(tmp, 'long-chart.toml')
    writeFileSync(tomlPath, LONG_CHART_TOML, 'utf-8')
    await page.setInputFiles('[data-testid="import-toml"]', tomlPath)
    await expect(page.locator('[data-testid="editor-toast"]')).toContainText('long-chart.toml を読み込みました')
    await page.waitForTimeout(500)

    const initialSegments = await getSegmentsFromWindow(page)
    expect(initialSegments.length).toBe(6)
    const initialTotalBeats = initialSegments.reduce((sum, s) => sum + s.beats, 0)
    expect(initialTotalBeats).toBe(24)

    // We'll record from beat 4 to beat ~8 (inside the existing segments)
    // Segments after beat 8 should be preserved completely
    const startBeat = 4
    const endBeat = 8

    // Verify segments structure before recording:
    // seg0: up 4 (0-4), seg1: down 4 (4-8), seg2: up 4 (8-12), seg3: down 4 (12-16), seg4: up 4 (16-20), seg5: down 4 (20-24)
    // Recording from beat 4 to 8 should overwrite seg1 entirely, but seg2-5 should remain intact

    const segmentsBeforeEndBeat = initialSegments.filter((_, i) => {
      let cum = 0
      for (let j = 0; j <= i; j++) cum += initialSegments[j].beats
      return cum > endBeat
    })
    expect(segmentsBeforeEndBeat.length).toBe(4) // seg2, seg3, seg4, seg5

    // ============================================================
    // Step 2: Perform User Interaction
    // Start playback, seek to startBeat, enter record mode, record, exit
    // ============================================================
    await startPlayback(page)
    await page.waitForTimeout(500)
    await seekToBeat(page, startBeat)
    await page.waitForTimeout(200)

    await enterRecordMode(page)
    await page.waitForTimeout(200)

    // Record: press ArrowUp for ~4 beats worth of time
    // At 120 BPM, 1 beat = 500ms, so 4 beats = 2000ms
    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(2200) // hold for ~4.4 beats
    await page.keyboard.up('ArrowUp')
    await page.waitForTimeout(200)

    // Exit record mode (this calls finishRecording)
    await exitRecordMode(page)
    await page.waitForTimeout(500)

    await stopPlayback(page)

    // ============================================================
    // Step 3: Assert Resulting Transition
    // Segments after endBeat (beat 8) must be preserved intact
    // ============================================================
    const finalSegments = await getSegmentsFromWindow(page)
    expect(finalSegments.length).toBeGreaterThan(0)

    // Find the segment index where cumulative beats > endBeat (8)
    // Those segments should be identical to the original seg2, seg3, seg4, seg5
    let cum = 0
    let preservedStartIdx = -1
    for (let i = 0; i < finalSegments.length; i++) {
      const end = cum + finalSegments[i].beats
      if (cum > endBeat && preservedStartIdx === -1) {
        preservedStartIdx = i
      }
      cum = end
    }

    expect(preservedStartIdx).toBeGreaterThanOrEqual(0)

    // The segments from preservedStartIdx onwards should match original seg2-5
    const preservedSegments = finalSegments.slice(preservedStartIdx)
    const expectedPreserved = initialSegments.slice(2) // seg2, seg3, seg4, seg5

    expect(preservedSegments.length).toBe(expectedPreserved.length)

    for (let i = 0; i < expectedPreserved.length; i++) {
      expect(preservedSegments[i].direction).toBe(expectedPreserved[i].direction)
      expect(preservedSegments[i].beats).toBeCloseTo(expectedPreserved[i].beats, 3)
    }

    // Additionally: total beats of preserved portion should equal original 16 beats (4 segments × 4 beats)
    const preservedTotalBeats = preservedSegments.reduce((sum, s) => sum + s.beats, 0)
    expect(preservedTotalBeats).toBeCloseTo(16, 1)

    // No partial/split segments should exist at the boundary
    // The segment just before preservedStartIdx should end exactly at or before endBeat
    if (preservedStartIdx > 0) {
      let cumBefore = 0
      for (let i = 0; i < preservedStartIdx; i++) {
        cumBefore += finalSegments[i].beats
      }
      // The last overwritten segment should end at or before endBeat
      expect(cumBefore).toBeLessThanOrEqual(endBeat + 0.5) // allow small quantization margin
    }
  })

  test('recording overwrite when startBeat is in middle of a segment', async ({ page }) => {
    // Test case: start recording in the middle of an existing segment
    // Should overwrite from the startBeat (splitting that segment) but preserve after endBeat
    const tmp = mkdtempSync(join(tmpdir(), 'chart-'))
    const tomlPath = join(tmp, 'long-chart.toml')
    writeFileSync(tomlPath, LONG_CHART_TOML, 'utf-8')
    await page.setInputFiles('[data-testid="import-toml"]', tomlPath)
    await expect(page.locator('[data-testid="editor-toast"]')).toContainText('long-chart.toml を読み込みました')
    await page.waitForTimeout(500)

    const initialSegments = await getSegmentsFromWindow(page)

    // Start recording at beat 2 (middle of first segment which is 0-4)
    // End recording at beat 10 (middle of third segment which is 8-12)
    const startBeat = 2
    const endBeat = 10

    await startPlayback(page)
    await page.waitForTimeout(500)
    await seekToBeat(page, startBeat)
    await page.waitForTimeout(200)

    await enterRecordMode(page)
    await page.waitForTimeout(200)

    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(2200)
    await page.keyboard.up('ArrowUp')
    await page.waitForTimeout(200)

    await exitRecordMode(page)
    await page.waitForTimeout(500)
    await stopPlayback(page)

    const finalSegments = await getSegmentsFromWindow(page)

    // Segments starting after endBeat (10) should be preserved
    // Original seg3 (down 4, 12-16), seg4 (up 4, 16-20), seg5 (down 4, 20-24)
    let cum = 0
    let preservedStartIdx = -1
    for (let i = 0; i < finalSegments.length; i++) {
      if (cum > endBeat && preservedStartIdx === -1) {
        preservedStartIdx = i
      }
      cum += finalSegments[i].beats
    }

    expect(preservedStartIdx).toBeGreaterThanOrEqual(0)

    const preservedSegments = finalSegments.slice(preservedStartIdx)
    const expectedPreserved = initialSegments.slice(3) // seg3, seg4, seg5

    expect(preservedSegments.length).toBe(expectedPreserved.length)
    for (let i = 0; i < expectedPreserved.length; i++) {
      expect(preservedSegments[i].direction).toBe(expectedPreserved[i].direction)
      expect(preservedSegments[i].beats).toBeCloseTo(expectedPreserved[i].beats, 3)
    }
  })

  test('recording overwrite with fractional off-grid timing (snap=0.5)', async ({ page }) => {
    // Test with snap=0.5 and off-grid release to verify quantization doesn't cause overshoot
    await page.selectOption('[data-testid="snap-select"]', '0.5')
    await page.waitForTimeout(200)

    const tmp = mkdtempSync(join(tmpdir(), 'chart-'))
    const tomlPath = join(tmp, 'long-chart.toml')
    writeFileSync(tomlPath, LONG_CHART_TOML, 'utf-8')
    await page.setInputFiles('[data-testid="import-toml"]', tomlPath)
    await expect(page.locator('[data-testid="editor-toast"]')).toContainText('long-chart.toml を読み込みました')
    await page.waitForTimeout(500)

    const initialSegments = await getSegmentsFromWindow(page)

    const startBeat = 4
    const endBeat = 8

    await startPlayback(page)
    await page.waitForTimeout(500)
    await seekToBeat(page, startBeat)
    await page.waitForTimeout(200)

    await enterRecordMode(page)
    await page.waitForTimeout(200)

    // Hold for a duration that will quantize to an off-grid boundary
    // 1.3 beats worth - should snap to 1.0 or 1.5 with snap=0.5
    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(700) // ~1.4 beats at 120 BPM
    await page.keyboard.up('ArrowUp')
    await page.waitForTimeout(200)

    await exitRecordMode(page)
    await page.waitForTimeout(500)
    await stopPlayback(page)

    const finalSegments = await getSegmentsFromWindow(page)

    // All segments should be snap-aligned
    for (const seg of finalSegments) {
      const remainder = ((seg.beats % 0.5) + 0.5) % 0.5
      expect(remainder < 1e-3 || Math.abs(remainder - 0.5) < 1e-3).toBeTruthy()
    }

    // Segments after endBeat (8) must be preserved intact
    let cum = 0
    let preservedStartIdx = -1
    for (let i = 0; i < finalSegments.length; i++) {
      if (cum > endBeat && preservedStartIdx === -1) {
        preservedStartIdx = i
      }
      cum += finalSegments[i].beats
    }

    expect(preservedStartIdx).toBeGreaterThanOrEqual(0)
    const preservedSegments = finalSegments.slice(preservedStartIdx)
    const expectedPreserved = initialSegments.slice(2) // seg2, seg3, seg4, seg5

    expect(preservedSegments.length).toBe(expectedPreserved.length)
    for (let i = 0; i < expectedPreserved.length; i++) {
      expect(preservedSegments[i].direction).toBe(expectedPreserved[i].direction)
      expect(preservedSegments[i].beats).toBeCloseTo(expectedPreserved[i].beats, 3)
    }
  })
})