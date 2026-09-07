/**
 * T196 — カスタム譜面ライブラリの結合・回帰 (Playwright E2E, real Chromium + real IndexedDB)
 *
 * 要求: T193〜T195の結合仕上げ
 * フロー: 追加→リロード→一覧表示→プレイ(音あり)→削除
 * 完了条件:
 *   (1) 一連フローが破綻なく完了
 *   (2) 異常系（容量・破損TOML/bytes）でクラッシュせず分かりやすいエラー
 *   (3) T110/T120/T194/T195 回帰なし
 *
 * STRICT QA:
 *  - すべての手順に Capture(pre) → Perform → Assert(delta) の3-stepを使用
 *  - setInputFiles で実ファイルを投入し、画面は実DOM操作（追加/削除/再生）で駆動
 *  - IndexedDB 記録件数は page.evaluate で直接カウントして前後差分を検証
 *  - コンソールに Uncaught/TypeError が出ないこと
 */
import { test, expect } from '@playwright/test';

const CHART_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/tests/fixtures/custom-song.toml';
const AUDIO_FIXTURE = '/home/p-yoko/Program/TypeScript/rhythm_game/public/test-audio.wav';
const DB_NAME = 'trace-wave-library';

async function idbCountCharts(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async (dbName: string) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const count = await new Promise<number>((resolve) => {
      const tx = db.transaction('charts', 'readonly');
      const store = tx.objectStore('charts');
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(-1);
    });
    db.close();
    return count;
  }, DB_NAME);
}

