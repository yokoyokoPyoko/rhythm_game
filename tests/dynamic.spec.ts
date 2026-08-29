import { test, expect } from '@playwright/test'

test.describe('T103: Legacy ring stamping removed in play mode, allowed in record mode', () => {
  test('Space key ring stamping is blocked in play mode, allowed in record mode', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          consoleErrors.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    await page.goto('/#/editor')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()

    // Wait for initial render and canvas to be ready
    await page.waitForTimeout(2000)

    // --- Step 1: Start from a clean chart ---
    await page.locator('[data-testid="editor-clear"]').click()
    await page.waitForTimeout(500)

    const getRingsLength = async () => {
      return await page.evaluate(() => (window as any).__editorRings?.length ?? -1)
    }

    const getMode = async () => {
      return await page.evaluate(() => (window as any).__editorMode ?? 'unknown')
    }

    const getIsPlaying = async () => {
      return await page.evaluate(() => (window as any).__editorIsPlaying ?? false)
    }

    let ringsBefore = await getRingsLength()
    expect(ringsBefore).toBe(0)

    // --- Step 2: Start playback (play mode) ---
    // Click the play button and wait for it to change to "停止"
    await page.locator('[data-testid="editor-play"]').click()

    // Wait for playback to start - button text changes to 停止
    await expect(page.locator('[data-testid="editor-play"]')).toHaveText(/停止/, { timeout: 30000 })
    await page.waitForTimeout(1000)

    // Verify we're in play mode and playing
    expect(await getMode()).toBe('play')
    expect(await getIsPlaying()).toBe(true)

    // --- Step 3: NEGATIVE CONTROL - In play mode, Space must NOT add rings ---
    // Focus the canvas so keyboard events are captured
    const canvas = page.locator('[data-testid="wave-preview-canvas"]')
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    const ringsBeforePlayMode = await getRingsLength()

    // Press Space multiple times
    for (let i = 0; i < 3; i++) {
      await page.keyboard.down('Space')
      await page.waitForTimeout(50)
      await page.keyboard.up('Space')
      await page.waitForTimeout(200)
    }

    await page.waitForTimeout(800)
    const ringsAfterPlayMode = await getRingsLength()

    // Rings should NOT have changed in play mode
    expect(ringsAfterPlayMode).toBe(ringsBeforePlayMode)

    // --- Step 4: Switch to record mode ---
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/, { timeout: 5000 })
    await page.waitForTimeout(500)

    // Verify mode changed to record while still playing
    expect(await getMode()).toBe('record')
    expect(await getIsPlaying()).toBe(true)

    // Re-focus canvas
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    // --- Step 5: POSITIVE CONTROL - In record mode, Space MUST add rings ---
    const ringsBeforeRecordMode = await getRingsLength()

    // Press and hold Space briefly (simulating a tap)
    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(600)

    const ringsAfterFirstRing = await getRingsLength()

    // One ring should have been added
    expect(ringsAfterFirstRing).toBe(ringsBeforeRecordMode + 1)

    // Add another ring at a different position
    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(600)

    const ringsAfterSecondRing = await getRingsLength()
    expect(ringsAfterSecondRing).toBe(ringsBeforeRecordMode + 2)

    // --- Step 6: Switch back to play mode ---
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).not.toHaveClass(/editor-record-active/)
    await page.waitForTimeout(500)

    // Verify mode changed back to play
    expect(await getMode()).toBe('play')
    expect(await getIsPlaying()).toBe(true)

    // Re-focus canvas
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    // --- Step 7: NEGATIVE CONTROL again - In play mode, Space must NOT add rings ---
    const ringsBeforePlayMode2 = await getRingsLength()

    for (let i = 0; i < 3; i++) {
      await page.keyboard.down('Space')
      await page.waitForTimeout(50)
      await page.keyboard.up('Space')
      await page.waitForTimeout(200)
    }

    await page.waitForTimeout(800)
    const ringsAfterPlayMode2 = await getRingsLength()

    // Rings should NOT have changed
    expect(ringsAfterPlayMode2).toBe(ringsBeforePlayMode2)

    // --- Final verification ---
    expect(consoleErrors).toHaveLength(0)
  })

  test('record mode toggle works correctly when not playing', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          consoleErrors.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    await page.goto('/#/editor')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
    await page.waitForTimeout(2000)

    await page.locator('[data-testid="editor-clear"]').click()
    await page.waitForTimeout(500)

    const getRingsLength = async () => {
      return await page.evaluate(() => (window as any).__editorRings?.length ?? -1)
    }

    const getMode = async () => {
      return await page.evaluate(() => (window as any).__editorMode ?? 'unknown')
    }

    // Without playback, pressing record toggle should NOT allow Space to add rings
    // (because isPlayingRef.current is false)
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/)
    await page.waitForTimeout(500)

    expect(await getMode()).toBe('record')

    const canvas = page.locator('[data-testid="wave-preview-canvas"]')
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    const ringsBefore = await getRingsLength()

    // Try pressing Space - should NOT add rings because not playing
    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(600)

    const ringsAfter = await getRingsLength()
    expect(ringsAfter).toBe(ringsBefore)

    // Now start playback
    await page.locator('[data-testid="editor-play"]').click()
    await expect(page.locator('[data-testid="editor-play"]')).toHaveText(/停止/, { timeout: 30000 })
    await page.waitForTimeout(1000)

    expect(await getMode()).toBe('record')
    expect(await getIsPlaying()).toBe(true)

    // Re-focus canvas
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    // Now Space SHOULD add rings
    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(600)

    const ringsAfterPlaying = await getRingsLength()
    expect(ringsAfterPlaying).toBe(ringsBefore + 1)

    expect(consoleErrors).toHaveLength(0)
  })

  test('hold ring creation with sustained Space press in record mode', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          consoleErrors.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    await page.goto('/#/editor')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
    await page.waitForTimeout(2000)

    await page.locator('[data-testid="editor-clear"]').click()
    await page.waitForTimeout(500)

    const getRingsLength = async () => {
      return await page.evaluate(() => (window as any).__editorRings?.length ?? -1)
    }

    const getRingsDetail = async () => {
      return await page.evaluate(() => (window as any).__editorRings ?? [])
    }

    const getMode = async () => {
      return await page.evaluate(() => (window as any).__editorMode ?? 'unknown')
    }

    const getIsPlaying = async () => {
      return await page.evaluate(() => (window as any).__editorIsPlaying ?? false)
    }

    // Start playback
    await page.locator('[data-testid="editor-play"]').click()
    await expect(page.locator('[data-testid="editor-play"]')).toHaveText(/停止/, { timeout: 30000 })
    await page.waitForTimeout(1000)

    // Switch to record mode
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/)
    await page.waitForTimeout(500)

    expect(await getMode()).toBe('record')
    expect(await getIsPlaying()).toBe(true)

    const canvas = page.locator('[data-testid="wave-preview-canvas"]')
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    const ringsBefore = await getRingsLength()

    // Press and HOLD Space for longer than 0.3 beats worth of time
    // At 120 BPM, 1 beat = 500ms, so 0.3 beats = 150ms
    // We'll hold for 400ms to trigger hold ring
    await page.keyboard.down('Space')
    await page.waitForTimeout(400)
    await page.keyboard.up('Space')
    await page.waitForTimeout(800)

    const ringsAfter = await getRingsLength()
    expect(ringsAfter).toBe(ringsBefore + 1)

    // Verify the ring is a hold type with duration
    const ringsDetail = await getRingsDetail()
    const newRing = ringsDetail[ringsDetail.length - 1]
    expect(newRing.type).toBe('hold')
    expect(newRing.duration).toBeGreaterThan(0.3)

    expect(consoleErrors).toHaveLength(0)
  })

  test('Space key press in play mode does not create rings even when record mode was previously active', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          consoleErrors.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message)
    })

    await page.goto('/#/editor')
    await page.waitForLoadState('networkidle', { timeout: 15000 })
    await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible()
    await page.waitForTimeout(2000)

    await page.locator('[data-testid="editor-clear"]').click()
    await page.waitForTimeout(500)

    const getRingsLength = async () => {
      return await page.evaluate(() => (window as any).__editorRings?.length ?? -1)
    }

    const getMode = async () => {
      return await page.evaluate(() => (window as any).__editorMode ?? 'unknown')
    }

    const getIsPlaying = async () => {
      return await page.evaluate(() => (window as any).__editorIsPlaying ?? false)
    }

    // Start playback
    await page.locator('[data-testid="editor-play"]').click()
    await expect(page.locator('[data-testid="editor-play"]')).toHaveText(/停止/, { timeout: 30000 })
    await page.waitForTimeout(1000)

    // Switch to record mode and add a ring
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/)
    await page.waitForTimeout(500)

    const canvas = page.locator('[data-testid="wave-preview-canvas"]')
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    // Add one ring in record mode
    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(600)

    let ringsCount = await getRingsLength()
    expect(ringsCount).toBe(1)

    // Switch back to play mode
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).not.toHaveClass(/editor-record-active/)
    await page.waitForTimeout(500)

    expect(await getMode()).toBe('play')
    expect(await getIsPlaying()).toBe(true)

    // Re-focus canvas
    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    // Press Space many times in play mode
    const ringsBeforePlay = await getRingsLength()
    for (let i = 0; i < 5; i++) {
      await page.keyboard.down('Space')
      await page.waitForTimeout(50)
      await page.keyboard.up('Space')
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(800)

    // Ring count should NOT change
    const ringsAfterPlay = await getRingsLength()
    expect(ringsAfterPlay).toBe(ringsBeforePlay)

    // Switch back to record mode and verify we can still add rings
    await page.locator('[data-testid="editor-record-toggle"]').click()
    await expect(page.locator('[data-testid="editor-record-toggle"]')).toHaveClass(/editor-record-active/)
    await page.waitForTimeout(500)

    expect(await getMode()).toBe('record')

    await canvas.click({ position: { x: 100, y: 200 } })
    await page.waitForTimeout(300)

    await page.keyboard.down('Space')
    await page.waitForTimeout(100)
    await page.keyboard.up('Space')
    await page.waitForTimeout(600)

    ringsCount = await getRingsLength()
    expect(ringsCount).toBe(ringsAfterPlay + 1)

    expect(consoleErrors).toHaveLength(0)
  })
})