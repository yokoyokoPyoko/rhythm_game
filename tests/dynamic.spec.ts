import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

test('T97 Editor Full Workflow Usability Evaluation', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));

  // ──────────────────────────────────────────────
  // 1. アプリ起動・エディタ画面へ遷移（HashRouter対応）
  // ──────────────────────────────────────────────
  await page.goto('/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await expect(page.locator('#root')).toBeVisible();
  await page.waitForTimeout(2500);

  await page.evaluate(() => { window.location.hash = '#/editor'; });
  await page.waitForLoadState('networkidle', { timeout: 8000 });
  await expect(page.locator('.editor-screen')).toBeVisible();
  await expect(page.locator('[data-testid="editor-legend"]')).toBeVisible();
  await page.waitForTimeout(3000);

  // ──────────────────────────────────────────────
  // 2. 譜面情報・基本設定（タイトル・アーティスト・BPM・振幅等）
  // ──────────────────────────────────────────────
  await page.locator('#chart-title').fill('T97 Usability Test Chart');
  await page.locator('#chart-artist').fill('Test Artist');
  await page.locator('#bpm').fill('150');
  await page.locator('#amplitude').fill('130');
  await page.locator('#scroll-speed').fill('110');
  await page.locator('#audio-offset').fill('0');
  await page.waitForTimeout(1500);

  // ──────────────────────────────────────────────
  // 3. 音楽ファイル読込・再生・シーク
  // ──────────────────────────────────────────────
  await page.locator('#audio-url').fill('/rhythm_game/audio/08.Reply.flac');
  await page.waitForTimeout(500);

  const playBtn = page.getByRole('button', { name: /読込・再生|再生/ });
  await playBtn.click();

  const slider = page.locator('.editor-slider');
  await expect(slider).toBeEnabled({ timeout: 30000 });
  await page.waitForTimeout(3000);

  // 位置表示確認
  const posText = await page.locator('.editor-pos-time').textContent();
  expect(posText).not.toBeNull();
  const beatText = await page.locator('.editor-pos-beat').textContent();
  expect(beatText).toContain('beat:');

  // プレビュー上部ルーラークリックでシーク
  const canvas = page.locator('[data-testid="wave-preview-canvas"]');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width * 0.25, y: 10 } });
  await page.waitForTimeout(1500);

  const posAfterSeek = await page.locator('.editor-pos-time').textContent();
  expect(posAfterSeek).not.toBeNull();
  await page.waitForTimeout(2000);

  // 一旦停止（後の操作のため）
  await playBtn.click();
  await page.waitForTimeout(1500);

  // ──────────────────────────────────────────────
  // 4. BPM変更の追加・編集
  // ──────────────────────────────────────────────
  await page.getByRole('button', { name: 'BPM変更を追加' }).click();
  await page.waitForTimeout(800);

  // 最初の変更行を編集
  await page.locator('.bpm-change-beat').first().fill('8');
  await page.locator('.bpm-change-bpm').first().fill('180');
  await page.waitForTimeout(800);

  // タップテンポでBPM測定（4回タップ）
  const tapBtn = page.getByRole('button', { name: /タップ/ });
  for (let i = 0; i < 4; i++) {
    await tapBtn.click();
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(800);

  // タップテンポリセット
  await page.getByRole('button', { name: 'リセット' }).click();
  await page.waitForTimeout(800);

  // ──────────────────────────────────────────────
  // 5. リング配置・編集・削除（プレビュー上での直感操作）
  // ──────────────────────────────────────────────
  // リングリストを展開
  const ringDetails = page.locator('[data-testid="ring-list-details"]');
  await ringDetails.locator('summary').click();
  await page.waitForTimeout(1200);

  // スナップ設定変更
  await page.locator('#snap').selectOption('0.25');
  await page.waitForTimeout(800);

  // プレビュー上でクリックしてリング追加（5箇所）
  const ringPositions = [0.1, 0.25, 0.4, 0.55, 0.75];
  for (const frac of ringPositions) {
    await canvas.click({ position: { x: box.width * frac, y: box.height * 0.5 } });
    await page.waitForTimeout(600);
  }

  // リングが追加されたか確認
  await expect(page.locator('[data-testid="ring-list-item-0"]')).toBeVisible();
  await expect(page.locator('[data-testid="ring-list-item-4"]')).toBeVisible();
  await page.waitForTimeout(1200);

  // リングタイプをホールドに変更（最初のリング）
  await page.locator('[data-testid="ring-list-item-0"] .ring-type-select').selectOption('hold');
  await page.waitForTimeout(800);

  // ホールド長さを設定
  await page.locator('[data-testid="ring-list-item-0"] .ring-duration-input').fill('2');
  await page.waitForTimeout(800);

  // ドラッグでリング移動（2つ目のリング）
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200);

  // 選択状態確認
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.5 } });
  await page.waitForTimeout(600);
  await expect(page.locator('[data-testid="ring-list-item-1"]')).toHaveClass(/ring-list-item-selected/);

  // リング削除（Deleteキーで選択中のリングを削除）
  await page.keyboard.press('Delete');
  await page.waitForTimeout(1200);

  // ──────────────────────────────────────────────
  // 6. セグメント配置・編集・並べ替え
  // ──────────────────────────────────────────────
  const segDetails = page.locator('[data-testid="segment-list-details"]');
  await segDetails.locator('summary').click();
  await page.waitForTimeout(1200);

  // セグメント追加（3つ）
  await segDetails.locator('.editor-accordion-add').click();
  await page.waitForTimeout(600);
  await segDetails.locator('.editor-accordion-add').click();
  await page.waitForTimeout(600);
  await segDetails.locator('.editor-accordion-add').click();
  await page.waitForTimeout(600);

  // 各セグメントの方向・拍数を設定
  await page.locator('[data-testid="segment-direction-0"]').selectOption('up');
  await page.locator('[data-testid="segment-beats-0"]').fill('2');
  await page.waitForTimeout(500);

  await page.locator('[data-testid="segment-direction-1"]').selectOption('down');
  await page.locator('[data-testid="segment-beats-1"]').fill('2');
  await page.waitForTimeout(500);

  await page.locator('[data-testid="segment-direction-2"]').selectOption('stay');
  await page.locator('[data-testid="segment-beats-2"]').fill('4');
  await page.waitForTimeout(500);

  // セグメント順序変更（下矢印で1つ目を下へ） - aria-labelで特定
  await page.locator('.segment-move[aria-label="セグメント1を下に移動"]').click();
  await page.waitForTimeout(800);

  // セグメント削除（最後のものを削除）
  await page.locator('[data-testid="segment-delete-2"]').click();
  await page.waitForTimeout(800);

  // プレビューが即座に反映されているか視覚確認用ウェイト
  await page.waitForTimeout(2500);

  // ──────────────────────────────────────────────
  // 7. 波形プレビューの即時フィードバック確認
  // ──────────────────────────────────────────────
  // キャンバスが見えること、グリッド・判定線・波形が描画されていることを確認
  await expect(canvas).toBeVisible();
  const canvasBox = (await canvas.boundingBox())!;
  expect(canvasBox.height).toBeGreaterThanOrEqual(600); // 拡大されたプレビュー
  await page.waitForTimeout(2500);

  // 再生中にスペースでリングスタンプ、矢印キーでセグメントスタンプの動作確認
  await playBtn.click();
  await page.waitForTimeout(1500);

  // 再生中にスペース押下でリング追加
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);

  // 再生中に矢印キーでセグメント録音
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(400);

  // 停止
  await playBtn.click();
  await page.waitForTimeout(1500);

  // ──────────────────────────────────────────────
  // 8. TOMLエクスポート・正規フォーマット検証
  // ──────────────────────────────────────────────
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'エクスポート' }).click(),
  ]);
  const dlPath = await download.path();
  const toml = dlPath ? readFileSync(dlPath, 'utf-8') : '';

  // 必須フィールドの存在確認
  expect(toml).toContain('title = "T97 Usability Test Chart"');
  expect(toml).toContain('artist = "Test Artist"');
  expect(toml).toContain('bpm = 150');
  expect(toml).toContain('audio = "/rhythm_game/audio/08.Reply.flac"');
  expect(toml).toContain('audio_offset = 0');
  expect(toml).toContain('scroll_speed = 110');
  expect(toml).toContain('amplitude = 130');
  expect(toml).toContain('[[bpm_changes]]');
  expect(toml).toContain('beat = 8');
  expect(toml).toContain('bpm = 180');
  expect(toml).toContain('[[segments]]');
  expect(toml).toContain('direction = "up"');
  expect(toml).toContain('direction = "down"');
  expect(toml).toContain('direction = "stay"');
  expect(toml).toContain('[[rings]]');
  expect(toml).toContain('type = "hold"');
  expect(toml).toContain('duration = 2');

  // エクスポート完了トースト表示確認
  await expect(page.locator('[data-testid="editor-toast"]')).toBeVisible();
  await page.waitForTimeout(2000);

  // ──────────────────────────────────────────────
  // 9. エクスポートしたTOMLを再読込（ラウンドトリップ）
  // ──────────────────────────────────────────────
  await page.locator('[data-testid="import-toml"]').setInputFiles({
    name: 'reply.toml',
    mimeType: 'text/toml',
    buffer: Buffer.from(toml, 'utf-8'),
  });
  await page.waitForTimeout(2000);

  // 読み込まれた値を検証
  await expect(page.locator('#chart-title')).toHaveValue('T97 Usability Test Chart');
  await expect(page.locator('#chart-artist')).toHaveValue('Test Artist');
  await expect(page.locator('#bpm')).toHaveValue('150');
  await expect(page.locator('#amplitude')).toHaveValue('130');
  await expect(page.locator('#scroll-speed')).toHaveValue('110');

  // リング・セグメント・BPM変更が復元されているか
  await ringDetails.locator('summary').click();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid="ring-list-item-0"]')).toBeVisible();

  await segDetails.locator('summary').click();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid="segment-direction-0"]')).toHaveValue('down'); // 並べ替え後
  await page.waitForTimeout(1500);

  // ──────────────────────────────────────────────
  // 10. プレイテスト起動・ゲーム画面での確認・終了
  // ──────────────────────────────────────────────
  await page.getByRole('button', { name: 'プレイテスト' }).click();
  await expect(page.locator('.game-canvas')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(4000);

  // ゲーム画面で基本操作確認（スペースで開始、上下で移動）
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);

  // オフセット調整
  await page.keyboard.press('>');
  await page.waitForTimeout(300);
  await page.keyboard.press('<');
  await page.waitForTimeout(300);

  // キー効果音トグル
  await page.keyboard.press('k');
  await page.waitForTimeout(300);

  // 終了ボタンでエディタに戻る
  await page.getByRole('button', { name: '終了' }).click();
  await expect(page.locator('.editor-screen')).toBeVisible();
  await page.waitForTimeout(2500);

  // ──────────────────────────────────────────────
  // 11. エラー・空状態・異常入力への堅牢性確認
  // ──────────────────────────────────────────────
  // 空のTOMLをインポート（エラー表示確認）
  await page.locator('[data-testid="import-toml"]').setInputFiles({
    name: 'empty.toml',
    mimeType: 'text/toml',
    buffer: Buffer.from('', 'utf-8'),
  });
  await page.waitForTimeout(1500);
  await expect(page.locator('.editor-error')).toBeVisible();
  await page.waitForTimeout(1500);

  // 不正なBPM値入力（0や負の値）→ 120にクランプされる
  await page.locator('#bpm').fill('-10');
  await page.waitForTimeout(500);
  await expect(page.locator('#bpm')).toHaveValue('120');
  await page.locator('#bpm').fill('150');
  await page.waitForTimeout(500);

  // 不正な振幅値
  await page.locator('#amplitude').fill('5');
  await page.waitForTimeout(500);
  await expect(page.locator('#amplitude')).toHaveValue('130'); // 最小値10にクランプまたはデフォルト
  await page.locator('#amplitude').fill('130');
  await page.waitForTimeout(500);

  // ──────────────────────────────────────────────
  // 12. UI一貫性・フィードバック・視覚的応答の確認
  // ──────────────────────────────────────────────
  // アコーディオンの開閉アニメーション・状態保持
  await ringDetails.locator('summary').click();
  await page.waitForTimeout(1000);
  expect(await ringDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

  await segDetails.locator('summary').click();
  await page.waitForTimeout(1000);
  expect(await segDetails.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);

  // ホバー・トランジション確認（カード風要素）
  const playtestBtn = page.getByRole('button', { name: 'プレイテスト' });
  await playtestBtn.hover();
  await page.waitForTimeout(600);

  // ヘッダーの戻るリンク
  await page.locator('header a').hover();
  await page.waitForTimeout(600);

  // ──────────────────────────────────────────────
  // 13. 最終的なコンソールエラーチェック
  // ──────────────────────────────────────────────
  await page.waitForTimeout(3000);
  expect(errors).toHaveLength(0);
});