test('T196 e2e: 追加→リロード→一覧表示→プレイ(音あり)→削除 が破綻なく完了し、IDB件数が 0→1→1→0 と遷移する', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) errors.push(err.message);
  });

  await page.goto('http://127.0.0.1:5173/rhythm_game/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });

  // ---------- [1] 追加 ----------
  // Step1: Capture — 初期IDB件数（事前状態）
  const preCount = await idbCountCharts(page);
  const cardsBefore = await page.locator('.song-card').count();

  // AudioContext を gesture で活性化しておく（ヘッドレスでは resume に必要なため）
  await page.locator('.select-header h1').click();

  // Step2: Perform — TOML + 音声を setInputFiles で投入
  await page.locator('input[data-testid="home-chart-input"]').setInputFiles(CHART_FIXTURE);
  await page.locator('input[data-testid="home-audio-input"]').setInputFiles(AUDIO_FIXTURE);

  // ペアリング完了で「追加」ボタンが活性化するまで待機
  const addBtn = page.locator('button[data-testid="home-play-button"]');
  await expect(addBtn).toBeEnabled({ timeout: 10000 });

  // 「追加」ボタン押下
  await addBtn.click();

  // Step3: Assert — 新カードが出現しIDB件数が+1
  await expect(page.locator('.song-card', { hasText: 'T196 E2E Custom' })).toBeVisible({ timeout: 10000 });
  const cardsAfterAdd = await page.locator('.song-card').count();
  expect(cardsAfterAdd).toBe(cardsBefore + 1);
  await expect.poll(async () => idbCountCharts(page), { timeout: 10000 }).toBe(preCount + 1);

  // カスタム曲の ID を把握（delete-{id} の data-testid から）
  const deleteBtn = page
    .locator('.song-card', { hasText: 'T196 E2E Custom' })
    .locator('xpath=..')
    .locator('button[aria-label*="削除"]');
  const deleteTestId = (await deleteBtn.getAttribute('data-testid')) ?? '';
  expect(deleteTestId).toMatch(/^delete-custom-/);

  // ---------- [2] リロード → 一覧表示 ----------
  // Step1: Capture — 追加時の delete-testid（=IDを特定）を保持
  // Step2: Perform — ページリロード
  await page.reload();
  await page.waitForLoadState('networkidle', { timeout: 10000 });

  // Step3: Assert — カスタムカードが同一IDで一覧に残る
  const cardAfterReload = page.locator('.song-card', { hasText: 'T196 E2E Custom' });
  await expect(cardAfterReload).toBeVisible({ timeout: 10000 });
  const deleteTestIdAfterReload =
    (await cardAfterReload
      .locator('xpath=..')
      .locator('button[aria-label*="削除"]')
      .getAttribute('data-testid')) ?? '';
  expect(deleteTestIdAfterReload).toBe(deleteTestId);
  expect(await idbCountCharts(page)).toBe(preCount + 1);

  // ---------- [3] プレイ（音あり） ----------
  // Step1: Capture — IDB件数（プレイで減らないこと）
  const countBeforePlay = await idbCountCharts(page);

  // Step2: Perform — カスタムカードをクリックしてゲーム起動
  await cardAfterReload.click();
  await expect(page).toHaveURL(/\/play\/custom-/, { timeout: 10000 });

  // Step3: Assert — ゲームキャンバスが表示され、R→Space で再生開始できる（音あり）
  const canvas = page.locator('canvas[data-testid="playtest-canvas"]');
  await expect(canvas).toBeVisible({ timeout: 15000 });
  await page.keyboard.press('r');
  await page.keyboard.press(' ');
  await page.waitForTimeout(1500);
  expect(await idbCountCharts(page)).toBe(countBeforePlay); // プレイでIDBは減らない

  // プレイ中に描画（0でないピクセル）が起きている＝ゲームループが動作
  const hasRendered = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] !== 0 || d[i + 1] !== 0 || d[i + 2] !== 0) return true;
    }
    return false;
  });
  expect(hasRendered).toBe(true);

  // ESC で曲選択に戻る
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
  await expect(page.locator('.select-header h1')).toBeVisible({ timeout: 10000 });

  // ---------- [4] 削除 ----------
  // Step1: Capture — 削除前の件数
  const countBeforeDelete = await idbCountCharts(page);

  // Step2: Perform — 削除ボタン押下
  const customCardDel = page.locator('.song-card', { hasText: 'T196 E2E Custom' });
  await expect(customCardDel).toBeVisible({ timeout: 10000 });
  await customCardDel.locator('xpath=..').locator('button[aria-label*="削除"]').click();

  // Step3: Assert — カードが消えIDB件数が減少
  await expect(page.locator('.song-card', { hasText: 'T196 E2E Custom' })).toHaveCount(0, { timeout: 10000 });
  await expect.poll(async () => idbCountCharts(page), { timeout: 10000 }).toBe(countBeforeDelete - 1);

  // ---------- リロード後も消えたまま ----------
  await page.reload();
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await expect(page.locator('.song-card', { hasText: 'T196 E2E Custom' })).toHaveCount(0, { timeout: 10000 });
  expect(await idbCountCharts(page)).toBe(0);

  expect(errors).toHaveLength(0);
});

test('T196 e2e 異常系: 破損TOML投入→追加ボタン非活性・エラー表示、画面上にUncaughtなし', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  page.on('pageerror', (err) => {
    if (/TypeError|ReferenceError|Uncaught/.test(err.message)) errors.push(err.message);
  });

  await page.goto('http://127.0.0.1:5173/rhythm_game/');
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  const preCount = await idbCountCharts(page);

  // 破損TOML（閉じ引用符が無い）を投入
  const brokenToml = `/tmp/opencode/t196-broken.toml`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(brokenToml, 'title = "Broken\n[[segments]]\ndirection = "up"', 'utf-8');
  await page.locator('input[data-testid="home-chart-input"]').setInputFiles(brokenToml);

  // ペアリング不成立＝「追加」ボタンが無効のまま
  const addBtn = page.locator('button[data-testid="home-play-button"]');
  await page.waitForTimeout(500);
  expect(await addBtn.isDisabled()).toBe(true);

  // エラーはDOMに表示されるがページは壊れない
  await expect(page.locator('[data-testid="select-import-error"]')).toBeAttached({ timeout: 5000 });
  await expect(page.locator('[data-testid="select-import-error"]')).toHaveText(/失敗|解析|パース/, { timeout: 5000 });

  expect(await idbCountCharts(page)).toBe(preCount);
  expect(errors).toHaveLength(0);
});