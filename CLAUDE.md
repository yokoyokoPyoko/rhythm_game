# CLAUDE.md — リズムゲーム（トレース・ウェーブ）

## 概要
文化祭用リズムゲーム。現在は **トレース・ウェーブ** 1 タイトルのみ（音波サバイバルは削除済み）。

## レイアウト
- `src/index.ts` — 全ロジック（単一ソース、Canvas 2D、約520行）。
- `docs/index.html` — GitHub Pages エントリ（`<canvas id="game">` 800×600、枠なし）。
- `docs/index.js` — `npx tsc` のビルド出力。**デプロイに必須**（Pages はコミット済み `docs/` を公開）。
- `/home/p-yoko/Downloads/trace_wave_prototype.html` — 初期プロトタイプ参考。

## ビルド / デプロイ
```
npm run build              # tsc → docs/index.js
git add src/index.ts docs/index.js && git commit && git push   # デプロイ
```
- 公開: `https://yokoyokoPyoko.github.io/rhythm_game/`（branch main, /docs）
- 反映まで最大10分キャッシュ → 検証時はハードリフレッシュ（Ctrl/Cmd+Shift+R）

## アーキテクチャ
- **ゲームループ**: `requestAnimationFrame` → `songNow()` で時刻更新 → `update()` / `render()`。
- **音声クロック（重要）**: `songNow()` は `audioCtx.currentTime` ベース。メトロノームは lookahead スケジューラで `audioStartTime + beat*beatSec` に予約。
- **ループ内状態**: `gameMode`("menu"|"tracewave"), `bpm`, `songTime`, `twState`。
- **キー入力**: `keydown` で `keysJust` / `keys` をセット。`Space` 押下時は `audioCtx.currentTime` を `spaceHitSong` に即座保存し、判定に使う（フレーム遅延排除）。

## トレース・ウェーブの定数（`src/index.ts`）
- `TW_JUDGE_X = W*0.26`, `TW_CENTER_Y = H/2`, `TW_AMP = 120`, `TW_SCROLL = 150`
- `TW_LEAD_BEATS = 2`, `TW_TOLERANCE = 26`, `TW_SNAP = 0.14`
- `tierColorsTW = ["#4cc9f0","#56e39f","#ffb454","#ff5d6c"]`（コンボ段階の状態色）

## 既知の設計的緊張（要解決）
現在のトレース・ウェーブは **3 つのタイミング系が重なる**構造:
1. 波形の山/谷が判定線を通過（連続的な上下トラッキング）
2. メトロノームの離散ビート音
3. リングが最小になった瞬間の Space 判定

これらをすべて一致させるのが困難（開発ログ参照）。次の方針は「単一のタイミング真理」へ集約する方針で検討中。

## 開発ルール（ENV.md より）
- コードは OpenCode が記述。バグ調査のみ `./debug-investigate.sh "<症状>"` で agy(Claude Sonnet 4.6) に依頼（原因特定のみ、編集なし）。
- 試行錯誤は `DEVELOPMENT_LOG.md` に時系列で記録。
- シンプル・イズ・ベスト、最小修正。
