import { test, expect, type ConsoleMessage } from '@playwright/test'

test.describe('T96: オーサリングツール UI/UX 刷新 (動的テスト・動画撮影用)', () => {
  test('expanded WavePreview, default-collapsed accordions, and intuitive editing', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only for video recording')
    test.setTimeout(180000)

    const errors: string[] = []
    page.on('console', (msg: ConsoleMessage) => {
      const t = msg.text()
      if (msg.type() === 'error' && /Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) {
        errors.push(t)
      }
    })
    page.on('pageerror', (e) => errors.push(e.message))

    // --- 1. ホーム画面からエディタへ遷移 ---
    await page.goto('/rhythm_game/', { waitUntil: 'networkidle' })
    await expect(page.locator('#root')).toBeVisible()
    await page.waitForTimeout(2000) // 初期ロード・フェードイン待機

    // HashRouterでのエディタ遷移
    await page.evaluate(() => { window.location.hash = '#/editor'; })
    await page.waitForTimeout(3000) // 画面遷移アニメーション + Canvas初期化待機

    // WavePreviewコンテナとCanvasが表示されることを確認
    const wavePreview = page.locator('[data-testid="wave-preview"]')
    await expect(wavePreview).toBeVisible()

    const canvas = page.locator('[data-testid="wave-preview-canvas"]')
    await expect(canvas).toBeVisible()
    const canvasBox = await canvas.boundingBox()
    expect(canvasBox).not.toBeNull()
    const box = canvasBox!

    // --- 柱1: プレビュー拡大 (縦幅 640px 以上) ---
    console.log(`[Video] WavePreview canvas size: ${Math.round(box.width)}x${Math.round(box.height)}`)
    expect(box.height).toBeGreaterThanOrEqual(600) // CSS指定 640px 以上

    // グリッド線・判定線・波形描画の視認性確認のため、十分な時間静止撮影
    await page.waitForTimeout(4000)

    // --- 柱2: 右ペインのアコーディオン（デフォルト折りたたみ） ---
    const ringDetails = page.locator('[data-testid="ring-list-details"]')
    const segDetails = page.locator('[data-testid="segment-list-details"]')
    await expect(ringDetails).toBeVisible()
    await expect(segDetails).toBeVisible()

    const isOpen = (loc: ReturnType<typeof page.locator>) =>
      loc.evaluate((el: HTMLElement) => (el as HTMLDetailsElement).open)

    expect(await isOpen(ringDetails)).toBe(false)
    expect(await isOpen(segDetails)).toBe(false)
    await page.waitForTimeout(2000) // 折りたたみ状態を動画に収める

    // リングアコーディオン展開
    await ringDetails.locator('summary').click()
    await page.waitForTimeout(1500)
    expect(await isOpen(ringDetails)).toBe(true)
    await page.waitForTimeout(1500)

    // セグメントアコーディオン展開
    await segDetails.locator('summary').click()
    await page.waitForTimeout(1500)
    expect(await isOpen(segDetails)).toBe(true)
    await page.waitForTimeout(2000) // 展開状態の撮影

    // --- 柱3: 直感的編集 (クリック追加・ドラッグ移動・ダブルクリック削除・選択) ---

    // 3a. セグメントを1つ追加して波形を表示させる
    await segDetails.locator('.editor-accordion-add').click()
    await page.waitForTimeout(2000) // セグメント追加・波形再描画待機

    // 3b. プレビューキャンバス上でクリック → リング追加
    const addXRatio = 0.25
    const addYRatio = 0.5
    await canvas.click({ position: { x: box.width * addXRatio, y: box.height * addYRatio } })
    await page.waitForTimeout(2000)

    const ringListItems = page.locator('[data-testid^="ring-list-item-"]')
    const ringCountAfterAdd = await ringListItems.count()
    expect(ringCountAfterAdd).toBeGreaterThan(0)
    console.log(`[Video] Ring added via click. Total rings: ${ringCountAfterAdd}`)
    await page.waitForTimeout(3000) // 追加されたリングマーカーの表示確認

    // 3c. 追加したリングをドラッグ移動
    const firstRingItem = ringListItems.first()
    const beatTextBefore = await firstRingItem.locator('.ring-list-beat').innerText()
    const beatBefore = parseFloat(beatTextBefore.replace(/[^0-9.]/g, ''))

    // ドラッグ開始位置 = 現在のリング位置
    const startX = Math.round((beatBefore / 4) * box.width) // lastBeat=4 (セグメント1つ=1beat, 最小4)
    const targetX = Math.min(box.width - 20, startX + Math.round(box.width * 0.3))

    await page.mouse.move(box.x + startX, box.y + box.height * 0.5)
    await page.waitForTimeout(500)
    await page.mouse.down()
    await page.waitForTimeout(300)
    await page.mouse.move(box.x + startX + 40, box.y + box.height * 0.5, { steps: 8 })
    await page.waitForTimeout(300)
    await page.mouse.move(box.x + targetX, box.y + box.height * 0.5, { steps: 12 })
    await page.waitForTimeout(300)
    await page.mouse.up()
    await page.waitForTimeout(2000)

    const beatTextAfterMove = await firstRingItem.locator('.ring-list-beat').innerText()
    const beatAfterMove = parseFloat(beatTextAfterMove.replace(/[^0-9.]/g, ''))
    expect(beatAfterMove).not.toBe(beatBefore)
    console.log(`[Video] Ring dragged: ${beatBefore.toFixed(2)} -> ${beatAfterMove.toFixed(2)} beat`)
    await page.waitForTimeout(3000) // 移動後の状態撮影

    // 3d. 移動したリングをクリック選択
    const movedRingX = Math.round((beatAfterMove / 4) * box.width)
    await canvas.click({ position: { x: movedRingX, y: box.height * 0.5 } })
    await page.waitForTimeout(1500)
    await expect(firstRingItem).toHaveClass(/ring-list-item-selected/)
    console.log('[Video] Ring selected via click')
    await page.waitForTimeout(2000)

    // 3e. 選択中のリングを Delete キーで削除
    await page.keyboard.press('Delete')
    await page.waitForTimeout(1500)
    const ringCountAfterDelete = await ringListItems.count()
    expect(ringCountAfterDelete).toBe(ringCountAfterAdd - 1)
    console.log('[Video] Ring deleted via Delete key')
    await page.waitForTimeout(2000)

    // 3f. 再度クリックでリング追加 → ダブルクリックで削除
    await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.6 } })
    await page.waitForTimeout(1500)
    const ringCountBeforeDbl = await ringListItems.count()
    expect(ringCountBeforeDbl).toBe(ringCountAfterDelete + 1)

    const newRingItem = ringListItems.last()
    const beatTextNew = await newRingItem.locator('.ring-list-beat').innerText()
    const beatNew = parseFloat(beatTextNew.replace(/[^0-9.]/g, ''))
    const dblClickX = Math.round((beatNew / 4) * box.width)

    await canvas.dblclick({ position: { x: dblClickX, y: box.height * 0.6 } })
    await page.waitForTimeout(1500)
    const ringCountAfterDbl = await ringListItems.count()
    expect(ringCountAfterDbl).toBe(ringCountBeforeDbl - 1)
    console.log('[Video] Ring deleted via double-click')
    await page.waitForTimeout(2000)

    // 3g. ホールドリング種別切り替え・長さ編集 (リング一覧内のUI操作)
    await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } })
    await page.waitForTimeout(1500)
    const lastRing = ringListItems.last()
    await expect(lastRing).toBeVisible()

    // タイプを 'hold' に変更
    const typeSelect = lastRing.locator('.ring-type-select')
    await typeSelect.selectOption('hold')
    await page.waitForTimeout(1000)

    // 長さ(duration)を入力
    const durationInput = lastRing.locator('.ring-duration-input')
    await expect(durationInput).toBeVisible()
    await durationInput.fill('2')
    await page.waitForTimeout(1000)
    console.log('[Video] Hold ring type + duration edited via accordion UI')
    await page.waitForTimeout(2000)

    // 3h. セグメント方向・拍数の編集 (セグメントアコーディオン内)
    const firstSegDirection = segDetails.locator('[data-testid="segment-direction-0"]')
    await firstSegDirection.selectOption('down')
    await page.waitForTimeout(1000)

    const firstSegBeats = segDetails.locator('[data-testid="segment-beats-0"]')
    await firstSegBeats.fill('2')
    await page.waitForTimeout(1000)
    console.log('[Video] Segment direction/beats edited via accordion UI')
    await page.waitForTimeout(2000)

    // 3i. セグメント追加・移動・削除ボタン操作
    await segDetails.locator('.editor-accordion-add').click()
    await page.waitForTimeout(1500)
    const segCount = await segDetails.locator('.segment-list-item').count()
    expect(segCount).toBe(2)
    console.log('[Video] Segment added via accordion button')

    // 2つ目のセグメントを下に移動 (移動ボタン)
    await segDetails.locator('[data-testid="segment-delete-0"]').click() // 最初のを削除してシンプルに
    await page.waitForTimeout(1500)
    console.log('[Video] Segment deleted via accordion button')
    await page.waitForTimeout(2000)

    // --- 柱2補足: アコーディオンを再度折りたたみ ---
    await ringDetails.locator('summary').click()
    await page.waitForTimeout(1000)
    expect(await isOpen(ringDetails)).toBe(false)

    await segDetails.locator('summary').click()
    await page.waitForTimeout(1000)
    expect(await isOpen(segDetails)).toBe(false)
    await page.waitForTimeout(3000) // 完全に折りたたまれた状態を撮影

    // --- エクスポート・プレイテストボタンの存在確認 ---
    const exportBtn = page.locator('button:has-text("エクスポート")')
    const playtestBtn = page.locator('button:has-text("プレイテスト")')
    await expect(exportBtn).toBeVisible()
    await expect(playtestBtn).toBeVisible()
    console.log('[Video] Export / Playtest buttons visible')
    await page.waitForTimeout(2000)

    // --- BPM設定ペインのタップテンポ・BPM変更追加 ---
    const bpmInput = page.locator('#bpm')
    await bpmInput.fill('140')
    await page.waitForTimeout(500)

    const tapBtn = page.locator('button:has-text("タップ")')
    for (let i = 0; i < 4; i++) {
      await tapBtn.click()
      await page.waitForTimeout(200)
    }
    await page.waitForTimeout(1000)
    console.log('[Video] Tap tempo interaction')
    await page.waitForTimeout(2000)

    const addBpmChangeBtn = page.locator('button:has-text("BPM変更を追加")')
    await addBpmChangeBtn.click()
    await page.waitForTimeout(1000)
    console.log('[Video] BPM change added')
    await page.waitForTimeout(2000)

    // --- 最終静止撮影 (全体レイアウト確認用) ---
    await page.waitForTimeout(8000)

    // コンソールエラーがないこと
    expect(errors).toHaveLength(0)
  })
})