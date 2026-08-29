import { test, expect } from '@playwright/test'

test.describe('T104: WavePreview vertex rendering (廃止: 固定ステップサンプリング / 多重重ね描き)', () => {
  const EDITOR_URL = 'http://localhost:5173/#/editor'
  const CANVAS_SELECTOR = '[data-testid="wave-preview-canvas"]'

  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          errors.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      errors.push(err.message)
    })

    await page.goto(EDITOR_URL)
    await page.waitForLoadState('networkidle', { timeout: 10000 })
    await expect(page.locator(CANVAS_SELECTOR)).toBeVisible()
    await page.waitForTimeout(800)
    expect(errors).toHaveLength(0)
  })

  // Build a chart with three colored segments via the real UI:
  //   up(8)  -> accent  (#6366f1)
  //   down(8)-> sub     (#22d3ee)
  //   stay(4)-> warning (#fbbf24)
  async function buildThreeSegments(page: import('@playwright/test').Page) {
    for (let i = 0; i < 3; i++) {
      await page.click('[data-testid="segment-add"]')
      await page.waitForTimeout(150)
    }
    await page.selectOption('[data-testid="segment-direction-0"]', 'up')
    await page.fill('[data-testid="segment-beats-0"]', '8')
    await page.selectOption('[data-testid="segment-direction-1"]', 'down')
    await page.fill('[data-testid="segment-beats-1"]', '8')
    await page.selectOption('[data-testid="segment-direction-2"]', 'stay')
    await page.fill('[data-testid="segment-beats-2"]', '4')
    // Show the whole 20-beat chart (zoom out to 20 beats).
    await page.fill('#zoom', '20')
    await page.waitForTimeout(300)
  }

  // Reads the canvas pixels and classifies the waveform color at the given beat
  // (startBeat = 0, viewBeats = 20). Returns 'accent' | 'sub' | 'warning' | other.
  async function colorAtBeat(page: import('@playwright/test').Page, beat: number) {
    return page.evaluate((b: number) => {
      const canvas = document.querySelector(
        '[data-testid="wave-preview-canvas"]',
      ) as HTMLCanvasElement | null
      if (!canvas) return 'none'
      const ctx = canvas.getContext('2d')
      if (!ctx) return 'none'
      const w = canvas.width
      const h = canvas.height
      const dpr = window.devicePixelRatio || 1
      const cssW = w / dpr
      const view = (window as unknown as { __editorView?: { startBeat: number; beats: number } })
        .__editorView || { startBeat: 0, beats: 20 }
      const viewBeats = view.beats
      const viewStart = view.startBeat
      const img = ctx.getImageData(0, 0, w, h).data
      const x = Math.round(((b - viewStart) / viewBeats) * cssW * dpr)
      if (x < 0 || x >= w) return 'none'

      const ACCENT = [99, 102, 241]
      const SUB = [34, 211, 238]
      const STAY = [251, 191, 36]
      const dist = (r: number, g: number, bl: number, c: number[]) =>
        (r - c[0]) ** 2 + (g - c[1]) ** 2 + (bl - c[2]) ** 2

      const counts: Record<string, number> = { accent: 0, sub: 0, warning: 0 }
      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4
        const r = img[idx]
        const g = img[idx + 1]
        const bl = img[idx + 2]
        // Ignore faint background and near-white guide lines.
        if (r < 25 && g < 25 && bl < 35) continue
        if (r > 200 && g > 200 && bl > 200) continue
        const da = dist(r, g, bl, ACCENT)
        const ds = dist(r, g, bl, SUB)
        const dt = dist(r, g, bl, STAY)
        const m = Math.min(da, ds, dt)
        if (m > 6000) continue
        if (m === da) counts.accent++
        else if (m === ds) counts.sub++
        else counts.warning++
      }
      const ranked = Object.entries(counts).sort((a, c) => c[1] - a[1])
      return ranked[0][1] > 0 ? ranked[0][0] : 'none'
    }, beat)
  }

  test('各セグメントが自身の区間のみを描画し、多重重ね描きしない（色リージョン検証）', async ({ page }) => {
    await buildThreeSegments(page)

    // up region (beat 4) -> accent
    const up = await colorAtBeat(page, 4)
    // down region (beat 10, away from center guide) -> sub
    const down = await colorAtBeat(page, 10)
    // stay region (beat 18, on bottom guide but opaque line on top) -> warning
    const stay = await colorAtBeat(page, 18)

    expect(up).toBe('accent')
    expect(down).toBe('sub')
    expect(stay).toBe('warning')
  })

  test('ズーム倍率（viewBeats変更）に関わらず頂点が正確に描画される', async ({ page }) => {
    await buildThreeSegments(page)

    // At every zoom level (wide enough to contain both regions) the down region
    // must keep its sub color and the up region its accent color (no full-range
    // overdraw that would smear the whole wave with the last segment's color).
    for (const zoom of [16, 32, 64]) {
      await page.fill('#zoom', String(zoom))
      await page.waitForTimeout(200)
      const up = await colorAtBeat(page, 4)
      const down = await colorAtBeat(page, 10)
      expect(up).toBe('accent')
      expect(down).toBe('sub')
    }
  })

  test('スクロール（開始拍変更）後も頂点描画が崩れない', async ({ page }) => {
    await buildThreeSegments(page)
    // Read the scroll slider's actual max so we never fill an out-of-range value.
    const maxAttr = await page.getAttribute('#scroll', 'max')
    const max = maxAttr ? Number(maxAttr) : 0
    if (max >= 2) {
      await page.fill('#scroll', '2')
      await page.waitForTimeout(300)
    }
    // After panning, the visible down/up regions should still be correctly colored.
    const up = await colorAtBeat(page, 4)
    const down = await colorAtBeat(page, 10)
    expect(up).toBe('accent')
    expect(down).toBe('sub')
  })

  test('固定ステップサンプリング廃止: セグメント区間が直線として正確に結ばれる', async ({ page }) => {
    await buildThreeSegments(page)
    // The down segment spans beats 8..16 from top(y=170) to bottom(y=430).
    // Sample several points and confirm they lie on the exact straight line
    // (vertex-to-vertex lineTo), i.e. y is linear in beat.
    const samples = await page.evaluate(() => {
      const canvas = document.querySelector(
        '[data-testid="wave-preview-canvas"]',
      ) as HTMLCanvasElement | null
      if (!canvas) return []
      const ctx = canvas.getContext('2d')
      if (!ctx) return []
      const w = canvas.width
      const h = canvas.height
      const dpr = window.devicePixelRatio || 1
      const cssW = w / dpr
      const view = (window as unknown as { __editorView?: { startBeat: number; beats: number } })
        .__editorView || { startBeat: 0, beats: 20 }
      const viewBeats = view.beats
      const viewStart = view.startBeat
      const img = ctx.getImageData(0, 0, w, h).data
      const SUB = [34, 211, 238]
      const dist = (r: number, g: number, bl: number) =>
        (r - SUB[0]) ** 2 + (g - SUB[1]) ** 2 + (bl - SUB[2]) ** 2
      const out: { beat: number; y: number }[] = []
      for (const b of [9, 10, 11, 12, 13, 14, 15]) {
        const x = Math.round(((b - viewStart) / viewBeats) * cssW * dpr)
        let bestY = -1
        let bestD = Infinity
        for (let y = 0; y < h; y++) {
          const idx = (y * w + x) * 4
          const d = dist(img[idx], img[idx + 1], img[idx + 2])
          if (d < bestD) {
            bestD = d
            bestY = y
          }
        }
        out.push({ beat: b, y: bestY })
      }
      return out
    })
    expect(samples.length).toBe(7)
    // Linear check: y as a function of beat must be a straight line (constant slope).
    const ys = samples.map((s) => s.y)
    const diffs: number[] = []
    for (let i = 1; i < ys.length; i++) diffs.push(ys[i] - ys[i - 1])
    const slope = diffs[0]
    for (const d of diffs) {
      expect(Math.abs(d - slope)).toBeLessThan(3) // per-beat step is constant
    }
  })

  test('コンソールエラーなし（未捕捉TypeError/ReferenceError等）', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(text)) {
          errors.push(text)
        }
      }
    })
    page.on('pageerror', (err) => {
      errors.push(err.message)
    })

    await buildThreeSegments(page)
    await page.fill('#zoom', '2')
    await page.waitForTimeout(200)
    await page.fill('#zoom', '64')
    await page.waitForTimeout(200)
    const maxAttr = await page.getAttribute('#scroll', 'max')
    const max = maxAttr ? Number(maxAttr) : 0
    if (max >= 2) {
      await page.fill('#scroll', '2')
      await page.waitForTimeout(200)
    }
    await page.fill('#scroll', '0')
    await page.waitForTimeout(200)

    expect(errors).toHaveLength(0)
  })
})
