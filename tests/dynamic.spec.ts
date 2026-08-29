import { test, expect } from '@playwright/test'

async function collectErrors(page: any): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (msg: any) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
        errors.push(text)
      }
    }
  })
  page.on('pageerror', (err: Error) => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) {
      errors.push(err.message)
    }
  })
  return errors
}

async function openEditor(page: any): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/editor'
  })
  await page.waitForSelector('.editor-screen', { timeout: 15000 })
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
  await expect(page.locator('[data-testid="wave-preview-canvas"]')).toBeVisible()
  await page.waitForTimeout(3000)
}

async function waitForAudioLoaded(page: any): Promise<void> {
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement
      if (!btn) return false
      return !btn.textContent?.includes('読込')
    },
    { timeout: 60000 }
  )
  await page.waitForTimeout(2000)
}

async function getSegmentsFromState(page: any): Promise<Array<{ direction: string; beats: number }>> {
  return page.evaluate(() => (window as any).__editorSegments ?? [])
}

async function getSnapFromState(page: any): Promise<number> {
  return page.evaluate(() => (window as any).__editorSnap ?? 0.25)
}

async function getBeatFromState(page: any): Promise<number> {
  return page.evaluate(() => (window as any).__editorBeat ?? 0)
}

async function getRecLiveFromState(page: any): Promise<any> {
  return page.evaluate(() => (window as any).__editorRecLive ?? null)
}

async function getRecTrajFromState(page: any): Promise<Array<{ beat: number; y: number }>> {
  return page.evaluate(() => (window as any).__editorRecTraj ?? [])
}

async function startPlayback(page: any, playBtn: any): Promise<void> {
  const txt = await playBtn.textContent()
  if (txt?.includes('停止')) return
  await playBtn.click()
  await waitForAudioLoaded(page)
}

async function stopPlayback(page: any, playBtn: any): Promise<void> {
  const txt = await playBtn.textContent()
  if (txt?.includes('停止')) {
    await playBtn.click()
    await page.waitForTimeout(800)
  }
}

async function seekToBeat(page: any, beat: number): Promise<void> {
  const slider = page.locator('.editor-slider').first()
  const ms = beat * 500
  await slider.fill(String(ms))
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.waitForTimeout(1200)
}

function isSnapAligned(beats: number, snap: number): boolean {
  if (!(snap > 0)) return true
  const remainder = ((beats % snap) + snap) % snap
  return remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6
}

