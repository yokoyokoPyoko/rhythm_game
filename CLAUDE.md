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

## タイミングの同期設計（解決済み）
トレース・ウェーブにおける「波形の進行」「メトロノーム音」「リング判定」の3つのタイミング系は、以下の仕組みで完全に同期（単一の真理）するよう解決されています。
- **基準クロック**: `audioCtx.currentTime` を唯一の真理として `songNow()` を計算。
- **入力の即時性**: Space押下時に即座に打鍵音を再生し、`currentTime` を保存してフレーム遅延を排除。
- **環境遅延の自動補正**: Linux等のオーディオバッファ過大報告バグに対し、自動で補正係数（0.375等）を適用することで、物理的な出力遅延とゲーム内判定を完璧に一致させています。

## 開発ルール（ENV.md より）
- コードは OpenCode が記述。バグ調査のみ `./debug-investigate.sh "<症状>"` で agy(Claude Sonnet 4.6) に依頼（原因特定のみ、編集なし）。
- 試行錯誤は `DEVELOPMENT_LOG.md` に時系列で記録。
- シンプル・イズ・ベスト、最小修正。