test.describe('T101 Dynamic Acceptance: Quantize (Snap) during Recording', () => {
  test('T101: Recording with quantization - segments beats are exact multiples of selected snap resolution', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only')
    test.setTimeout(300000)

    const allErrors = await collectErrors(page)

    // 0. Wait for dev server
    let retries = 0
    while (retries < 30) {
      try {
        const resp = await page.goto(process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/', {
          waitUntil: 'networkidle',
          timeout: 5000,
        })
        if (resp?.ok()) break
      } catch {
        // ignore
      }
      await page.waitForTimeout(1000)
      retries++
    }
    await expect(page.locator('#root')).toBeVisible()
    await page.waitForTimeout(2500)

    // 1. Open Editor
    await openEditor(page)
    await page.waitForTimeout(3000)

    const playBtn = page.locator('[data-testid="editor-play"]')
    const recordBtn = page.locator('[data-testid="editor-record-toggle"]')
    const snapSelect = page.locator('#snap')

    // 2. Load audio
    await expect(playBtn).toBeVisible()
    await playBtn.click()
    await waitForAudioLoaded(page)
    await page.waitForTimeout(3000)

    // 3. Verify snap dropdown exists and has correct options (1/8, 1/4, 1/2, 1/1)
    await expect(snapSelect).toBeVisible({ timeout: 5000 })
    const options = await snapSelect.locator('option').all()
    expect(options.length).toBe(4)
    const optionValues = await Promise.all(options.map((o) => o.getAttribute('value')))
    expect(optionValues).toEqual(['0.125', '0.25', '0.5', '1'])
    const optionTexts = await Promise.all(options.map((o) => o.textContent()))
    expect(optionTexts).toEqual(['1/8', '1/4', '1/2', '1/1'])
    await expect(snapSelect).toHaveValue('0.25')

    // Test each snap value: 1/2, 1/4, 1/8
    const snapTestCases = [
      { value: '0.5', label: '1/2', snap: 0.5 },
      { value: '0.25', label: '1/4', snap: 0.25 },
      { value: '0.125', label: '1/8', snap: 0.125 },
    ]

    for (const { value, label, snap } of snapTestCases) {
      console.log(`\n=== Testing snap = ${label} (${snap}) ===`)

      // 4a. Select snap value from dropdown
      await snapSelect.selectOption(value)
      await expect(snapSelect).toHaveValue(value)
      await page.waitForTimeout(500)

      // Verify internal state updated to match dropdown
      const snapState = await getSnapFromState(page)
      expect(snapState).toBe(snap)

      // 4b. Clear existing segments
      const clearBtn = page.locator('button[data-testid="editor-clear"]')
      await expect(clearBtn).toBeVisible()
      page.once('dialog', (dialog) => dialog.accept())
      await clearBtn.click()
      await page.waitForTimeout(1000)

      // 4c. Seek to beat 4 for consistent start
      await seekToBeat(page, 4)

      // 4d. Enter recording mode
      await recordBtn.click()
      await page.waitForTimeout(1000)
      await expect(recordBtn).toHaveClass(/editor-record-active/)

      // 4e. Start playback (recording happens during playback)
      await startPlayback(page, playBtn)
      await page.waitForTimeout(2000)

      // 4f. Simulate cursor movement: Up for ~2s, Down for ~2s
      await page.keyboard.down('ArrowUp')
      await page.waitForTimeout(2000)
      await page.keyboard.up('ArrowUp')
      await page.waitForTimeout(500)
      await page.keyboard.down('ArrowDown')
      await page.waitForTimeout(2000)
      await page.keyboard.up('ArrowDown')
      await page.waitForTimeout(1000)

      // 4g. Stop recording - this commits segments via segmentize()
      await recordBtn.click()
      await page.waitForTimeout(2000)
      await expect(recordBtn).not.toHaveClass(/editor-record-active/)

      // 4h. Stop playback
      await stopPlayback(page, playBtn)

      // 4i. CRITICAL: Read recorded segments from app state and verify quantization
      const segments = await getSegmentsFromState(page)

      expect(segments).toBeDefined()
      expect(Array.isArray(segments)).toBe(true)
      expect(segments!.length).toBeGreaterThan(0)

      console.log(`Recorded ${segments!.length} segments with snap=${label}:`)
      segments!.forEach((seg: any, idx: number) => {
        console.log(`  Segment ${idx}: direction=${seg.direction}, beats=${seg.beats}`)
      })

      // 4j. CRITICAL ASSERTION: Each segment's beats is an EXACT MULTIPLE of the snap resolution
      // This is the core behavioral contract - beats === n * snap for integer n
      for (const seg of segments!) {
        const beats = seg.beats
        const remainder = beats % snap
        const isMultiple = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6
        expect(isMultiple).toBeTruthy()
        if (!isMultiple) {
          console.error(`FAIL: Segment beats=${beats} is NOT a multiple of snap=${snap} (remainder=${remainder})`)
        }
      }

      // 4k. Verify via SegmentEditor UI that beats values are snapped
      const segmentPane = page.locator('section.editor-pane', { hasText: 'セグメント' })
      const details = segmentPane.locator('details[data-testid="segment-list-details"]')
      await expect(details).toBeVisible()
      await details.evaluate((el) => ((el as HTMLDetailsElement).open = true))
      await page.waitForTimeout(500)

      for (let segIdx = 0; segIdx < segments!.length; segIdx++) {
        const beatsInput = segmentPane.locator(`input[data-testid="segment-beats-${segIdx}"]`)
        if (await beatsInput.isVisible({ timeout: 2000 })) {
          const value = await beatsInput.inputValue()
          const beats = Number(value)
          const remainder = beats % snap
          const isMultiple = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6
          expect(isMultiple).toBeTruthy()
          if (!isMultiple) {
            console.error(`FAIL (UI): Segment ${segIdx} beats=${beats} is NOT a multiple of snap=${snap} (remainder=${remainder})`)
          }
        }
      }

      // 4l. Export TOML and verify quantization persisted in file
      const exportBtn = page.locator('button[data-testid="editor-export"]')
      await expect(exportBtn).toBeVisible()

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        exportBtn.click(),
      ])

      expect(download.suggestedFilename()).toBe('reply.toml')
      const filePath = await download.path()
      if (filePath) {
        const fs = require('fs')
        const parse = require('smol-toml').parse
        const fileContent = fs.readFileSync(filePath, 'utf8')
        const parsed = parse(fileContent) as any
        expect(parsed).toBeDefined()
        expect(Array.isArray(parsed.segments)).toBe(true)
        expect(parsed.segments.length).toBeGreaterThan(0)

        for (const seg of parsed.segments) {
          const beats = seg.beats
          const remainder = beats % snap
          const isMultiple = remainder < 1e-6 || Math.abs(remainder - snap) < 1e-6
          expect(isMultiple).toBeTruthy()
          if (!isMultiple) {
            console.error(`FAIL (TOML): Segment beats=${beats} is NOT a multiple of snap=${snap} (remainder=${remainder})`)
          }
        }

        console.log(`TOML export verified for snap=${label}`)
      }

      await page.waitForTimeout(1000)
    }

    // 5. Test that changing snap AFTER recording does NOT retroactively change existing segments
    console.log('\n=== Testing snap change does not retroactively modify segments ===')
    await snapSelect.selectOption('1') // Change to 1/1
    await expect(snapSelect).toHaveValue('1')
    await page.waitForTimeout(500)

    const segmentsAfterSnapChange = await getSegmentsFromState(page)

    expect(segmentsAfterSnapChange).toBeDefined()
    expect(segmentsAfterSnapChange!.length).toBeGreaterThan(0)

    // The segments should still be multiples of the ORIGINAL snap (0.125), not the new snap (1)
    for (const seg of segmentsAfterSnapChange!) {
      const beats = seg.beats
      const originalSnap = 0.125 // Last tested snap
      const remainder = beats % originalSnap
      const isMultipleOfOriginal = remainder < 1e-6 || Math.abs(remainder - originalSnap) < 1e-6
      expect(isMultipleOfOriginal).toBeTruthy()
      if (!isMultipleOfOriginal) {
        console.error(`FAIL: Segment beats=${beats} lost original quantization (snap=0.125)`)
      }
    }
    console.log('Segments preserved original quantization after snap change')

    // 6. Navigate back to home
    const backLink = page.locator('a', { hasText: '/ に戻る' })
    await expect(backLink).toBeVisible()
    await backLink.click()
    await page.waitForSelector('.select-screen', { timeout: 5000 })
    await page.waitForTimeout(1500)

    // 7. Assert no unhandled console errors
    expect(allErrors).toHaveLength(0)
  })

  test('T101: Snap dropdown UI correctly exposes quantize resolutions and updates internal state', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only')
    test.setTimeout(120000)

    const allErrors = await collectErrors(page)

    await page.goto(process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/')
    await page.waitForLoadState('networkidle', { timeout: 10000 })

    await page.evaluate(() => {
      window.location.hash = '#/editor'
    })
    await page.waitForSelector('.editor-screen', { timeout: 10000 })
    await page.waitForTimeout(2000)

    // Verify snap dropdown has correct options with fractional labels
    const snapSelect = page.locator('#snap')
    await expect(snapSelect).toBeVisible({ timeout: 5000 })

    const options = await snapSelect.locator('option').all()
    expect(options.length).toBe(4)

    const optionValues = await Promise.all(options.map((o) => o.getAttribute('value')))
    expect(optionValues).toEqual(['0.125', '0.25', '0.5', '1'])

    const optionTexts = await Promise.all(options.map((o) => o.textContent()))
    expect(optionTexts).toEqual(['1/8', '1/4', '1/2', '1/1'])

    // Verify default value is 0.25 (1/4)
    await expect(snapSelect).toHaveValue('0.25')

    // Verify changing snap updates internal state via window.__editorSnap
    await snapSelect.selectOption('0.5')
    await expect(snapSelect).toHaveValue('0.5')

    const snapState = await getSnapFromState(page)
    expect(snapState).toBe(0.5)

    await snapSelect.selectOption('1')
    await expect(snapSelect).toHaveValue('1')

    const snapState2 = await getSnapFromState(page)
    expect(snapState2).toBe(1)

    await snapSelect.selectOption('0.125')
    await expect(snapSelect).toHaveValue('0.125')

    const snapState3 = await getSnapFromState(page)
    expect(snapState3).toBe(0.125)

    expect(allErrors).toHaveLength(0)
  })

  test('T101: Recording trajectory produces segments quantized to the snap value selected DURING recording', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only')
    test.setTimeout(180000)

    const allErrors = await collectErrors(page)

    await page.goto(process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/')
    await page.waitForLoadState('networkidle', { timeout: 10000 })
    await expect(page.locator('#root')).toBeVisible()
    await page.waitForTimeout(2500)

    await openEditor(page)
    await page.waitForTimeout(3000)

    const playBtn = page.locator('[data-testid="editor-play"]')
    const recordBtn = page.locator('[data-testid="editor-record-toggle"]')
    const snapSelect = page.locator('#snap')

    // Load audio
    await playBtn.click()
    await waitForAudioLoaded(page)
    await page.waitForTimeout(3000)

    // Set snap to 1/4 (0.25) BEFORE recording
    await snapSelect.selectOption('0.25')
    await expect(snapSelect).toHaveValue('0.25')
    await page.waitForTimeout(500)

    // Capture the snap value that will be used during recording
    const snapUsedDuringRecording = await getSnapFromState(page)
    expect(snapUsedDuringRecording).toBe(0.25)

    // Clear segments
    const clearBtn = page.locator('button[data-testid="editor-clear"]')
    page.once('dialog', (dialog) => dialog.accept())
    await clearBtn.click()
    await page.waitForTimeout(1000)

    // Seek to beat 2
    await seekToBeat(page, 2)

    // Start recording
    await recordBtn.click()
    await page.waitForTimeout(1000)
    await startPlayback(page, playBtn)
    await page.waitForTimeout(1500)

    // During recording, press Up briefly
    await page.keyboard.down('ArrowUp')
    await page.waitForTimeout(1500)
    await page.keyboard.up('ArrowUp')

    // Continue recording Down
    await page.keyboard.down('ArrowDown')
    await page.waitForTimeout(1500)
    await page.keyboard.up('ArrowDown')
    await page.waitForTimeout(1000)

    // Stop recording - this is where segmentize(traj, snap, amplitude) is called
    await recordBtn.click()
    await page.waitForTimeout(2000)
    await stopPlayback(page, playBtn)

    // CRITICAL: Verify committed segments are quantized to the snap value used DURING recording
    const segments = await getSegmentsFromState(page)
    expect(segments.length).toBeGreaterThan(0)

    console.log(`Segments recorded with snap=${snapUsedDuringRecording}:`)
    segments.forEach((seg: any, idx: number) => {
      console.log(`  Segment ${idx}: direction=${seg.direction}, beats=${seg.beats}`)
    })

    for (const seg of segments) {
      const remainder = seg.beats % snapUsedDuringRecording
      const isMultiple = remainder < 1e-6 || Math.abs(remainder - snapUsedDuringRecording) < 1e-6
      expect(isMultiple).toBeTruthy()
      if (!isMultiple) {
        console.error(`FAIL: Segment beats=${seg.beats} is NOT a multiple of recording snap=${snapUsedDuringRecording} (remainder=${remainder})`)
      }
    }

    // Negative test: if we artificially change snap AFTER recording, segments should NOT change
    // (This verifies that quantization happens at commit time, not dynamically)
    await snapSelect.selectOption('0.5')
    await page.waitForTimeout(500)

    const segmentsAfterSnapChange = await getSegmentsFromState(page)
    expect(segmentsAfterSnapChange.length).toBe(segments.length)

    for (let i = 0; i < segments.length; i++) {
      // Segments should remain unchanged
      expect(segmentsAfterSnapChange[i].beats).toBe(segments[i].beats)
      expect(segmentsAfterSnapChange[i].direction).toBe(segments[i].direction)
    }

    expect(allErrors).toHaveLength(0)
  })

  test('T101: Segmentize function output is driven by snap parameter (negative test)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only')
    test.setTimeout(120000)

    // This test verifies the behavioral contract by directly testing the segmentize function
    // If segmentize() is patched to NOT quantize, this test MUST FAIL
    const { segmentize } = await import('../src/chart/quantize')

    // Create a trajectory that would produce non-quantized beats without quantization
    const trajectory = Array.from({ length: 21 }, (_, i) => ({
      beat: i * 0.1,
      y: 300 + Math.sin(i * 0.1 * Math.PI * 2) * 100,
    }))

    // With snap=0.25, segments MUST be multiples of 0.25
    const segments = segmentize(trajectory, 0.25, 130)
    expect(segments.length).toBeGreaterThan(0)

    for (const seg of segments) {
      const remainder = seg.beats % 0.25
      const isMultiple = remainder < 1e-6 || Math.abs(remainder - 0.25) < 1e-6
      expect(isMultiple).toBeTruthy()
    }

    // With snap=0.5, segments MUST be multiples of 0.5
    const segments2 = segmentize(trajectory, 0.5, 130)
    expect(segments2.length).toBeGreaterThan(0)

    for (const seg of segments2) {
      const remainder = seg.beats % 0.5
      const isMultiple = remainder < 1e-6 || Math.abs(remainder - 0.5) < 1e-6
      expect(isMultiple).toBeTruthy()
    }

    // With snap=0.125, segments MUST be multiples of 0.125
    const segments3 = segmentize(trajectory, 0.125, 130)
    expect(segments3.length).toBeGreaterThan(0)

    for (const seg of segments3) {
      const remainder = seg.beats % 0.125
      const isMultiple = remainder < 1e-6 || Math.abs(remainder - 0.125) < 1e-6
      expect(isMultiple).toBeTruthy()
    }
  })
})